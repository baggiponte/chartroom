import type { Plugin } from "../plugins.ts";
import { ANY, NUMBER, STRING, check, parseFenced } from "../schema.ts";
import type { Schema } from "../schema.ts";
import { onPath, runCli, timed } from "./run.ts";

const ANTIGRAVITY_OUTPUT = {
  type: "object",
  properties: { status: STRING, response: STRING, error: STRING, structured_output: ANY, duration_seconds: NUMBER },
} as const satisfies Schema;

// No system prompt flag, so both go in the one prompt.
export default {
  model: "",
  needs: "the agy CLI on PATH",
  available: env => onPath("agy", env),
  run: call =>
    timed(() =>
      runCli(
        call,
        "agy",
        [
          "-p",
          `${call.system}\n\n${call.input}`,
          "--output-format",
          "json",
          "--json-schema",
          JSON.stringify(call.schema),
          "--effort",
          call.effort,
          ...(call.model ? ["--model", call.model] : []),
        ],
        "",
        out => {
          const res: unknown = JSON.parse(out);
          check(res, ANTIGRAVITY_OUTPUT, "agy output");
          if (res.error || (res.status && res.status !== "SUCCESS")) {
            throw new Error(res.error ?? `agy ended with ${res.status ?? "no status"}`);
          }
          return {
            data: res.structured_output ?? parseFenced(res.response ?? ""),
            ms: res.duration_seconds === undefined ? undefined : res.duration_seconds * 1000,
          };
        },
      ),
    ),
} satisfies Plugin;
