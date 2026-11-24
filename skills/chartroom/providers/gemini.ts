import type { Plugin } from "../plugins.ts";
import { STRING, check, parseFenced, withSchema } from "../schema.ts";
import type { Schema } from "../schema.ts";
import { onPath, runCli, timed } from "./run.ts";

const GEMINI_OUTPUT = {
  type: "object",
  properties: { response: STRING, error: { type: "object", properties: { message: STRING } } },
} as const satisfies Schema;

// No schema flag, so the schema goes in the prompt.
export default {
  model: "gemini-2.5-flash",
  needs: "the gemini CLI on PATH",
  available: env => onPath("gemini", env),
  host: { agent: "Gemini CLI", running: env => Boolean(env["GEMINI_CLI"]) },
  run: call =>
    timed(() =>
      runCli(
        call,
        "gemini",
        [
          "-m",
          call.model,
          "--output-format",
          "json",
          "--approval-mode",
          "plan",
          "-p",
          withSchema(call.system, call.schema),
        ],
        call.input,
        out => {
          const res: unknown = JSON.parse(out);
          check(res, GEMINI_OUTPUT, "gemini output");
          if (res.error) {
            throw new Error(res.error.message ?? "gemini returned an error");
          }
          return { data: parseFenced(res.response ?? "") };
        },
      ),
    ),
} satisfies Plugin;
