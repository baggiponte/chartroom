// The help-me server's HTTP contract, driven through the real process with a fake model API (test/support).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, type TestContext, test } from "node:test";

import { z } from "zod";

import { type FakeModel, type HelpMe, runHelpMe, startFakeApi, startHelpMe } from "./support/help-me.ts";

const scratch = mkdtempSync(join(tmpdir(), "help-me-files-"));

function configFile(settings: Record<string, unknown>): string {
  const path = join(scratch, `config-${String(Math.random()).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(settings));
  return path;
}

const Init = z.object({
  draft: z.string(),
  model: z.string(),
  backend: z.string(),
  agent: z.string(),
  images: z.boolean(),
  build: z.string(),
});

async function init(helpMe: HelpMe): Promise<z.infer<typeof Init>> {
  return Init.parse(await (await helpMe.get("/api/init")).json());
}

const Analysis = z.object({
  summary: z.string(),
  choices: z.array(
    z.object({
      type: z.enum(["ask", "underline", "extra"]),
      span: z.string().optional(),
      token: z.string().optional(),
      kind: z.string(),
      statement: z.string().optional(),
    }),
  ),
});
const Failure = z.object({ error: z.string() });
const Tidied = z.object({ blocks: z.array(z.object({ heading: z.string(), items: z.array(z.number()) })) });
const Decision = z.object({
  questions: z.array(z.object({ question: z.string() })),
  recommendation: z.object({ label: z.string(), why: z.string() }).optional(),
});
const Submitted = z.object({ ok: z.literal(true), sent: z.string() });
const OutFile = z.object({ status: z.string(), prompt: z.string() });

function outFile(path: string): z.infer<typeof OutFile> {
  return OutFile.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** Starts a fake API and a server wired to it, and stops both when the test ends. */
async function withModel(t: TestContext, answer: FakeModel) {
  const api = await startFakeApi(answer);
  const helpMe = await startHelpMe({ api });
  t.after(async () => {
    helpMe.stop();
    await api.close();
  });
  return { api, helpMe };
}

describe("/api/init", () => {
  test("hands the page the draft, the backend and a build hash", async t => {
    const helpMe = await startHelpMe({ args: ["--draft", "a coffee machine"] });
    t.after(helpMe.stop);
    const { build, ...rest } = await init(helpMe);
    assert.deepEqual(rest, {
      draft: "a coffee machine",
      model: "claude-haiku-5-5",
      backend: "anthropic",
      agent: "your agent",
      images: true,
    });
    assert.match(build, /^[0-9a-f]{12}$/);
  });

  test("a --model flag beats the env var, which beats the config file", async () => {
    const config = configFile({ backend: "anthropic", model: "from-file" });
    const cases: [string[], Record<string, string>, string][] = [
      [[], { PROMPT_SHAPER_CONFIG: config }, "from-file"],
      [[], { PROMPT_SHAPER_CONFIG: config, PROMPT_SHAPER_MODEL: "from-env" }, "from-env"],
      [["--model", "from-flag"], { PROMPT_SHAPER_CONFIG: config, PROMPT_SHAPER_MODEL: "from-env" }, "from-flag"],
    ];
    const models = await Promise.all(
      cases.map(async ([args, env]) => {
        const helpMe = await startHelpMe({ args, env, backendFlag: false });
        const { model } = await init(helpMe);
        helpMe.stop();
        return model;
      }),
    );
    assert.deepEqual(
      models,
      cases.map(([, , model]) => model),
    );
  });

  test("a config-file model is dropped when the backend comes from a flag", async t => {
    const helpMe = await startHelpMe({ env: { PROMPT_SHAPER_CONFIG: configFile({ model: "haiku" }) } });
    t.after(helpMe.stop);
    assert.equal((await init(helpMe)).model, "claude-haiku-5-5");
  });
});

describe("/api/analyze", () => {
  const text = "Should we go by train or car? I hate long train rides.";
  const reply = {
    summary: "Let's plan the trip.",
    asks: [
      {
        span: "Should we go by train or car?",
        sentence: "We'll go by {value}.",
        question: "Train or car?",
        kind: "slider",
        options: [
          { label: "Train", text: "train" },
          { label: "Car", text: "car" },
        ],
      },
    ],
    underlines: [
      {
        span: "train",
        question: "Which train?",
        kind: "single",
        options: [{ label: "High-speed", text: "high-speed train" }],
      },
      {
        span: "long",
        question: "How long?",
        kind: "single",
        options: [{ label: "Over 3 hours", text: "over 3 hours" }],
      },
      { span: "plane", question: "Which plane?", kind: "single", options: [{ label: "Any", text: "any plane" }] },
    ],
    extras: [{ token: "Budget", sentence: "My budget is {value}.", question: "What's your budget?", kind: "single" }],
  };

  test("a one-word request gets no choices and never reaches the model", async t => {
    const { api, helpMe } = await withModel(t, () => reply);
    assert.deepEqual(await helpMe.ask("/api/analyze", { text: "coffee" }, Analysis), { summary: "", choices: [] });
    assert.equal(api.calls.length, 0);
  });

  test("keeps the choices whose span is in the request and labels each one with its type", async t => {
    const { helpMe } = await withModel(t, () => reply);
    const data = await helpMe.ask("/api/analyze", { text }, Analysis);
    assert.equal(data.summary, "Let's plan the trip.");
    assert.deepEqual(
      data.choices.map(c => [c.type, c.span ?? c.token]),
      [
        ["ask", "Should we go by train or car?"],
        ["underline", "long"],
        ["extra", "Budget"],
      ],
    );
    const ask = data.choices[0];
    assert.equal(ask?.kind, "single", "an ask is answered with options, never a slider");
    assert.equal(ask?.statement, "We'll go by {value}.");
  });

  test("tells the model which phrases are settled and which extras were shown", async t => {
    const { api, helpMe } = await withModel(t, () => reply);
    await helpMe.post("/api/analyze", { text, settled: ["car"], asked: ["What's your budget?"] });
    const input = api.calls[0]?.input ?? "";
    assert.match(input, /do not return underlines for them:\n- "car"/);
    assert.match(input, /Extras already shown \(do not repeat them\):\n- What's your budget\?/);
  });

  test("a reply that misses a field is an error the page can show", async t => {
    const { helpMe } = await withModel(t, () => ({ summary: "", asks: [], extras: [] }));
    const res = await helpMe.post("/api/analyze", { text });
    assert.equal(res.status, 500);
    assert.deepEqual(Failure.parse(await res.json()), { error: "reply.underlines is missing" });
  });
});

describe("/api/tidy", () => {
  test("turns 1-based numbers into indexes, uses each sentence once and keeps the ones the model forgot", async t => {
    const { helpMe } = await withModel(t, () => ({
      blocks: [
        { heading: "", items: [2, 1] },
        { heading: "Must-haves:", items: [3, 3, 9] },
      ],
    }));
    const data = await helpMe.ask("/api/tidy", { sentences: ["a.", "b.", "c.", "d."] }, Tidied);
    assert.deepEqual(data.blocks, [
      { heading: "", items: [1, 0, 3] },
      { heading: "Must-haves", items: [2] },
    ]);
  });
});

describe("/api/decide", () => {
  const question = { text: "a coffee machine", question: "Which kind?", options: ["Espresso", "Pod"] };
  const reply = {
    questions: [
      { question: "How often?", options: [{ label: "Daily" }, { label: "Weekends" }] },
      { question: "Already asked?", options: [{ label: "Yes" }, { label: "No" }] },
      { question: "One option only?", options: [{ label: "Yes" }] },
    ],
    recommendation: { label: "pod", why: "You want it quick." },
  };

  test("drops repeated questions and questions with fewer than two options", async t => {
    const { helpMe } = await withModel(t, () => reply);
    const data = await helpMe.ask("/api/decide", { ...question, asked: ["already asked?"] }, Decision);
    assert.deepEqual(
      data.questions.map(q => q.question),
      ["How often?"],
    );
  });

  test("recommends only once there are answers, and only one of the options", async t => {
    const { helpMe } = await withModel(t, () => reply);
    const none = await helpMe.ask("/api/decide", question, Decision);
    assert.equal(none.recommendation, undefined);
    const answered = { ...question, answers: [{ q: "How often?", a: "Daily" }] };
    const some = await helpMe.ask("/api/decide", answered, Decision);
    assert.deepEqual(some.recommendation, { label: "pod", why: "You want it quick." });
  });

  test("a recommendation that is not one of the options is dropped", async t => {
    const { helpMe } = await withModel(t, () => ({ ...reply, recommendation: { label: "Filter", why: "" } }));
    const answered = { ...question, answers: [{ q: "How often?", a: "Daily" }] };
    const data = await helpMe.ask("/api/decide", answered, Decision);
    assert.equal(data.recommendation, undefined);
  });
});

describe("handing the result back", () => {
  test("Send prints the prompt on stdout, writes it to --out and exits 0", async () => {
    const out = join(scratch, "sent.json");
    const helpMe = await startHelpMe({ args: ["--out", out] });
    const res = await helpMe.ask("/api/submit", { prompt: "Pick a pod machine." }, Submitted);
    assert.equal(res.sent, "Pick a pod machine.\n");
    assert.deepEqual(await helpMe.exited, { code: 0, stdout: "Pick a pod machine.\n" });
    assert.deepEqual(outFile(out), { status: "sent", prompt: "Pick a pod machine." });
  });

  test("Cancel prints nothing and exits 2", async () => {
    const out = join(scratch, "cancelled.json");
    const helpMe = await startHelpMe({ args: ["--out", out] });
    await helpMe.post("/api/cancel", {});
    assert.deepEqual(await helpMe.exited, { code: 2, stdout: "" });
    assert.deepEqual(outFile(out), { status: "cancelled", prompt: "" });
  });

  test("--stdin takes the draft from standard input, trimmed", async t => {
    const helpMe = await startHelpMe({ args: ["--stdin"], stdin: "  a coffee machine\n" });
    t.after(helpMe.stop);
    assert.equal((await init(helpMe)).draft, "a coffee machine");
  });
});

describe("requests the server does not understand", () => {
  test("an unknown path is a 404 and a body that is not JSON is a 400", async t => {
    const helpMe = await startHelpMe();
    t.after(helpMe.stop);
    assert.equal((await helpMe.get("/api/nope")).status, 404);
    const res = await fetch(new URL("/api/analyze", helpMe.url), { method: "POST", body: "{" });
    assert.equal(res.status, 400);
  });
});

describe("choosing a backend", () => {
  test("an unknown backend exits 1 and lists the known ones", async () => {
    const { code, stderr } = await runHelpMe(["--backend", "nope"]);
    assert.equal(code, 1);
    assert.match(stderr, /unknown backend "nope", use one of: auto, claude, codex, gemini, anthropic, openai/);
  });

  test("a config file that is not a JSON object exits 1 instead of being ignored", async () => {
    const config = join(scratch, "broken-config.json");
    writeFileSync(config, "{ backend: anthropic");
    const out = join(scratch, "broken-config-out.json");
    const { code, stderr } = await runHelpMe(["--out", out], { PROMPT_SHAPER_CONFIG: config, ANTHROPIC_API_KEY: "x" });
    assert.equal(code, 1);
    assert.match(stderr, /broken-config\.json is not a valid config/);
    assert.deepEqual(outFile(out), { status: "error", prompt: "" });
  });

  test("with no CLI on PATH and no API key there is no backend, and it exits 1", async () => {
    const { code, stderr } = await runHelpMe([]);
    assert.equal(code, 1);
    assert.match(stderr, /no backend found/);
  });
});

// Bugs found while writing these tests, one issue each. A test still marked `todo` asserts the behaviour we want before
// the fix lands, so the suite stays green and the runner still reports whether it passes.
describe("bugs", () => {
  test("a second Send is ignored instead of printing the prompt twice", async () => {
    const helpMe = await startHelpMe();
    await Promise.all([helpMe.post("/api/submit", { prompt: "once" }), helpMe.post("/api/submit", { prompt: "once" })]);
    assert.equal((await helpMe.exited).stdout, "once\n");
  });

  test("with no backend, --out still says what happened", async () => {
    const out = join(scratch, "no-backend.json");
    await runHelpMe(["--out", out]);
    assert.deepEqual(outFile(out), { status: "error", prompt: "" });
  });

  test("a --timeout-min that is not a number is refused at start", async () => {
    const { code } = await runHelpMe(["--backend", "anthropic", "--timeout-min", "abc"], { ANTHROPIC_API_KEY: "x" });
    assert.equal(code, 1);
  });

  test("an empty PROMPT_SHAPER_MODEL counts as unset, so the config file's model applies", async t => {
    const helpMe = await startHelpMe({
      backendFlag: false,
      env: {
        PROMPT_SHAPER_CONFIG: configFile({ backend: "anthropic", model: "from-file" }),
        PROMPT_SHAPER_MODEL: "",
      },
    });
    t.after(helpMe.stop);
    assert.equal((await init(helpMe)).model, "from-file");
  });

  test("a flag with no value does not swallow the next flag", async () => {
    const { code, stderr } = await runHelpMe(["--backend", "--no-open"]);
    assert.equal(code, 1);
    assert.match(stderr, /--backend needs a value/);
  });

  test("a body with the wrong shape is a 400, not a 500", async t => {
    const helpMe = await startHelpMe();
    t.after(helpMe.stop);
    const res = await helpMe.post("/api/analyze", { text: "a coffee machine", settled: null });
    assert.equal(res.status, 400);
  });
});
