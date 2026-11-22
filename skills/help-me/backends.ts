import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SupersededError } from "./jobs.ts";
import type { Jobs } from "./jobs.ts";
import { ANY, BOOLEAN, NUMBER, STRING, check, dropNulls, isRecord, parseFenced, strict, withSchema } from "./schema.ts";
import type { Schema } from "./schema.ts";

export type BackendName = keyof typeof BACKENDS;

export interface Backend {
  /** Used when no --model is given; "" lets the CLI pick its own default. */
  model: string;
  run: (call: BackendCall) => Promise<RawReply>;
}

export interface BackendCall {
  slot: string;
  system: string;
  schema: Schema;
  input: string;
  model: string;
  effort: string;
  env: NodeJS.ProcessEnv;
  jobs: Jobs;
}

/** `model` and `ms` are only there when the backend reports them. */
export interface RawReply {
  data: unknown;
  model?: string | undefined;
  ms?: number | undefined;
}

function runCli<T>(
  { slot, env, jobs }: BackendCall,
  cmd: string,
  argv: Array<string>,
  stdin: string,
  parse: (out: string) => T,
  cwd = tmpdir(),
): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { cwd, env: { ...env, PROMPT_SHAPER_CHILD: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    const job = { abort: () => child.kill("SIGTERM") };
    jobs.claim(slot, job);
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
    child.on("close", (code, signal) => {
      jobs.release(slot, job);
      if (signal) {
        reject(new SupersededError());
        return;
      }
      try {
        resolve(parse(out));
      } catch (error) {
        // A bare JSON.parse failure ("Unexpected token…") says less than the CLI's own output does.
        const why = error instanceof Error && !error.message.startsWith("Unexpected") ? `${error.message} ` : "";
        reject(new Error(`${cmd} exited ${String(code)}: ${why}${(err || out).slice(0, 400)}`));
      }
    });
    child.stdin.end(stdin);
  });
}

async function runHttp<T>(
  { slot, jobs }: BackendCall,
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  parse: (reply: unknown) => T,
): Promise<T> {
  const ctl = new AbortController();
  const job = { abort: () => ctl.abort() };
  jobs.claim(slot, job);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    const text = await r.text();
    if (!r.ok) {
      throw new Error(`${new URL(url).host} answered ${String(r.status)}: ${text.slice(0, 400)}`);
    }
    return parse(JSON.parse(text));
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new SupersededError();
    }
    throw error;
  } finally {
    jobs.release(slot, job);
  }
}

const CLAUDE_OUTPUT = {
  type: "object",
  properties: { is_error: BOOLEAN, result: STRING, structured_output: ANY, modelUsage: ANY, duration_ms: NUMBER },
} as const satisfies Schema;
const GEMINI_OUTPUT = {
  type: "object",
  properties: { response: STRING, error: { type: "object", properties: { message: STRING } } },
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

export const BACKENDS = {
  claude: {
    model: "haiku",
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
    run: call => {
      const dir = mkdtempSync(join(tmpdir(), "prompt-shaper-"));
      const schemaFile = join(dir, "schema.json");
      const outFile = join(dir, "out.json");
      writeFileSync(schemaFile, JSON.stringify(strict(call.schema)));
      const t0 = Date.now();
      return runCli(
        call,
        "codex",
        [
          "exec",
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
        () => ({ data: JSON.parse(readFileSync(outFile, "utf8")) as unknown, ms: Date.now() - t0 }),
        dir,
      ).finally(() => {
        rmSync(dir, { recursive: true, force: true });
      });
    },
  },
  // No schema flag, so the schema goes in the prompt.
  gemini: {
    model: "gemini-2.5-flash",
    run: call => {
      const t0 = Date.now();
      return runCli(
        call,
        "gemini",
        ["-m", call.model, "--output-format", "json", "-p", withSchema(call.system, call.schema)],
        call.input,
        out => {
          const res: unknown = JSON.parse(out);
          check(res, GEMINI_OUTPUT, "gemini output");
          if (res.error) {
            throw new Error(res.error.message ?? "gemini returned an error");
          }
          return { data: parseFenced(res.response ?? ""), ms: Date.now() - t0 };
        },
      );
    },
  },
  // A forced tool call returns input that matches the schema.
  anthropic: {
    model: "claude-haiku-5-5",
    run: call => {
      const t0 = Date.now();
      return runHttp(
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
          return { data: answer.input, model, ms: Date.now() - t0 };
        },
      );
    },
  },
  openai: {
    model: "gpt-5-mini",
    run: call => {
      const t0 = Date.now();
      return runHttp(
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
          return { data: JSON.parse(text) as unknown, model, ms: Date.now() - t0 };
        },
      );
    },
  },
} as const satisfies Record<string, Backend>;
// Object.hasOwn, not `in`: "constructor" is not a backend.
export const isBackend = (name: string): name is BackendName => Object.hasOwn(BACKENDS, name);
