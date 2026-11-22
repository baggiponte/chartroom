import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, test } from "node:test";
import type { TestContext } from "node:test";

import { createApi } from "../skills/help-me/api.ts";
import type { Api, ExitCode } from "../skills/help-me/api.ts";
import { createHandler } from "../skills/help-me/http.ts";
import { SupersededError } from "../skills/help-me/jobs.ts";
import { createJobs } from "../skills/help-me/jobs.ts";
import { createModel } from "../skills/help-me/model.ts";
import type { ModelCall } from "../skills/help-me/model.ts";
import { check } from "../skills/help-me/schema.ts";
import { loadPlugin } from "../skills/help-me/plugins.ts";
import type { Plugin } from "../skills/help-me/plugins.ts";
import { PROVIDERS } from "../skills/help-me/providers.ts";
import { readSettings } from "../skills/help-me/settings.ts";
import { analyze, tidy } from "../skills/help-me/tasks.ts";

const CALL = {
  system: "sys",
  schema: { type: "object", properties: {} },
  input: "in",
  model: "",
  effort: "low",
  env: {},
  signal: new AbortController().signal,
} as const;

const NO_CONFIG = { PROMPT_SHAPER_CONFIG: "/nonexistent/config.json", PATH: "", OPENAI_API_KEY: "x" };

/** A model that always answers `data`, checked against the schema it was asked for like a real reply. */
const answering =
  (data: unknown): ModelCall =>
  async (_slot, _system, schema) => {
    const reply = structuredClone(data);
    check(reply, schema);
    return Object.assign({}, reply, { model: "fake", ms: 1 });
  };

describe("readSettings", () => {
  test("a flag beats its env var", async () => {
    const s = await readSettings(["--backend", "openai", "--model", "flag"], {
      ...NO_CONFIG,
      PROMPT_SHAPER_MODEL: "env",
    });
    assert.deepEqual([s.backend.name, s.backend.plugin], ["openai", PROVIDERS.openai]);
    assert.equal(s.model, "flag");
  });

  test("a backend that can run is taken as asked, leaving the model to it", async () => {
    const s = await readSettings(["--backend", "anthropic"], { ...NO_CONFIG, ANTHROPIC_API_KEY: "x" });
    assert.deepEqual([s.backend.name, s.model], ["anthropic", ""]);
  });

  test("inside a known harness, the page names it", async () => {
    const s = await readSettings(["--backend", "openai"], { ...NO_CONFIG, CLAUDECODE: "1" });
    assert.equal(s.agent, "Claude Code");
  });

  test("--no-open and --no-images turn those off", async () => {
    const s = await readSettings(["--backend", "openai", "--no-open", "--no-images"], NO_CONFIG);
    assert.deepEqual([s.open, s.images], [false, false]);
  });

  test("refuses what it can't use with a message for the user", async () => {
    await assert.rejects(readSettings(["--backend", "nope"], NO_CONFIG), /unknown backend "nope"/);
    await assert.rejects(
      readSettings(["--backend", "anthropic"], NO_CONFIG),
      /backend "anthropic" needs ANTHROPIC_API_KEY, which isn't there. .*Set "backend" in \/nonexistent\/config.json/,
    );
    await assert.rejects(readSettings(["--backend", "openai", "--timeout-min", "x"], NO_CONFIG), /--timeout-min/);
  });
});

describe("plugins", () => {
  const dir = mkdtempSync(join(tmpdir(), "plugins-"));
  const plugins = join(import.meta.dirname, "support", "plugins");
  const configWith = (config: unknown, env: NodeJS.ProcessEnv = {}) => {
    const file = join(dir, `${String(Math.random())}.json`);
    writeFileSync(file, JSON.stringify(config));
    return { PROMPT_SHAPER_CONFIG: file, PATH: "", ...env };
  };
  const module = (name: string, source: string) => {
    const file = join(dir, name);
    writeFileSync(file, source);
    return file;
  };

  test("a plugin named in the config file runs under that name, path relative to the file", async () => {
    const env = configWith({ backend: "mine", plugins: { mine: relative(dir, join(plugins, "echo.ts")) } });
    const { backend } = await readSettings([], env);
    assert.equal(backend.name, "mine");
    const reply = await backend.plugin.run({ ...CALL, model: backend.plugin.model ?? "" });
    assert.deepEqual(reply, { data: { model: "echo-1", input: "in" }, model: "echo-1" });
  });

  test("a plugin can replace a built-in backend", async () => {
    const env = configWith({ plugins: { claude: join(plugins, "echo.ts") } });
    const { backend } = await readSettings(["--backend", "claude"], env);
    assert.equal(backend.plugin.model, "echo-1");
  });

  test("a plugin that recognises its harness is what host runs, and names it on the page", async () => {
    const file = module(
      "harness.mjs",
      'export default { host: { agent: "Mine", running: env => env.MINE === "1" }, run: async () => ({ data: {} }) };',
    );
    const s = await readSettings([], configWith({ plugins: { mine: file } }, { MINE: "1" }));
    assert.deepEqual([s.backend.name, s.agent], ["mine", "Mine"]);
  });

  test("a plugin that can't run says what it needs", async () => {
    const file = module(
      "needy.mjs",
      'export default { needs: "the mine CLI on PATH", available: () => false, run: async () => ({ data: {} }) };',
    );
    await assert.rejects(
      readSettings(["--backend", "mine"], configWith({ plugins: { mine: file } })),
      /backend "mine" needs the mine CLI on PATH, which isn't there/,
    );
  });

  test("unknown backends list the plugins too, once", async () => {
    const env = configWith({ plugins: { mine: join(plugins, "echo.ts"), claude: join(plugins, "echo.ts") } });
    await assert.rejects(readSettings(["--backend", "nope"], env), /to one of: host, claude, .*, openai, mine\./);
  });

  test("refuses a module that doesn't export a plugin, even when host only had to ask it", async () => {
    await assert.rejects(loadPlugin(join(plugins, "broken.ts")), /should export default \{ model\?, needs\?/);
    const env = configWith({ plugins: { b: join(plugins, "broken.ts") } }, { CLAUDECODE: "1" });
    await assert.rejects(readSettings([], env), /broken.ts should export default/);
  });

  test("a plugins entry that is not a path is refused", async () => {
    await assert.rejects(readSettings([], configWith({ plugins: { mine: 3 } })), /plugin "mine" should be the path/);
  });
});

describe("createModel", () => {
  const SCHEMA = { type: "object", required: ["n"], properties: { n: { type: "number" } } } as const;
  const options = { name: "fake", model: "", effort: "low", env: {}, jobs: createJobs() };

  test("asks with the backend's default model and checks the reply", async () => {
    const backend: Plugin = { model: "small", run: async ({ model }) => ({ data: { n: 1, extra: model } }) };
    const reply = await createModel({ ...options, backend })("s", "sys", SCHEMA, "in");
    assert.deepEqual(reply, { n: 1, model: "small", ms: undefined });
  });

  test("refuses a reply without data, which only a plugin can send", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "plugin-")), "no-data.mjs");
    writeFileSync(file, "export default { run: async () => ({ nothing: true }) };");
    const backend = await loadPlugin(file);
    await assert.rejects(
      createModel({ ...options, backend })("s", "sys", SCHEMA, "in"),
      /fake's reply.data is missing/,
    );
  });

  test("a newer call in the same slot aborts the backend's signal and rejects the older one as superseded", async () => {
    const backend: Plugin = {
      model: "",
      run: ({ signal, input }) =>
        input === "old"
          ? new Promise((_, reject) => {
              signal.addEventListener("abort", () => reject(new Error("killed")));
            })
          : Promise.resolve({ data: { n: 2 } }),
    };
    const model = createModel({ ...options, backend, jobs: createJobs() });
    const older = model("s", "sys", SCHEMA, "old");
    const newer = await model("s", "sys", SCHEMA, "new");
    await assert.rejects(older, SupersededError);
    assert.equal(newer.n, 2);
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
  await new Promise<void>(resolve => {
    server.listen(0, "127.0.0.1", resolve);
  });
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
