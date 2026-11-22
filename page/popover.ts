import { canDecide, isAsk, optionLabels, textFor } from "./choice.ts";
import { clamp, errorMessage, esc, fmtNum } from "./format.ts";
import { isSuperseded, post } from "./client.ts";
import { commonsImage } from "./commons.ts";
import { demoDecide, demoExplain } from "./demo.ts";
import { hideHint } from "./pointer.ts";
import { journey, render } from "./render.ts";
import { applyChoice, demote } from "./request.ts";
import { backdrop, extrasEl, pop, ta } from "./dom.ts";
import { byChoiceId, state } from "./state.ts";
import type { Choice, Decide } from "./state.ts";

const KIND = { single: "pick one", multi: "pick any", slider: "slide, or drag the value in place" } as const;

interface ExplainedOption {
  label: string;
  emoji?: string | undefined;
  what?: string | undefined;
  good_for?: string | undefined;
  image?: string | undefined;
  /** The option's index, or -1 for an explained end of a numeric slider, which only the slider below sets. */
  i: number;
}

const newDecide = (): Decide => ({ qs: [], rec: null, busy: false, err: "", seq: 0 });

function query<T extends Element>(selector: string, type: new () => T, root: ParentNode = pop): T | null {
  const el = root.querySelector(selector);
  return el instanceof type ? el : null;
}
function onClick(selector: string, handler: (el: HTMLElement) => void): void {
  for (const el of pop.querySelectorAll<HTMLElement>(selector)) {
    el.addEventListener("click", () => {
      handler(el);
    });
  }
}
const dataIndex = (el: HTMLElement, key: string): number => Number(el.dataset[key]);

function customHTML(ch: Choice): string {
  return ch.custom
    ? `<button class="chip on" data-custom="1" ${state.ended ? "disabled" : ""}><span class="emo">✎</span>${esc(ch.custom)}</button>`
    : "";
}
function otherHTML(ch: Choice): string {
  return (
    `<div class="chips">` +
    customHTML(ch) +
    (ch.kind === "slider" || state.ended
      ? ""
      : `<button class="chip other" data-role="other"><span class="emo">+</span>Something else</button>`) +
    `</div>`
  );
}

function controlsHTML(ch: Choice): string {
  const { ended } = state;
  if (ch.kind === "slider") {
    const s = ch.slider;
    return `<div class="slider-val ${(ch.extra || ch.promo) && !ch.touched ? "unset" : ""}" data-role="sval"></div>
      <input type="range" data-role="range" min="${String(s.min)}" max="${String(s.max)}" step="${String(s.step)}" value="${String(ch.value)}" aria-label="${esc(ch.question)}" ${ended ? "disabled" : ""}>
      <div class="slider-ends"><span>${esc(s.minLabel || fmtNum(s.min))}</span><span>${esc(s.maxLabel || fmtNum(s.max))}</span></div>`;
  }
  const hint = (l: string): string =>
    ch.explanation?.options.find(x => x.label.toLowerCase() === l.toLowerCase())?.what ?? "";
  return (
    `<div class="chips">` +
    ch.options
      .map(
        (o, i) =>
          `<button class="chip ${ch.selected.includes(o.label) ? "on" : ""}" data-i="${String(i)}" title="${esc(hint(o.label))}" ${ended ? "disabled" : ""}>${o.emoji ? `<span class="emo">${esc(o.emoji)}</span>` : ""}${esc(o.label)}</button>`,
      )
      .join("") +
    customHTML(ch) +
    (ended ? "" : `<button class="chip other" data-role="other"><span class="emo">+</span>Something else</button>`) +
    `</div>`
  );
}

function explainHTML(c: Choice): string {
  if (!c.explainOpen) {
    return "";
  }
  if (c.explainBusy) {
    return `<div class="explain loading">Explaining in plain words…</div>`;
  }
  if (c.explainGone && !c.explanation) {
    return `<div class="explain">You didn't open this before sending, and explanations need the session, which has ended.</div>`;
  }
  if (c.explainErr) {
    return `<div class="explain err">Couldn't explain: ${esc(c.explainErr)}</div>`;
  }
  return c.explanation ? `<div class="explain"><p>${esc(c.explanation.intro)}</p></div>` : "";
}

function explainedOptions(ch: Choice): Array<ExplainedOption> {
  const ex = ch.explanation?.options ?? [];
  const find = (label: string, i: number) => ex.find(x => x.label.toLowerCase() === label.toLowerCase()) ?? ex[i] ?? {};
  if (ch.kind !== "slider") {
    return ch.options.map((o, i) => Object.assign({}, find(o.label, i), { label: o.label, emoji: o.emoji, i }));
  }
  const s = ch.slider;
  if (s.stops?.length) {
    return s.stops.map((st, i) => Object.assign({}, find(st, i), { label: st, i }));
  }
  return ex.map(x => Object.assign({}, x, { i: -1 }));
}

function isPicked(ch: Choice, o: ExplainedOption): boolean {
  if (ch.kind === "slider") {
    return o.i >= 0 && (!(ch.extra || ch.promo) || ch.touched) && Math.round(ch.value) === o.i;
  }
  return ch.selected.includes(o.label);
}
const isRecommended = (ch: Choice, o: ExplainedOption): boolean =>
  Boolean(ch.decide?.rec) && o.i >= 0 && ch.decide?.rec?.label.toLowerCase() === o.label.toLowerCase();

// A picture whose lookup fails is left out quietly.
type Picture = { status: "loading" | "none" } | { status: "ok"; src: string; page: string; title: string };
const images = new Map<string, Picture>();
const imgState = (q: string): Picture => images.get(q) ?? { status: "loading" };
const srcOf = (q: string | undefined): string | undefined => {
  const p = q === undefined ? undefined : images.get(q);
  return p?.status === "ok" ? p.src : undefined;
};
// two options landing on the same picture would mislead; keep only the first
const dupImage = (ch: Choice, o: ExplainedOption): boolean =>
  explainedOptions(ch).some(x => x.i < o.i && x.image && srcOf(x.image) === srcOf(o.image));

function loadImages(ch: Choice): void {
  if (!state.imagesOn) {
    return;
  }
  for (const o of ch.explanation?.options ?? []) {
    const q = (o.image ?? "").trim();
    if (!q || images.has(q)) {
      continue;
    }
    images.set(q, { status: "loading" });
    void commonsImage(q)
      .then(
        r => images.set(q, r ? { status: "ok", ...r } : { status: "none" }),
        () => images.set(q, { status: "none" }),
      )
      .finally(() => {
        refreshChoice(ch);
      });
  }
}

function cardsHTML(ch: Choice): string {
  const { ended } = state;
  if (ch.explainBusy) {
    return `<div class="cards skeleton">${(ch.options.length ? ch.options : [0, 0, 0]).map(() => `<div class="ocard"></div>`).join("")}</div>`;
  }
  const items = explainedOptions(ch);
  if (!items.length) {
    return "";
  }
  return (
    `<div class="cards">` +
    items
      .map(o => {
        const img = o.image && state.imagesOn ? imgState(o.image) : null;
        const pic = !img
          ? ""
          : img.status === "loading"
            ? `<span class="pic loading"></span>`
            : img.status === "ok" && !dupImage(ch, o)
              ? `<span class="pic"><img src="${esc(img.src)}" alt="${esc(o.label)}" loading="lazy" onerror="this.parentNode.remove()"></span>` +
                (img.page
                  ? `<a class="credit" href="${esc(img.page)}" target="_blank" rel="noopener" title="${esc(img.title)}">Wikimedia</a>`
                  : "")
              : "";
        const clickable = o.i >= 0;
        const rec = isRecommended(ch, o);
        return (
          `<button class="ocard ${ch.kind === "multi" ? "multi" : ""} ${isPicked(ch, o) ? "on" : ""} ${rec ? "rec" : ""} ${clickable ? "" : "static"}" ${clickable ? `data-card="${String(o.i)}"` : ""} ${clickable && !ended ? "" : "disabled"}>` +
          pic +
          (clickable ? `<span class="tick">✓</span>` : "") +
          `<span class="body">${rec ? `<span class="badge">Suggested for you</span>` : ""}<span class="name">${o.emoji ? `<span class="emo">${esc(o.emoji)}</span>` : ""}${esc(o.label)}</span>` +
          (o.what ? `<span class="what">${esc(o.what)}</span>` : "") +
          (o.good_for ? `<span class="for">Good for: ${esc(o.good_for)}</span>` : "") +
          `</span></button>`
        );
      })
      .join("") +
    `</div>`
  );
}

function decideHTML(ch: Choice): string {
  if (!canDecide(ch) || ch.explainBusy) {
    return "";
  }
  if (!ch.decide) {
    return state.ended
      ? ""
      : `<button class="decide-start" data-role="decide"><span class="emo">🧭</span>Help me decide</button>`;
  }
  return `<div class="decide"><div class="decide-head"><b>Help me decide</b><button data-role="decide-close">close</button></div>${decideBody(ch, ch.decide)}</div>`;
}

function decideBody(ch: Choice, d: Decide): string {
  const { ended } = state;
  const rec = d.rec ? explainedOptions(ch).find(o => isRecommended(ch, o)) : undefined;
  const recHTML =
    rec && d.rec
      ? `<div class="decide-rec"><span><b>Suggested: ${esc(rec.label)}.</b> ${esc(d.rec.why)}</span>` +
        `<button data-role="decide-pick" ${isPicked(ch, rec) || ended ? "disabled" : ""}>${isPicked(ch, rec) ? "Picked" : `Pick ${esc(rec.label)}`}</button></div>`
      : "";
  const qs = d.qs
    .map(
      (q, qi) =>
        `<div class="dq"><div class="dq-q">${esc(q.question)}</div><div class="chips">` +
        q.options
          .map(
            (o, oi) =>
              `<button class="chip ${q.answer === o.label ? "on" : ""}" data-dq="${String(qi)}" data-da="${String(oi)}" ${ended ? "disabled" : ""}>` +
              (o.emoji ? `<span class="emo">${esc(o.emoji)}</span>` : "") +
              `${esc(o.label)}</button>`,
          )
          .join("") +
        `</div></div>`,
    )
    .join("");
  const answered = d.qs.filter(q => q.answer).length;
  const status = d.busy
    ? `<div class="decide-busy">${d.qs.length ? "Weighing your answers…" : "Thinking of questions about you…"}</div>`
    : d.err
      ? `<div class="decide-err">Couldn't help decide: ${esc(d.err)}</div>`
      : d.qs.length && !answered
        ? `<div class="decide-head">${ended ? "You didn't answer these before sending." : "Answer any of these and I'll suggest one."}</div>`
        : "";
  return recHTML + qs + status;
}

function pickCard(ch: Choice, i: number): void {
  if (ch.kind === "slider") {
    ch.value = i;
    ch.touched = true;
    applyChoice(ch);
    openPop(ch.id);
    return;
  }
  const o = ch.options[i];
  if (!o) {
    return;
  }
  toggle(ch, o.label);
  if (!ch.extra && !ch.promo && ch.kind === "multi" && !ch.selected.length && !ch.custom) {
    applyChoice(ch, ch.orig);
  } else {
    applyChoice(ch);
  }
  openPop(ch.id);
}

/** Picks `label`: toggles it in a multi, replaces the pick (and anything typed) in a single. */
function toggle(ch: Choice, label: string): void {
  if (ch.kind === "multi") {
    ch.selected = ch.selected.includes(label) ? ch.selected.filter(l => l !== label) : [...ch.selected, label];
  } else {
    ch.selected = [label];
    ch.custom = "";
  }
}

function bindControls(ch: Choice, rerender: () => void, onPicked: () => void): void {
  if (ch.kind === "slider") {
    const r = query('[data-role="range"]', HTMLInputElement);
    const out = query('[data-role="sval"]', HTMLElement);
    if (!r || !out) {
      return;
    }
    const show = (): void => {
      const unset = (ch.extra || ch.promo) && !ch.touched;
      out.classList.toggle("unset", Boolean(unset));
      out.textContent = unset ? "not set: drag to choose" : textFor(ch);
    };
    show();
    r.addEventListener("input", () => {
      ch.value = Number(r.value);
      ch.touched = true;
      show();
      applyChoice(ch);
    });
    return;
  }
  onClick(".chip[data-i]", b => {
    const o = ch.options[dataIndex(b, "i")];
    if (!o) {
      return;
    }
    toggle(ch, o.label);
    if (!ch.extra && !ch.promo && ch.kind === "multi" && !ch.selected.length && !ch.custom) {
      applyChoice(ch, ch.orig);
      rerender();
      return;
    }
    applyChoice(ch);
    rerender();
    onPicked();
  });
  onClick("[data-custom]", () => {
    ch.custom = "";
    applyChoice(ch);
    rerender();
  });
  onClick('[data-role="other"]', b => {
    const inp = document.createElement("input");
    inp.className = "other-input";
    inp.placeholder = "Type your own, then Enter";
    inp.value = ch.custom;
    b.replaceWith(inp);
    inp.focus();
    inp.addEventListener("keydown", ev => {
      ev.stopPropagation();
      if (ev.key === "Enter" && inp.value.trim()) {
        ev.preventDefault();
        if (ch.kind === "single") {
          ch.selected = [];
        }
        ch.custom = inp.value.trim();
        applyChoice(ch);
        closePop();
        ta.focus();
      } else if (ev.key === "Escape") {
        closePop();
        ta.focus();
      }
    });
  });
}

function bindDecide(ch: Choice): void {
  onClick('[data-role="decide"]', () => {
    ch.decide = newDecide();
    void runDecide(ch);
  });
  onClick('[data-role="decide-close"]', () => {
    ch.decide = null;
    refreshChoice(ch);
  });
  onClick("[data-dq]", b => {
    const q = ch.decide?.qs[dataIndex(b, "dq")];
    const o = q?.options[dataIndex(b, "da")];
    if (!q || !o) {
      return;
    }
    q.answer = q.answer === o.label ? "" : o.label;
    void runDecide(ch);
  });
  onClick('[data-role="decide-pick"]', () => {
    const o = explainedOptions(ch).find(x => isRecommended(ch, x));
    if (o && !isPicked(ch, o)) {
      pickCard(ch, o.i);
    }
  });
}

function bindCards(ch: Choice): void {
  onClick("[data-card]", b => {
    pickCard(ch, dataIndex(b, "card"));
  });
}

async function runDecide(ch: Choice): Promise<void> {
  const d = ch.decide;
  if (!d || state.ended) {
    return;
  }
  const my = ++d.seq;
  d.busy = true;
  d.err = "";
  refreshChoice(ch);
  const answers = d.qs.filter(q => q.answer).map(q => ({ q: q.question, a: q.answer }));
  const payload = {
    text: ta.value,
    question: ch.question,
    options: optionLabels(ch),
    answers,
    asked: d.qs.map(q => q.question),
  };
  try {
    const r = state.mode === "live" ? await post("/api/decide", payload) : await demoDecide(ch, payload);
    if (ch.decide !== d || my !== d.seq) {
      return;
    }
    d.qs.push(...r.questions.map(q => ({ question: q.question, options: q.options, answer: "" })));
    d.rec = answers.length ? (r.recommendation ?? d.rec) : null;
  } catch (error) {
    if (isSuperseded(error) || ch.decide !== d || my !== d.seq) {
      return;
    }
    d.err = errorMessage(error);
  }
  d.busy = false;
  refreshChoice(ch);
}

async function toggleExplain(ch: Choice): Promise<void> {
  ch.explainOpen = !ch.explainOpen;
  if (ch.explainOpen && !ch.explanation && !ch.explainBusy && state.ended) {
    ch.explainErr = "";
    ch.explainGone = true;
  } else if (ch.explainOpen && !ch.explanation && !ch.explainBusy) {
    ch.explainBusy = true;
    ch.explainErr = "";
    refreshChoice(ch);
    const options = optionLabels(ch);
    try {
      ch.explanation =
        state.mode === "live"
          ? await post("/api/explain", { text: ta.value, question: ch.question, options })
          : await demoExplain(ch, options);
    } catch (error) {
      if (!isSuperseded(error)) {
        ch.explainErr = errorMessage(error);
      }
    }
    ch.explainBusy = false;
  }
  if (ch.explainOpen) {
    loadImages(ch);
  }
  refreshChoice(ch);
}

function openSheet(ch: Choice, d: Decide, keepScroll: number): void {
  const { ended } = state;
  const picked = [
    ...explainedOptions(ch)
      .filter(o => isPicked(ch, o))
      .map(o => o.label),
    ...(ch.custom ? [ch.custom] : []),
  ];
  pop.style.left = pop.style.top = pop.style.maxHeight = "";
  pop.innerHTML =
    `<div class="sheet-head"><div class="sheet-title"><div class="sheet-kicker">🧭 Help me decide</div><div class="sheet-q">${esc(ch.question)}</div></div>` +
    (ended ? "" : `<button class="link" data-role="decide-restart">Start over</button>`) +
    `<button class="sheet-x" data-role="sheet-close" aria-label="Back to request" title="Back to request (Esc)">✕</button></div>` +
    `<div class="sheet-body"><section class="sheet-you"><div class="sheet-label">About you</div>${decideBody(ch, d)}</section>` +
    `<section class="sheet-opts"><div class="sheet-label">Your options</div>${explainHTML(ch)}${cardsHTML(ch)}${otherHTML(ch)}</section></div>` +
    `<div class="sheet-foot"><span>${picked.length ? `${ended ? "You sent" : "Your request will say"} <b>${esc(picked.join(", "))}</b>` : "Nothing picked yet"}</span>` +
    `<button class="sheet-done" data-role="sheet-close">Back to request</button></div>`;
  pop.hidden = false;
  const body = query(".sheet-body", HTMLElement);
  if (body) {
    body.scrollTop = keepScroll;
  }
  bindControls(
    ch,
    () => {
      openPop(ch.id);
    },
    () => {},
  );
  bindCards(ch);
  bindDecide(ch);
  onClick('[data-role="sheet-close"]', () => {
    closePop();
    ta.focus();
  });
  onClick('[data-role="decide-restart"]', () => {
    ch.decide = newDecide();
    void runDecide(ch);
  });
  render();
}

export function openPop(id: string): void {
  const ch = byChoiceId(id);
  if (!ch) {
    return;
  }
  const { ended } = state;
  state.openId = id;
  hideHint();
  const footLeft = ch.extra
    ? "not in your request yet"
    : ch.promo
      ? ch.settled
        ? "you added this"
        : "left out if you don't pick"
      : isAsk(ch)
        ? ch.settled
          ? `you asked “${esc(ch.orig)}”`
          : "your question: pick an answer to write it in"
        : `was “${esc(ch.orig)}”`;
  const wide = ch.explainOpen && !ch.explainErr;
  const numeric = ch.kind === "slider" && !ch.slider.stops?.length;
  const sheet = wide && ch.decide !== null && canDecide(ch);
  pop.classList.toggle("wide", wide && !sheet);
  pop.classList.toggle("sheet", sheet);
  const scroller = (): Element | null => (sheet ? pop.querySelector(".sheet-body") : pop);
  const keepScroll = state.openedFor === id ? (scroller()?.scrollTop ?? 0) : 0;
  state.openedFor = id;
  if (sheet && ch.decide) {
    openSheet(ch, ch.decide, keepScroll);
    return;
  }
  const reset = ch.extra ? "leave open" : ch.promo ? "clear" : isAsk(ch) ? "back to question" : "reset";
  pop.innerHTML = `<div class="pop-head"><span class="pop-q">${esc(ch.question)}</span>${ended ? "" : `<span class="pop-kind">${KIND[ch.kind]}</span>`}</div>
    ${explainHTML(ch)}
    ${wide ? decideHTML(ch) + cardsHTML(ch) : ""}
    <div>${wide && !numeric ? otherHTML(ch) : controlsHTML(ch)}</div>
    <div class="pop-note">${footLeft}</div>
    <div class="pop-foot"><span class="pop-tools">${
      wide
        ? `<button class="explain-btn" data-role="explain">Hide explanation</button>`
        : `${canDecide(ch) && !ended ? `<button class="explain-btn" data-role="decide-open">🧭 Help me decide</button>` : ""}<button class="explain-btn" data-role="explain">Explain me</button>`
    }</span>
    <span>${ended ? `<span class="ro-note">${ended} · read-only</span>` : `${ch.promo ? `<button data-role="remove">remove sentence</button>` : ""}${ch.promo && !ch.settled ? "" : `${ch.promo ? " · " : ""}<button data-role="reset">${reset}</button>`}`}</span></div>`;
  pop.hidden = false;
  positionPop();
  pop.scrollTop = keepScroll;
  const multi = ch.kind === "multi";
  // In the expanded view a pick keeps the panel open so you can compare; Esc or a click outside closes it.
  bindControls(
    ch,
    () => {
      openPop(ch.id);
    },
    () => {
      if (!multi && !wide) {
        setTimeout(closePop, 200);
      }
    },
  );
  bindCards(ch);
  bindDecide(ch);
  onClick('[data-role="explain"]', () => {
    void toggleExplain(ch);
  });
  // opens the explained panel too: the suggestion is shown on its cards
  onClick('[data-role="decide-open"]', () => {
    if (!ch.decide) {
      ch.decide = newDecide();
      void runDecide(ch);
    }
    if (!ch.explainOpen) {
      void toggleExplain(ch);
    }
  });
  onClick('[data-role="reset"]', () => {
    ch.selected = [];
    ch.custom = "";
    ch.touched = false;
    if (ch.kind === "slider") {
      ch.value = clamp(ch.slider.value ?? ch.slider.min, ch.slider.min, ch.slider.max);
    }
    applyChoice(ch, ch.extra || ch.promo ? "" : ch.orig);
    closePop();
  });
  onClick('[data-role="remove"]', () => {
    demote(ch);
  });
  render();
}

export const anchorFor = (id: string): HTMLElement | null =>
  backdrop.querySelector<HTMLElement>(`mark[data-id="${id}"]`) ??
  extrasEl.querySelector<HTMLElement>(`[data-id="${id}"]`);

export function positionPop(): void {
  if (pop.classList.contains("sheet") || !state.openId) {
    return; // placed by CSS
  }
  const a = anchorFor(state.openId);
  if (!a) {
    return;
  }
  if (pop.classList.contains("wide")) {
    // the expanded panel sits under the whole request card so the sentence stays readable while you pick
    const c = document.querySelector(".card")?.getBoundingClientRect();
    const pw = pop.offsetWidth;
    if (c) {
      const top = c.bottom + 10;
      const room = innerHeight - top - 12;
      if (room >= 320) {
        pop.style.left = `${String(clamp(c.left + (c.width - pw) / 2, 16, innerWidth - pw - 16))}px`;
        pop.style.top = `${String(top)}px`;
        pop.style.maxHeight = `${String(room)}px`;
        return;
      }
    }
  }
  pop.style.maxHeight = "";
  const rs = a.getClientRects();
  const r = rs.item(rs.length - 1) ?? a.getBoundingClientRect();
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  let top = r.bottom + 10;
  if (top + ph > innerHeight - 12) {
    top = r.top - ph - 10 > 12 ? r.top - ph - 10 : innerHeight - ph - 12;
  }
  pop.style.left = `${String(clamp(r.left - 12, 16, innerWidth - pw - 16))}px`;
  pop.style.top = `${String(Math.max(12, top))}px`;
}

export function closePop(): void {
  if (!state.openId) {
    return;
  }
  if (pop.classList.contains("sheet")) {
    // reopen as the small popover; Help me decide resumes the sheet
    const c = byChoiceId(state.openId);
    if (c) {
      c.explainOpen = false;
    }
  }
  state.openId = null;
  state.openedFor = null;
  pop.hidden = true;
  render();
}

export function refreshChoice(ch: Choice): void {
  if (state.openId === ch.id) {
    openPop(ch.id);
  } else {
    journey();
  }
}
