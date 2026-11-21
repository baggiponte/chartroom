#!/usr/bin/env node
// prompt-shaper: serves index.html, blocks until Send, prints the shaped request on stdout.
// Exit codes: 0 sent, 2 cancelled, 3 timeout. Flags and settings: see README.

import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, platform, homedir } from "node:os";
import { dirname, join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const log = (...m) => console.error("[prompt-shaper]", ...m);

const CONFIG_FILE = process.env.PROMPT_SHAPER_CONFIG ||
  join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "prompt-shaper", "config.json");
const CONFIG = (() => {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    const c = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error("not a JSON object");
    return c;
  } catch (e) { log(`ignoring ${CONFIG_FILE}: ${e.message}`); return {}; }
})();
const ENV_NAME = (key) => "PROMPT_SHAPER_" + key.replace(/[A-Z]/g, (c) => "_" + c).toUpperCase();
const setting = (key, flagName, fallback) => {
  const v = opt(flagName, process.env[ENV_NAME(key)] ?? CONFIG[key]);
  return v === undefined || v === "" ? fallback : v;
};
const onOff = (key, fallback) => {
  if (flag(`--${key}`)) return true;
  if (flag(`--no-${key}`)) return false;
  const v = process.env[ENV_NAME(key)] ?? CONFIG[key];
  if (v === undefined || v === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(v).toLowerCase());
};

const PORT = Number(setting("port", "--port", 0));
const IMAGES = onOff("images", true);
const AGENT = setting("agent", "--agent", process.env.CLAUDECODE ? "Claude Code"
  : process.env.GEMINI_CLI ? "Gemini CLI" : Object.keys(process.env).some((k) => k.startsWith("CODEX_")) ? "Codex" : "your agent");

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

const draft = flag("--stdin") ? (await readStdin()).trim() : opt("--draft", "");

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

const CHOICE = (what) => ({
  type: "object",
  required: { extra: ["token", "sentence", "question", "kind"], ask: ["span", "sentence", "question", "kind"] }[what]
    || ["span", "question", "kind"],
  properties: {
    ...(what === "extra" ? { token: { type: "string" }, sentence: { type: "string" } }
      : what === "ask" ? { span: { type: "string" }, sentence: { type: "string" } } : { span: { type: "string" } }),
    question: { type: "string" },
    kind: { type: "string", enum: ["single", "multi", "slider"] },
    explain: { type: "boolean" },
    options: {
      type: "array",
      items: {
        type: "object",
        required: ["label", "text"],
        properties: { label: { type: "string" }, emoji: { type: "string" }, text: { type: "string" } },
      },
    },
    current: { type: "array", items: { type: "string" } },
    slider: {
      type: "object",
      properties: {
        min: { type: "number" }, max: { type: "number" }, step: { type: "number" }, value: { type: "number" },
        unit: { type: "string" }, minLabel: { type: "string" }, maxLabel: { type: "string" },
        template: { type: "string" }, stops: { type: "array", items: { type: "string" } },
      },
    },
  },
});

// Separate lists keep Haiku from mixing up "answer this question", "underline this phrase" and "add this missing setting".
const SCHEMA = {
  type: "object",
  required: ["summary", "asks", "underlines", "extras"],
  properties: {
    summary: { type: "string" },
    asks: { type: "array", items: CHOICE("ask") },
    underlines: { type: "array", items: CHOICE("underline") },
    extras: { type: "array", items: CHOICE("extra") },
  },
};

const running = {}; // one live process or request per slot; a newer request in the same slot aborts the older one
const superseded = () => Object.assign(new Error("superseded"), { superseded: true });

function runCli(slot, cmd, argv, stdin, parse, opts = {}) {
  running[slot]?.abort();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, {
      cwd: opts.cwd || tmpdir(), env: { ...process.env, PROMPT_SHAPER_CHILD: "1" }, stdio: ["pipe", "pipe", "pipe"],
    });
    const job = { abort: () => child.kill("SIGTERM") };
    running[slot] = job;
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => reject(new Error(`could not start ${cmd}: ${e.message}`)));
    child.on("close", (code, signal) => {
      if (running[slot] === job) delete running[slot];
      if (signal) return reject(superseded());
      try { resolve(parse(out, code)); }
      catch (e) { reject(new Error(`${cmd} exited ${code}: ${(e.message && !e.message.startsWith("Unexpected") ? e.message + " " : "") + (err || out).slice(0, 400)}`)); }
    });
    child.stdin.end(stdin);
  });
}

async function runHttp(slot, url, headers, payload, parse) {
  running[slot]?.abort();
  const ctl = new AbortController();
  const job = { abort: () => ctl.abort() };
  running[slot] = job;
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(payload), signal: ctl.signal });
    const text = await r.text();
    if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}: ${text.slice(0, 400)}`);
    return parse(JSON.parse(text));
  } catch (e) {
    if (e.name === "AbortError") throw superseded();
    throw e;
  } finally {
    if (running[slot] === job) delete running[slot];
  }
}

// OpenAI-style strict schemas want every property required and no extra keys. Optional fields become nullable,
// and dropNulls() removes them again so the page sees the same shape as from the other backends.
function strict(schema) {
  if (schema.type === "array") return { ...schema, items: strict(schema.items) };
  if (schema.type !== "object") return schema;
  const req = new Set(schema.required || []);
  const properties = {};
  for (const [k, v] of Object.entries(schema.properties || {})) {
    const sv = strict(v);
    properties[k] = req.has(k) ? sv : { anyOf: [sv, { type: "null" }] };
  }
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}
const dropNulls = (v) => Array.isArray(v) ? v.map(dropNulls)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, dropNulls(x)]))
  : v;

// Covers only the keywords the schemas in this file use (type, enum, required, properties, items).
function check(v, schema, at = "reply") {
  const t = schema.type;
  const ok = t === "object" ? v !== null && typeof v === "object" && !Array.isArray(v)
    : t === "array" ? Array.isArray(v) : t === "integer" ? Number.isInteger(v)
    : t === "number" ? Number.isFinite(v) : typeof v === t;
  if (!ok) throw new Error(`${at} should be ${t}, got ${v === null ? "null" : Array.isArray(v) ? "array" : typeof v}`);
  if (schema.enum && !schema.enum.includes(v)) throw new Error(`${at} should be one of ${schema.enum.join(", ")}, got ${JSON.stringify(v)}`);
  if (t === "array") v.forEach((x, i) => check(x, schema.items, `${at}[${i}]`));
  if (t === "object") {
    for (const k of schema.required || []) if (!(k in v)) throw new Error(`${at}.${k} is missing`);
    for (const [k, s] of Object.entries(schema.properties || {})) if (k in v) check(v[k], s, `${at}.${k}`);
  }
}
// For backends that only see the schema in the prompt: the model may still wrap its JSON in a code fence.
function checkedReply(text, schema) {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/i);
  let data;
  try { data = JSON.parse(fenced ? fenced[1] : text); } catch { throw new Error("reply is not JSON"); }
  data = dropNulls(data);
  check(data, schema);
  return data;
}
const withSchema = (system, schema) =>
  `${system}\n\nReply with one JSON object only, no prose and no code fences, matching this JSON Schema:\n${JSON.stringify(schema)}`;

const BACKENDS = {
  claude: {
    model: "haiku",
    run: (slot, system, schema, input) => runCli(slot, "claude", [
      "-p", "--model", MODEL, "--output-format", "json", "--tools", "",
      "--no-session-persistence", "--setting-sources", "", "--effort", EFFORT,
      "--system-prompt", system, "--json-schema", JSON.stringify(schema),
    ], input, (out) => {
      const res = JSON.parse(out);
      if (res.is_error) throw new Error(res.result || "claude returned an error");
      return { data: res.structured_output ?? JSON.parse(res.result), model: Object.keys(res.modelUsage || {})[0], ms: res.duration_ms };
    }),
  },
  codex: {
    model: "",
    run: (slot, system, schema, input) => {
      const dir = mkdtempSync(join(tmpdir(), "prompt-shaper-"));
      const schemaFile = join(dir, "schema.json"), outFile = join(dir, "out.json");
      writeFileSync(schemaFile, JSON.stringify(strict(schema)));
      const t0 = Date.now();
      return runCli(slot, "codex", [
        "exec", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never",
        ...(MODEL ? ["-m", MODEL] : []), "-c", `model_reasoning_effort="${EFFORT}"`,
        "--output-schema", schemaFile, "--output-last-message", outFile, "-",
      ], `${system}\n\n${input}`, () => {
        const data = dropNulls(JSON.parse(readFileSync(outFile, "utf8")));
        return { data, ms: Date.now() - t0 };
      }, { cwd: dir }).finally(() => rmSync(dir, { recursive: true, force: true }));
    },
  },
  // No schema flag, so the schema goes in the prompt.
  gemini: {
    model: "gemini-2.5-flash",
    run: (slot, system, schema, input) => {
      const t0 = Date.now();
      return runCli(slot, "gemini", ["-m", MODEL, "--output-format", "json", "-p", withSchema(system, schema)], input, (out) => {
        const res = JSON.parse(out);
        if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
        return { data: checkedReply(res.response ?? "", schema), ms: Date.now() - t0 };
      });
    },
  },
  // A forced tool call returns input that matches the schema.
  anthropic: {
    model: "claude-haiku-5-5",
    run: (slot, system, schema, input) => {
      const t0 = Date.now();
      return runHttp(slot, `${(process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`, {
        "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01",
      }, {
        model: MODEL, max_tokens: 4096, system,
        messages: [{ role: "user", content: input }],
        tools: [{ name: "answer", description: "Return the answer.", input_schema: schema }],
        tool_choice: { type: "tool", name: "answer" },
      }, (res) => {
        const call = (res.content || []).find((c) => c.type === "tool_use");
        if (!call) throw new Error("no structured answer in reply");
        const data = dropNulls(call.input);
        check(data, schema);
        return { data, model: res.model, ms: Date.now() - t0 };
      });
    },
  },
  openai: {
    model: "gpt-5-mini",
    run: (slot, system, schema, input) => {
      const t0 = Date.now();
      return runHttp(slot, `${(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`, {
        authorization: `Bearer ${process.env.OPENAI_API_KEY || ""}`,
      }, {
        model: MODEL,
        messages: [{ role: "system", content: system }, { role: "user", content: input }],
        response_format: { type: "json_schema", json_schema: { name: "answer", strict: true, schema: strict(schema) } },
      }, (res) => {
        const text = res.choices?.[0]?.message?.content;
        if (!text) throw new Error("empty reply");
        return { data: dropNulls(JSON.parse(text)), model: res.model, ms: Date.now() - t0 };
      });
    },
  },
};

function onPath(cmd) {
  const exts = platform() === "win32" ? ["", ".cmd", ".exe"] : [""];
  return (process.env.PATH || "").split(delimiter).some((d) => d && exts.some((e) => existsSync(join(d, cmd + e))));
}

function pickBackend() {
  const asked = String(setting("backend", "--backend", "auto")).toLowerCase();
  if (asked !== "auto") {
    if (!BACKENDS[asked]) { log(`unknown backend "${asked}", use one of: auto, ${Object.keys(BACKENDS).join(", ")}`); process.exit(1); }
    return asked;
  }
  const env = process.env;
  const host = env.CLAUDECODE ? "claude" : env.GEMINI_CLI ? "gemini"
    : Object.keys(env).some((k) => k.startsWith("CODEX_")) ? "codex" : null;
  if (host && onPath(host)) return host;
  for (const cli of ["claude", "codex", "gemini"]) if (onPath(cli)) return cli;
  if (env.ANTHROPIC_API_KEY) return "anthropic";
  if (env.OPENAI_API_KEY || env.OPENAI_BASE_URL) return "openai";
  log("no backend found: install the claude, codex or gemini CLI, or set ANTHROPIC_API_KEY or OPENAI_API_KEY");
  process.exit(1);
}

const BACKEND = pickBackend();
// A config-file model is dropped when the backend comes from a flag or env var, so `--backend gemini`
// doesn't run gemini with "haiku".
const rank = (key, flagName) => flag(flagName) ? 0 : process.env[ENV_NAME(key)] ? 1 : CONFIG[key] !== undefined ? 2 : 3;
const MODEL = rank("model", "--model") <= rank("backend", "--backend") ? setting("model", "--model", BACKENDS[BACKEND].model)
  : BACKENDS[BACKEND].model;
const EFFORT = setting("effort", "--effort", "low");

async function runModel(slot, system, schema, input) {
  const { data, model, ms } = await BACKENDS[BACKEND].run(slot, system, schema, input);
  return { ...dropNulls(data), model: model || MODEL || BACKEND, ms };
}

async function analyze(text, settled = [], answers = [], asked = [], more = false) {
  let input = `Request:\n<<<\n${text}\n>>>`;
  if (settled.length) {
    input += `\n\nThe user already decided these phrases; do not return underlines for them:\n` +
      settled.map((s) => `- "${s}"`).join("\n");
  }
  if (answers.length) input += `\n\nThe user's answers so far:\n` + answers.map((a) => `- ${a}`).join("\n");
  if (asked.length) input += `\n\nExtras already shown (do not repeat them):\n` + asked.map((q) => `- ${q}`).join("\n");
  if (more) input += `\n\nReturn no underlines and only 2-3 NEW extras that build on the answers so far ` +
    `and would most sharpen the result. No inline choices.`;
  const data = await runModel("analyze", SYSTEM, SCHEMA, input);
  const inText = (c) => c.span && text.toLowerCase().includes(c.span.toLowerCase());
  const asks = (data.asks || []).filter(inText).map(({ sentence, ...a }) =>
    ({ ...a, type: "ask", kind: a.kind === "slider" ? "single" : a.kind, statement: sentence }));
  // the page places each span at its first occurrence (exact case first), so that is the one that must not sit in an ask
  const at = (span) => { const i = text.indexOf(span); return i >= 0 ? i : text.toLowerCase().indexOf(span.toLowerCase()); };
  const inAsk = (u) => asks.some((a) => at(u.span) < at(a.span) + a.span.length && at(u.span) + u.span.length > at(a.span));
  const underlines = (data.underlines || []).filter((u) => inText(u) && !inAsk(u)).map((u) => ({ ...u, type: "underline" }));
  const extras = (data.extras || []).map(({ span, ...e }) => ({ ...e, type: "extra" }));
  return { summary: data.summary, choices: more ? extras : [...asks, ...underlines, ...extras], model: data.model, ms: data.ms };
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
    intro: { type: "string" },
    options: {
      type: "array",
      items: {
        type: "object",
        required: ["label", "what"],
        properties: {
          label: { type: "string" }, what: { type: "string" },
          good_for: { type: "string" }, image: { type: "string" },
        },
      },
    },
  },
};

function explain(text, question, options) {
  const input = `Request: ${text}\nQuestion: ${question}\nOptions:\n` + options.map((o) => `- ${o}`).join("\n");
  return runModel("explain:" + question, EXPLAIN_SYSTEM, EXPLAIN_SCHEMA, input);
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
          question: { type: "string" },
          options: { type: "array", items: { type: "object", required: ["label"], properties: { label: { type: "string" }, emoji: { type: "string" } } } },
        },
      },
    },
    recommendation: { type: "object", required: ["label", "why"], properties: { label: { type: "string" }, why: { type: "string" } } },
  },
};

async function decide(text, question, options, answers = [], asked = []) {
  let input = `Request: ${text}\nQuestion: ${question}\nOptions:\n` + options.map((o) => `- ${o}`).join("\n");
  if (answers.length) input += `\n\nTheir answers so far:\n` + answers.map((a) => `- ${a.q} ${a.a}`).join("\n");
  if (asked.length) input += `\n\nAlready asked (do not repeat):\n` + asked.map((q) => `- ${q}`).join("\n");
  const data = await runModel("decide:" + question, DECIDE_SYSTEM, DECIDE_SCHEMA, input);
  const lc = new Set(options.map((o) => o.toLowerCase()));
  if (data.recommendation && !lc.has(String(data.recommendation.label).toLowerCase())) delete data.recommendation;
  if (!answers.length) delete data.recommendation;
  const seen = new Set(asked.map((q) => q.toLowerCase()));
  data.questions = (data.questions || []).filter((q) => q.question && !seen.has(q.question.toLowerCase()) && (q.options || []).length >= 2);
  return data;
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
        properties: { heading: { type: "string" }, items: { type: "array", items: { type: "integer" } } },
      },
    },
  },
};

// Returns 0-based sentence indexes; every sentence lands in exactly one block, so nothing the user wrote is lost.
async function tidy(sentences) {
  const input = "Sentences:\n" + sentences.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const data = await runModel("tidy", TIDY_SYSTEM, TIDY_SCHEMA, input);
  const used = new Set(), blocks = [];
  for (const b of data.blocks || []) {
    const items = [];
    for (const n of b.items || []) {
      const i = Math.round(Number(n)) - 1;
      if (i >= 0 && i < sentences.length && !used.has(i)) { used.add(i); items.push(i); }
    }
    if (items.length) blocks.push({ heading: String(b.heading || "").trim().replace(/[:：]\s*$/, ""), items });
  }
  const missing = sentences.map((_, i) => i).filter((i) => !used.has(i));
  if (missing.length) blocks.length ? blocks[0].items.push(...missing) : blocks.push({ heading: "", items: missing });
  return { blocks, model: data.model, ms: data.ms };
}

// Read once, so a running server never serves a page newer than its own code.
const PAGE = readFileSync(join(HERE, "index.html"));

function body(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  });
}

function send(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

const OUT = opt("--out", process.env.PROMPT_SHAPER_OUT || "");
const STATUS = { 0: "sent", 2: "cancelled", 3: "timeout" };

const printed = (text) => text ? (text.endsWith("\n") ? text : text + "\n") : "";
function finish(code, text) {
  for (const j of Object.values(running)) j.abort();
  if (text) process.stdout.write(printed(text));
  if (OUT) {
    try { // write then rename, so a poller never reads half a file
      writeFileSync(OUT + ".tmp", JSON.stringify({ status: STATUS[code] || "error", prompt: text || "" }) + "\n");
      renameSync(OUT + ".tmp", OUT);
    } catch (e) { log(`could not write ${OUT}: ${e.message}`); }
  }
  setTimeout(() => process.exit(code), 150);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(PAGE);
    }
    if (req.method === "GET" && url.pathname === "/api/init") return send(res, 200, { draft, model: MODEL || BACKEND, backend: BACKEND, agent: AGENT, images: IMAGES });
    if (req.method === "POST" && url.pathname === "/api/analyze") {
      const { text = "", settled = [], answers = [], asked = [], more = false } = await body(req);
      if (text.trim().split(/\s+/).length < 2) return send(res, 200, { summary: "", choices: [] });
      try {
        const t0 = Date.now();
        const data = await analyze(text, settled, answers, asked, more);
        log(`analysed ${text.length} chars in ${Date.now() - t0} ms, ${data.choices?.length ?? 0} choices`);
        return send(res, 200, data);
      } catch (e) {
        if (e.superseded) return send(res, 409, { error: "superseded" });
        log(e.message);
        return send(res, 500, { error: e.message });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/explain") {
      const { text = "", question = "", options = [] } = await body(req);
      try {
        const data = await explain(text, question, options);
        log(`explained "${question}" in ${data.ms} ms`);
        return send(res, 200, data);
      } catch (e) {
        log(e.message);
        return send(res, e.superseded ? 409 : 500, { error: e.message });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/decide") {
      const { text = "", question = "", options = [], answers = [], asked = [] } = await body(req);
      try {
        const data = await decide(text, question, options, answers, asked);
        log(`helped decide "${question}" in ${data.ms} ms${data.recommendation ? `: ${data.recommendation.label}` : ""}`);
        return send(res, 200, data);
      } catch (e) {
        if (!e.superseded) log(e.message);
        return send(res, e.superseded ? 409 : 500, { error: e.message });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/tidy") {
      const { sentences = [] } = await body(req);
      try {
        const data = await tidy(sentences.map(String));
        log(`tidied ${sentences.length} sentences into ${data.blocks.length} blocks in ${data.ms} ms`);
        return send(res, 200, data);
      } catch (e) {
        if (!e.superseded) log(e.message);
        return send(res, e.superseded ? 409 : 500, { error: e.message });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/submit") {
      const { prompt = "" } = await body(req);
      send(res, 200, { ok: true, sent: printed(prompt) });
      return finish(0, prompt);
    }
    if (req.method === "POST" && url.pathname === "/api/cancel") {
      send(res, 200, { ok: true });
      return finish(2, "");
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 400, { error: String(e.message || e) });
  }
});

const TIMEOUT_MIN = Number(setting("timeoutMin", "--timeout-min", 30));
if (TIMEOUT_MIN > 0) setTimeout(() => { log(`no answer after ${TIMEOUT_MIN} min, giving up`); finish(3, ""); }, TIMEOUT_MIN * 60000).unref();

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${server.address().port}/`;
  log(`open ${url}  (waiting for Send; Ctrl+C to abort)`);
  log(`backend: ${BACKEND}${MODEL ? ` (${MODEL})` : ""}${IMAGES ? "" : ", no pictures"}${Object.keys(CONFIG).length ? `, defaults from ${CONFIG_FILE}` : ""}`);
  if (!onOff("open", true)) return;
  const cmd = setting("browser", "--browser", "") ||
    (platform() === "darwin" ? "open" : platform() === "win32" ? "explorer" : "xdg-open");
  try { spawn(cmd, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch {}
});
