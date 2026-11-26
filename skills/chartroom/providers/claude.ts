import type { Plugin } from "../plugins.ts";
import { ANY, BOOLEAN, NUMBER, STRING, check, isRecord } from "../schema.ts";
import type { Schema } from "../schema.ts";
import { onPath, runCli } from "./run.ts";

const CLAUDE_OUTPUT = {
  type: "object",
  properties: { is_error: BOOLEAN, result: STRING, structured_output: ANY, modelUsage: ANY, duration_ms: NUMBER },
} as const satisfies Schema;

export default {
  model: "haiku",
  needs: "the claude CLI on PATH",
  available: env => onPath("claude", env),
  // CHARTROOM_MCP_CLIENT is set by mcp/server.ts: "claude-ai" for the Claude apps, "claude-code" for Claude Code.
  host: {
    agent: "Claude Code",
    running: env => Boolean(env["CLAUDECODE"]) || /^claude/i.test(env["CHARTROOM_MCP_CLIENT"] ?? ""),
  },
  run: call =>
    runCli(
      call,
      "claude",
      [
        "-p",
        "--model",
        call.model,
        "--output-format",
        "json",
        "--tools",
        "",
        "--no-session-persistence",
        "--setting-sources",
        "",
        "--effort",
        call.effort,
        "--system-prompt",
        call.system,
        "--json-schema",
        JSON.stringify(call.schema),
      ],
      call.input,
      out => {
        const res: unknown = JSON.parse(out);
        check(res, CLAUDE_OUTPUT, "claude output");
        if (res.is_error) {
          throw new Error(res.result || "claude returned an error");
        }
        return {
          data: res.structured_output ?? (JSON.parse(res.result ?? "") as unknown),
          model: isRecord(res.modelUsage) ? Object.keys(res.modelUsage)[0] : undefined,
          ms: res.duration_ms,
        };
      },
    ),
} satisfies Plugin;
