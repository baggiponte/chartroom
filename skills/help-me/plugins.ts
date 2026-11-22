import { pathToFileURL } from "node:url";

import { isRecord } from "./schema.ts";
import type { Schema } from "./schema.ts";

/**
 * A backend: anything that can answer one structured question. The built-ins in providers/ and the modules named under
 * `plugins` in the config file all have this shape; PLUGINS.md is the guide to writing one.
 */
export interface Plugin {
  /** Used when no --model is given; "" or none lets the backend pick its own default. */
  model?: string;
  /** What it needs to run (its CLI on PATH, an API key), for the error when `available` says no. */
  needs?: string;
  /** Whether it can run here. Without it, help-me assumes it can. */
  available?: (env: NodeJS.ProcessEnv) => boolean;
  /** For a harness: its name on the page, and whether help-me is running inside it right now, for `host`. */
  host?: { agent: string; running: (env: NodeJS.ProcessEnv) => boolean };
  run: (call: BackendCall) => Promise<RawReply>;
}

export interface BackendCall {
  system: string;
  schema: Schema;
  input: string;
  /** Already resolved: the --model given, or the backend's own default. */
  model: string;
  effort: string;
  env: NodeJS.ProcessEnv;
  /** Aborted when a newer call replaces this one or the page closes; the backend only has to stop. */
  signal: AbortSignal;
}

/** `model` and `ms` are only there when the backend reports them. */
export interface RawReply {
  data: unknown;
  model?: string | undefined;
  ms?: number | undefined;
}

const optional = (v: unknown, type: "string" | "function"): boolean => v === undefined || typeof v === type;

/** Nothing compiled a plugin module against these types, so its shape is checked here and its replies in model.ts. */
const isPlugin = (v: unknown): v is Plugin =>
  isRecord(v) &&
  typeof v["run"] === "function" &&
  optional(v["model"], "string") &&
  optional(v["needs"], "string") &&
  optional(v["available"], "function") &&
  (v["host"] === undefined ||
    (isRecord(v["host"]) && typeof v["host"]["agent"] === "string" && typeof v["host"]["running"] === "function"));

export async function loadPlugin(file: string): Promise<Plugin> {
  const mod: unknown = await import(pathToFileURL(file).href);
  const plugin = isRecord(mod) ? mod["default"] : undefined;
  if (!isPlugin(plugin)) {
    throw new Error(
      `${file} should export default { model?, needs?, available?(env), host?: { agent, running(env) }, run(call) }`,
    );
  }
  return plugin;
}
