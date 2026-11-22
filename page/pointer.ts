// Marks sit under the textarea, so presses are hit-tested against their boxes.

import { clamp } from "./format.ts";
import { anchorFor, closePop, openPop } from "./popover.ts";
import { render } from "./render.ts";
import { applyChoice } from "./request.ts";
import { backdrop, extrasEl, hintEl, ta } from "./dom.ts";
import { byChoiceId, type Choice, state } from "./state.ts";

type SliderChoice = Choice & { kind: "slider" };
const isScrub = (ch: Choice | undefined): ch is SliderChoice => ch?.kind === "slider";

function markAt(x: number, y: number): string | null {
  for (const m of backdrop.querySelectorAll<HTMLElement>("mark")) {
    for (const r of m.getClientRects()) {
      if (x >= r.left && x <= r.right && y >= r.top - 2 && y <= r.bottom + 4) {
        return m.dataset["id"] ?? null;
      }
    }
  }
  return null;
}

const tokenOf = (e: Event, selector = ".token"): HTMLElement | null => {
  const b = e.target instanceof Element ? e.target.closest(selector) : null;
  return b instanceof HTMLElement ? b : null;
};

function pxPerStep(ch: SliderChoice): number {
  const s = ch.slider;
  const n = Math.max(1, (s.max - s.min) / s.step);
  return clamp(280 / n, 4, 40); // whole range in ~280px, but never too twitchy or too sluggish
}

function scrubTo(ch: SliderChoice, v: number): void {
  if (state.ended) {
    return;
  }
  const s = ch.slider;
  const n = Math.round((clamp(v, s.min, s.max) - s.min) / s.step);
  const next = clamp(Number((s.min + n * s.step).toFixed(6)), s.min, s.max);
  if (next === ch.value && ch.touched) {
    return;
  }
  ch.value = next;
  ch.touched = true;
  applyChoice(ch);
}

function showHint(ch: Choice): void {
  const a = anchorFor(ch.id);
  if (!a) {
    hideHint();
    return;
  }
  const r = a.getClientRects()[0] ?? a.getBoundingClientRect();
  hintEl.innerHTML = `<b>⟷</b> drag to change · click for more`;
  hintEl.hidden = false;
  hintEl.style.left = `${String(clamp(r.left + r.width / 2, 90, innerWidth - 90))}px`;
  hintEl.style.top = `${String(r.top)}px`;
}

export function hideHint(): void {
  hintEl.hidden = true;
}

function startPress(id: string | null, e: PointerEvent, el: HTMLElement): void {
  const ch = byChoiceId(id);
  const scrub = isScrub(ch) && !state.ended;
  state.press = {
    id: ch ? id : null,
    pointer: e.pointerId,
    x0: e.clientX,
    v0: ch?.value ?? 0,
    scrub,
    moved: false,
    inTa: el === ta,
  };
  if (scrub) {
    el.setPointerCapture(e.pointerId);
    hideHint();
  }
}

function endPress(e: PointerEvent, cancelled: boolean): void {
  const d = state.press;
  if (!d || e.pointerId !== d.pointer) {
    return;
  }
  state.press = null;
  document.body.classList.remove("scrubbing");
  if (d.moved || (cancelled && d.scrub)) {
    render();
    return;
  }
  if (cancelled) {
    return;
  }
  // a mouse drag that selected text isn't a click; a touch moves the caret only after pointerup, so skip the check there
  if (d.inTa && !d.scrub && e.pointerType !== "touch" && ta.selectionStart !== ta.selectionEnd) {
    return;
  }
  if (!d.id) {
    closePop();
  } else if (d.id === state.openId) {
    closePop();
  } else {
    openPop(d.id);
  }
}

const ARROWS: Partial<Record<string, number>> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 };

function scrubKey(ch: SliderChoice, e: KeyboardEvent): boolean {
  if (state.ended) {
    return false;
  }
  const s = ch.slider;
  const big = e.shiftKey ? 10 : 1;
  const d = ARROWS[e.key];
  if (d) {
    scrubTo(ch, ch.value + d * big * s.step);
  } else if (e.key === "Home") {
    scrubTo(ch, s.min);
  } else if (e.key === "End") {
    scrubTo(ch, s.max);
  } else {
    return false;
  }
  e.preventDefault();
  return true;
}

ta.addEventListener("mousemove", e => {
  if (state.press) {
    return;
  }
  const id = markAt(e.clientX, e.clientY);
  if (id !== state.hoverId) {
    state.hoverId = id;
    const ch = byChoiceId(id);
    ta.classList.toggle("on-mark", Boolean(id));
    ta.classList.toggle("on-scrub", isScrub(ch));
    for (const m of backdrop.querySelectorAll<HTMLElement>("mark")) {
      m.classList.toggle("hover", m.dataset["id"] === id);
    }
    if (isScrub(ch)) {
      showHint(ch);
    } else {
      hideHint();
    }
  }
});
ta.addEventListener("mouseleave", () => {
  state.hoverId = null;
  ta.classList.remove("on-mark", "on-scrub");
  hideHint();
  for (const m of backdrop.querySelectorAll("mark.hover")) {
    m.classList.remove("hover");
  }
});
// Pointer presses open on pointerup (see endPress), so this only answers Enter and Space, whose clicks have detail 0.
extrasEl.addEventListener("click", e => {
  const b = tokenOf(e);
  const id = b?.dataset["id"];
  if (!id || e.detail) {
    return;
  }
  if (id === state.openId) {
    closePop();
  } else {
    openPop(id);
  }
});

document.addEventListener("pointermove", e => {
  const d = state.press;
  if (!d?.scrub || e.pointerId !== d.pointer) {
    return;
  }
  const ch = byChoiceId(d.id);
  if (!isScrub(ch)) {
    state.press = null;
    return;
  }
  const dx = e.clientX - d.x0;
  if (!d.moved) {
    if (Math.abs(dx) < 4) {
      return;
    }
    d.moved = true;
    document.body.classList.add("scrubbing");
    if (state.openId) {
      closePop();
    }
  }
  scrubTo(ch, d.v0 + Math.round(dx / pxPerStep(ch)) * ch.slider.step);
});
document.addEventListener("pointerup", e => {
  endPress(e, false);
});
document.addEventListener("pointercancel", e => {
  endPress(e, true);
});

ta.addEventListener("pointerdown", e => {
  if (e.button !== 0) {
    return;
  }
  const id = markAt(e.clientX, e.clientY);
  if (isScrub(byChoiceId(id))) {
    e.preventDefault();
  }
  startPress(id, e, ta);
});
ta.addEventListener("mousedown", e => {
  if (isScrub(byChoiceId(markAt(e.clientX, e.clientY)))) {
    e.preventDefault();
  }
});
// stop the page from scrolling while a finger scrubs
ta.addEventListener(
  "touchstart",
  e => {
    const t = e.touches[0];
    if (t && isScrub(byChoiceId(markAt(t.clientX, t.clientY)))) {
      e.preventDefault();
    }
  },
  { passive: false },
);

extrasEl.addEventListener("pointerdown", e => {
  const b = tokenOf(e);
  if (!b || e.button !== 0) {
    return;
  }
  if (b.classList.contains("scrub")) {
    e.preventDefault();
    b.focus();
  }
  startPress(b.dataset["id"] ?? null, e, b);
});
extrasEl.addEventListener("pointerover", e => {
  const ch = byChoiceId(tokenOf(e, ".token.scrub")?.dataset["id"] ?? null);
  if (ch && !state.press) {
    showHint(ch);
  }
});
extrasEl.addEventListener("pointerout", e => {
  const to = e.relatedTarget instanceof Element ? e.relatedTarget.closest(".token.scrub") : null;
  if (tokenOf(e, ".token.scrub") && !to) {
    hideHint();
  }
});
extrasEl.addEventListener("keydown", e => {
  const ch = byChoiceId(tokenOf(e, ".token.scrub")?.dataset["id"] ?? null);
  if (isScrub(ch)) {
    hideHint();
    scrubKey(ch, e);
  }
});
ta.addEventListener("keydown", e => {
  if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) {
    return;
  }
  const p = ta.selectionStart;
  const ch = state.choices.find(c => !c.extra && c.kind === "slider" && p >= c.start && p <= c.end);
  if (isScrub(ch) && scrubKey(ch, e)) {
    ta.setSelectionRange(ch.end, ch.end);
  }
});
