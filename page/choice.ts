import type { Choice as Sent } from "../skills/chartroom/tasks.ts";
import { clamp, fmtNum } from "./format.ts";
import { state } from "./state.ts";
import type { Choice, Slider } from "./state.ts";

const WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];
export function numberIn(t: string): number | null {
  const m = /\d+(\.\d+)?/.exec(t);
  if (m) {
    return Number(m[0]);
  }
  for (const x of t.toLowerCase().match(/[a-z]+/g) ?? []) {
    const i = WORDS.indexOf(x);
    if (i >= 0) {
      return i;
    }
  }
  return null;
}

/** A slider read from the model's reply, and where it starts. */
interface SliderStart {
  slider: Slider;
  value: number;
}

function sliderFrom(raw: Sent["slider"], span: string): SliderStart {
  const s = raw ?? {};
  const stops = s.stops?.length ? s.stops : undefined;
  const slider: Slider = {
    ...s,
    min: stops ? 0 : (s.min ?? 0),
    max: stops ? stops.length - 1 : (s.max ?? 10),
    step: stops ? 1 : (s.step ?? 1),
  };
  let value = clamp(slider.value ?? Math.round((slider.min + slider.max) / 2), slider.min, slider.max);
  if (!s.stops) {
    const n = numberIn(span);
    if (n !== null && n >= slider.min && n <= slider.max) {
      value = slider.value = n;
    }
  }
  return { slider, value };
}

export function makeChoice(c: Sent): Choice | null {
  const span = c.type === "extra" ? "" : c.span;
  const options = (c.options ?? []).filter(o => o.label && o.text);
  const base = {
    id: "c" + String(++state.lastChoiceId),
    type: c.type,
    span,
    question: c.question || "Choose",
    token: c.type === "extra" ? c.token : "",
    sentence: c.type === "extra" ? c.sentence : "",
    statement: c.type === "ask" ? c.statement || "{value}" : "",
    options,
    selected: [] as Array<string>,
    custom: "",
    touched: false,
    orig: span,
    cur: span,
    start: -1,
    end: -1,
    settled: false,
    extra: c.type === "extra",
    promo: null,
    explain: Boolean(c.explain),
    explanation: null,
    explainOpen: false,
    explainBusy: false,
    explainErr: "",
    explainGone: false,
    decide: null,
  };
  if (base.extra && !base.token) {
    base.token = base.question.replace(/^(what('s| is)|how|which|do you|any)\s+/i, "").replace(/\?$/, "");
  }
  const current = new Set((c.current ?? []).map(s => s.toLowerCase()));
  base.selected = options.filter(o => current.has(o.label.toLowerCase())).map(o => o.label);
  if (base.extra && base.selected.length) {
    base.settled = true;
  }
  if (c.kind === "slider") {
    return { ...base, kind: "slider", ...sliderFrom(c.slider, span) };
  }
  return options.length ? { ...base, kind: c.kind, slider: null, value: 0 } : null;
}

export const isAsk = (ch: Choice): boolean => ch.type === "ask";
export const isSet = (ch: Choice): boolean =>
  ch.kind === "slider" ? ch.touched : ch.selected.length > 0 || Boolean(ch.custom);
export const placeholderFor = (ch: Choice): string => `[${(ch.token || "answer").toLowerCase()}]`;

export function valueFor(ch: Choice): string {
  if (ch.kind === "slider") {
    const s = ch.slider;
    if (s.stops?.length) {
      return s.stops[Math.round(ch.value)] ?? ch.orig;
    }
    const v = fmtNum(ch.value);
    if (s.template?.includes("{value}")) {
      return s.template.replaceAll("{value}", v);
    }
    return v + (s.unit ? " " + s.unit : "");
  }
  const parts = ch.options.filter(o => ch.selected.includes(o.label)).map(o => o.text);
  if (ch.custom) {
    parts.push(ch.custom);
  }
  if (!parts.length) {
    return ch.extra || ch.promo ? "" : ch.orig;
  }
  return parts.length === 1 ? (parts[0] ?? "") : parts.slice(0, -1).join(", ") + " and " + String(parts.at(-1));
}

export function textFor(ch: Choice): string {
  if (!isAsk(ch)) {
    return valueFor(ch);
  }
  if (!isSet(ch)) {
    return ch.orig;
  }
  let t = ch.statement.trim();
  if (!t.includes("{value}")) {
    t = t.replace(/[.!?]?$/, ": {value}.");
  }
  return t.replace("{value}", valueFor(ch)).replaceAll("{value}", "");
}

export function tokenValue(ch: Choice): string {
  if (!ch.settled) {
    return "";
  }
  if (ch.kind === "slider") {
    return textFor(ch);
  }
  return [...ch.options.filter(o => ch.selected.includes(o.label)).map(o => o.label), ch.custom]
    .filter(Boolean)
    .join(", ");
}

/** A choice's sentence split around where its value goes. */
interface SentenceParts {
  pre: string;
  post: string;
}

export function sentenceParts(ch: Choice): SentenceParts {
  let t = ch.sentence.trim();
  if (!t.includes("{value}")) {
    t = `${ch.token || "Also"}: {value}.`;
  }
  if (!/[.!?]$/.test(t)) {
    t += ".";
  }
  const i = t.indexOf("{value}");
  return { pre: t.slice(0, i), post: t.slice(i + 7).replaceAll("{value}", "") };
}

export function optionLabels(ch: Choice): Array<string> {
  if (ch.kind !== "slider") {
    return ch.options.map(o => o.label);
  }
  const s = ch.slider;
  return s.stops?.length ? s.stops : [s.minLabel || String(s.min), s.maxLabel || String(s.max)];
}

export const canDecide = (ch: Choice): boolean =>
  (ch.kind !== "slider" || (ch.slider.stops?.length ?? 0) > 1) && optionLabels(ch).length > 1;
