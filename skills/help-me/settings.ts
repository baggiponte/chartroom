import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, join } from "node:path";
import { parseArgs } from "node:util";
import type { ParseArgsOptionsConfig } from "node:util";

import { BACKENDS, isBackend } from "./backends.ts";
import type { BackendName } from "./backends.ts";
import { isRecord } from "./schema.ts";

export interface Settings {
  /** Where to write `{status, prompt}` for an agent that polls instead of blocking; "" for nowhere. */
  out: string;
  stdin: boolean;
  draft: string;
  agent: string;
  backend: BackendName;
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

const isCodex = (env: NodeJS.ProcessEnv): boolean => Object.keys(env).some(k => k.startsWith("CODEX_"));

function onPath(cmd: string, env: NodeJS.ProcessEnv): boolean {
  const exts = platform() === "win32" ? ["", ".cmd", ".exe"] : [""];
  return (env["PATH"] ?? "").split(delimiter).some(d => d && exts.some(e => existsSync(join(d, cmd + e))));
}

function autoBackend(env: NodeJS.ProcessEnv): BackendName {
  const host = env["CLAUDECODE"] ? "claude" : env["GEMINI_CLI"] ? "gemini" : isCodex(env) ? "codex" : null;
  if (host && onPath(host, env)) {
    return host;
  }
  for (const cli of ["claude", "codex", "gemini"] as const) {
    if (onPath(cli, env)) {
      return cli;
    }
  }
  if (env["ANTHROPIC_API_KEY"]) {
    return "anthropic";
  }
  if (env["OPENAI_API_KEY"] || env["OPENAI_BASE_URL"]) {
    return "openai";
  }
  throw new Error(
    "no backend found: install the claude, codex or gemini CLI, or set ANTHROPIC_API_KEY or OPENAI_API_KEY",
  );
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
      const v = config[f.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())];
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
  if (asked !== "auto" && !isBackend(asked)) {
    throw new Error(`unknown backend "${asked}", use one of: auto, ${Object.keys(BACKENDS).join(", ")}`);
  }
  const backend = asked === "auto" ? autoBackend(env) : asked;
  const fallbackModel = BACKENDS[backend].model;

  const timeout = setting("timeout-min", "30");
  const timeoutMin = Number(timeout);
  if (!Number.isFinite(timeoutMin)) {
    throw new Error(`--timeout-min should be a number of minutes, got "${timeout}"`);
  }

  return {
    out: outPath(argv, env),
    stdin: flags.stdin ?? false,
    draft: flags.draft ?? "",
    agent: setting(
      "agent",
      env["CLAUDECODE"] ? "Claude Code" : env["GEMINI_CLI"] ? "Gemini CLI" : isCodex(env) ? "Codex" : "your agent",
    ),
    backend,
    // A config-file model is dropped when the backend comes from a flag or env var, so `--backend gemini`
    // doesn't run gemini with "haiku".
    model: sourceOf("model") <= sourceOf("backend") ? setting("model", fallbackModel) : fallbackModel,
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
