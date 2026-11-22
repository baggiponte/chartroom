import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { ANY, BOOLEAN, NUMBER, STRING, check, dropNulls, isRecord, parseFenced, strict, withSchema } from "./schema.ts";
import type { Schema } from "./schema.ts";

/** Anything that can answer one structured question. Plugins implement this and nothing else. */
export interface Backend {
  /** Used when no --model is given; "" lets the CLI pick its own default. */
  readonly model: string;
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

/** A backend that ships with help-me, and how `auto` finds it. */
export interface Provider extends Backend {
  /** Whether it can run here: its CLI is on PATH, or its API key is set. */
  available: (env: NodeJS.ProcessEnv) => boolean;
  /** For a harness: its name on the page, and whether help-me is running inside it right now. */
  host?: { agent: string; running: (env: NodeJS.ProcessEnv) => boolean };
}

export type ProviderName = keyof typeof PROVIDERS;

function onPath(cmd: string, env: NodeJS.ProcessEnv): boolean {
  const exts = platform() === "win32" ? ["", ".cmd", ".exe"] : [""];
  return (env["PATH"] ?? "").split(delimiter).some(d => d && exts.some(e => existsSync(join(d, cmd + e))));
}

/** Runs `cmd` and parses its stdout; a failed parse reports the CLI's own output, which says more. */
function runCli<T>(
  { env, signal }: BackendCall,
  cmd: string,
  argv: ReadonlyArray<string>,
  stdin: string,
  parse: (out: string) => T,
  cwd = tmpdir(),
): Promise<T> {
  return new Promise((resolve, reject) => {
    // The child gets PROMPT_SHAPER_CHILD so a harness that loads this skill doesn't open the page again.
    const child = spawn(cmd, argv, {
      cwd,
      env: { ...env, PROMPT_SHAPER_CHILD: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      signal,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.on("error", e => {
      reject(new Error(`could not start ${cmd}: ${e.message}`));
    });
    child.on("close", code => {
      try {
        resolve(parse(out));
      } catch (error) {
        // A bare JSON.parse failure ("Unexpected token…") says less than the CLI's own output does.
        const why = error instanceof Error && !error.message.startsWith("Unexpected") ? `${error.message} ` : "";
        reject(new Error(`${cmd} exited ${String(code)}: ${why}${(err || out).slice(0, 400)}`));
      }
    });
    // A CLI that exits before reading stdin would otherwise crash us with EPIPE.
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

async function runHttp<T>(
  { signal }: BackendCall,
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  parse: (reply: unknown) => T,
): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
    signal,
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`${new URL(url).host} answered ${String(r.status)}: ${text.slice(0, 400)}`);
  }
  return parse(JSON.parse(text));
}

const timed = async <T extends RawReply>(run: () => Promise<T>): Promise<T> => {
  const t0 = Date.now();
  const reply = await run();
  return { ...reply, ms: reply.ms ?? Date.now() - t0 };
};

const CLAUDE_OUTPUT = {
  type: "object",
  properties: { is_error: BOOLEAN, result: STRING, structured_output: ANY, modelUsage: ANY, duration_ms: NUMBER },
} as const satisfies Schema;
const GEMINI_OUTPUT = {
  type: "object",
  properties: { response: STRING, error: { type: "object", properties: { message: STRING } } },
} as const satisfies Schema;
const ANTIGRAVITY_OUTPUT = {
  type: "object",
  properties: { status: STRING, response: STRING, error: STRING, structured_output: ANY, duration_seconds: NUMBER },
} as const satisfies Schema;
/** Qwen Code prints the whole run as one array; the last `result` message holds the answer. */
const QWEN_OUTPUT = {
  type: "array",
  items: {
    type: "object",
    properties: { type: STRING, model: STRING, is_error: BOOLEAN, result: STRING, duration_ms: NUMBER },
  },
} as const satisfies Schema;
/** One line of `opencode run --format json`: the answer arrives as `text` parts. */
const OPENCODE_EVENT = {
  type: "object",
  properties: { type: STRING, part: { type: "object", properties: { text: STRING } }, error: ANY },
} as const satisfies Schema;
const ANTHROPIC_REPLY = {
  type: "object",
  required: ["content"],
  properties: {
    model: STRING,
    content: { type: "array", items: { type: "object", required: ["type"], properties: { type: STRING, input: ANY } } },
  },
} as const satisfies Schema;
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

const baseUrl = (value: string | undefined, fallback: string): string => (value || fallback).replace(/\/$/, "");

/** In the order `auto` tries them: the harnesses' own CLIs on their subscriptions first, API keys last. */
export const PROVIDERS = {
  claude: {
    model: "haiku",
    available: env => onPath("claude", env),
    host: { agent: "Claude Code", running: env => Boolean(env["CLAUDECODE"]) },
    run: call =>
      runCli(
        call,
        "claude",
        [
          "-p",
          "--model",
          call.model,
          "--output-format",
          "json",
          "--tools",
          "",
          "--no-session-persistence",
          "--setting-sources",
          "",
          "--effort",
          call.effort,
          "--system-prompt",
          call.system,
          "--json-schema",
          JSON.stringify(call.schema),
        ],
        call.input,
        out => {
          const res: unknown = JSON.parse(out);
          check(res, CLAUDE_OUTPUT, "claude output");
          if (res.is_error) {
            throw new Error(res.result || "claude returned an error");
          }
          return {
            data: res.structured_output ?? (JSON.parse(res.result ?? "") as unknown),
            model: isRecord(res.modelUsage) ? Object.keys(res.modelUsage)[0] : undefined,
            ms: res.duration_ms,
          };
        },
      ),
  },
  codex: {
    model: "",
    available: env => onPath("codex", env),
    host: { agent: "Codex", running: env => Object.keys(env).some(k => k.startsWith("CODEX_")) },
    run: call => {
      const dir = mkdtempSync(join(tmpdir(), "prompt-shaper-"));
      const schemaFile = join(dir, "schema.json");
      const outFile = join(dir, "out.json");
      writeFileSync(schemaFile, JSON.stringify(strict(call.schema)));
      return timed(() =>
        runCli(
          call,
          "codex",
          [
            "exec",
            "--ephemeral",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "--color",
            "never",
            ...(call.model ? ["-m", call.model] : []),
            "-c",
            `model_reasoning_effort="${call.effort}"`,
            "--output-schema",
            schemaFile,
            "--output-last-message",
            outFile,
            "-",
          ],
          `${call.system}\n\n${call.input}`,
          () => ({ data: JSON.parse(readFileSync(outFile, "utf8")) as unknown }),
          dir,
        ),
      ).finally(() => {
        rmSync(dir, { recursive: true, force: true });
      });
    },
  },
  // No schema flag, so the schema goes in the prompt.
  gemini: {
    model: "gemini-2.5-flash",
    available: env => onPath("gemini", env),
    host: { agent: "Gemini CLI", running: env => Boolean(env["GEMINI_CLI"]) },
    run: call =>
      timed(() =>
        runCli(
          call,
          "gemini",
          [
            "-m",
            call.model,
            "--output-format",
            "json",
            "--approval-mode",
            "plan",
            "-p",
            withSchema(call.system, call.schema),
          ],
          call.input,
          out => {
            const res: unknown = JSON.parse(out);
            check(res, GEMINI_OUTPUT, "gemini output");
            if (res.error) {
              throw new Error(res.error.message ?? "gemini returned an error");
            }
            return { data: parseFenced(res.response ?? "") };
          },
        ),
      ),
  },
  // No system prompt flag, so both go in the one prompt.
  antigravity: {
    model: "",
    available: env => onPath("agy", env),
    run: call =>
      timed(() =>
        runCli(
          call,
          "agy",
          [
            "-p",
            `${call.system}\n\n${call.input}`,
            "--output-format",
            "json",
            "--json-schema",
            JSON.stringify(call.schema),
            "--effort",
            call.effort,
            ...(call.model ? ["--model", call.model] : []),
          ],
          "",
          out => {
            const res: unknown = JSON.parse(out);
            check(res, ANTIGRAVITY_OUTPUT, "agy output");
            if (res.error || (res.status && res.status !== "SUCCESS")) {
              throw new Error(res.error ?? `agy ended with ${res.status ?? "no status"}`);
            }
            return {
              data: res.structured_output ?? parseFenced(res.response ?? ""),
              ms: res.duration_seconds === undefined ? undefined : res.duration_seconds * 1000,
            };
          },
        ),
      ),
  },
  qwen: {
    model: "",
    available: env => onPath("qwen", env),
    host: { agent: "Qwen Code", running: env => Boolean(env["QWEN_CODE"]) },
    run: call =>
      runCli(
        call,
        "qwen",
        [
          ...(call.model ? ["-m", call.model] : []),
          "--output-format",
          "json",
          "--approval-mode",
          "plan",
          "-p",
          withSchema(call.system, call.schema),
        ],
        call.input,
        out => {
          const res: unknown = JSON.parse(out);
          check(res, QWEN_OUTPUT, "qwen output");
          const result = res.findLast(m => m.type === "result");
          if (!result || result.is_error) {
            throw new Error(result?.result || "qwen returned no result");
          }
          return {
            data: parseFenced(result.result ?? ""),
            model: res.find(m => m.model)?.model,
            ms: result.duration_ms,
          };
        },
      ),
  },
  // `run` has no system prompt or schema flag, and --pure keeps the user's plugins out of a one-off question.
  opencode: {
    model: "",
    available: env => onPath("opencode", env),
    host: { agent: "OpenCode", running: env => Boolean(env["OPENCODE"]) },
    run: call =>
      timed(() =>
        runCli(
          call,
          "opencode",
          [
            "run",
            "--pure",
            "--format",
            "json",
            ...(call.model ? ["-m", call.model] : []),
            `${withSchema(call.system, call.schema)}\n\n${call.input}`,
          ],
          "",
          out => {
            let text = "";
            for (const line of out.split("\n")) {
              if (!line.trim().startsWith("{")) {
                continue;
              }
              const event: unknown = JSON.parse(line);
              check(event, OPENCODE_EVENT, "opencode event");
              if (event.type === "error") {
                throw new Error(`opencode: ${JSON.stringify(event.error)}`);
              }
              text += event.type === "text" ? (event.part?.text ?? "") : "";
            }
            return { data: parseFenced(text) };
          },
        ),
      ),
  },
  // Plain -p prints only the final answer, which is all we read.
  pi: {
    model: "",
    available: env => onPath("pi", env),
    host: { agent: "Pi", running: env => Boolean(env["PI_CODING_AGENT"]) },
    run: call =>
      timed(() =>
        runCli(
          call,
          "pi",
          [
            "-p",
            "--no-tools",
            "--no-session",
            "--system-prompt",
            withSchema(call.system, call.schema),
            ...(call.model ? ["--model", call.model] : []),
            call.input,
          ],
          "",
          out => ({ data: parseFenced(out.trim()) }),
        ),
      ),
  },
  // A forced tool call returns input that matches the schema.
  anthropic: {
    model: "claude-haiku-5-5",
    available: env => Boolean(env["ANTHROPIC_API_KEY"]),
    run: call =>
      timed(() =>
        runHttp(
          call,
          `${baseUrl(call.env["ANTHROPIC_BASE_URL"], "https://api.anthropic.com")}/v1/messages`,
          { "x-api-key": call.env["ANTHROPIC_API_KEY"] ?? "", "anthropic-version": "2023-06-01" },
          {
            model: call.model,
            max_tokens: 4096,
            system: call.system,
            messages: [{ role: "user", content: call.input }],
            tools: [{ name: "answer", description: "Return the answer.", input_schema: call.schema }],
            tool_choice: { type: "tool", name: "answer" },
          },
          res => {
            check(res, ANTHROPIC_REPLY, "anthropic reply");
            const { model, content } = res;
            const answer = content.find(c => c.type === "tool_use");
            if (!answer) {
              throw new Error("no structured answer in reply");
            }
            return { data: answer.input, model };
          },
        ),
      ),
  },
  openai: {
    model: "gpt-5-mini",
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
  },
} as const satisfies Record<string, Provider>;

// Object.hasOwn, not `in`: "constructor" is not a provider.
export const isProvider = (name: string): name is ProviderName => Object.hasOwn(PROVIDERS, name);

const NAMES = Object.keys(PROVIDERS).filter(isProvider);

/** The harness help-me is running inside, if it is one we know. */
export function hostOf(env: NodeJS.ProcessEnv): { name: ProviderName; agent: string } | undefined {
  for (const name of NAMES) {
    const { host }: Provider = PROVIDERS[name];
    if (host?.running(env)) {
      return { name, agent: host.agent };
    }
  }
  return undefined;
}

/** The calling harness when it can run here, so help-me spends that subscription; else the first that can. */
export function autoProvider(env: NodeJS.ProcessEnv): ProviderName | undefined {
  const host = hostOf(env)?.name;
  if (host && PROVIDERS[host].available(env)) {
    return host;
  }
  return NAMES.find(name => PROVIDERS[name].available(env));
}
