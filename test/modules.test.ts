import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, test } from "node:test";
import type { TestContext } from "node:test";

import { createApi } from "../skills/help-me/api.ts";
import type { Api, ExitCode } from "../skills/help-me/api.ts";
import { createHandler } from "../skills/help-me/http.ts";
import { SupersededError } from "../skills/help-me/jobs.ts";
import type { ModelCall } from "../skills/help-me/model.ts";
import { check } from "../skills/help-me/schema.ts";
import { readSettings } from "../skills/help-me/settings.ts";
import { analyze, tidy } from "../skills/help-me/tasks.ts";

const NO_CONFIG = { PROMPT_SHAPER_CONFIG: "/nonexistent/config.json", PATH: "" };

/** A model that always answers `data`, checked against the schema it was asked for like a real reply. */
const answering =
  (data: unknown): ModelCall =>
  async (_slot, _system, schema) => {
    const reply = structuredClone(data);
    check(reply, schema);
    return Object.assign({}, reply, { model: "fake", ms: 1 });
  };

describe("readSettings", () => {
  test("a flag beats its env var", () => {
    const s = readSettings(["--backend", "openai", "--model", "flag"], { ...NO_CONFIG, PROMPT_SHAPER_MODEL: "env" });
    assert.equal(s.backend, "openai");
    assert.equal(s.model, "flag");
  });

  test("an API key picks its backend, with that backend's default model", () => {
    const s = readSettings([], { ...NO_CONFIG, ANTHROPIC_API_KEY: "x" });
    assert.deepEqual([s.backend, s.model], ["anthropic", "claude-haiku-5-5"]);
  });

  test("--no-open and --no-images turn those off", () => {
    const s = readSettings(["--backend", "openai", "--no-open", "--no-images"], NO_CONFIG);
    assert.deepEqual([s.open, s.images], [false, false]);
  });

  test("refuses what it can't use with a message for the user", () => {
    assert.throws(() => readSettings(["--backend", "nope"], NO_CONFIG), /unknown backend "nope"/);
    assert.throws(() => readSettings([], NO_CONFIG), /no backend found/);
    assert.throws(() => readSettings(["--backend", "openai", "--timeout-min", "x"], NO_CONFIG), /--timeout-min/);
  });
});

describe("tasks", () => {
  test("analyze drops underlines inside a question it returned as an ask", async () => {
    const model = answering({
      summary: "",
      asks: [
        { span: "Train or car?", sentence: "We'll go by {value}.", question: "How?", kind: "single", options: [] },
      ],
      underlines: [
        { span: "car", question: "Which car?", kind: "single", options: [] },
        { span: "Lisbon", question: "Where?", kind: "single", options: [] },
      ],
      extras: [],
    });
    const { choices } = await analyze(model, {
      text: "A weekend in Lisbon. Train or car?",
      settled: [],
      answers: [],
      asked: [],
      more: false,
    });
    assert.deepEqual(
      choices.map(c => c.type),
      ["ask", "underline"],
    );
  });

  test("tidy keeps every sentence even when the model forgets one", async () => {
    const model = answering({ blocks: [{ heading: "Must-haves:", items: [2, 2, 9] }] });
    const { blocks } = await tidy(model, ["a.", "b.", "c."]);
    assert.deepEqual(blocks, [{ heading: "Must-haves", items: [1, 0, 2] }]);
  });
});

async function serve(t: TestContext, model: ModelCall) {
  const finished: Array<[ExitCode, string]> = [];
  const server = createServer(
    createHandler({
      model,
      init: { draft: "", model: "fake", backend: "anthropic", agent: "your agent", images: true, build: "x" },
      page: "<!doctype html>",
      log: () => {},
      finish: (code, prompt) => finished.push([code, prompt]),
    }),
  );
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const post = <R extends keyof Api>(route: R, body: Api[R]["body"]) =>
    fetch(`http://127.0.0.1:${String(port)}${route}`, { method: "POST", body: JSON.stringify(body) });
  return { post, finished };
}

describe("createHandler", () => {
  test("a superseded model call is a 409", async t => {
    const { post } = await serve(t, () => Promise.reject(new SupersededError()));
    assert.equal((await post("/api/tidy", { sentences: ["a.", "b."] })).status, 409);
  });

  test("Send hands the prompt to finish and answers with what gets printed", async t => {
    const { post, finished } = await serve(t, answering({}));
    const res = await post("/api/submit", { prompt: "hello" });
    assert.deepEqual(await res.json(), { ok: true, sent: "hello\n" });
    assert.deepEqual(finished, [[0, "hello"]]);
  });
});

const api = (model: ModelCall, finished: Array<[ExitCode, string]> = []) =>
  createApi({ model, log: () => {}, finish: (code, prompt) => finished.push([code, prompt]) });

describe("createApi", () => {
  test("answers a model-backed route with the model's reply", async () => {
    const { status, body } = await api(answering({ blocks: [] })).call("/api/tidy", { sentences: ["a."] });
    assert.equal(status, 200);
    assert.deepEqual(body, { blocks: [{ heading: "", items: [0] }], model: "fake", ms: 1 });
  });

  test("a body of the wrong shape is a 400, not a throw", async () => {
    const { status } = await api(answering({})).call("/api/tidy", { sentences: "a." });
    assert.equal(status, 400);
  });

  test("a failing model is a 500 with its message", async () => {
    const { status, body } = await api(() => Promise.reject(new Error("no key"))).call("/api/explain", {});
    assert.deepEqual([status, body], [500, { error: "no key" }]);
  });

  test("Cancel hands nothing to finish", async () => {
    const finished: Array<[ExitCode, string]> = [];
    assert.equal((await api(answering({}), finished).call("/api/cancel", {})).status, 200);
    assert.deepEqual(finished, [[2, ""]]);
  });
});
