// Editing the request: each choice owns a range of the textarea's text, which moves as the text around it changes.

import { isSet, placeholderFor, sentenceParts, textFor } from "./choice.ts";
import { render, renderExtras } from "./render.ts";
import { type Choice, pop, state, ta } from "./state.ts";

export const overlaps = (ranges: [number, number][], a: number, b: number): boolean =>
  ranges.some(([s, e]) => a < e && b > s);

export const isHeading = (line: string): boolean => {
  const t = line.trim();
  return t.endsWith(":") && state.tidyHeads.has(t.slice(0, -1).trim());
};
export const hasTidyLayout = (text = ta.value): boolean => state.tidyHeads.size > 0 && text.split("\n").some(isHeading);

/** Finds each choice again after an edit, at the occurrence nearest where it was; a choice whose text is gone goes. */
export function relocate(text: string): void {
  const taken: [number, number][] = [];
  state.choices = state.choices.filter(ch => {
    if (ch.extra) {
      return true;
    }
    let best = -1;
    let bestD = Infinity;
    let i = text.indexOf(ch.cur);
    while (ch.cur && i >= 0) {
      const d = Math.abs(i - ch.start);
      if (d < bestD && !overlaps(taken, i, i + ch.cur.length)) {
        best = i;
        bestD = d;
      }
      i = text.indexOf(ch.cur, i + 1);
    }
    if (best < 0) {
      if (ch.promo) {
        dismiss(ch);
      }
      return false;
    }
    ch.start = best;
    ch.end = best + ch.cur.length;
    taken.push([ch.start, ch.end]);
    return true;
  });
}

export function shiftAfter(ch: Choice, at: number, delta: number): void {
  for (const o of state.choices) {
    if (o !== ch && !o.extra && o.start >= at) {
      o.start += delta;
      o.end += delta;
    }
  }
}

/** Replaces the text, keeping the caret where it was: sentences are added after it. */
export function setText(text: string): void {
  const a = ta.selectionStart;
  const b = ta.selectionEnd;
  const focused = document.activeElement === ta;
  ta.value = text;
  state.skipNextAnalysisFor = text;
  if (focused) {
    ta.setSelectionRange(Math.min(a, text.length), Math.min(b, text.length));
  }
}

/** Writes a choice's text into the request; `override` writes that text instead, "" unsets a written-in one. */
export function applyChoice(ch: Choice, override?: string): void {
  if (state.ended) {
    return;
  }
  if (ch.extra) {
    if (override !== "" && isSet(ch)) {
      promote(ch);
      return;
    }
    ch.settled = false;
    renderExtras();
    return;
  }
  let next = override ?? textFor(ch);
  if (ch.promo) {
    const set = override !== "" && isSet(ch);
    next = set ? next : placeholderFor(ch);
    override = undefined;
    ch.settled = set;
  }
  const delta = next.length - (ch.end - ch.start);
  const text = ta.value.slice(0, ch.start) + next + ta.value.slice(ch.end);
  shiftAfter(ch, ch.end, delta);
  ch.cur = next;
  ch.end = ch.start + next.length;
  if (!ch.promo) {
    ch.settled = override === undefined;
  }
  setText(text);
  render(ch.id);
}

/** Writes an extra into the request as its own sentence, with its value or a [placeholder]. */
export function promote(ch: Choice): void {
  const set = isSet(ch);
  const value = set ? textFor(ch) : placeholderFor(ch);
  if (!value) {
    return;
  }
  const { pre, post } = sentenceParts(ch);
  let text = ta.value.replace(/\s+$/, "");
  const sep = !text ? "" : /\n[ \t]*- [^\n]*$/.test(text) ? "\n- " : /[.!?:;…)]$/.test(text) ? " " : ". ";
  ch.promo = { sep, pre, post };
  ch.extra = false;
  ch.settled = set;
  ch.start = text.length + sep.length + pre.length;
  ch.end = ch.start + value.length;
  ch.orig = ch.cur = ch.span = value;
  text += sep + pre + value + post;
  setText(text);
}

/** The whole sentence [a, b) around a written-in question, or just the value if you rewrote the words around it. */
export function sentenceRange(ch: Choice, text: string): [number, number] {
  let a = ch.start;
  let b = ch.end;
  if (!ch.promo) {
    return [a, b];
  }
  const { sep, pre, post } = ch.promo;
  if (text.slice(a - pre.length, a) === pre && text.slice(b, b + post.length) === post) {
    a -= pre.length;
    b += post.length;
    if (sep && text.slice(a - sep.length, a) === sep) {
      a -= sep.length;
    } else {
      const ls = text.lastIndexOf("\n", a - 1) + 1;
      const lineEnd = b === text.length || text[b] === "\n";
      if (/^[ \t]*(?:[-*•][ \t]+)?$/.test(text.slice(ls, a)) && lineEnd) {
        a = ls;
        if (text[b] === "\n") {
          b++;
        } else if (a > 0) {
          a--;
        }
      } else if (text[b] === " ") {
        b++;
      } else if (text[a - 1] === " ") {
        a--;
      }
    }
  }
  return [a, b];
}

export function dismiss(ch: Choice): void {
  if (!state.removed.some(r => r.question === ch.question)) {
    state.removed.push({ question: ch.question, token: ch.token });
  }
}

/** Removes a written-in question's sentence from the request. */
export function demote(ch: Choice): void {
  let text = ta.value;
  const [a, b] = sentenceRange(ch, text);
  text = text.slice(0, a) + text.slice(b);
  shiftAfter(ch, b, a - b);
  dismiss(ch);
  state.choices = state.choices.filter(c => c !== ch);
  setText(text);
  if (state.openId === ch.id) {
    state.openId = null;
    state.openedFor = null;
    pop.hidden = true;
  }
  render();
}

/** The request without the sentences you haven't filled in: what gets sent, and what the model re-reads. */
export function withoutOpen(text = ta.value): string {
  const open = state.choices.filter(c => c.promo && !c.settled && c.start >= 0).toSorted((x, y) => y.start - x.start);
  for (const ch of open) {
    const [a, b] = sentenceRange(ch, text);
    text = text.slice(0, a) + text.slice(b);
  }
  if (state.tidyHeads.size) {
    // a heading whose list emptied out goes too
    const lines = text.split("\n").filter(l => !/^[ \t]*[-*•][ \t]*$/.test(l));
    text = lines
      .filter((l, i) => !(isHeading(l) && !(lines[i + 1] ?? "").trim()))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n");
  }
  return text.replace(/[ \t]+$/gm, "").trim();
}
