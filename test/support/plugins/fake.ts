import type { Plugin } from "../../../skills/help-me/plugins.ts";

/** Sends each question to the fake model at FAKE_MODEL_URL (see startFakeApi) and answers with what it returns. */
export default {
  model: "fake-1",
  run: async ({ system, input, model, env, signal }) => {
    const r = await fetch(env["FAKE_MODEL_URL"] ?? "", {
      method: "POST",
      body: JSON.stringify({ model, system, input }),
      signal,
    });
    return { data: (await r.json()) as unknown, model };
  },
} satisfies Plugin;
