import type { Plugin } from "../plugins.ts";
import { ANY, STRING, check } from "../schema.ts";
import type { Schema } from "../schema.ts";
import { baseUrl, runHttp, timed } from "./run.ts";

const ANTHROPIC_REPLY = {
  type: "object",
  required: ["content"],
  properties: {
    model: STRING,
    content: { type: "array", items: { type: "object", required: ["type"], properties: { type: STRING, input: ANY } } },
  },
} as const satisfies Schema;

// A forced tool call returns input that matches the schema.
export default {
  model: "claude-haiku-5-5",
  needs: "ANTHROPIC_API_KEY",
  available: env => Boolean(env["ANTHROPIC_API_KEY"]),
  run: call =>
    timed(() =>
      runHttp(
        call,
        `${baseUrl(call.env["ANTHROPIC_BASE_URL"], "https://api.anthropic.com")}/v1/messages`,
        { "x-api-key": call.env["ANTHROPIC_API_KEY"] ?? "", "anthropic-version": "2023-06-01" },
        {
          model: call.model,
          max_tokens: 4096,
          system: call.system,
          messages: [{ role: "user", content: call.input }],
          tools: [{ name: "answer", description: "Return the answer.", input_schema: call.schema }],
          tool_choice: { type: "tool", name: "answer" },
        },
        res => {
          check(res, ANTHROPIC_REPLY, "anthropic reply");
          const { model, content } = res;
          const answer = content.find(c => c.type === "tool_use");
          if (!answer) {
            throw new Error("no structured answer in reply");
          }
          return { data: answer.input, model };
        },
      ),
    ),
} satisfies Plugin;
