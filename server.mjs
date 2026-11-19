#!/usr/bin/env node
// prompt-shaper: a local bridge between a browser prompt box and Claude Code.
//
//   node server.mjs [--draft "text" | --stdin] [--port N] [--model haiku] [--no-open]
//
// Serves index.html, runs the "choices" analysis through the `claude` CLI
// (so it uses your Claude Code login / subscription, no API key), and blocks
// until you press Send in the browser. The shaped prompt is printed to stdout,
// which is what the /shape command hands back to the Claude Code session.
// Exit codes: 0 = sent, 2 = cancelled in the browser.

import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const MODEL = opt("--model", process.env.PROMPT_SHAPER_MODEL || "haiku");
const PORT = Number(opt("--port", process.env.PROMPT_SHAPER_PORT || 0));
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
   length, deadline...). They appear as small tokens under the sentence. Give each a token: a 1-2 word name
   like "Budget" or "Milk". Option text is a short phrase that completes "<token>: ...", e.g. "up to €500".

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

const running = {}; // one live process per slot; a newer request in the same slot kills the older one

function runClaude(slot, system, schema, input) {
  if (running[slot]) running[slot].kill("SIGTERM");
  return new Promise((resolve, reject) => {
    const child = spawn(
      "claude",
      [
        "-p", "--model", MODEL, "--output-format", "json", "--tools", "",
        "--no-session-persistence", "--setting-sources", "", "--effort", process.env.PROMPT_SHAPER_EFFORT || "low",
        "--system-prompt", system, "--json-schema", JSON.stringify(schema),
      ],
      { cwd: tmpdir(), env: { ...process.env, PROMPT_SHAPER_CHILD: "1" }, stdio: ["pipe", "pipe", "pipe"] },
    );
    running[slot] = child;
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => reject(new Error(`could not start claude CLI: ${e.message}`)));
    child.on("close", (code, signal) => {
      if (running[slot] === child) delete running[slot];
      if (signal) return reject(Object.assign(new Error("superseded"), { superseded: true }));
      try {
        const res = JSON.parse(out);
        if (res.is_error) return reject(new Error(res.result || "claude returned an error"));
        const data = res.structured_output ?? JSON.parse(res.result);
        resolve({ ...data, model: Object.keys(res.modelUsage || {})[0] || MODEL, ms: res.duration_ms });
      } catch {
        reject(new Error(`claude exited ${code}: ${(err || out).slice(0, 400)}`));
      }
    });
    child.stdin.end(input);
  });
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
  const data = await runClaude("analyze", SYSTEM, SCHEMA, input);
  const underlines = (data.underlines || []).filter((u) => u.span && text.toLowerCase().includes(u.span.toLowerCase()));
  const extras = (data.extras || []).map((e) => ({ ...e, span: "" }));
  return { summary: data.summary, choices: more ? extras : [...underlines, ...extras], model: data.model, ms: data.ms };
}

const EXPLAIN_SYSTEM = `Someone is answering a short questionnaire so an assistant can help with their request.
They asked you to explain one question. Write for a smart newcomer: plain words, no jargon (or define it in passing),
friendly and concrete, and SHORT: it appears in a small popover. Return JSON: intro = one sentence (max 25 words)
on what the question is really about and why it changes the outcome; options = one entry per option, in the same
order, with label copied exactly and what = max 15 words on what picking it means in practice (taste, cost,
effort, who it suits). For a slider, explain what
moving it from one end to the other changes, and return options for the ends or stops.`;

const EXPLAIN_SCHEMA = {
  type: "object",
  required: ["intro", "options"],
  properties: {
    intro: { type: "string" },
    options: { type: "array", items: { type: "object", required: ["label", "what"], properties: { label: { type: "string" }, what: { type: "string" } } } },
  },
};

function explain(text, question, options) {
  const input = `Request: ${text}\nQuestion: ${question}\nOptions:\n` + options.map((o) => `- ${o}`).join("\n");
  return runClaude("explain:" + question, EXPLAIN_SYSTEM, EXPLAIN_SCHEMA, input);
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

function finish(code, text) {
  for (const c of Object.values(running)) c.kill("SIGTERM");
  if (text) process.stdout.write(text.endsWith("\n") ? text : text + "\n");
  setTimeout(() => process.exit(code), 150);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(html());
    }
    if (req.method === "GET" && url.pathname === "/api/init") return send(res, 200, { draft, model: MODEL });
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

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${server.address().port}/`;
  log(`open ${url}  (waiting for Send; Ctrl+C to abort)`);
  if (flag("--no-open")) return;
  const cmd = process.env.PROMPT_SHAPER_BROWSER ||
    (platform() === "darwin" ? "open" : platform() === "win32" ? "explorer" : "xdg-open");
  try { spawn(cmd, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch {}
});
