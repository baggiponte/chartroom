import type { Choice as Suggested, Explanation as Explained } from "../skills/chartroom/tasks.ts";
import type { ChatHost } from "./chat.ts";

/** A choice on the request: a question it asks, a phrase in it, or something it doesn't say yet (`extra`). */
export type Choice = ChoiceBase & ({ kind: "slider"; slider: Slider } | { kind: "single" | "multi"; slider: null });

interface ChoiceBase {
  id: string;
  type: Suggested["type"];
  span: string;
  question: string;
  token: string;
  sentence: string;
  statement: string;
  options: Array<Option>;
  selected: Array<string>;
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

export type Option = NonNullable<Suggested["options"]>[number];

export type Slider = NonNullable<Suggested["slider"]> & { min: number; max: number; step: number };

/** Where a written-in question's sentence sits around its value: "My budget is " + value + ".". */
export interface Promo {
  sep: string;
  pre: string;
  post: string;
}

export type Explanation = Omit<Explained, "model" | "ms">;

export interface Decide {
  qs: Array<DecideQuestion>;
  rec: { label: string; why: string } | null;
  busy: boolean;
  err: string;
  seq: number;
}

export interface DecideQuestion {
  question: string;
  options: Array<{ label: string; emoji?: string | undefined }>;
  answer: string;
}

export interface PageState {
  /** "demo" when no server is behind the page, so canned replies stand in. */
  mode: "live" | "demo";
  modelName: string;
  agentName: string;
  imagesOn: boolean;
  chat: ChatHost | null;
  choices: Array<Choice>;
  summary: string;
  /** Bumped by each read of the request, so an older read's answer is dropped. */
  analysisSeq: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  lastAnalyzed: string | null;
  busy: boolean;
  moreBusy: boolean;
  openId: string | null;
  hoverId: string | null;
  /** The choice the open popover was last drawn for, so a redraw of the same one keeps its scroll. */
  openedFor: string | null;
  lastChoiceId: number;
  /** Once sent or cancelled the page stays open to look back at, but nothing changes or is sent again. */
  ended: "sent" | "cancelled" | null;
  /** Each written-in question whose sentence you removed. */
  removed: Array<{ question: string; token: string }>;
  skipNextAnalysisFor: string | null;
  statusKind: string;
  readInfo: string;
  nudgeId: string | null;
  tidyHeads: Set<string>;
  tidyBusy: boolean;
  tidyUndo: TidyUndo | null;
  tidySeq: number;
  moveUndo: Array<Snapshot & { after: string }>;
  ranking: RankDrag | null;
  laneLine: number;
  press: Press | null;
}

export interface TidyUndo {
  before: string;
  after: string;
  pos: Array<[Choice, number, number, string | undefined]>;
}

export interface Snapshot {
  text: string;
  pos: Array<[Choice, number, number]>;
  linked: boolean;
}

/** A tidied item being dragged by its grip. */
export interface RankDrag {
  ln: number;
  id: number;
  snap: Snapshot;
  y0: number;
  live: boolean;
}

/** A pointer press on the request or a token: a drag on a slider's value scrubs it, anything else is a click. */
export interface Press {
  id: string | null;
  pointer: number;
  x0: number;
  v0: number;
  scrub: boolean;
  moved: boolean;
  inTa: boolean;
}

export const state: PageState = {
  mode: "live",
  modelName: "the model",
  agentName: "your agent",
  imagesOn: true,
  chat: null,
  choices: [],
  summary: "",
  analysisSeq: 0,
  timer: undefined,
  lastAnalyzed: null,
  busy: false,
  moreBusy: false,
  openId: null,
  hoverId: null,
  openedFor: null,
  lastChoiceId: 0,
  ended: null,
  removed: [],
  skipNextAnalysisFor: null,
  statusKind: "",
  readInfo: "",
  nudgeId: null,
  tidyHeads: new Set(),
  tidyBusy: false,
  tidyUndo: null,
  tidySeq: 0,
  moveUndo: [],
  ranking: null,
  laneLine: -1,
  press: null,
};

export const byChoiceId = (id: string | null): Choice | undefined =>
  id ? state.choices.find(c => c.id === id) : undefined;
