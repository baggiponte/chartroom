import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { ParseArgsOptionsConfig } from "node:util";

import { PROVIDERS, hostOf, isProvider } from "./providers.ts";
import type { ProviderName } from "./providers.ts";
import { isRecord } from "./schema.ts";

export interface Settings {
  /** Where to write `{status, prompt}` for an agent that polls instead of blocking; "" for nowhere. */
  out: string;
  stdin: boolean;
  draft: string;
  agent: string;
  backend: ProviderName;
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
  return (typeof out === "string" && !out.startsWith("-") ? out : "") || env["PROMPT_SHAPER_OUT"] || "";
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
 * The backend asked for, or with `auto` the agent help-me is running in. Never another one: when that can't run, the
 * error says why and where to set `backend`, so the agent can offer to fix the config instead of us choosing for them.
 */
function pickBackend(asked: string, env: NodeJS.ProcessEnv, configFile: string): ProviderName {
  const names = Object.keys(PROVIDERS).join(", ");
  const fix = `Set "backend" in ${configFile} (or pass --backend) to one of: ${names}.`;
  if (asked === "auto") {
    const host = hostOf(env);
    if (!host) {
      throw new Error(`backend is "auto", but help-me can't tell which agent is running it. ${fix}`);
    }
    if (!PROVIDERS[host.name].available(env)) {
      throw new Error(
        `backend is "auto" and ${host.agent} is running help-me, but ${PROVIDERS[host.name].needs} isn't there. ${fix}`,
      );
    }
    return host.name;
  }
  if (!isProvider(asked)) {
    throw new Error(`unknown backend "${asked}". ${fix}`);
  }
  if (!PROVIDERS[asked].available(env)) {
    throw new Error(`backend "${asked}" needs ${PROVIDERS[asked].needs}, which isn't there. Install it, or: ${fix}`);
  }
  return asked;
}

/**
 * Each setting comes from its flag, then `PROMPT_SHAPER_<FLAG>`, then the config file, then a default. Throws, with a
 * message for the user, when one can't be used.
 */
export function readSettings(argv: Array<string>, env: NodeJS.ProcessEnv): Settings {
  const flags = parseArgs({ ...ARGS, args: argv }).values;
  const configFile =
    env["PROMPT_SHAPER_CONFIG"] ||
    join(env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "prompt-shaper", "config.json");
  const config = readConfig(configFile);

  const sources = [
    (f: Flag) => flags[f],
    // An empty variable counts as unset, so `PROMPT_SHAPER_MODEL=` falls through to the config file like no variable does.
    (f: Flag) => env["PROMPT_SHAPER_" + f.replaceAll("-", "_").toUpperCase()] || undefined,
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

  const asked = setting("backend", "auto").toLowerCase();
  const backend = pickBackend(asked, env, configFile);

  const timeout = setting("timeout-min", "30");
  const timeoutMin = Number(timeout);
  if (!Number.isFinite(timeoutMin)) {
    throw new Error(`--timeout-min should be a number of minutes, got "${timeout}"`);
  }

  return {
    out: outPath(argv, env),
    stdin: flags.stdin ?? false,
    draft: flags.draft ?? "",
    agent: setting("agent", hostOf(env)?.agent ?? "your agent"),
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
