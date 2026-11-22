// Drawing the request: underlines in the backdrop, extras as tokens, the toolbar and the "Where you are" timeline.

import { cap, esc, isAsk, isSet, textFor, tokenValue } from "./choice.ts";
import { anchorFor, openPop, positionPop } from "./popover.ts";
import { renderGrips, tidyLists } from "./rank.ts";
import { hasTidyLayout, isHeading } from "./request.ts";
import { $, backdrop, extrasEl, moreBtn, sendBtn, state, ta, tidyBtn } from "./state.ts";
import { segments, tidyOrUndo } from "./tidy.ts";

// plain text between underlines; headings added by Tidy up are dimmed (colour only, so the caret stays aligned)
const plain = (s: string): string =>
  !state.tidyHeads.size
    ? esc(s)
    : s
        .split("\n")
        .map(l => (isHeading(l) ? `<span class="hd">${esc(l)}</span>` : esc(l)))
        .join("\n");

export function render(flashId?: string): void {
  const text = ta.value;
  const marks = state.choices.filter(c => !c.extra && c.start >= 0).toSorted((a, b) => a.start - b.start);
  let html = "";
  let pos = 0;
  for (const c of marks) {
    if (c.start < pos) {
      continue;
    }
    html += plain(text.slice(pos, c.start));
    const cls = [
      c.kind === "slider" ? "scrub" : "",
      state.drag?.id === c.id ? "scrubbing" : "",
      c.settled ? "settled" : "",
      c.promo && !c.settled ? "ph" : "",
      isAsk(c) ? "ask" : "",
      c.id === state.openId ? "active" : "",
      c.id === state.hoverId ? "hover" : "",
      c.id === flashId ? "flash" : "",
      c.id === state.nudgeId ? "nudge" : "",
    ].join(" ");
    html += `<mark data-id="${c.id}" class="${cls}">${esc(text.slice(c.start, c.end))}</mark>`;
    pos = c.end;
  }
  backdrop.innerHTML = html + plain(text.slice(pos)) + "​";
  ta.style.height = "auto";
  ta.style.height = `${String(ta.scrollHeight)}px`;
  $("summaryText").textContent =
    state.summary || (state.busy ? "Reading your request…" : text.trim() ? "" : "What do you need help with?");
  sendBtn.disabled = !text.trim() || Boolean(state.ended);
  renderGrips();
  renderExtras();
  journey();
}

export function renderExtras(): void {
  const extras = state.choices.filter(c => c.extra && c.settled);
  const active = document.activeElement;
  const focused = active instanceof HTMLElement && extrasEl.contains(active) ? active.dataset["id"] : undefined;
  extrasEl.innerHTML = extras
    .map(c => {
      const open = c.id === state.openId ? "active" : "";
      if (c.kind === "slider") {
        const s = c.slider;
        const v = textFor(c);
        return (
          `<button class="token scrub ${c.settled ? "settled" : "unset"} ${open} ${state.drag?.id === c.id ? "scrubbing" : ""}" data-id="${c.id}" ` +
          `role="slider" aria-label="${esc(c.question)}" aria-valuemin="${String(s.min)}" aria-valuemax="${String(s.max)}" aria-valuenow="${String(c.value)}" aria-valuetext="${esc(v)}">` +
          `<span class="k">${esc(c.token)}:</span> <span class="v">${esc(v)}</span></button>`
        );
      }
      const v = tokenValue(c);
      return (
        `<button class="token ${c.settled ? "settled" : "unset"} ${open}" data-id="${c.id}" title="${esc(c.question)}">` +
        `<span class="k">${esc(c.token)}:</span> <span class="v">${v ? esc(v) : "?"}</span></button>`
      );
    })
    .join("");
  renderMore();
  renderTidy();
  if (focused) {
    extrasEl.querySelector<HTMLElement>(`[data-id="${focused}"]`)?.focus();
  }
  if (state.openId) {
    positionPop();
  }
}

export function setStatus(kind: "" | "busy" | "err", msg: string): void {
  state.statusKind = kind;
  $("status").className = "status " + kind;
  $("statusText").innerHTML = msg;
  $("summary").classList.toggle("loading", kind === "busy" && !state.summary);
  journey();
}

function renderMore(): void {
  moreBtn.hidden = !state.lastAnalyzed || Boolean(state.ended);
  moreBtn.disabled = state.moreBusy;
  moreBtn.innerHTML = state.moreBusy
    ? 'Thinking<span class="long"> of more</span>…'
    : '+ More<span class="long"> questions</span>';
}

function renderTidy(): void {
  const { tidyUndo } = state;
  if (tidyUndo && ta.value !== tidyUndo.after) {
    state.tidyUndo = null;
  }
  const undo = state.tidyUndo;
  const n = undo ? 0 : segments(ta.value).length;
  tidyBtn.hidden = Boolean(state.ended) || !state.lastAnalyzed || (!undo && n < 3);
  tidyBtn.disabled = state.tidyBusy || ((state.busy || state.moreBusy) && !undo);
  tidyBtn.classList.toggle("undo", Boolean(undo));
  tidyBtn.innerHTML = state.tidyBusy
    ? "Tidying…"
    : undo
      ? '↶ Undo<span class="long"> tidy</span>'
      : hasTidyLayout()
        ? "Tidy again"
        : 'Tidy<span class="long"> up</span>';
}

// Four steps: the model reads -> you shape it -> you read it over and send -> your agent takes over.
// The side timeline (a compact stepper on narrow screens), the toolbar status and the Send button all say
// what is happening now and what you're expected to do.
export function openItems() {
  return state.choices
    .filter(c => !c.extra && c.start >= 0 && ((c.promo && !c.settled) || (isAsk(c) && !isSet(c))))
    .toSorted((a, b) => a.start - b.start);
}

function waits(): string[] {
  const M = esc(cap(state.modelName));
  const w: string[] = [];
  if (state.busy && state.lastAnalyzed) {
    w.push(`${M} is re-reading your edit`);
  }
  if (state.moreBusy) {
    w.push(`${M} is looking for more questions`);
  }
  if (state.tidyBusy) {
    w.push(`${M} is sorting it into must-haves and nice-to-haves`);
  }
  for (const c of state.choices) {
    if (c.explainBusy) {
      w.push(`Explaining “${esc(c.question)}”`);
    }
    if (c.decide?.busy) {
      w.push(
        c.decide.qs.length
          ? `Weighing your answers on “${esc(c.question)}”`
          : `Thinking of questions about you for “${esc(c.question)}”`,
      );
    }
  }
  return w;
}

export function showNext(): void {
  const open = openItems();
  const i = open.findIndex(c => c.id === state.openId);
  const ch = open[(i + 1) % open.length];
  if (!ch) {
    return;
  }
  anchorFor(ch.id)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  openPop(ch.id);
}

interface Step {
  title: string;
  now: string;
  next?: string;
  done?: string;
  wait?: boolean;
}

export function journey(): void {
  const { ended, tidyUndo } = state;
  const open = openItems();
  const n = open.length;
  const w = waits();
  const A = esc(cap(state.agentName));
  const agent = esc(state.agentName);
  const empty = !ta.value.trim();
  const at = ended ? 3 : !state.lastAnalyzed ? 0 : n ? 1 : 2;
  const readErr = at === 0 && state.statusKind === "err";
  const blanks = open.filter(c => c.promo).length;
  const asks = n - blanks;
  const left = [
    blanks && `${String(blanks)} blank${blanks === 1 ? "" : "s"}`,
    asks && `${String(asks)} question${asks === 1 ? "" : "s"}`,
  ]
    .filter(Boolean)
    .join(" and ");
  const nextBtn = n
    ? ` <button data-j="next">Show me ${n > 1 || !open.some(c => c.id === state.openId) ? "the next one" : "it"}</button>`
    : "";
  const steps: Step[] = [
    {
      title: empty && !state.busy ? "Write your request" : `${esc(cap(state.modelName))} reads your request`,
      now: readErr
        ? "Couldn't read it. Use retry under the request, or edit it and it will try again."
        : empty
          ? "Type what you need help with. Reading starts when you pause."
          : `Looking for the parts you could flip and what's missing. This takes a few seconds; you can keep typing.`,
      done: state.readInfo ? `Read by ${esc(state.readInfo)}.` : "Read.",
      wait: !readErr && !empty,
    },
    {
      title: "You shape it",
      now: `<b>${left} left to answer.</b> Click an underline to flip it or fill a <span class="ph-sample">[blank]</span>. Each one has Explain me and Help me decide.${nextBtn}`,
      next: "Underlines appear on your request: click them to flip choices and fill the blanks.",
      done: ended ? "Shaped." : "Nothing left open. You can still flip any underline.",
    },
    {
      title: "Read it over and send",
      now:
        `Everything's answered. Give it a last read, then press <b>Shift+Enter</b> or ↑ to send it to ${agent}.` +
        (tidyUndo && ta.value === tidyUndo.after
          ? ` Not how you'd group it? <button data-j="tidy">Undo tidy</button>.`
          : !hasTidyLayout() && segments(ta.value).length >= 5
            ? ` Long? <button data-j="tidy">Tidy it up</button> into a short paragraph, must-haves and nice-to-haves.`
            : "") +
        (tidyLists().length
          ? ` Drag the <span class="grip-sample">⋮⋮</span> beside an item to rank it or move it to the other list; the order is what gets sent.`
          : ""),
      next: `Press <b>Shift+Enter</b> whenever it reads right. You can send early: unfilled blanks are left out.`,
      done: ended === "cancelled" ? "Cancelled before sending." : "Sent.",
    },
    {
      title: `Back to ${agent}`,
      now:
        ended === "sent"
          ? `${A} has your request and takes it from here. Head back to it; this page stays to look back at.`
          : `Nothing was sent, so ${agent} stops here.`,
      next: `${A} picks up the sharpened request and starts the work. This page turns read-only.`,
    },
  ];
  const waitList = (extra: string): string =>
    w.length ? `<ul class="j-waits">${w.map(x => `<li>${x}…</li>`).join("")}${extra}</ul>` : "";
  $("jSteps").innerHTML = steps
    .map((s, i) => {
      const stepState =
        i < at || (i === 3 && ended === "sent") ? "done" : i === at ? "now" : i === at + 1 ? "next" : "later";
      const cls = [
        stepState,
        i === at ? "now" : "",
        i === at && s.wait && !readErr && !empty ? "wait" : "",
        i === at && readErr ? "err" : "",
        (i === 2 || i === 3) && ended === "cancelled" ? "off" : "",
      ].join(" ");
      const tag =
        i === at
          ? readErr
            ? "Stuck"
            : ended === "sent"
              ? "Done"
              : ended
                ? "Cancelled"
                : "Now"
          : stepState === "next"
            ? "Next"
            : "";
      const text = stepState === "done" && i !== at ? s.done : i === at ? s.now : stepState === "next" ? s.next : "";
      const wl = i === at ? waitList(`<li class="j-also">You can keep going meanwhile.</li>`) : "";
      return (
        `<li class="j-step ${cls}" ${i === at ? 'aria-current="step"' : ""}><span class="j-dot" aria-hidden="true"></span>` +
        `<span class="j-title">${s.title}${tag ? `<span class="j-tag">${tag}</span>` : ""}</span>` +
        (text ? `<div class="j-text">${text}</div>` : "") +
        wl +
        `</li>`
      );
    })
    .join("");
  const cur = steps[at];
  const then = steps[at + 1];
  $("jNow").innerHTML =
    `<div class="j-text"><b>${cur?.title ?? ""}.</b> ${cur?.now ?? ""}</div>` +
    waitList("") +
    (then && !ended ? `<div class="j-then">Then: ${then.title.replace(/^./, c => c.toLowerCase())}.</div>` : "");
  for (const b of document.querySelectorAll<HTMLElement>('#journey [data-j="next"]')) {
    b.addEventListener("click", showNext);
  }
  for (const b of document.querySelectorAll<HTMLElement>('#journey [data-j="tidy"]')) {
    b.addEventListener("click", tidyOrUndo);
  }

  const card = $("card");
  card.classList.toggle("working", !ended && (state.busy || state.moreBusy || w.length > 0));
  card.classList.toggle("reading", !ended && state.busy && !state.lastAnalyzed);
  sendBtn.classList.toggle("ready", !ended && at === 2 && !state.busy && !empty);
  if (!ended && state.lastAnalyzed && state.statusKind === "") {
    const st = $("status");
    st.className = "status" + (w.length ? " busy" : "");
    st.title = state.readInfo ? `read by ${state.readInfo}` : "";
    $("statusText").innerHTML = w.length
      ? `${w[0] ?? ""}…`
      : n
        ? `${String(n)} to answer · <button class="next-btn" data-j="next">next →</button>`
        : empty
          ? "waiting for a request"
          : `ready · press Shift+Enter`;
    st.querySelector('[data-j="next"]')?.addEventListener("click", showNext);
  }
}
