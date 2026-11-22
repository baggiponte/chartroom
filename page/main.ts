import { isRecord } from "../skills/help-me/schema.ts";
import type { Analysis } from "../skills/help-me/tasks.ts";
import { chatHost, inChat } from "./chat.ts";
import { isAsk, isSet, makeChoice, textFor } from "./choice.ts";
import { cap, errorMessage, esc } from "./format.ts";
import { STALE, getInit, isSuperseded, post, staleFor } from "./client.ts";
import { demoAnalyze } from "./demo.ts";
import { closePop, openPop, positionPop } from "./popover.ts";
import { hideHint } from "./pointer.ts";
import { caretMove, renderGrips, undoMove } from "./rank.ts";
import { openItems, render, setStatus } from "./render.ts";
import { overlaps, promote, relocate, sentenceRange, withoutOpen } from "./request.ts";
import { $, extrasEl, moreBtn, pop, sendBtn, ta, tidyBtn } from "./dom.ts";
import { state } from "./state.ts";
import type { Choice } from "./state.ts";
import { tidyOrUndo, undoTidy } from "./tidy.ts";

const EXAMPLE = "Help me choose a home coffee machine for my small kitchen, something good for lattes.";

function schedule(ms = 700): void {
  clearTimeout(state.timer);
  state.timer = setTimeout(() => void analyze(), ms);
}

async function analyze({ more = false } = {}): Promise<void> {
  if (state.ended) {
    return;
  }
  const text = ta.value;
  if (!more && text === state.lastAnalyzed) {
    return;
  }
  if (!text.trim()) {
    setStatus("", "waiting for a request");
    return;
  }
  const my = more ? state.analysisSeq : ++state.analysisSeq;
  if (more) {
    state.moreBusy = true;
  } else {
    state.busy = true;
  }
  render();
  setStatus("busy", more ? `${esc(state.modelName)} is looking for more…` : `${esc(state.modelName)} is reading…`);
  const extras = state.choices.filter(c => c.extra);
  const payload = {
    text: withoutOpen(text),
    more,
    settled: state.choices.filter(c => !c.extra && c.settled).map(c => c.cur),
    answers: extras.filter(c => c.settled).map(c => `${c.token}: ${textFor(c)}`),
    asked: [...extras, ...state.choices.filter(c => c.promo)]
      .map(c => c.question)
      .concat(state.removed.map(r => r.question)),
  };
  let data: Analysis;
  try {
    data = state.mode === "live" ? await post("/api/analyze", payload) : await demoAnalyze(text, more);
  } catch (e) {
    if (more) {
      state.moreBusy = false;
      render();
    }
    if (my !== state.analysisSeq || isSuperseded(e)) {
      return;
    }
    state.busy = false;
    render();
    setStatus("err", `couldn't analyse: ${esc(errorMessage(e))} · <button id="retry">retry</button>`);
    $("retry").addEventListener("click", () => {
      state.lastAnalyzed = null;
      void analyze({ more });
    });
    return;
  }
  if (more) {
    state.moreBusy = false;
  } else {
    state.busy = false;
  }
  if (my !== state.analysisSeq || ta.value !== text) {
    render();
    return;
  }
  const first = !state.lastAnalyzed && !more;
  if (!more) {
    state.lastAnalyzed = text;
    state.readInfo =
      state.mode === "demo"
        ? "the demo"
        : `${data.model || state.modelName}${data.ms ? ` in ${(data.ms / 1000).toFixed(1)}s` : ""}`;
  }
  merge(text, data, more);
  if (first) {
    state.nudgeId = openItems()[0]?.id ?? null;
    if (state.nudgeId) {
      render();
      setTimeout(() => {
        state.nudgeId = null;
      }, 3300);
    }
  }
  setStatus("", "");
}

/** A fresh read keeps what you've set and replaces the rest; "+ more" only adds extras. */
function merge(text: string, data: Analysis, more: boolean): void {
  if (!more && data.summary) {
    state.summary = data.summary;
  }
  const kept = more ? state.choices : state.choices.filter(c => c.settled || c.promo);
  const seen = new Set(
    [...state.removed, ...kept.filter(c => c.extra || c.promo)].flatMap(c => [
      c.question.toLowerCase(),
      c.token.toLowerCase(),
    ]),
  );
  const taken = kept
    .filter(c => !c.extra)
    .map(c => (c.promo ? sentenceRange(c, text) : ([c.start, c.end] as [number, number])));
  const fresh: Array<Choice> = [];
  for (const raw of data.choices) {
    const ch = makeChoice(raw);
    if (!ch) {
      continue;
    }
    if (ch.type === "extra") {
      if (seen.has(ch.question.toLowerCase()) || seen.has(ch.token.toLowerCase())) {
        continue;
      }
      seen.add(ch.question.toLowerCase());
      seen.add(ch.token.toLowerCase());
      fresh.push(ch);
      continue;
    }
    if (more) {
      continue;
    }
    let i = text.indexOf(ch.span);
    if (i < 0) {
      const j = text.toLowerCase().indexOf(ch.span.toLowerCase());
      if (j < 0) {
        continue;
      }
      i = j;
      ch.span = ch.orig = ch.cur = text.slice(j, j + ch.span.length);
    }
    if (overlaps(taken, i, i + ch.span.length)) {
      continue;
    }
    ch.start = i;
    ch.end = i + ch.span.length;
    taken.push([ch.start, ch.end]);
    fresh.push(ch);
  }
  if (state.openId && !kept.some(k => k.id === state.openId)) {
    closePop();
  }
  state.choices = [...kept, ...fresh];
  for (const ch of fresh) {
    if (ch.extra && !ch.settled) {
      promote(ch);
    }
  }
  if (fresh.some(c => c.promo) && !more) {
    state.lastAnalyzed = ta.value;
  }
  render();
}

function compose(): string {
  let out = withoutOpen();
  const set = state.choices.filter(c => c.extra && c.settled);
  if (set.length) {
    out += "\n\n" + set.map(c => `- ${c.token}: ${textFor(c)}`).join("\n");
  }
  return out;
}

const q = (s: string): string => `<b>${esc(s)}</b>`;

function sentNotes(): Array<string> {
  const text = ta.value;
  const n: Array<string> = [];
  const { choices, removed } = state;
  const open = choices.filter(c => c.promo && !c.settled && c.start >= 0);
  if (open.length) {
    n.push(`Left out, unanswered: ${open.map(c => q(c.question)).join(", ")}.`);
  }
  const unset = choices.filter(c => c.extra && !c.settled);
  if (unset.length) {
    n.push(`Not sent: ${unset.map(c => q(c.token || c.question)).join(", ")}.`);
  }
  if (removed.length) {
    n.push(`Removed by you: ${removed.map(r => q(r.question)).join(", ")}.`);
  }
  const asks = choices.filter(c => isAsk(c) && c.start >= 0 && !isSet(c));
  if (asks.length) {
    n.push(`Sent as the question you wrote: ${asks.map(c => q(c.orig)).join(", ")}.`);
  }
  const kept = choices.filter(c => c.type === "underline" && c.start >= 0 && text.slice(c.start, c.end) === c.orig);
  if (kept.length) {
    n.push(`Kept as you wrote it: ${kept.map(c => q(c.orig)).join(", ")}.`);
  }
  n.push("Explain me and Help me decide stay on this page. Only the text above goes back.");
  return n;
}

const LOOK_BACK = "read-only now: click an underline to look back at what you picked and why";

async function submit(): Promise<void> {
  if (state.ended || !withoutOpen()) {
    return;
  }
  closePop();
  const prompt = compose();
  const notes = sentNotes();
  const { chat } = state;
  if (chat && state.mode === "live") {
    // the shaped request goes into the conversation as the user's own message
    const failed = await chat.request("ui/message", { role: "user", content: [{ type: "text", text: prompt }] }).then(
      r => (isRecord(r) && r["isError"] ? "" : null),
      (e: unknown) => `: ${esc(errorMessage(e))}`,
    );
    if (failed !== null) {
      setStatus("err", `couldn't send it to the chat${failed}`);
      return;
    }
    post("/api/submit", { prompt }).catch(() => {});
    end("sent", "Sent to Claude", LOOK_BACK, prompt, notes);
  } else if (state.mode === "live") {
    let sent;
    try {
      ({ sent } = await post("/api/submit", { prompt }));
    } catch (e) {
      setStatus("err", "couldn't reach the help-me server: " + esc(errorMessage(e)));
      return;
    }
    end("sent", `Sent to ${state.agentName}`, LOOK_BACK, sent, notes);
  } else {
    try {
      await navigator.clipboard.writeText(prompt);
    } catch {
      // no clipboard here: the prompt is still shown under "see what was sent"
    }
    end("sent", "Copied to clipboard", "demo mode: paste it into your agent", prompt, notes);
  }
}

async function cancel(): Promise<void> {
  if (state.ended) {
    return;
  }
  if (state.mode === "live") {
    await post("/api/cancel", {}).catch(() => {});
    state.chat
      ?.request("ui/update-model-context", {
        content: [{ type: "text", text: "The user cancelled /help-me without sending a request." }],
      })
      .catch(() => {});
  }
  closePop();
  end("cancelled", "Cancelled", `nothing was sent to ${state.agentName}`, "");
}

// The help-me server exits once you send, so from here on everything the page shows comes from what it already has.
function end(kind: "sent" | "cancelled", title: string, sub: string, prompt: string, notes: Array<string> = []): void {
  state.ended = kind;
  clearTimeout(state.timer);
  state.analysisSeq++;
  state.tidySeq++;
  state.busy = state.moreBusy = state.tidyBusy = false;
  for (const c of state.choices) {
    if (c.decide) {
      c.decide.busy = false;
      c.decide.seq++;
    }
  }
  document.body.classList.add("ended");
  ta.readOnly = true;
  ta.blur();
  const bar = $("endedBar");
  bar.hidden = false;
  bar.classList.toggle("cancelled", kind === "cancelled");
  $("endedTitle").textContent = title;
  $("endedSub").textContent = sub;
  const sent = $("endedSent");
  const show = $("endedShow");
  $("endedPrompt").textContent = prompt;
  show.hidden = !prompt;
  $("sentNotes").innerHTML = notes.map(s => `<li>${s}</li>`).join("");
  show.addEventListener("click", () => {
    sent.hidden = !sent.hidden;
    show.textContent = sent.hidden ? "see what was sent" : "hide what was sent";
  });
  $("hint").textContent =
    kind === "sent"
      ? "This session is closed. Underlines, Explain me and Help me decide still show what you chose; run /help-me again to start a new one."
      : "This session is closed. Run /help-me again to start a new one.";
  setStatus("", kind === "sent" ? "sent" : "cancelled");
  render();
}

const undoKey = (e: KeyboardEvent): boolean => e.key.toLowerCase() === "z" && (e.metaKey || e.ctrlKey) && !e.shiftKey;

moreBtn.addEventListener("click", () => void analyze({ more: true }));
tidyBtn.addEventListener("click", tidyOrUndo);
sendBtn.addEventListener("click", () => void submit());
$("cancel").addEventListener("click", () => void cancel());

ta.addEventListener("input", () => {
  relocate(ta.value);
  render();
  if (ta.value !== state.skipNextAnalysisFor) {
    schedule();
  }
});
ta.addEventListener("keydown", e => {
  if (undoKey(e) && undoMove()) {
    e.preventDefault();
    return;
  }
  if (undoKey(e) && state.tidyUndo && ta.value === state.tidyUndo.after) {
    e.preventDefault();
    undoTidy();
    return;
  }
  if (
    e.altKey &&
    e.shiftKey &&
    (e.key === "ArrowUp" || e.key === "ArrowDown") &&
    caretMove(e.key === "ArrowUp" ? -1 : 1)
  ) {
    e.preventDefault();
    return;
  }
  if (e.key === "Enter" && e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void submit();
  } else if (e.key === "ArrowDown" && e.altKey) {
    const p = ta.selectionStart;
    const at = state.choices.find(c => !c.extra && p >= c.start && p <= c.end);
    if (at) {
      e.preventDefault();
      openPop(at.id);
    }
  }
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && state.openId) {
    closePop();
    ta.focus();
    return;
  }
  if (e.key === "Enter" && e.shiftKey && e.target === document.body) {
    e.preventDefault();
    void submit();
  }
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.target !== ta) {
    e.preventDefault();
    void submit();
  }
});
document.addEventListener("mousedown", e => {
  const t = e.target instanceof Node ? e.target : null;
  if (state.openId && !pop.contains(t) && t !== ta && !extrasEl.contains(t)) {
    closePop();
  }
});
addEventListener("resize", () => {
  renderGrips();
  if (state.openId) {
    positionPop();
  }
});
addEventListener(
  "scroll",
  e => {
    if (e.target instanceof Node && pop.contains(e.target)) {
      return;
    }
    hideHint();
    if (state.openId) {
      positionPop();
    }
  },
  true,
);

async function start(): Promise<void> {
  const chat = inChat() ? chatHost() : null;
  state.chat = chat;
  try {
    if (!chat && location.protocol === "file:") {
      throw new Error("no server behind a file");
    }
    const j = chat
      ? await chat.init().catch((e: unknown) => {
          chat.failed = errorMessage(e);
          throw e;
        })
      : await getInit();
    state.modelName = j.model || "the model";
    state.agentName = j.agent || "your agent";
    document.querySelectorAll(".agentName").forEach((el, i) => {
      el.textContent = i === 2 ? cap(state.agentName) : state.agentName;
    });
    sendBtn.title = `Send to ${state.agentName} (Shift+Enter)`;
    ta.value = j.draft || "";
    state.imagesOn = j.images;
    if (staleFor(j)) {
      $("hint").textContent = cap(STALE) + ".";
    }
  } catch {
    state.mode = "demo";
    state.modelName = "demo";
    ta.value = EXAMPLE;
    $("hint").innerHTML = "Demo mode: canned underlines, since this page wasn't opened by <code>/help-me</code>.";
    if (chat?.failed) {
      $("hint").textContent = chat.failed;
      ta.value = "";
    }
  }
  render();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  if (ta.value.trim()) {
    void analyze();
  } else {
    setStatus("", "waiting for a request");
    render();
  }
}

void start();
