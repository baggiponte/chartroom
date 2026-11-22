import type { Backend } from "../../../skills/help-me/providers.ts";

/** Answers with the model and input it was given, so a test can see what reached the plugin. */
export default {
  model: "echo-1",
  run: async ({ model, input }) => ({ data: { model, input }, model }),
} satisfies Backend;
