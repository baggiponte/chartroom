import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Plugin } from "../plugins.ts";
import { strict } from "../schema.ts";
import { onPath, runCli, timed } from "./run.ts";

export default {
  model: "",
  needs: "the codex CLI on PATH",
  available: env => onPath("codex", env),
  // Not any CODEX_* variable: CODEX_HOME is a user setting and the npm wrapper sets CODEX_MANAGED_BY_NPM, so
  // only what Codex sets for the commands it runs counts.
  host: { agent: "Codex", running: env => Boolean(env["CODEX_THREAD_ID"] || env["CODEX_SANDBOX"]) },
  run: call => {
    const dir = mkdtempSync(join(tmpdir(), "chartroom-"));
    const schemaFile = join(dir, "schema.json");
    const outFile = join(dir, "out.json");
    writeFileSync(schemaFile, JSON.stringify(strict(call.schema)));
    return timed(() =>
      runCli(
        call,
        "codex",
        [
          "exec",
          "--ephemeral",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "--color",
          "never",
          ...(call.model ? ["-m", call.model] : []),
          "-c",
          `model_reasoning_effort="${call.effort}"`,
          "--output-schema",
          schemaFile,
          "--output-last-message",
          outFile,
          "-",
        ],
        `${call.system}\n\n${call.input}`,
        () => ({ data: JSON.parse(readFileSync(outFile, "utf8")) as unknown }),
        dir,
      ),
    ).finally(() => {
      rmSync(dir, { recursive: true, force: true });
    });
  },
} satisfies Plugin;
