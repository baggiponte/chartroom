// What the page asks the model for: one prompt and schema per route, and the clean-up of each reply.

import type { ModelCall } from "./model.ts";
import type { Infer, Schema } from "./schema.ts";

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

type Item<K extends "asks" | "underlines" | "extras"> = Infer<(typeof SCHEMA)["properties"][K]["items"]>;
/** A choice as the page gets it: `type` says where it goes in the request. */
export type Choice =
  | (Omit<Item<"asks">, "sentence" | "kind"> & { type: "ask"; kind: "single" | "multi"; statement: string })
  | (Item<"underlines"> & { type: "underline" })
  | (Item<"extras"> & { type: "extra" });
export interface Analysis {
  summary: string;
  choices: Choice[];
  model?: string;
  ms?: number | undefined;
}

export interface AnalyzeInput {
  text: string;
  settled: string[];
  answers: string[];
  asked: string[];
  more: boolean;
}

export async function analyze(
  model: ModelCall,
  { text, settled, answers, asked, more }: AnalyzeInput,
): Promise<Analysis> {
  if (text.trim().split(/\s+/).length < 2) {
    return { summary: "", choices: [] };
  }
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
  const data = await model("analyze", SYSTEM, SCHEMA, input);
  const inText = (c: { span: string }): boolean => Boolean(c.span) && text.toLowerCase().includes(c.span.toLowerCase());
  const asks = data.asks.filter(inText).map(({ sentence, kind, ...a }): Choice & { type: "ask" } =>
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
  const extras = data.extras.map(e => Object.assign(e, { type: "extra" as const }));
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

export interface ExplainInput {
  text: string;
  question: string;
  options: string[];
}

export function explain(model: ModelCall, { text, question, options }: ExplainInput) {
  const input = `Request: ${text}\nQuestion: ${question}\nOptions:\n` + options.map(o => `- ${o}`).join("\n");
  return model(`explain:${question}`, EXPLAIN_SYSTEM, EXPLAIN_SCHEMA, input);
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

export interface DecideInput {
  text: string;
  question: string;
  options: string[];
  answers: { q: string; a: string }[];
  asked: string[];
}

export async function decide(model: ModelCall, { text, question, options, answers, asked }: DecideInput) {
  let input = `Request: ${text}\nQuestion: ${question}\nOptions:\n` + options.map(o => `- ${o}`).join("\n");
  if (answers.length) {
    input += `\n\nTheir answers so far:\n` + answers.map(a => `- ${a.q} ${a.a}`).join("\n");
  }
  if (asked.length) {
    input += `\n\nAlready asked (do not repeat):\n` + asked.map(q => `- ${q}`).join("\n");
  }
  const { recommendation, ...data } = await model(`decide:${question}`, DECIDE_SYSTEM, DECIDE_SCHEMA, input);
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
export async function tidy(model: ModelCall, sentences: string[]) {
  const input = "Sentences:\n" + sentences.map((s, i) => `${String(i + 1)}. ${s}`).join("\n");
  const data = await model("tidy", TIDY_SYSTEM, TIDY_SCHEMA, input);
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
