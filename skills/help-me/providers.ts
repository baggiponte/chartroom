import type { Plugin } from "./plugins.ts";
import anthropic from "./providers/anthropic.ts";
import antigravity from "./providers/antigravity.ts";
import claude from "./providers/claude.ts";
import codex from "./providers/codex.ts";
import gemini from "./providers/gemini.ts";
import openai from "./providers/openai.ts";
import opencode from "./providers/opencode.ts";
import pi from "./providers/pi.ts";

/** The plugins that ship with help-me. Harnesses come first, so `host` asks them before the API backends. */
export const PROVIDERS = {
  claude,
  codex,
  gemini,
  antigravity,
  opencode,
  pi,
  anthropic,
  openai,
} as const satisfies Record<string, Plugin>;

export type ProviderName = keyof typeof PROVIDERS;

/** The first backend that says help-me is running inside its harness. */
export function hostOf(
  env: NodeJS.ProcessEnv,
  backends: ReadonlyMap<string, Plugin> = new Map<string, Plugin>(Object.entries(PROVIDERS)),
): { name: string; agent: string } | undefined {
  for (const [name, { host }] of backends) {
    if (host?.running(env)) {
      return { name, agent: host.agent };
    }
  }
  return undefined;
}
