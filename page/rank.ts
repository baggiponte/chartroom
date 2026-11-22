// Only whole lines move, so underlines travel with their item, and the order on screen is what gets sent.

import { closePop } from "./popover.ts";
import { render } from "./render.ts";
import { isHeading, setText } from "./request.ts";
import { $, backdrop, gripsEl, laneEl, ta } from "./dom.ts";
import { state } from "./state.ts";
import type { Snapshot } from "./state.ts";
import { undoTidy } from "./tidy.ts";

const BULLET = /^[ \t]*[-*•][ \t]+\S/;
const GRIP_SVG =
  '<svg viewBox="0 0 10 16" fill="currentColor" aria-hidden="true"><circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></svg>';

interface List {
  head: number;
  title: string;
  /** Line numbers of the list's bullets. */
  items: Array<number>;
}

export function tidyLists(text = ta.value): Array<List> {
  if (!state.tidyHeads.size || state.ended) {
    return [];
  }
  const lists: Array<List> = [];
  let cur: List | null = null;
  text.split("\n").forEach((l, i) => {
    if (isHeading(l)) {
      cur = { head: i, title: l.trim().slice(0, -1), items: [] };
      lists.push(cur);
    } else if (cur && BULLET.test(l)) {
      cur.items.push(i);
    } else {
      cur = null;
    }
  });
  return lists;
}

const lineStarts = (lines: Array<string>): Array<number> => {
  const s: Array<number> = [];
  let p = 0;
  for (const l of lines) {
    s.push(p);
    p += l.length + 1;
  }
  return s;
};

function whereIs(lists: Array<List>, ln: number): { li: number; k: number } | null {
  for (const [li, list] of lists.entries()) {
    const k = list.items.indexOf(ln);
    if (k >= 0) {
      return { li, k };
    }
  }
  return null;
}

/** The box of text [a, b) as drawn in the backdrop, relative to the field. */
function textBox(a: number, b: number): { top: number; bottom: number } | null {
  const w = document.createTreeWalker(backdrop, NodeFilter.SHOW_TEXT);
  const r = document.createRange();
  let pos = 0;
  let started = false;
  for (let n = w.nextNode(); n instanceof Text; n = w.nextNode()) {
    const len = n.data.length;
    if (!started && a <= pos + len) {
      r.setStart(n, a - pos);
      started = true;
    }
    if (started && b <= pos + len) {
      r.setEnd(n, b - pos);
      const box = r.getBoundingClientRect();
      const f = backdrop.getBoundingClientRect();
      return { top: box.top - f.top, bottom: box.bottom - f.top };
    }
    pos += len;
  }
  return null;
}

function lineBox(ln: number, text = ta.value): { top: number; bottom: number } | null {
  const lines = text.split("\n");
  const start = lineStarts(lines)[ln];
  const line = lines[ln];
  return start === undefined || line === undefined ? null : textBox(start, start + line.length);
}

export function renderGrips(): void {
  const lists = tidyLists();
  const text = ta.value;
  const lines = text.split("\n");
  const items = lists.flatMap((L, li) => L.items.map((ln, k) => ({ ln, li, k, n: L.items.length })));
  const lh = parseFloat(getComputedStyle(ta).lineHeight) || 35;
  if (gripsEl.children.length !== items.length) {
    gripsEl.innerHTML = items
      .map(() => `<button class="grip" type="button" tabindex="0">${GRIP_SVG}</button>`)
      .join("");
  }
  items.forEach((it, i) => {
    const g = gripsEl.children[i];
    if (!(g instanceof HTMLElement)) {
      return;
    }
    const box = lineBox(it.ln, text);
    const words = (lines[it.ln] ?? "").replace(/^[ \t]*[-*•][ \t]+/, "");
    g.dataset["ln"] = String(it.ln);
    g.style.top = `${String(box ? box.top : 0)}px`;
    g.style.height = `${String(lh)}px`;
    g.title = "Drag to rank, or focus and use ↑/↓";
    g.setAttribute(
      "aria-label",
      `Move “${words}”: item ${String(it.k + 1)} of ${String(it.n)} in ${lists[it.li]?.title ?? ""}. Use up and down arrows to move it.`,
    );
    g.classList.toggle("dragging", Boolean(state.ranking) && state.ranking?.ln === it.ln);
  });
  const fg = document.activeElement;
  if (fg instanceof HTMLElement && gripsEl.contains(fg)) {
    state.laneLine = Number(fg.dataset["ln"]);
  }
  const show = state.ranking ? state.ranking.ln : state.laneLine;
  const box = show >= 0 && items.some(it => it.ln === show) ? lineBox(show, text) : null;
  laneEl.hidden = !box;
  if (box) {
    laneEl.style.top = `${String(box.top - 3)}px`;
    laneEl.style.height = `${String(box.bottom - box.top + 6)}px`;
  }
}

/** Moves the item on line `from` to slot k of list li (k counts the list's other items); returns its new line. */
function moveItem(from: number, li: number, k: number): number | null {
  const text = ta.value;
  const lines = text.split("\n");
  const lists = tidyLists(text);
  const L = lists[li];
  if (!L || !whereIs(lists, from)) {
    return null;
  }
  const others = L.items.filter(x => x !== from);
  const order = lines.map((_, i) => i).filter(i => i !== from);
  const before = others[k];
  if (before !== undefined) {
    order.splice(order.indexOf(before), 0, from);
  } else {
    order.splice(order.indexOf(others.at(-1) ?? L.head) + 1, 0, from);
  }
  const out = order.map(i => lines[i]).join("\n");
  if (out === text) {
    return from;
  }
  const oldS = lineStarts(lines);
  const newS: Array<number> = Array.from({ length: lines.length }, () => 0);
  let p = 0;
  for (const i of order) {
    newS[i] = p;
    p += (lines[i] ?? "").length + 1;
  }
  const lineOf = (at: number): number => {
    let i = oldS.length - 1;
    while (i > 0 && (oldS[i] ?? 0) > at) {
      i--;
    }
    return i;
  };
  const shift = (at: number): number => {
    const i = lineOf(at);
    return (newS[i] ?? 0) - (oldS[i] ?? 0);
  };
  for (const c of state.choices) {
    if (c.extra || c.start < 0) {
      continue;
    }
    const d = shift(c.start);
    c.start += d;
    c.end += d;
  }
  if (state.tidyUndo && state.tidyUndo.after === text) {
    state.tidyUndo.after = out;
  }
  const focused = document.activeElement === ta;
  const a = ta.selectionStart;
  const b = ta.selectionEnd;
  setText(out);
  if (focused) {
    // keep the caret on the same words
    ta.setSelectionRange(a + shift(a), b + shift(b));
  }
  return order.indexOf(from);
}

const snapshot = (): Snapshot => ({
  text: ta.value,
  pos: state.choices.map(c => [c, c.start, c.end]),
  linked: Boolean(state.tidyUndo) && state.tidyUndo?.after === ta.value,
});

function recordMove(snap: Snapshot): void {
  if (ta.value === snap.text) {
    return;
  }
  if (state.moveUndo.length && state.moveUndo.at(-1)?.after !== snap.text) {
    state.moveUndo = [];
  }
  state.moveUndo.push({ ...snap, after: ta.value });
}

function restore(snap: Snapshot, from: string): void {
  for (const [c, start, end] of snap.pos) {
    c.start = start;
    c.end = end;
  }
  if (state.tidyUndo && snap.linked && state.tidyUndo.after === from) {
    state.tidyUndo.after = snap.text;
  }
  setText(snap.text);
}

export function undoMove(): boolean {
  const m = state.moveUndo.at(-1);
  if (!m || state.ended) {
    return false;
  }
  if (m.after !== ta.value) {
    state.moveUndo = [];
    return false;
  }
  state.moveUndo.pop();
  restore(m, m.after);
  render();
  say("Move undone.");
  return true;
}

function say(msg: string): void {
  $("rankSay").textContent = msg;
}

function sayWhere(ln: number): void {
  const lists = tidyLists();
  const at = whereIs(lists, ln);
  const list = at ? lists[at.li] : undefined;
  if (at && list) {
    say(`Now item ${String(at.k + 1)} of ${String(list.items.length)} in ${list.title}.`);
  }
}

/** One step up or down, crossing into the neighbouring list at its end. */
function step(ln: number, dir: -1 | 1): { li: number; k: number } | null {
  const lists = tidyLists();
  const at = whereIs(lists, ln);
  if (!at) {
    return null;
  }
  const n = lists[at.li]?.items.length ?? 0;
  if (dir < 0) {
    const prev = lists[at.li - 1];
    return at.k > 0 ? { li: at.li, k: at.k - 1 } : prev ? { li: at.li - 1, k: prev.items.length } : null;
  }
  return at.k < n - 1 ? { li: at.li, k: at.k + 1 } : at.li < lists.length - 1 ? { li: at.li + 1, k: 0 } : null;
}

function stepMove(ln: number, dir: -1 | 1): number | null {
  const to = step(ln, dir);
  if (!to) {
    return null;
  }
  const snap = snapshot();
  const now = moveItem(ln, to.li, to.k);
  recordMove(snap);
  render();
  if (now !== null) {
    sayWhere(now);
  }
  return now;
}

/** Moves the item the caret is on; false when it isn't on one. */
export function caretMove(dir: -1 | 1): boolean {
  const text = ta.value;
  const ln = text.slice(0, ta.selectionStart).split("\n").length - 1;
  if (!whereIs(tidyLists(text), ln)) {
    return false;
  }
  stepMove(ln, dir);
  return true;
}

const gripOf = (e: Event): HTMLElement | null => {
  const g = e.target instanceof Element ? e.target.closest(".grip") : null;
  return g instanceof HTMLElement ? g : null;
};
const focusGrip = (ln: number | string): void => {
  gripsEl.querySelector<HTMLElement>(`.grip[data-ln="${String(ln)}"]`)?.focus();
};

gripsEl.addEventListener("keydown", e => {
  const g = gripOf(e);
  if (!g || state.ended) {
    return;
  }
  if (e.key.toLowerCase() === "z" && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
    e.preventDefault();
    const ln = g.dataset["ln"] ?? "";
    if (!undoMove() && state.tidyUndo && ta.value === state.tidyUndo.after) {
      undoTidy();
    }
    (gripsEl.querySelector<HTMLElement>(`.grip[data-ln="${ln}"]`) ?? ta).focus();
    return;
  }
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") {
    return;
  }
  e.preventDefault();
  const now = stepMove(Number(g.dataset["ln"]), e.key === "ArrowUp" ? -1 : 1);
  if (now !== null) {
    focusGrip(now);
  }
});
gripsEl.addEventListener("focusin", e => {
  const g = gripOf(e);
  if (g) {
    state.laneLine = Number(g.dataset["ln"]);
    renderGrips();
  }
});
gripsEl.addEventListener("focusout", () => {
  state.laneLine = -1;
  renderGrips();
});
gripsEl.addEventListener("pointerover", e => {
  const g = gripOf(e);
  if (g && !state.ranking) {
    state.laneLine = Number(g.dataset["ln"]);
    renderGrips();
  }
});
gripsEl.addEventListener("pointerout", () => {
  if (!state.ranking && !gripsEl.contains(document.activeElement)) {
    state.laneLine = -1;
    renderGrips();
  }
});

// Dragging: the item moves live as you go, by the middles of the other items, so what you see is where it lands.
gripsEl.addEventListener("pointerdown", e => {
  const g = gripOf(e);
  if (!g || state.ended || e.button > 0) {
    return;
  }
  e.preventDefault();
  closePop();
  g.setPointerCapture(e.pointerId);
  state.ranking = { ln: Number(g.dataset["ln"]), id: e.pointerId, snap: snapshot(), y0: e.clientY, live: false };
  render();
});
gripsEl.addEventListener("pointermove", e => {
  const { ranking: rank } = state;
  if (!rank || e.pointerId !== rank.id) {
    return;
  }
  if (!rank.live) {
    if (Math.abs(e.clientY - rank.y0) < 4) {
      return;
    }
    rank.live = true;
    document.body.classList.add("ranking");
  }
  const y = e.clientY - backdrop.getBoundingClientRect().top;
  const lists = tidyLists();
  const cur = whereIs(lists, rank.ln);
  if (!cur) {
    return;
  }
  let li = 0;
  lists.forEach((L, i) => {
    const hb = lineBox(L.head);
    if (hb && y >= hb.top) {
      li = i;
    }
  });
  const others = lists[li]?.items.filter(x => x !== rank.ln) ?? [];
  let k = others.findIndex(ln => {
    const b = lineBox(ln);
    return b !== null && y < (b.top + b.bottom) / 2;
  });
  if (k < 0) {
    k = others.length;
  }
  if (li === cur.li && k === cur.k) {
    return;
  }
  const now = moveItem(rank.ln, li, k);
  if (now !== null) {
    rank.ln = now;
    render();
  }
});

function endRank(e: PointerEvent | null, cancel: boolean): void {
  const r = state.ranking;
  if (!r || (e && e.pointerId !== r.id)) {
    return;
  }
  state.ranking = null;
  document.body.classList.remove("ranking");
  if (cancel) {
    restore(r.snap, ta.value);
  } else {
    recordMove(r.snap);
  }
  state.laneLine = -1;
  render();
  if (!cancel && r.snap.text !== ta.value) {
    sayWhere(r.ln);
  }
}
gripsEl.addEventListener("pointerup", e => {
  endRank(e, false);
});
gripsEl.addEventListener("pointercancel", e => {
  endRank(e, true);
});
document.addEventListener(
  "keydown",
  e => {
    if (e.key === "Escape" && state.ranking) {
      e.preventDefault();
      endRank(null, true);
    }
  },
  true,
);
