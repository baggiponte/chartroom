import type { ModelCall } from "./model.ts";
import { ANALYZE_SYSTEM, DECIDE_SYSTEM, EXPLAIN_SYSTEM, TIDY_SYSTEM } from "./prompts.ts";
import { BOOLEAN, type Infer, NUMBER, STRING, STRINGS, type Schema } from "./schema.ts";

export type Choice = Infer<typeof CHOICE>;
export type Analysis = Infer<typeof ANALYSIS>;
export type Explanation = Infer<typeof EXPLANATION>;
export type Decision = Infer<typeof DECISION>;
/** Each block lists 0-based sentence indexes, and every sentence lands in exactly one block. */
export type Tidied = Infer<typeof TIDIED>;

export interface AnalyzeInput {
  text: string;
  settled: string[];
  answers: string[];
  asked: string[];
  more: boolean;
}

export interface ExplainInput {
  text: string;
  question: string;
  options: string[];
}

export interface DecideInput {
  text: string;
  question: string;
  options: string[];
  answers: { q: string; a: string }[];
  asked: string[];
}

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

const UNDERLINE = {
  type: "object",
  required: ["span", "question", "kind"],
  properties: { span: STRING, ...CHOICE_FIELDS },
} as const satisfies Schema;
const EXTRA = {
  type: "object",
  required: ["token", "sentence", "question", "kind"],
  properties: { token: STRING, sentence: STRING, ...CHOICE_FIELDS },
} as const satisfies Schema;

// Separate lists keep Haiku from mixing up "answer this question", "underline this phrase" and "add this missing setting".
const ANALYZE_SCHEMA = {
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
    underlines: { type: "array", items: UNDERLINE },
    extras: { type: "array", items: EXTRA },
  },
} as const satisfies Schema;

/** A choice as the page gets it: `type` says where it goes in the request. */
const CHOICE = {
  anyOf: [
    {
      type: "object",
      required: ["type", "span", "statement", "question", "kind"],
      properties: {
        type: { type: "string", enum: ["ask"] },
        span: STRING,
        statement: STRING,
        ...CHOICE_FIELDS,
        kind: { type: "string", enum: ["single", "multi"] },
      },
    },
    {
      ...UNDERLINE,
      required: [...UNDERLINE.required, "type"],
      properties: { ...UNDERLINE.properties, type: { type: "string", enum: ["underline"] } },
    },
    {
      ...EXTRA,
      required: [...EXTRA.required, "type"],
      properties: { ...EXTRA.properties, type: { type: "string", enum: ["extra"] } },
    },
  ],
} as const satisfies Schema;

// Which model answered and how long it took, when the backend says.
const MODEL_INFO = { model: STRING, ms: NUMBER } as const;

export const ANALYSIS = {
  type: "object",
  required: ["summary", "choices"],
  properties: { summary: STRING, choices: { type: "array", items: CHOICE }, ...MODEL_INFO },
} as const satisfies Schema;

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
  const data = await model("analyze", ANALYZE_SYSTEM, ANALYZE_SCHEMA, input);
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
export const EXPLANATION = {
  ...EXPLAIN_SCHEMA,
  properties: { ...EXPLAIN_SCHEMA.properties, ...MODEL_INFO },
} as const satisfies Schema;

export function explain(model: ModelCall, { text, question, options }: ExplainInput): Promise<Explanation> {
  const input = `Request: ${text}\nQuestion: ${question}\nOptions:\n` + options.map(o => `- ${o}`).join("\n");
  return model(`explain:${question}`, EXPLAIN_SYSTEM, EXPLAIN_SCHEMA, input);
}

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
export const DECISION = {
  ...DECIDE_SCHEMA,
  properties: { ...DECIDE_SCHEMA.properties, ...MODEL_INFO },
} as const satisfies Schema;

export async function decide(
  model: ModelCall,
  { text, question, options, answers, asked }: DecideInput,
): Promise<Decision> {
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
export const TIDIED = {
  ...TIDY_SCHEMA,
  properties: { ...TIDY_SCHEMA.properties, ...MODEL_INFO },
} as const satisfies Schema;

export async function tidy(model: ModelCall, sentences: string[]): Promise<Tidied> {
  const input = "Sentences:\n" + sentences.map((s, i) => `${String(i + 1)}. ${s}`).join("\n");
  const data = await model("tidy", TIDY_SYSTEM, TIDY_SCHEMA, input);
  const used = new Set<number>();
  const blocks: Tidied["blocks"] = [];
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
