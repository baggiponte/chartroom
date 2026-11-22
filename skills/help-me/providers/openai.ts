import type { Plugin } from "../plugins.ts";
import { STRING, check, dropNulls, strict } from "../schema.ts";
import type { Schema } from "../schema.ts";
import { baseUrl, runHttp, timed } from "./run.ts";

const OPENAI_REPLY = {
  type: "object",
  required: ["choices"],
  properties: {
    model: STRING,
    choices: {
      type: "array",
      items: { type: "object", properties: { message: { type: "object", properties: { content: STRING } } } },
    },
  },
} as const satisfies Schema;

export default {
  model: "gpt-5-mini",
  needs: "OPENAI_API_KEY or OPENAI_BASE_URL",
  available: env => Boolean(env["OPENAI_API_KEY"] || env["OPENAI_BASE_URL"]),
  run: call =>
    timed(() =>
      runHttp(
        call,
        `${baseUrl(call.env["OPENAI_BASE_URL"], "https://api.openai.com/v1")}/chat/completions`,
        { authorization: `Bearer ${call.env["OPENAI_API_KEY"] ?? ""}` },
        {
          model: call.model,
          messages: [
            { role: "system", content: call.system },
            { role: "user", content: call.input },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: "answer", strict: true, schema: strict(call.schema) },
          },
        },
        res => {
          // content is null when the model refuses
          const reply = dropNulls(res);
          check(reply, OPENAI_REPLY, "openai reply");
          const { model, choices } = reply;
          const text = choices[0]?.message?.content;
          if (!text) {
            throw new Error("empty reply");
          }
          return { data: JSON.parse(text) as unknown, model };
        },
      ),
    ),
} satisfies Plugin;
