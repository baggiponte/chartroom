#!/usr/bin/env node
// prompt-shaper: serves index.html, blocks until Send, prints the shaped request on stdout.
// Exit codes: 0 sent, 2 cancelled, 3 timeout. Flags and settings: see README.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { homedir, platform, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type Infer, type Schema, check, checkedReply, dropNulls, isRecord, strict, withSchema } from "./schema.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
// null when the flag is there but has no value: what follows it is another flag, or nothing.
const valueOf = (name: string): string | null | undefined => {
  const i = args.indexOf(name);
  if (i < 0) {
    return undefined;
  }
  const v = args[i + 1];
  return v === undefined || v.startsWith("--") ? null : v;
};

const log = (...m: unknown[]): void => {
  console.error("[prompt-shaper]", ...m);
};
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type ExitCode = 0 | 1 | 2 | 3;
const STATUS = { 0: "sent", 1: "error", 2: "cancelled", 3: "timeout" } as const satisfies Record<ExitCode, string>;

const OUT = valueOf("--out") || process.env["PROMPT_SHAPER_OUT"] || "";
function writeOut(code: ExitCode, text: string): void {
  if (!OUT) {
    return;
  }
  try {
    // write then rename, so a poller never reads half a file
    writeFileSync(`${OUT}.tmp`, JSON.stringify({ status: STATUS[code], prompt: text }) + "\n");
    renameSync(`${OUT}.tmp`, OUT);
  } catch (e) {
    log(`could not write ${OUT}: ${errorMessage(e)}`);
  }
}
// Refusing to start still writes --out, so an agent polling it learns at once instead of at its own timeout.
function fail(message: string): never {
  log(message);
  writeOut(1, "");
  process.exit(1);
}
const opt = (name: string, fallback: string | undefined): string | undefined => {
  const v = valueOf(name);
  if (v === null) {
    fail(`${name} needs a value`);
  }
  return v ?? fallback;
};
if (valueOf("--out") === null) {
  fail("--out needs a value");
}

const CONFIG_FILE =
  process.env["PROMPT_SHAPER_CONFIG"] ||
  join(process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "prompt-shaper", "config.json");
const CONFIG = ((): Readonly<Record<string, unknown>> => {
  if (!existsSync(CONFIG_FILE)) {
    return {};
  }
  try {
    const c: unknown = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    if (!isRecord(c)) {
      throw new Error("not a JSON object");
    }
    return c;
  } catch (e) {
    return fail(`${CONFIG_FILE} is not a valid config: ${errorMessage(e)}`);
  }
})();
// Config values are read as text, like flags and env vars: `"port": 8080` and `"port": "8080"` mean the same.
const fromConfig = (key: string): string | undefined => {
  const v = CONFIG[key];
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : undefined;
};
const ENV_NAME = (key: string): string => "PROMPT_SHAPER_" + key.replace(/[A-Z]/g, c => "_" + c).toUpperCase();
// An empty variable counts as unset, so `PROMPT_SHAPER_MODEL=` falls through to the config file like no variable does.
const fromEnv = (key: string): string | undefined => process.env[ENV_NAME(key)] || undefined;
const setting = (key: string, flagName: string, fallback: string): string =>
  opt(flagName, fromEnv(key) ?? fromConfig(key)) || fallback;
const onOff = (key: string, fallback: boolean): boolean => {
  if (flag(`--${key}`)) {
    return true;
  }
  if (flag(`--no-${key}`)) {
    return false;
  }
  const v = fromEnv(key) ?? fromConfig(key);
  if (v === undefined || v === "") {
    return fallback;
  }
  return !["0", "false", "no", "off"].includes(v.toLowerCase());
};

const isCodex = (): boolean => Object.keys(process.env).some(k => k.startsWith("CODEX_"));
const PORT = Number(setting("port", "--port", "0"));
const IMAGES = onOff("images", true);
const AGENT = setting(
  "agent",
  "--agent",
  process.env["CLAUDECODE"]
    ? "Claude Code"
    : process.env["GEMINI_CLI"]
      ? "Gemini CLI"
      : isCodex()
        ? "Codex"
        : "your agent",
);

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin as AsyncIterable<Buffer>) {
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const draft = flag("--stdin") ? (await readStdin()).trim() : (opt("--draft", "") ?? "");

const SYSTEM = `You help someone sharpen a request before an AI assistant works on it. The request might be a decision
("help me choose a coffee machine"), a task ("plan a weekend in Lisbon") or a prompt ("make two posters for our lab").
The user will see their own sentence with dotted underlines on the parts they can flip in one click, so your main
job is to find those parts. Return JSON matching the schema.

0. asks: questions the request itself asks, of the user themselves or of you, e.g. "What do I do with the water
   heating system?", "Should we go by train or car?", "Not sure which colours to use?". Return [] when there is none.
   span = the whole question copied EXACTLY from the request, including its question mark. Offer 3-5 concrete,
   realistic answers as options (for the water heater: repair it / replace it with a heat pump / switch to a gas
   boiler / leave it as is). sentence = a short first-person statement in the request's language that replaces the
   question once answered, with {value} where the answer goes, e.g. "With the water heating system, I'll {value}.",
   "We'll go {value}.". Option text must read naturally in place of {value} ("repair it", "replace it with a heat
   pump", "by train"); for multi, option texts get joined with "and". kind is "single" or "multi", never "slider".
   Set explain true when the options involve trade-offs a newcomer would need explained (costs, how they work).
   Do not return underlines or extras for anything inside a question you returned as an ask.
1. underlines (span = a phrase copied EXACTLY from the request, same case and punctuation, usually 1-3 words).
   Underline every part of the request that could reasonably be different and would change the result:
   the main object ("coffee machine" -> espresso / bean-to-cup / filter / pod), quantities ("two posters"),
   dates and times, places, audiences, vague adjectives ("clean", "short", "cheap"), tone.
   Even a short request usually has 1-3. Aim for 2-6. Spans must occur in the request and must not overlap.
   Underline things, not the request's own verbs ("help", "choose", "make", "want") or filler words.
   For a slider on an inline span, every stop must read naturally in place of the span.
   Option text replaces the span so the sentence still reads naturally (e.g. "espresso machine").
2. extras (no span, a token instead): ALWAYS return 2-4 of these: the most important things the request does not say yet (budget, size, aspect ratio,
   length, deadline...). Each is written into the request straight away as a new sentence with a "[token]"
   placeholder where the answer goes, which the user clicks to answer. Give each a token: a 1-2 word
   name like "Budget" or "Milk", and a sentence: a short first-person sentence with {value} where the answer goes, written in the
   request's language, that does not start with {value} (e.g. "I mostly make {value}.", "My budget is {value}.",
   "I'd like it to froth milk with {value}."). Option text (and slider template/stops) must read naturally in
   place of {value}; for multi, several option texts get joined with "and" (e.g. "lattes and flat whites").

For each choice:
- question: short, shown above the options, e.g. "What kind of machine?", "What's your budget?"
- kind: default to "multi" whenever two or more options could both be true for the same person
  (styles, looks, features, drinks, priorities, places, colours: a machine can be both "classic steel" and
  "compact"). Use "single" ONLY when the options are mutually exclusive by nature (one type of thing to buy,
  a count, yes/no, beans vs pods). "slider" for amounts and continua (budget, size, how often, simple <-> hands-on).
  Before answering, check every "single": if someone could sensibly tick two of its options, make it "multi".
- options (single/multi only, 3-6): {label, emoji, text}. label is a 1-3 word chip, emoji one fitting emoji.
  Concrete, realistic, genuinely different. Most common first.
- current: labels of options the request already says (often empty).
- slider (slider only): numeric uses min/max/step/value plus template with {value} (inline: replaces the span,
  e.g. "{value} posters"; extras: fills the sentence, e.g. "up to €{value}"). For a qualitative continuum give 3-5
  stops ordered from minLabel to maxLabel, min=0, max=stops-1, step=1, template "". value is a sensible default.
- explain: true when a newcomer might not understand the question or how its options differ (jargon, technical
  terms, trade-offs that need context, e.g. "dark Italian vs light single-origin", "steam wand vs automatic
  frother"). false for plain questions like budget or a count.
Also return summary: one short sentence about what you'll figure out together, e.g.
"Let's pin down which coffee machine fits how you drink coffee."
Keep option texts under 10 words. If the request is too short to understand, return no choices and say what's missing.`;

const STRING = { type: "string" } as const;
const STRINGS = { type: "array", items: STRING } as const;
const NUMBER = { type: "number" } as const;
const BOOLEAN = { type: "boolean" } as const;

// What asks, underlines and extras share; each adds the field that says where it goes in the request.
const CHOICE_FIELDS = {
  question: STRING,
  kind: { type: "string", enum: ["single", "multi", "slider"] },
  explain: BOOLEAN,
  options: {
    type: "array",
    items: {
      type: "object",
      required: ["label", "text"],
      properties: { label: STRING, emoji: STRING, text: STRING },
    },
  },
  current: STRINGS,
  slider: {
    type: "object",
    properties: {
      min: NUMBER,
      max: NUMBER,
      step: NUMBER,
      value: NUMBER,
      unit: STRING,
      minLabel: STRING,
      maxLabel: STRING,
      template: STRING,
      stops: STRINGS,
    },
  },
} as const satisfies Record<string, Schema>;

// Separate lists keep Haiku from mixing up "answer this question", "underline this phrase" and "add this missing setting".
const SCHEMA = {
  type: "object",
  required: ["summary", "asks", "underlines", "extras"],
  properties: {
    summary: STRING,
    asks: {
      type: "array",
      items: {
        type: "object",
        required: ["span", "sentence", "question", "kind"],
        properties: { span: STRING, sentence: STRING, ...CHOICE_FIELDS },
      },
    },
    underlines: {
      type: "array",
      items: { type: "object", required: ["span", "question", "kind"], properties: { span: STRING, ...CHOICE_FIELDS } },
    },
    extras: {
      type: "array",
      items: {
        type: "object",
        required: ["token", "sentence", "question", "kind"],
        properties: { token: STRING, sentence: STRING, ...CHOICE_FIELDS },
      },
    },
  },
} as const satisfies Schema;

/** A model reply before it is checked: `model` and `ms` are only there when the backend reports them. */
interface RawReply {
  data: unknown;
  model?: string | undefined;
  ms?: number | undefined;
}
interface Backend {
  /** Used when no --model is given; "" lets the CLI pick its own default. */
  model: string;
  run: (slot: string, system: string, schema: Schema, input: string) => Promise<RawReply>;
}

// A newer request in the same slot aborts the older one; the older caller gets a SupersededError and answers 409.
class SupersededError extends Error {
  constructor() {
    super("superseded");
  }
}
interface Job {
  abort: () => void;
}
const running = new Map<string, Job>();
function claim(slot: string, job: Job): void {
  running.get(slot)?.abort();
  running.set(slot, job);
}
function release(slot: string, job: Job): void {
  if (running.get(slot) === job) {
    running.delete(slot);
  }
}

function runCli<T>(
  slot: string,
  cmd: string,
  argv: string[],
  stdin: string,
  parse: (out: string) => T,
  opts: { cwd?: string } = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, {
      cwd: opts.cwd ?? tmpdir(),
      env: { ...process.env, PROMPT_SHAPER_CHILD: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const job = { abort: () => child.kill("SIGTERM") };
    claim(slot, job);
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
      release(slot, job);
      if (signal) {
        reject(new SupersededError());
        return;
      }
      try {
        resolve(parse(out));
      } catch (e) {
        // A bare JSON.parse failure ("Unexpected token…") says less than the CLI's own output does.
        const why = e instanceof Error && !e.message.startsWith("Unexpected") ? `${e.message} ` : "";
        reject(new Error(`${cmd} exited ${String(code)}: ${why}${(err || out).slice(0, 400)}`));
      }
    });
    child.stdin.end(stdin);
  });
}

async function runHttp<T>(
  slot: string,
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  parse: (reply: unknown) => T,
): Promise<T> {
  const ctl = new AbortController();
  const job = { abort: () => ctl.abort() };
  claim(slot, job);
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
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new SupersededError();
    }
    throw e;
  } finally {
    release(slot, job);
  }
}

const textOf = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const numberOf = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

const BACKENDS = {
  claude: {
    model: "haiku",
    run: (slot, system, schema, input) =>
      runCli(
        slot,
        "claude",
        [
          "-p",
          "--model",
          MODEL,
          "--output-format",
          "json",
          "--tools",
          "",
          "--no-session-persistence",
          "--setting-sources",
          "",
          "--effort",
          EFFORT,
          "--system-prompt",
          system,
          "--json-schema",
          JSON.stringify(schema),
        ],
        input,
        out => {
          const res: unknown = JSON.parse(out);
          if (!isRecord(res)) {
            throw new Error("claude did not answer with a JSON object");
          }
          if (res["is_error"]) {
            throw new Error(textOf(res["result"]) || "claude returned an error");
          }
          const usage = res["modelUsage"];
          return {
            data: res["structured_output"] ?? (JSON.parse(textOf(res["result"]) ?? "") as unknown),
            model: isRecord(usage) ? Object.keys(usage)[0] : undefined,
            ms: numberOf(res["duration_ms"]),
          };
        },
      ),
  },
  codex: {
    model: "",
    run: (slot, system, schema, input) => {
      const dir = mkdtempSync(join(tmpdir(), "prompt-shaper-"));
      const schemaFile = join(dir, "schema.json");
      const outFile = join(dir, "out.json");
      writeFileSync(schemaFile, JSON.stringify(strict(schema)));
      const t0 = Date.now();
      return runCli(
        slot,
        "codex",
        [
          "exec",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "--color",
          "never",
          ...(MODEL ? ["-m", MODEL] : []),
          "-c",
          `model_reasoning_effort="${EFFORT}"`,
          "--output-schema",
          schemaFile,
          "--output-last-message",
          outFile,
          "-",
        ],
        `${system}\n\n${input}`,
        () => ({ data: JSON.parse(readFileSync(outFile, "utf8")) as unknown, ms: Date.now() - t0 }),
        { cwd: dir },
      ).finally(() => {
        rmSync(dir, { recursive: true, force: true });
      });
    },
  },
  // No schema flag, so the schema goes in the prompt.
  gemini: {
    model: "gemini-2.5-flash",
    run: (slot, system, schema, input) => {
      const t0 = Date.now();
      return runCli(
        slot,
        "gemini",
        ["-m", MODEL, "--output-format", "json", "-p", withSchema(system, schema)],
        input,
        out => {
          const res: unknown = JSON.parse(out);
          if (!isRecord(res)) {
            throw new Error("gemini did not answer with a JSON object");
          }
          const error = res["error"];
          if (error) {
            throw new Error((isRecord(error) && textOf(error["message"])) || JSON.stringify(error));
          }
          return { data: checkedReply(textOf(res["response"]) ?? "", schema), ms: Date.now() - t0 };
        },
      );
    },
  },
  // A forced tool call returns input that matches the schema.
  anthropic: {
    model: "claude-haiku-5-5",
    run: (slot, system, schema, input) => {
      const t0 = Date.now();
      return runHttp(
        slot,
        `${(process.env["ANTHROPIC_BASE_URL"] || "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`,
        {
          "x-api-key": process.env["ANTHROPIC_API_KEY"] ?? "",
          "anthropic-version": "2023-06-01",
        },
        {
          model: MODEL,
          max_tokens: 4096,
          system,
          messages: [{ role: "user", content: input }],
          tools: [{ name: "answer", description: "Return the answer.", input_schema: schema }],
          tool_choice: { type: "tool", name: "answer" },
        },
        res => {
          const content = isRecord(res) ? res["content"] : undefined;
          const call: unknown = Array.isArray(content)
            ? content.find((c: unknown) => isRecord(c) && c["type"] === "tool_use")
            : undefined;
          if (!isRecord(call)) {
            throw new Error("no structured answer in reply");
          }
          return { data: call["input"], model: isRecord(res) ? textOf(res["model"]) : undefined, ms: Date.now() - t0 };
        },
      );
    },
  },
  openai: {
    model: "gpt-5-mini",
    run: (slot, system, schema, input) => {
      const t0 = Date.now();
      return runHttp(
        slot,
        `${(process.env["OPENAI_BASE_URL"] || "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`,
        {
          authorization: `Bearer ${process.env["OPENAI_API_KEY"] ?? ""}`,
        },
        {
          model: MODEL,
          messages: [
            { role: "system", content: system },
            { role: "user", content: input },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: "answer", strict: true, schema: strict(schema) },
          },
        },
        res => {
          const choices = isRecord(res) ? res["choices"] : undefined;
          const first: unknown = Array.isArray(choices) ? choices[0] : undefined;
          const message = isRecord(first) ? first["message"] : undefined;
          const text = isRecord(message) ? textOf(message["content"]) : undefined;
          if (!text) {
            throw new Error("empty reply");
          }
          return {
            data: JSON.parse(text) as unknown,
            model: isRecord(res) ? textOf(res["model"]) : undefined,
            ms: Date.now() - t0,
          };
        },
      );
    },
  },
} satisfies Record<string, Backend>;
type BackendName = keyof typeof BACKENDS;
// Object.hasOwn, not `in`: "constructor" is not a backend.
const isBackend = (name: string): name is BackendName => Object.hasOwn(BACKENDS, name);

function onPath(cmd: string): boolean {
  const exts = platform() === "win32" ? ["", ".cmd", ".exe"] : [""];
  return (process.env["PATH"] ?? "").split(delimiter).some(d => d && exts.some(e => existsSync(join(d, cmd + e))));
}

function pickBackend(): BackendName {
  const asked = setting("backend", "--backend", "auto").toLowerCase();
  if (asked !== "auto") {
    if (!isBackend(asked)) {
      fail(`unknown backend "${asked}", use one of: auto, ${Object.keys(BACKENDS).join(", ")}`);
    }
    return asked;
  }
  const env = process.env;
  const host = env["CLAUDECODE"] ? "claude" : env["GEMINI_CLI"] ? "gemini" : isCodex() ? "codex" : null;
  if (host && onPath(host)) {
    return host;
  }
  for (const cli of ["claude", "codex", "gemini"] as const) {
    if (onPath(cli)) {
      return cli;
    }
  }
  if (env["ANTHROPIC_API_KEY"]) {
    return "anthropic";
  }
  if (env["OPENAI_API_KEY"] || env["OPENAI_BASE_URL"]) {
    return "openai";
  }
  return fail("no backend found: install the claude, codex or gemini CLI, or set ANTHROPIC_API_KEY or OPENAI_API_KEY");
}

const BACKEND = pickBackend();
// A config-file model is dropped when the backend comes from a flag or env var, so `--backend gemini`
// doesn't run gemini with "haiku".
const rank = (key: string, flagName: string): number =>
  flag(flagName) ? 0 : fromEnv(key) !== undefined ? 1 : fromConfig(key) !== undefined ? 2 : 3;
const MODEL: string =
  rank("model", "--model") <= rank("backend", "--backend")
    ? setting("model", "--model", BACKENDS[BACKEND].model)
    : BACKENDS[BACKEND].model;
const EFFORT: string = setting("effort", "--effort", "low");

type Reply<S extends Schema> = Infer<S> & { model: string; ms: number | undefined };

/** Every model call goes through here, and every reply is checked against the schema it was asked for. */
async function runModel<S extends Schema>(slot: string, system: string, schema: S, input: string): Promise<Reply<S>> {
  const backend: Backend = BACKENDS[BACKEND];
  const { data, model, ms } = await backend.run(slot, system, schema, input);
  const reply = dropNulls(data);
  check(reply, schema);
  return Object.assign({}, reply, { model: model || MODEL || BACKEND, ms });
}

async function analyze(text: string, settled: string[], answers: string[], asked: string[], more: boolean) {
  let input = `Request:\n<<<\n${text}\n>>>`;
  if (settled.length) {
    input +=
      `\n\nThe user already decided these phrases; do not return underlines for them:\n` +
      settled.map(s => `- "${s}"`).join("\n");
  }
  if (answers.length) {
    input += `\n\nThe user's answers so far:\n` + answers.map(a => `- ${a}`).join("\n");
  }
  if (asked.length) {
    input += `\n\nExtras already shown (do not repeat them):\n` + asked.map(q => `- ${q}`).join("\n");
  }
  if (more) {
    input +=
      `\n\nReturn no underlines and only 2-3 NEW extras that build on the answers so far ` +
      `and would most sharpen the result. No inline choices.`;
  }
  const data = await runModel("analyze", SYSTEM, SCHEMA, input);
  const inText = (c: { span: string }): boolean => Boolean(c.span) && text.toLowerCase().includes(c.span.toLowerCase());
  const asks = data.asks.filter(inText).map(({ sentence, kind, ...a }) =>
    Object.assign(a, {
      type: "ask" as const,
      kind: kind === "slider" ? ("single" as const) : kind,
      statement: sentence,
    }),
  );
  // the page places each span at its first occurrence (exact case first), so that is the one that must not sit in an ask
  const at = (span: string): number => {
    const i = text.indexOf(span);
    return i >= 0 ? i : text.toLowerCase().indexOf(span.toLowerCase());
  };
  const inAsk = (u: { span: string }): boolean =>
    asks.some(a => at(u.span) < at(a.span) + a.span.length && at(u.span) + u.span.length > at(a.span));
  const underlines = data.underlines
    .filter(u => inText(u) && !inAsk(u))
    .map(u => Object.assign(u, { type: "underline" as const }));
  // An extra has no place in the request, so a span the model added anyway is dropped.
  const extras = data.extras.map((e: (typeof data.extras)[number] & { span?: unknown }) => {
    const { span: _span, ...rest } = e;
    return Object.assign(rest, { type: "extra" as const });
  });
  return {
    summary: data.summary,
    choices: more ? extras : [...asks, ...underlines, ...extras],
    model: data.model,
    ms: data.ms,
  };
}

const EXPLAIN_SYSTEM = `Someone is answering a short questionnaire so an assistant can help with their request.
They asked you to explain one question. Write for a smart newcomer: plain words, no jargon (or define it in passing),
friendly and concrete. It appears in a panel with one clickable card per option, so keep each card short.
Return JSON: intro = one or two sentences (max 35 words) on what the question is really about and why it changes the
outcome; options = one entry per option, in the same order, with label copied exactly, what = max 25 words on what
picking it means in practice (taste, cost, effort, trade-offs), and good_for = max 8 words naming who or what it
suits best (e.g. "daily milk drinkers on a budget").
image: ONLY when seeing the option genuinely helps someone tell the options apart (physical products, mechanisms,
visual styles, places, dishes), give a 2-5 word image search query for Wikimedia Commons naming the concrete thing,
e.g. "dual boiler espresso machine", "moka pot", "Art Deco poster". Leave it empty for abstract options
(budgets, counts, priorities, yes/no, timing) or when every option would show the same picture.
For a slider, explain what moving it from one end to the other changes, and return options for the ends or stops.`;

const EXPLAIN_SCHEMA = {
  type: "object",
  required: ["intro", "options"],
  properties: {
    intro: STRING,
    options: {
      type: "array",
      items: {
        type: "object",
        required: ["label", "what"],
        properties: { label: STRING, what: STRING, good_for: STRING, image: STRING },
      },
    },
  },
} as const satisfies Schema;

function explain(text: string, question: string, options: string[]) {
  const input = `Request: ${text}\nQuestion: ${question}\nOptions:\n` + options.map(o => `- ${o}`).join("\n");
  return runModel(`explain:${question}`, EXPLAIN_SYSTEM, EXPLAIN_SCHEMA, input);
}

const DECIDE_SYSTEM = `Someone is stuck choosing between options for one question in a short questionnaire about their request.
Help them decide by asking about THEM, not about the options: their habits, budget, space, skill, time, priorities.
Each question must be one they can answer instantly from their own life (e.g. "How often do you steam milk?",
"How much counter space do you have?") and whose answer clearly favours some options over others.
Never ask them to pick between the options directly, and never ask something the request or their answers already say.
Return JSON:
- questions: NEW questions only, each with question (max 12 words) and 2-4 options (label max 5 words, optional emoji),
  answerable with one tap. With no answers yet return the 3 questions that split the options best. Once they have
  answered, return 0-2 follow-ups, and only if the choice is still genuinely close; otherwise return none.
- recommendation: once at least one answer points somewhere, the option that fits best: label copied exactly from the
  options, and why = one sentence (max 25 words) tying it to their answers in plain words. Omit it with no answers.`;

const DECIDE_SCHEMA = {
  type: "object",
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        required: ["question", "options"],
        properties: {
          question: STRING,
          options: {
            type: "array",
            items: { type: "object", required: ["label"], properties: { label: STRING, emoji: STRING } },
          },
        },
      },
    },
    recommendation: { type: "object", required: ["label", "why"], properties: { label: STRING, why: STRING } },
  },
} as const satisfies Schema;

interface Answer {
  q: string;
  a: string;
}

async function decide(text: string, question: string, options: string[], answers: Answer[], asked: string[]) {
  let input = `Request: ${text}\nQuestion: ${question}\nOptions:\n` + options.map(o => `- ${o}`).join("\n");
  if (answers.length) {
    input += `\n\nTheir answers so far:\n` + answers.map(a => `- ${a.q} ${a.a}`).join("\n");
  }
  if (asked.length) {
    input += `\n\nAlready asked (do not repeat):\n` + asked.map(q => `- ${q}`).join("\n");
  }
  const { recommendation, ...data } = await runModel(`decide:${question}`, DECIDE_SYSTEM, DECIDE_SCHEMA, input);
  const lc = new Set(options.map(o => o.toLowerCase()));
  const seen = new Set(asked.map(q => q.toLowerCase()));
  const questions = data.questions.filter(
    q => q.question && !seen.has(q.question.toLowerCase()) && q.options.length >= 2,
  );
  // A recommendation needs an answer to rest on, and must be one of the options the page can highlight.
  const fits = recommendation && answers.length > 0 && lc.has(recommendation.label.toLowerCase());
  return { ...data, questions, ...(fits ? { recommendation } : {}) };
}

const TIDY_SYSTEM = `Someone wrote a long request for an AI assistant, one sentence after another, and it is hard to scan.
Restructure it WITHOUT changing a single word: you only choose the order of their sentences and group them into blocks.
You get the sentences numbered. Return blocks in reading order:
- First a block with heading "" holding the main goal (what they want), then the context about them and their
  situation (skill level, how often, where, who for).
- Then a block "Must-haves": hard requirements and limits (budget caps, sizes, deadlines, things they clearly need,
  deal-breakers).
- Then a block "Nice to have": preferences that could give way if needed (looks, extras, softer wishes).
- Add another block only when sentences clearly fit none of these (e.g. "Still open" for questions they asked).
  Leave out empty blocks. At most 5 blocks.
- Within a block, put related sentences next to each other (everything about milk together), most important first.
- Headings are 1-3 words in the request's language, without a colon.
- Use every sentence number exactly once. Sentences with a [placeholder] are blanks not filled yet: put them where
  their answer would belong.`;

const TIDY_SCHEMA = {
  type: "object",
  required: ["blocks"],
  properties: {
    blocks: {
      type: "array",
      items: {
        type: "object",
        required: ["heading", "items"],
        properties: { heading: STRING, items: { type: "array", items: { type: "integer" } } },
      },
    },
  },
} as const satisfies Schema;

// Returns 0-based sentence indexes; every sentence lands in exactly one block, so nothing the user wrote is lost.
async function tidy(sentences: string[]) {
  const input = "Sentences:\n" + sentences.map((s, i) => `${String(i + 1)}. ${s}`).join("\n");
  const data = await runModel("tidy", TIDY_SYSTEM, TIDY_SCHEMA, input);
  const used = new Set<number>();
  const blocks: { heading: string; items: number[] }[] = [];
  for (const b of data.blocks) {
    const items = [];
    for (const n of b.items) {
      const i = n - 1;
      if (i >= 0 && i < sentences.length && !used.has(i)) {
        used.add(i);
        items.push(i);
      }
    }
    if (items.length) {
      blocks.push({ heading: b.heading.trim().replace(/[:：]\s*$/, ""), items });
    }
  }
  const missing = sentences.map((_, i) => i).filter(i => !used.has(i));
  const first = blocks[0];
  if (missing.length && first) {
    first.items.push(...missing);
  } else if (missing.length) {
    blocks.push({ heading: "", items: missing });
  }
  return { blocks, model: data.model, ms: data.ms };
}

// Read once, so a running server never serves a page newer than its own code. The page carries a hash of the
// file it was cut from and /api/init returns this process's, so a page that outlived its server can tell.
const PAGE_SRC = readFileSync(join(HERE, "index.html"), "utf8");
const BUILD = createHash("sha256").update(PAGE_SRC).digest("hex").slice(0, 12);
const PAGE = PAGE_SRC.replace('"%BUILD%"', JSON.stringify(BUILD));

// Every field is optional, with its default where the handler reads it; a field that is there must have this shape.
const BODY = {
  analyze: {
    type: "object",
    properties: { text: STRING, settled: STRINGS, answers: STRINGS, asked: STRINGS, more: BOOLEAN },
  },
  explain: { type: "object", properties: { text: STRING, question: STRING, options: STRINGS } },
  decide: {
    type: "object",
    properties: {
      text: STRING,
      question: STRING,
      options: STRINGS,
      answers: { type: "array", items: { type: "object", required: ["q", "a"], properties: { q: STRING, a: STRING } } },
      asked: STRINGS,
    },
  },
  tidy: { type: "object", properties: { sentences: STRINGS } },
  submit: { type: "object", properties: { prompt: STRING } },
} as const satisfies Record<string, Schema>;

// Rejects a body that is not JSON or not shaped like `schema`, which the request handler answers with a 400.
function body<S extends Schema>(req: IncomingMessage, schema: S): Promise<Infer<S>> {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (d: Buffer) => {
      b += d.toString();
    });
    req.on("end", () => {
      try {
        const data: unknown = b ? JSON.parse(b) : {};
        check(data, schema, "body");
        resolve(data);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
}

function send(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

const printed = (text: string): string => (text ? (text.endsWith("\n") ? text : text + "\n") : "");
let finished = false;
function finish(code: ExitCode, text: string): void {
  if (finished) {
    return;
  }
  finished = true;
  for (const job of running.values()) {
    job.abort();
  }
  if (text) {
    process.stdout.write(printed(text));
  }
  writeOut(code, text);
  setTimeout(() => process.exit(code), 150);
}

/** Answers a model-backed route: 409 when a newer request in the same slot took over, 500 for any other failure. */
async function answer<T>(res: ServerResponse, work: () => Promise<T>, done: (data: T) => string): Promise<void> {
  try {
    const data = await work();
    log(done(data));
    send(res, 200, data);
  } catch (e) {
    if (e instanceof SupersededError) {
      send(res, 409, { error: e.message });
      return;
    }
    log(errorMessage(e));
    send(res, 500, { error: errorMessage(e) });
  }
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://x");
  const at = `${req.method ?? ""} ${url.pathname}`;
  switch (at) {
    case "GET /":
    case "GET /index.html":
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(PAGE);
      return;
    case "GET /api/init":
      send(res, 200, { draft, model: MODEL || BACKEND, backend: BACKEND, agent: AGENT, images: IMAGES, build: BUILD });
      return;
    case "POST /api/analyze": {
      const { text = "", settled = [], answers = [], asked = [], more = false } = await body(req, BODY.analyze);
      if (text.trim().split(/\s+/).length < 2) {
        send(res, 200, { summary: "", choices: [] });
        return;
      }
      const t0 = Date.now();
      await answer(
        res,
        () => analyze(text, settled, answers, asked, more),
        data =>
          `analysed ${String(text.length)} chars in ${String(Date.now() - t0)} ms, ${String(data.choices.length)} choices`,
      );
      return;
    }
    case "POST /api/explain": {
      const { text = "", question = "", options = [] } = await body(req, BODY.explain);
      await answer(
        res,
        () => explain(text, question, options),
        data => `explained "${question}" in ${String(data.ms)} ms`,
      );
      return;
    }
    case "POST /api/decide": {
      const { text = "", question = "", options = [], answers = [], asked = [] } = await body(req, BODY.decide);
      await answer(
        res,
        () => decide(text, question, options, answers, asked),
        data =>
          `helped decide "${question}" in ${String(data.ms)} ms${data.recommendation ? `: ${data.recommendation.label}` : ""}`,
      );
      return;
    }
    case "POST /api/tidy": {
      const { sentences = [] } = await body(req, BODY.tidy);
      await answer(
        res,
        () => tidy(sentences),
        data =>
          `tidied ${String(sentences.length)} sentences into ${String(data.blocks.length)} blocks in ${String(data.ms)} ms`,
      );
      return;
    }
    case "POST /api/submit": {
      const { prompt = "" } = await body(req, BODY.submit);
      send(res, 200, { ok: true, sent: printed(prompt) });
      finish(0, prompt);
      return;
    }
    case "POST /api/cancel":
      send(res, 200, { ok: true });
      finish(2, "");
      return;
    default:
      send(res, 404, { error: "not found" });
  }
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e: unknown) => {
    send(res, 400, { error: errorMessage(e) });
  });
});

const TIMEOUT_SETTING = setting("timeoutMin", "--timeout-min", "30");
const TIMEOUT_MIN = Number(TIMEOUT_SETTING);
if (!Number.isFinite(TIMEOUT_MIN)) {
  fail(`--timeout-min should be a number of minutes, got "${TIMEOUT_SETTING}"`);
}
if (TIMEOUT_MIN > 0) {
  setTimeout(() => {
    log(`no answer after ${String(TIMEOUT_MIN)} min, giving up`);
    finish(3, "");
  }, TIMEOUT_MIN * 60000).unref();
}

server.listen(PORT, "127.0.0.1", () => {
  const address = server.address();
  const url = `http://127.0.0.1:${String(typeof address === "object" && address ? address.port : PORT)}/`;
  log(`open ${url}  (waiting for Send; Ctrl+C to abort)`);
  log(
    `backend: ${BACKEND}${MODEL ? ` (${MODEL})` : ""}${IMAGES ? "" : ", no pictures"}${Object.keys(CONFIG).length ? `, defaults from ${CONFIG_FILE}` : ""}`,
  );
  if (!onOff("open", true)) {
    return;
  }
  const cmd =
    setting("browser", "--browser", "") ||
    (platform() === "darwin" ? "open" : platform() === "win32" ? "explorer" : "xdg-open");
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true })
      .on("error", () => {})
      .unref();
  } catch {
    // no browser to open: the URL is in the log above
  }
});
