import { pathToFileURL } from "node:url";

import { PROVIDERS } from "./providers.ts";
import type { Backend, BackendCall, ProviderName } from "./providers.ts";
import { ANY, NUMBER, STRING, check, isRecord } from "./schema.ts";
import type { Schema } from "./schema.ts";

/** Which backend to run: one that ships with help-me, or a module named under `plugins` in the config file. */
export type BackendChoice =
  | { kind: "provider"; name: ProviderName }
  | { kind: "plugin"; name: string; /** Absolute path of the module. */ file: string };

const RAW_REPLY = {
  type: "object",
  required: ["data"],
  properties: { data: ANY, model: STRING, ms: NUMBER },
} as const satisfies Schema;

/** What a plugin module exports by default. Its reply is checked, since nothing compiled it against our types. */
interface Plugin {
  model?: string;
  run: (call: BackendCall) => Promise<unknown>;
}

const isPlugin = (v: unknown): v is Plugin =>
  isRecord(v) && typeof v["run"] === "function" && (v["model"] === undefined || typeof v["model"] === "string");

export async function loadPlugin(file: string): Promise<Backend> {
  const mod: unknown = await import(pathToFileURL(file).href);
  const plugin = isRecord(mod) ? mod["default"] : undefined;
  if (!isPlugin(plugin)) {
    throw new Error(`${file} should export default { model?: string, run(call) }`);
  }
  return {
    model: plugin.model ?? "",
    run: async call => {
      const reply = await plugin.run(call);
      check(reply, RAW_REPLY, `${file}'s reply`);
      return reply;
    },
  };
}

export const loadBackend = async (choice: BackendChoice): Promise<Backend> =>
  choice.kind === "provider" ? PROVIDERS[choice.name] : loadPlugin(choice.file);
