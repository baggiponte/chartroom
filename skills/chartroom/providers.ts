import type { Plugin } from "./plugins.ts";
import antigravity from "./providers/antigravity.ts";
import claude from "./providers/claude.ts";
import codex from "./providers/codex.ts";
import gemini from "./providers/gemini.ts";
import opencode from "./providers/opencode.ts";
import pi from "./providers/pi.ts";

/** The plugins that ship with chartroom: the harness CLIs, so chartroom runs on the subscription the user already has. */
export const PROVIDERS = {
  claude,
  codex,
  gemini,
  antigravity,
  opencode,
  pi,
} as const satisfies Record<string, Plugin>;

export type ProviderName = keyof typeof PROVIDERS;

// Object.hasOwn, not `in`: "constructor" is not a provider.
export const isProvider = (name: string): name is ProviderName => Object.hasOwn(PROVIDERS, name);

/** The first backend that says chartroom is running inside its harness. */
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
