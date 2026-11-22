// Each harness CLI is replaced by a shell script that prints what the real one prints, so these tests pin down how
// help-me calls it and reads it back, not what the model answers.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { PROVIDERS, autoProvider, hostOf } from "../skills/help-me/providers.ts";
import type { ProviderName } from "../skills/help-me/providers.ts";

const SCHEMA = { type: "object", required: ["n"], properties: { n: { type: "number" } } } as const;

/** Puts a fake `cmd` on a fresh PATH that prints `stdout` and records its argv, one argument per line. */
function fakeCli(cmd: string, stdout: string) {
  const dir = mkdtempSync(join(tmpdir(), "fake-cli-"));
  const argvFile = join(dir, "argv");
  const script = join(dir, cmd);
  writeFileSync(
    script,
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\ncat > /dev/null\ncat <<'FAKE_EOF'\n${stdout}\nFAKE_EOF\n`,
  );
  chmodSync(script, 0o755);
  return { env: { PATH: `${dir}:/usr/bin:/bin` }, argv: () => readFileSync(argvFile, "utf8").split("\n") };
}

async function ask(name: ProviderName, cmd: string, stdout: string, model = "") {
  const cli = fakeCli(cmd, stdout);
  const reply = await PROVIDERS[name].run({
    system: "sys",
    schema: SCHEMA,
    input: "Request: a bike",
    model,
    effort: "low",
    env: cli.env,
    signal: new AbortController().signal,
  });
  return { reply, argv: cli.argv() };
}

describe("harness CLIs", () => {
  test("antigravity reads structured_output and reports seconds as ms", async () => {
    const { reply, argv } = await ask(
      "antigravity",
      "agy",
      JSON.stringify({ status: "SUCCESS", response: '{"n":1}', structured_output: { n: 1 }, duration_seconds: 2 }),
    );
    assert.deepEqual(reply, { data: { n: 1 }, ms: 2000 });
    assert.ok(argv.includes("--json-schema"));
    assert.ok(!argv.includes("--model"), "no --model lets agy pick its default");
  });

  test("antigravity surfaces a failed run", async () => {
    await assert.rejects(ask("antigravity", "agy", JSON.stringify({ status: "ERROR", error: "no auth" })), /no auth/);
  });

  test("qwen reads the last result message, fenced or not, and the model from the run", async () => {
    const run = [
      { type: "system", subtype: "session_start", model: "qwen3-coder" },
      { type: "result", subtype: "success", is_error: false, result: '```json\n{"n":3}\n```', duration_ms: 9 },
    ];
    const { reply, argv } = await ask("qwen", "qwen", JSON.stringify(run), "qwen3-coder");
    assert.deepEqual(reply, { data: { n: 3 }, model: "qwen3-coder", ms: 9 });
    assert.deepEqual(argv.slice(0, 2), ["-m", "qwen3-coder"]);
  });

  test("qwen surfaces an error result", async () => {
    await assert.rejects(
      ask("qwen", "qwen", JSON.stringify([{ type: "result", is_error: true, result: "quota" }])),
      /quota/,
    );
  });

  test("opencode joins the text parts of its event stream", async () => {
    const events = [
      { type: "step_start", part: {} },
      { type: "text", part: { text: '{"n":' } },
      { type: "text", part: { text: "4}" } },
      { type: "step_finish", part: {} },
    ];
    const { reply, argv } = await ask("opencode", "opencode", events.map(e => JSON.stringify(e)).join("\n"));
    assert.deepEqual(reply.data, { n: 4 });
    assert.deepEqual(argv.slice(0, 2), ["run", "--pure"]);
  });

  test("opencode surfaces an error event", async () => {
    await assert.rejects(
      ask("opencode", "opencode", JSON.stringify({ type: "error", error: { data: { message: "no provider" } } })),
      /no provider/,
    );
  });

  test("pi runs with no tools and no session, and reads its printed answer", async () => {
    const { reply, argv } = await ask("pi", "pi", '{"n":5}');
    assert.deepEqual(reply.data, { n: 5 });
    assert.ok(argv.includes("--no-tools") && argv.includes("--no-session"));
    assert.ok(argv.includes("Request: a bike"));
  });
});

describe("auto", () => {
  test("prefers the harness it runs in when that CLI is installed", () => {
    const { env } = fakeCli("pi", "");
    assert.equal(autoProvider({ ...env, PI_CODING_AGENT: "1" }), "pi");
    assert.equal(hostOf({ PI_CODING_AGENT: "1" })?.agent, "Pi");
  });

  test("falls back to the first CLI on PATH, then to an API key", () => {
    const { env } = fakeCli("opencode", "");
    assert.equal(autoProvider({ ...env, CLAUDECODE: "1" }), "opencode");
    assert.equal(autoProvider({ PATH: "", OPENAI_API_KEY: "x" }), "openai");
    assert.equal(autoProvider({ PATH: "" }), undefined);
  });
});
