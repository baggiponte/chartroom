import type { Plugin } from "../plugins.ts";
import { parseFenced, withSchema } from "../schema.ts";
import { onPath, runCli, timed } from "./run.ts";

// Plain -p prints only the final answer, which is all we read.
export default {
  model: "",
  needs: "the pi CLI on PATH",
  available: env => onPath("pi", env),
  host: { agent: "Pi", running: env => Boolean(env["PI_CODING_AGENT"]) },
  run: call =>
    timed(() =>
      runCli(
        call,
        "pi",
        [
          "-p",
          "--no-tools",
          "--no-session",
          "--system-prompt",
          withSchema(call.system, call.schema),
          ...(call.model ? ["--model", call.model] : []),
          call.input,
        ],
        "",
        out => ({ data: parseFenced(out.trim()) }),
      ),
    ),
} satisfies Plugin;
