// What the page knows: its elements, the choices on the request, and what is running.

import type { Api } from "../skills/help-me/api.ts";
import type { ChatHost } from "./chat.ts";

export interface Option {
  label: string;
  emoji?: string;
  text: string;
}

export interface Slider {
  min: number;
  max: number;
  step: number;
  value?: number;
  unit?: string;
  minLabel?: string;
  maxLabel?: string;
  template?: string;
  stops?: string[];
}

/** Where a written-in question's sentence sits around its value: "My budget is " + value + ".". */
export interface Promo {
  sep: string;
  pre: string;
  post: string;
}

export type Explanation = Omit<Api["/api/explain"]["reply"], "model" | "ms">;

export interface DecideQuestion {
  question: string;
  options: { label: string; emoji?: string }[];
  answer: string;
}

export interface Decide {
  qs: DecideQuestion[];
  rec: { label: string; why: string } | null;
  busy: boolean;
  err: string;
  seq: number;
}

interface ChoiceBase {
  id: string;
  /** Where it came from: a question the request asks, a phrase in it, or something it doesn't say yet. */
  type: "ask" | "underline" | "extra";
  span: string;
  question: string;
  token: string;
  sentence: string;
  statement: string;
  options: Option[];
  selected: string[];
  custom: string;
  value: number;
  touched: boolean;
  orig: string;
  cur: string;
  /** Where `cur` sits in the request; -1 while it isn't in it. */
  start: number;
  end: number;
  settled: boolean;
  /** Not in the request yet: shown as a token under it. Becomes false once written in (`promo`). */
  extra: boolean;
  promo: Promo | null;
  explain: boolean;
  explanation: Explanation | null;
  explainOpen: boolean;
  explainBusy: boolean;
  explainErr: string;
  /** Explain me was opened after the session ended, with no explanation fetched before. */
  explainGone: boolean;
  decide: Decide | null;
}

export type Choice = ChoiceBase & ({ kind: "slider"; slider: Slider } | { kind: "single" | "multi"; slider: null });

export interface TidyUndo {
  before: string;
  after: string;
  pos: [Choice, number, number, string | undefined][];
}

export interface Snapshot {
  text: string;
  pos: [Choice, number, number][];
  linked: boolean;
}

export interface Rank {
  ln: number;
  id: number;
  snap: Snapshot;
  y0: number;
  live: boolean;
}

export interface Press {
  id: string | null;
  pointer: number;
  x0: number;
  v0: number;
  scrub: boolean;
  moved: boolean;
  inTa: boolean;
}

function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) {
    throw new Error(`#${id} is missing`);
  }
  return el;
}

export const $ = (id: string): HTMLElement => byId(id, HTMLElement);
export const ta = byId("ta", HTMLTextAreaElement);
export const backdrop = $("backdrop");
export const pop = $("pop");
export const extrasEl = $("extras");
export const gripsEl = $("grips");
export const laneEl = $("lane");
export const hintEl = $("scrubHint");
export const moreBtn = byId("more", HTMLButtonElement);
export const tidyBtn = byId("tidy", HTMLButtonElement);
export const sendBtn = byId("send", HTMLButtonElement);

export const state = {
  mode: "live" as "live" | "demo",
  modelName: "the model",
  agentName: "your agent",
  imagesOn: true,
  chat: null as ChatHost | null,
  choices: [] as Choice[],
  summary: "",
  seq: 0,
  timer: undefined as ReturnType<typeof setTimeout> | undefined,
  lastAnalyzed: null as string | null,
  busy: false,
  moreBusy: false,
  openId: null as string | null,
  hoverId: null as string | null,
  /** The choice the open popover was last drawn for, so a redraw of the same one keeps its scroll. */
  openedFor: null as string | null,
  uid: 0,
  /** Once sent or cancelled the page stays open to look back at, but nothing changes or is sent again. */
  ended: null as "sent" | "cancelled" | null,
  /** Each written-in question whose sentence you removed. */
  removed: [] as { question: string; token: string }[],
  skipNextAnalysisFor: null as string | null,
  statusKind: "",
  readInfo: "",
  nudgeId: null as string | null,
  tidyHeads: new Set<string>(),
  tidyBusy: false,
  tidyUndo: null as TidyUndo | null,
  tidySeq: 0,
  moves: [] as (Snapshot & { after: string })[],
  rank: null as Rank | null,
  laneLn: -1,
  drag: null as Press | null,
};

export const byChoiceId = (id: string | null): Choice | undefined =>
  id ? state.choices.find(c => c.id === id) : undefined;
