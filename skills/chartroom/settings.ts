import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ParseArgsOptionsConfig } from "node:util";

import { loadPlugin } from "./plugins.ts";
import type { Plugin } from "./plugins.ts";
import { PROVIDERS, hostOf } from "./providers.ts";
import { isRecord } from "./schema.ts";

export interface Settings {
  /** Where to write `{status, prompt}` for an agent that polls instead of blocking; "" for nowhere. */
  out: string;
  stdin: boolean;
  draft: string;
  agent: string;
  backend: { name: string; plugin: Plugin };
  /** "" for the backend's own default. */
  model: string;
  effort: string;
  images: boolean;
  open: boolean;
  /** The command that opens the page; "" for the platform's own. */
  browser: string;
  port: number;
  /** 0 waits forever. */
  timeoutMin: number;
  configFile: string;
  /** Whether the config file set anything, for the startup log. */
  configured: boolean;
}

const FLAGS = {
  out: { type: "string" },
  stdin: { type: "boolean" },
  draft: { type: "string" },
  agent: { type: "string" },
  backend: { type: "string" },
  model: { type: "string" },
  effort: { type: "string" },
  images: { type: "boolean" },
  open: { type: "boolean" },
  browser: { type: "string" },
  port: { type: "string" },
  "timeout-min": { type: "string" },
} as const satisfies ParseArgsOptionsConfig;
type Flag = keyof typeof FLAGS;
const ARGS = { options: FLAGS, allowNegative: true } as const;

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The --out file, read leniently so that a command line `readSettings` refuses can still say so there. A value that
 * starts with "-" is the next flag, which the lenient parse would take as the file name.
 */
export function outPath(argv: Array<string>, env: NodeJS.ProcessEnv): string {
  const out = parseArgs({ ...ARGS, args: argv, strict: false }).values.out;
  return (typeof out === "string" && !out.startsWith("-") ? out : "") || env["CHARTROOM_OUT"] || "";
}

function readConfig(file: string): Readonly<Record<string, unknown>> {
  if (!existsSync(file)) {
    return {};
  }
  try {
    const c: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(c)) {
      throw new Error("not a JSON object");
    }
    return c;
  } catch (error) {
    throw new Error(`${file} is not a valid config: ${errorMessage(error)}`, { cause: error });
  }
}

/**
 * `"plugins": { "name": "./module.ts" }`, paths relative to the config file. A plugin with a built-in's name replaces
 * it, so how `claude` is called can be changed without a fork.
 */
function readPlugins(config: Readonly<Record<string, unknown>>, configFile: string): ReadonlyMap<string, string> {
  const plugins = config["plugins"] ?? {};
  if (!isRecord(plugins)) {
    throw new Error(`${configFile}: "plugins" should map backend names to module paths`);
  }
  return new Map(
    Object.entries(plugins).map(([name, file]) => {
      if (typeof file !== "string" || !file) {
        throw new Error(`${configFile}: plugin "${name}" should be the path of a module`);
      }
      return [name.toLowerCase(), resolve(dirname(configFile), file)];
    }),
  );
}

/**
 * The backend asked for, or with `host` the agent chartroom is running in. Never another one: when that can't run, the
 * error says why and where to set `backend`, so the agent can offer to fix the config instead of us choosing for them.
 * Plugins come before the built-ins, so one can replace a built-in or claim to be the host. `host` imports every
 * configured plugin to ask it, so a broken one stops chartroom even when it isn't the host.
 */
async function pickBackend(
  asked: string,
  plugins: ReadonlyMap<string, string>,
  env: NodeJS.ProcessEnv,
  configFile: string,
): Promise<{ backend: Settings["backend"]; host: string | undefined }> {
  const names = ["host", ...new Set([...Object.keys(PROVIDERS), ...plugins.keys()])].join(", ");
  const fix = `Set "backend" in ${configFile} (or pass --backend) to one of: ${names}.`;
  const backends = new Map<string, Plugin>();
  for (const [name, file] of plugins) {
    if (asked === "host" || asked === name) {
      backends.set(name, await loadPlugin(file));
    }
  }
  for (const [name, plugin] of Object.entries(PROVIDERS)) {
    if (!plugins.has(name)) {
      backends.set(name, plugin);
    }
  }
  const host = hostOf(env, backends);
  let name = asked;
  if (asked === "host") {
    if (!host) {
      throw new Error(`backend is "host", but chartroom can't tell which agent is running it. ${fix}`);
    }
    name = host.name;
  }
  const plugin = backends.get(name);
  if (!plugin) {
    throw new Error(`unknown backend "${asked}". ${fix}`);
  }
  if (plugin.available && !plugin.available(env)) {
    const needs = plugin.needs ?? "something its available() checks for";
    throw new Error(
      asked === "host"
        ? `backend is "host" and ${plugin.host?.agent ?? name} is running chartroom, but ${needs} isn't there. ${fix}`
        : `backend "${name}" needs ${needs}, which isn't there. Install it, or: ${fix}`,
    );
  }
  return { backend: { name, plugin }, host: host?.agent };
}

/**
 * Each setting comes from its flag, then `CHARTROOM_<FLAG>`, then the config file, then a default. Throws, with a
 * message for the user, when one can't be used.
 */
export async function readSettings(argv: Array<string>, env: NodeJS.ProcessEnv): Promise<Settings> {
  const flags = parseArgs({ ...ARGS, args: argv }).values;
  const configFile =
    env["CHARTROOM_CONFIG"] || join(env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "chartroom", "config.json");
  const config = readConfig(configFile);

  const sources = [
    (f: Flag) => flags[f],
    // An empty variable counts as unset, so `CHARTROOM_MODEL=` falls through to the config file like no variable does.
    (f: Flag) => env["CHARTROOM_" + f.replaceAll("-", "_").toUpperCase()] || undefined,
    // Config values are read as text, like flags and env vars: `"port": 8080` and `"port": "8080"` mean the same.
    (f: Flag) => {
      const v = config[f.replaceAll(/-(\w)/g, (_, c: string) => c.toUpperCase())];
      return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : undefined;
    },
  ] as const;
  const sourceOf = (f: Flag): number => {
    const i = sources.findIndex(get => get(f) !== undefined);
    return i < 0 ? sources.length : i;
  };
  const valueOf = (f: Flag): string | boolean | undefined => sources[sourceOf(f)]?.(f);
  const setting = (f: Flag, fallback: string): string => String(valueOf(f) ?? "") || fallback;
  const onOff = (f: Flag, fallback: boolean): boolean => {
    const v = valueOf(f);
    return typeof v === "boolean" ? v : !v ? fallback : !["0", "false", "no", "off"].includes(v.toLowerCase());
  };

  const plugins = readPlugins(config, configFile);
  const asked = setting("backend", "host").toLowerCase();
  const { backend, host } = await pickBackend(asked, plugins, env, configFile);

  const timeout = setting("timeout-min", "30");
  const timeoutMin = Number(timeout);
  if (!Number.isFinite(timeoutMin)) {
    throw new Error(`--timeout-min should be a number of minutes, got "${timeout}"`);
  }

  return {
    out: outPath(argv, env),
    stdin: flags.stdin ?? false,
    draft: flags.draft ?? "",
    agent: setting("agent", host ?? "your agent"),
    backend,
    // A config-file model is dropped when the backend comes from a flag or env var, so `--backend gemini`
    // doesn't run gemini with "haiku".
    model: sourceOf("model") <= sourceOf("backend") ? setting("model", "") : "",
    effort: setting("effort", "low"),
    images: onOff("images", true),
    open: onOff("open", true),
    browser: setting("browser", ""),
    port: Number(setting("port", "0")),
    timeoutMin,
    configFile,
    configured: Object.keys(config).length > 0,
  };
}
