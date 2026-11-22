// Tidy up only reorders whole sentences, never rewords, so every underline and blank moves with its sentence and
// stays clickable.

import { errorMessage, esc } from "./format.ts";
import { isSuperseded, post } from "./client.ts";
import { demoTidy } from "./demo.ts";
import { closePop } from "./popover.ts";
import { render, setStatus } from "./render.ts";
import { isHeading, relocate, setText } from "./request.ts";
import { $, ta } from "./dom.ts";
import { state } from "./state.ts";

interface Segment {
  a: number;
  b: number;
}

/** Sentences as [a, b) ranges, never cutting through an underline; bullets and our own headings are left out. */
export function segments(text: string): Array<Segment> {
  const marks = state.choices.filter(c => !c.extra && c.start >= 0);
  const inMark = (p: number): boolean => marks.some(c => p > c.start && p < c.end);
  const segs: Array<Segment> = [];
  let ls = 0;
  for (const line of text.split("\n")) {
    const le = ls + line.length;
    if (line.trim() && !isHeading(line)) {
      let a = ls + (/^[ \t]*(?:[-*•][ \t]+)?/.exec(line)?.[0].length ?? 0);
      const re = /[.!?…]+["'”’)\]]*([ \t]+)/g;
      re.lastIndex = a - ls;
      for (let m = re.exec(line); m; m = re.exec(line)) {
        const gap = m[1]?.length ?? 0;
        const cut = ls + m.index + m[0].length - gap;
        if (inMark(cut)) {
          continue;
        }
        if (cut > a) {
          segs.push({ a, b: cut });
        }
        a = cut + gap;
      }
      const b = ls + line.replace(/\s+$/, "").length;
      if (b > a) {
        segs.push({ a, b });
      }
    }
    ls = le + 1;
  }
  return segs;
}

export function tidyOrUndo(): void {
  if (state.tidyUndo && ta.value === state.tidyUndo.after) {
    undoTidy();
  } else {
    void runTidy();
  }
}

async function runTidy(): Promise<void> {
  if (state.ended || state.tidyBusy || state.busy || state.moreBusy) {
    return;
  }
  const text = ta.value;
  const segs = segments(text);
  if (segs.length < 2) {
    return;
  }
  closePop();
  const my = ++state.tidySeq;
  const sentences = segs.map(s => text.slice(s.a, s.b));
  state.tidyBusy = true;
  setStatus("busy", `${esc(state.modelName)} is tidying…`);
  render();
  let blocks;
  try {
    blocks = (state.mode === "live" ? await post("/api/tidy", { sentences }) : await demoTidy(sentences)).blocks;
  } catch (error) {
    if (my !== state.tidySeq) {
      return;
    }
    state.tidyBusy = false;
    render();
    if (!isSuperseded(error)) {
      setStatus("err", `couldn't tidy: ${esc(errorMessage(error))} · <button id="retry">retry</button>`);
    }
    document.getElementById("retry")?.addEventListener("click", () => void runTidy());
    return;
  }
  if (my !== state.tidySeq) {
    return;
  }
  state.tidyBusy = false;
  if (ta.value !== text) {
    render();
    setStatus("err", `you edited while it was tidying · <button id="retry">tidy again</button>`);
    $("retry").addEventListener("click", () => void runTidy());
    return;
  }
  applyTidy(text, segs, blocks);
  setStatus("", "");
}

function applyTidy(text: string, segs: Array<Segment>, raw: Array<{ heading: string; items: Array<number> }>): void {
  // every sentence exactly once, whatever came back
  const used = new Set<number>();
  const blocks: Array<{ heading: string; items: Array<number> }> = [];
  for (const b of raw) {
    const items = b.items.filter(i => {
      const ok = Number.isInteger(i) && i >= 0 && i < segs.length && !used.has(i);
      if (ok) {
        used.add(i);
      }
      return ok;
    });
    if (items.length) {
      blocks.push({ heading: b.heading.trim().replace(/:$/, ""), items });
    }
  }
  const missing = segs.flatMap((_, i) => (used.has(i) ? [] : [i]));
  if (missing.length) {
    const first = blocks[0];
    if (first) {
      first.items.push(...missing);
    } else {
      blocks.push({ heading: "", items: missing });
    }
  }

  let out = "";
  const at = new Map<number, number>();
  for (const b of blocks) {
    if (out) {
      out += "\n\n";
    }
    if (b.heading) {
      state.tidyHeads.add(b.heading);
      out += b.heading + ":";
    }
    b.items.forEach((si, k) => {
      out += b.heading ? "\n- " : k ? " " : "";
      at.set(si, out.length);
      const seg = segs[si];
      if (seg) {
        out += text.slice(seg.a, seg.b);
      }
    });
  }
  state.tidyUndo = { before: text, after: out, pos: state.choices.map(c => [c, c.start, c.end, c.promo?.sep]) };
  for (const c of state.choices) {
    if (c.extra || c.start < 0) {
      continue;
    }
    const si = segs.findIndex(s => c.start >= s.a && c.end <= s.b);
    const seg = segs[si];
    const to = at.get(si);
    if (!seg || to === undefined) {
      continue;
    }
    const d = to - seg.a;
    c.start += d;
    c.end += d;
    if (c.promo) {
      // a bullet or line start has no separator; sentenceRange then takes the whole line
      const p = c.start - c.promo.pre.length;
      const lead = out.slice(out.lastIndexOf("\n", p - 1) + 1, p);
      c.promo.sep = /^[ \t]*(?:[-*•][ \t]+)?$/.test(lead) ? "" : " ";
    }
  }
  const focused = document.activeElement === ta;
  setText(out);
  relocate(out);
  if (focused) {
    ta.setSelectionRange(out.length, out.length);
  }
  render();
  const card = $("card");
  card.classList.remove("tidied");
  void card.offsetWidth;
  card.classList.add("tidied");
}

export function undoTidy(): void {
  const u = state.tidyUndo;
  if (!u || ta.value !== u.after || state.ended) {
    return;
  }
  for (const [c, start, end, sep] of u.pos) {
    c.start = start;
    c.end = end;
    if (c.promo && sep !== undefined) {
      c.promo.sep = sep;
    }
  }
  state.tidyUndo = null;
  setText(u.before);
  relocate(u.before);
  render();
}
