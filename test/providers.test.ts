// Each harness CLI is replaced by a shell script that prints what the real one prints, so these tests pin down how
// chartroom calls it and reads it back, not what the model answers.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { PROVIDERS, hostOf } from "../skills/chartroom/providers.ts";
import type { ProviderName } from "../skills/chartroom/providers.ts";

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

describe("hostOf", () => {
  test("names the agent chartroom runs in, and nothing outside one", () => {
    assert.deepEqual(hostOf({ PI_CODING_AGENT: "1" }), { name: "pi", agent: "Pi" });
    assert.equal(hostOf({ PATH: "" }), undefined);
  });

  test("a user's own CODEX_HOME is not taken for running inside Codex", () => {
    assert.equal(hostOf({ CODEX_HOME: "/x", CODEX_MANAGED_BY_NPM: "1" }), undefined);
    assert.equal(hostOf({ CODEX_THREAD_ID: "t" })?.name, "codex");
  });
});
