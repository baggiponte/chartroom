import type { Plugin } from "../plugins.ts";
import { ANY, STRING, check, parseFenced, withSchema } from "../schema.ts";
import type { Schema } from "../schema.ts";
import { onPath, runCli, timed } from "./run.ts";

/** One line of `opencode run --format json`: the answer arrives as `text` parts. */
const OPENCODE_EVENT = {
  type: "object",
  properties: { type: STRING, part: { type: "object", properties: { text: STRING } }, error: ANY },
} as const satisfies Schema;

// `run` has no system prompt or schema flag, and --pure keeps the user's plugins out of a one-off question.
export default {
  model: "",
  needs: "the opencode CLI on PATH",
  available: env => onPath("opencode", env),
  host: { agent: "OpenCode", running: env => Boolean(env["OPENCODE"]) },
  run: call =>
    timed(() =>
      runCli(
        call,
        "opencode",
        [
          "run",
          "--pure",
          "--format",
          "json",
          ...(call.model ? ["-m", call.model] : []),
          `${withSchema(call.system, call.schema)}\n\n${call.input}`,
        ],
        "",
        out => {
          let text = "";
          for (const line of out.split("\n")) {
            if (!line.trim().startsWith("{")) {
              continue;
            }
            const event: unknown = JSON.parse(line);
            check(event, OPENCODE_EVENT, "opencode event");
            if (event.type === "error") {
              throw new Error(`opencode: ${JSON.stringify(event.error)}`);
            }
            text += event.type === "text" ? (event.part?.text ?? "") : "";
          }
          return { data: parseFenced(text) };
        },
      ),
    ),
} satisfies Plugin;
