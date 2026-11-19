#!/usr/bin/env node
// prompt-shaper: a local bridge between a browser prompt box and any coding agent.
//
//   node server.mjs [--draft "text" | --stdin] [--backend auto|claude|codex|gemini|anthropic|openai]
//                   [--model M] [--port N] [--out FILE] [--no-open] [--no-images]
//
// Serves index.html, runs the analysis through a pluggable backend (the claude, codex or gemini CLI with your
// existing login, or an Anthropic / OpenAI-compatible API key), and blocks until you press Send in the browser.
// The shaped prompt is printed to stdout, which is what the agent picks up and carries on with.
// Exit codes: 0 = sent, 2 = cancelled in the browser, 3 = nobody answered in time.
// --out FILE also writes {"status":"sent"|"cancelled"|"timeout","prompt":"..."} to FILE, for agents whose shell
// tool can't wait minutes for a command: run it in the background and poll for the file.

import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { dirname, join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const PORT = Number(opt("--port", process.env.PROMPT_SHAPER_PORT || 0));
// Explanation cards can show pictures, looked up by the browser on Wikimedia Commons (keyless). Set
// PROMPT_SHAPER_IMAGES=0 or pass --no-images to turn that off.
// Shown on the page ("Send to Codex"). The skill passes --agent; otherwise guess from the environment.
const AGENT = opt("--agent", process.env.PROMPT_SHAPER_AGENT || (process.env.CLAUDECODE ? "Claude Code"
  : process.env.GEMINI_CLI ? "Gemini CLI" : Object.keys(process.env).some((k) => k.startsWith("CODEX_")) ? "Codex" : "your agent"));
const IMAGES = !flag("--no-images") && process.env.PROMPT_SHAPER_IMAGES !== "0";
const log = (...m) => console.error("[prompt-shaper]", ...m);

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

const draft = flag("--stdin") ? (await readStdin()).trim() : opt("--draft", "");

// ---------------------------------------------------------------- analysis
const SYSTEM = `You help someone sharpen a request before an AI assistant works on it. The request might be a decision
("help me choose a coffee machine"), a task ("plan a weekend in Lisbon") or a prompt ("make two posters for our lab").
The user will see their own sentence with dotted underlines on the parts they can flip in one click, so your main
job is to find those parts. Return JSON matching the schema.

1. underlines (span = a phrase copied EXACTLY from the request, same case and punctuation, usually 1-3 words).
   Underline every part of the request that could reasonably be different and would change the result:
   the main object ("coffee machine" -> espresso / bean-to-cup / filter / pod), quantities ("two posters"),
   dates and times, places, audiences, vague adjectives ("clean", "short", "cheap"), tone.
   Even a short request usually has 1-3. Aim for 2-6. Spans must occur in the request and must not overlap.
   Underline things, not the request's own verbs ("help", "choose", "make", "want") or filler words.
   For a slider on an inline span, every stop must read naturally in place of the span.
   Option text replaces the span so the sentence still reads naturally (e.g. "espresso machine").
2. extras (no span, a token instead): ALWAYS return 2-4 of these: the most important things the request does not say yet (budget, size, aspect ratio,
   length, deadline...). They appear as a numbered list of questions with radio buttons or checkboxes, and once
   answered as small tokens under the sentence. Give each a token: a 1-2 word name like "Budget" or "Milk".
   Option text is a short phrase that completes "<token>: ...", e.g. "up to €500". Give extras' options a hint:
   a 3-8 word clause that turns the label into a full answer, shown as "<label> – <hint>"
   (label "Very important", hint "ready in a few minutes"; label "Steam wand", hint "you froth the milk yourself").

For each choice:
- question: short, shown above the options, e.g. "What kind of machine?", "What's your budget?"
- kind: default to "multi" whenever two or more options could both be true for the same person
  (styles, looks, features, drinks, priorities, places, colours: a machine can be both "classic steel" and
  "compact"). Use "single" ONLY when the options are mutually exclusive by nature (one type of thing to buy,
  a count, yes/no, beans vs pods). "slider" for amounts and continua (budget, size, how often, simple <-> hands-on).
  Before answering, check every "single": if someone could sensibly tick two of its options, make it "multi".
- options (single/multi only, 3-6): {label, emoji, text, hint (extras only)}. label is a 1-3 word chip, emoji one fitting emoji.
  Concrete, realistic, genuinely different. Most common first.
- current: labels of options the request already says (often empty).
- slider (slider only): numeric uses min/max/step/value plus template with {value} (inline: replaces the span,
  e.g. "{value} posters"; extras: completes the token, e.g. "up to €{value}"). For a qualitative continuum give 3-5
  stops ordered from minLabel to maxLabel, min=0, max=stops-1, step=1, template "". value is a sensible default.
- explain: true when a newcomer might not understand the question or how its options differ (jargon, technical
  terms, trade-offs that need context, e.g. "dark Italian vs light single-origin", "steam wand vs automatic
  frother"). false for plain questions like budget or a count.
Also return summary: one short sentence about what you'll figure out together, e.g.
"Let's pin down which coffee machine fits how you drink coffee."
Keep option texts under 10 words. If the request is too short to understand, return no choices and say what's missing.`;

const CHOICE = (extra) => ({
  type: "object",
  required: extra ? ["token", "question", "kind"] : ["span", "question", "kind"],
  properties: {
    ...(extra ? { token: { type: "string" } } : { span: { type: "string" } }),
    question: { type: "string" },
    kind: { type: "string", enum: ["single", "multi", "slider"] },
    explain: { type: "boolean" },
    options: {
      type: "array",
      items: {
        type: "object",
        required: ["label", "text"],
        properties: { label: { type: "string" }, emoji: { type: "string" }, text: { type: "string" }, hint: { type: "string" } },
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

// Two separate lists keep Haiku from mixing up "underline this phrase" and "add this missing setting".
const SCHEMA = {
  type: "object",
  required: ["summary", "underlines", "extras"],
  properties: {
    summary: { type: "string" },
    underlines: { type: "array", items: CHOICE(false) },
    extras: { type: "array", items: CHOICE(true) },
  },
};

const running = {}; // one live process or request per slot; a newer request in the same slot aborts the older one
const superseded = () => Object.assign(new Error("superseded"), { superseded: true });

// Every backend gets the same (system, schema, input) and must resolve to the parsed JSON object.
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

// For backends without schema enforcement: take the outermost {...} out of the reply.
function jsonFrom(text) {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("no JSON in reply");
  return JSON.parse(text.slice(a, b + 1));
}
const withSchema = (system, schema) =>
  `${system}\n\nReply with one JSON object only, no prose and no code fences, matching this JSON Schema:\n${JSON.stringify(schema)}`;

const BACKENDS = {
  // Claude Code CLI: uses your Claude login, no key.
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
  // Codex CLI: uses your ChatGPT/Codex login. The schema file makes the last message valid JSON.
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
        const data = dropNulls(jsonFrom(readFileSync(outFile, "utf8")));
        return { data, ms: Date.now() - t0 };
      }, { cwd: dir }).finally(() => rmSync(dir, { recursive: true, force: true }));
    },
  },
  // Gemini CLI: uses your Google login. No schema flag, so the schema goes in the prompt.
  gemini: {
    model: "gemini-2.5-flash",
    run: (slot, system, schema, input) => {
      const t0 = Date.now();
      return runCli(slot, "gemini", ["-m", MODEL, "--output-format", "json", "-p", withSchema(system, schema)], input, (out) => {
        const res = jsonFrom(out);
        if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
        return { data: jsonFrom(res.response ?? ""), ms: Date.now() - t0 };
      });
    },
  },
  // Anthropic API key. A forced tool call returns input that matches the schema.
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
        return { data: call.input, model: res.model, ms: Date.now() - t0 };
      });
    },
  },
  // OpenAI or any OpenAI-compatible endpoint (OpenRouter, Ollama, LM Studio...) via OPENAI_BASE_URL.
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
        return { data: dropNulls(jsonFrom(text)), model: res.model, ms: Date.now() - t0 };
      });
    },
  },
};

function onPath(cmd) {
  const exts = platform() === "win32" ? ["", ".cmd", ".exe"] : [""];
  return (process.env.PATH || "").split(delimiter).some((d) => d && exts.some((e) => existsSync(join(d, cmd + e))));
}

// Pick a backend: an explicit choice wins; then the agent we were started from; then whatever is installed.
function pickBackend() {
  const asked = opt("--backend", process.env.PROMPT_SHAPER_BACKEND || "auto");
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
const MODEL = opt("--model", process.env.PROMPT_SHAPER_MODEL || BACKENDS[BACKEND].model);
const EFFORT = process.env.PROMPT_SHAPER_EFFORT || "low";

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
  const underlines = (data.underlines || []).filter((u) => u.span && text.toLowerCase().includes(u.span.toLowerCase()));
  const extras = (data.extras || []).map((e) => ({ ...e, span: "" }));
  return { summary: data.summary, choices: more ? extras : [...underlines, ...extras], model: data.model, ms: data.ms };
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

// ---------------------------------------------------------------- http
const html = () => readFileSync(join(HERE, "index.html"));

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

function finish(code, text) {
  for (const j of Object.values(running)) j.abort();
  if (text) process.stdout.write(text.endsWith("\n") ? text : text + "\n");
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
      return res.end(html());
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
    if (req.method === "POST" && url.pathname === "/api/submit") {
      const { prompt = "" } = await body(req);
      send(res, 200, { ok: true });
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

// Don't wait forever, e.g. when the agent ran us in the background and moved on.
const TIMEOUT_MIN = Number(process.env.PROMPT_SHAPER_TIMEOUT_MIN || 30);
if (TIMEOUT_MIN > 0) setTimeout(() => { log(`no answer after ${TIMEOUT_MIN} min, giving up`); finish(3, ""); }, TIMEOUT_MIN * 60000).unref();

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${server.address().port}/`;
  log(`open ${url}  (waiting for Send; Ctrl+C to abort)`);
  log(`backend: ${BACKEND}${MODEL ? ` (${MODEL})` : ""}`);
  if (flag("--no-open")) return;
  const cmd = process.env.PROMPT_SHAPER_BROWSER ||
    (platform() === "darwin" ? "open" : platform() === "win32" ? "explorer" : "xdg-open");
  try { spawn(cmd, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch {}
});
