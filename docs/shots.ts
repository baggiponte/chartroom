// Records the annotated README images in docs/img/ from demo mode:
//   node docs/shots.ts     (needs Playwright's Chromium and ffmpeg)
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { type Locator, type Page, chromium } from "@playwright/test";

const PAGE = new URL("../skills/help-me/index.html", import.meta.url).href;
const OUT = fileURLToPath(new URL("img", import.meta.url));
const VID = fileURLToPath(new URL("vid", import.meta.url));
mkdirSync(OUT, { recursive: true });

type Point = [x: number, y: number];
interface Note {
  /** A selector, or a box in viewport pixels: [x, y, width, height]. */
  el: string | [number, number, number, number];
  text: string;
  dx?: number;
  dy?: number;
  at?: Point;
  to?: Point;
  ring?: boolean | number;
  bend?: number;
  arrow?: false;
}
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const ACCENT = "#e8590c";
// Draws labelled arrows over the page. dx/dy place the label's center relative to the target's center (at: absolute
// viewport point instead); to overrides where the arrow ends; ring outlines the target.
// It runs inside the page (Playwright sends its source), so it may use only its argument and the page's globals.
function annotate({ notes, accent }: { notes: Note[]; accent: string }): void {
  document.getElementById("__ann")?.remove();
  const NS = "http://www.w3.org/2000/svg";
  const root = document.createElement("div");
  root.id = "__ann";
  root.style.cssText = `position:absolute;left:0;top:0;width:100%;height:${String(document.documentElement.scrollHeight)}px;pointer-events:none;z-index:99990`;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.style.cssText = "position:absolute;inset:0;overflow:visible";
  svg.innerHTML = `<defs><marker id="__ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${accent}"/></marker></defs>`;
  root.appendChild(svg);
  document.body.appendChild(root);
  const box = (el: Note["el"]): Box => {
    if (Array.isArray(el)) {
      return { x: el[0], y: el[1] + scrollY, w: el[2], h: el[3] };
    }
    const n = document.querySelector(el);
    if (!n) {
      throw new Error(`annotate: no element ${el}`);
    }
    const r = n.getClientRects()[0] ?? n.getBoundingClientRect();
    return { x: r.x, y: r.y + scrollY, w: r.width, h: r.height };
  };
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- annotate runs in the page, so it can't use helpers from this file
  const setAll = (node: Element, attrs: Record<string, string | number>): void => {
    for (const [k, v] of Object.entries(attrs)) {
      node.setAttribute(k, String(v));
    }
  };
  for (const n of notes) {
    const t = box(n.el);
    const cx = t.x + t.w / 2,
      cy = t.y + t.h / 2;
    const lab = document.createElement("div");
    lab.textContent = n.text;
    lab.style.cssText = `position:absolute;white-space:nowrap;background:${accent};color:#fff;font:600 14px/1 system-ui,-apple-system,"Segoe UI",sans-serif;padding:7px 11px;border-radius:999px;box-shadow:0 2px 6px rgba(0,0,0,.18)`;
    root.appendChild(lab);
    const lw = lab.offsetWidth,
      lh = lab.offsetHeight,
      lx = (n.at ? n.at[0] : cx + (n.dx ?? 0)) - lw / 2,
      ly = (n.at ? n.at[1] + scrollY : cy + (n.dy ?? 0)) - lh / 2;
    lab.style.left = `${String(lx)}px`;
    lab.style.top = `${String(ly)}px`;
    if (n.ring) {
      const r = document.createElementNS(NS, "rect");
      const pad = n.ring === true ? 5 : n.ring;
      setAll(r, {
        x: t.x - pad,
        y: t.y - pad,
        width: t.w + 2 * pad,
        height: t.h + 2 * pad,
        rx: 10,
        fill: "none",
        stroke: accent,
        "stroke-width": 2.5,
        "stroke-dasharray": "6 4",
      });
      svg.appendChild(r);
    }
    if (n.arrow === false) {
      continue;
    }
    // start on the label's edge facing the target, end just outside the target's box
    const lcx = lx + lw / 2,
      lcy = ly + lh / 2;
    const clampTo = (px: number, py: number, b: Box, pad: number): Point => [
      Math.max(b.x - pad, Math.min(px, b.x + b.w + pad)),
      Math.max(b.y - pad, Math.min(py, b.y + b.h + pad)),
    ];
    const tb = n.ring ? { x: t.x - 8, y: t.y - 8, w: t.w + 16, h: t.h + 16 } : t;
    const [ex, ey] = n.to ? [n.to[0], n.to[1] + scrollY] : clampTo(lcx, lcy, tb, 4);
    const [sx, sy] = clampTo(ex, ey, { x: lx, y: ly, w: lw, h: lh }, 3);
    const bend = n.bend ?? 0.25,
      mx = (sx + ex) / 2 - (ey - sy) * bend,
      my = (sy + ey) / 2 + (ex - sx) * bend;
    const p = document.createElementNS(NS, "path");
    setAll(p, {
      d: `M${String(sx)} ${String(sy)} Q${String(mx)} ${String(my)} ${String(ex)} ${String(ey)}`,
      fill: "none",
      stroke: accent,
      "stroke-width": 2.5,
      "stroke-linecap": "round",
      "marker-end": "url(#__ah)",
    });
    svg.appendChild(p);
  }
}

/** The page's bounding box, which only a hidden element lacks. */
async function boxOf(loc: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await loc.boundingBox();
  if (!b) {
    throw new Error(`${String(loc)} is not visible`);
  }
  return b;
}

// The middle of the element's first line box, so a mark that wraps is clicked on its text.
const center = (loc: Locator): Promise<Point> =>
  loc.evaluate((el): Point => {
    const b = el.getClientRects()[0] ?? el.getBoundingClientRect();
    return [b.x + b.width / 2, b.y + b.height / 2];
  });

// Helpers bound to one page, so each step reads as what a person does.
function helpers(p: Page) {
  return {
    w: (ms: number): Promise<void> => p.waitForTimeout(ms),
    mark: (text: string): Locator => p.locator("#backdrop mark", { hasText: text }).first(),
    chip: (text: string): Locator => p.locator("#pop .chip", { hasText: text }).first(),
    center,
    async click(loc: Locator, pause = 200): Promise<void> {
      const [x, y] = await center(loc);
      await p.mouse.move(x, y, { steps: 14 });
      await p.waitForTimeout(pause);
      await p.mouse.down();
      await p.waitForTimeout(60);
      await p.mouse.up();
    },
    async scrub(loc: Locator, dx: number): Promise<void> {
      const [x, y] = await center(loc);
      await p.mouse.move(x, y, { steps: 12 });
      await p.waitForTimeout(300);
      await p.mouse.down();
      await p.mouse.move(x + dx * 1.8, y, { steps: 28 });
      await p.waitForTimeout(250);
      await p.mouse.move(x + dx, y, { steps: 14 });
      await p.waitForTimeout(200);
      await p.mouse.up();
    },
    async ask(atEnd = false): Promise<void> {
      await p.evaluate(end => {
        const ta = document.querySelector<HTMLTextAreaElement>("#ta");
        if (!ta) {
          throw new Error("no #ta textarea");
        }
        const i = end ? ta.value.length : ta.value.indexOf("lattes.") + "lattes.".length;
        ta.focus();
        ta.setSelectionRange(i, i);
      }, atEnd);
      await p.keyboard.type(" Which heating system should it have?", { delay: 0 });
      await p.waitForTimeout(1600);
    },
    ann: (notes: Note[]): Promise<void> => p.evaluate(annotate, { notes, accent: ACCENT }),
    shot: (name: string, clip?: { x: number; y: number; width: number; height: number }): Promise<Buffer> =>
      p.screenshot({ path: join(OUT, name), ...(clip ? { clip } : {}) }),
  };
}
type Helpers = ReturnType<typeof helpers>;

const quiet = (p: Page): Promise<void> =>
  p.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });

const markTexts = (p: Page): Promise<string[]> =>
  p.evaluate(() => [...document.querySelectorAll("#backdrop mark")].map(m => m.textContent));

async function main(): Promise<void> {
  // Like playwright.config.ts: a machine with a Chromium already installed can skip `playwright install`.
  const executablePath = process.env["PLAYWRIGHT_CHROMIUM_PATH"];
  const b = await chromium.launch(executablePath === undefined ? {} : { executablePath });
  const page = async (opts: { w?: number; h?: number; video?: boolean } = {}): Promise<Page> => {
    const width = opts.w ?? 1360;
    const height = opts.h ?? 760;
    const ctx = await b.newContext({
      viewport: { width, height },
      deviceScaleFactor: opts.video ? 1 : 2,
      colorScheme: "light",
      ...(opts.video ? { recordVideo: { dir: VID, size: { width, height } } } : {}),
    });
    if (opts.video) {
      await ctx.addInitScript(() => {
        addEventListener("DOMContentLoaded", () => {
          const c = document.createElement("div");
          c.style.cssText =
            "position:fixed;left:0;top:0;width:18px;height:18px;z-index:99999;pointer-events:none;transform:translate(-3px,-2px)";
          c.innerHTML =
            '<svg width="18" height="22" viewBox="0 0 18 22"><path d="M1 1 L1 17 L5.5 13 L8.5 20 L11 19 L8 12 L14 12 Z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
          document.body.appendChild(c);
          addEventListener(
            "mousemove",
            e => {
              c.style.left = `${String(e.clientX)}px`;
              c.style.top = `${String(e.clientY)}px`;
            },
            true,
          );
        });
      });
    }
    const p = await ctx.newPage();
    await p.goto(PAGE);
    await p.waitForTimeout(2300);
    return p;
  };
  // 1. Overview: every kind of mark in one request, plus the timeline
  {
    const p = await page({ h: 640 });
    const h = helpers(p);
    await p.addStyleTag({ content: "body{padding-top:70px} #summary,#hint,.hint{display:none!important}" });
    await h.w(300);
    await h.click(h.mark("coffee machine"));
    await h.w(500);
    await h.click(h.chip("Espresso"));
    await h.w(700);
    await h.scrub(h.mark("[budget]"), 75);
    await h.w(700);
    await h.click(h.mark("[counter space]"));
    await h.w(500);
    await h.click(p.locator('#pop [data-role="remove"]'));
    await h.w(800);
    await h.ask();
    await quiet(p);
    await p.mouse.move(1350, 630);
    await h.w(400);
    const marks = await markTexts(p);
    console.log("marks", marks);
    await h.ann([
      {
        el: `#backdrop mark:nth-of-type(${String(marks.findIndex(m => m.startsWith("espresso")) + 1)})`,
        text: "Click an underline to flip it",
        dx: -90,
        dy: -78,
        bend: -0.2,
      },
      {
        el: `#backdrop mark:nth-of-type(${String(marks.findIndex(m => m.startsWith("Which")) + 1)})`,
        text: "A question you asked: pick an answer",
        dx: 230,
        dy: -128,
        bend: 0.1,
      },
      {
        el: `#backdrop mark:nth-of-type(${String(marks.findIndex(m => m.startsWith("up to")) + 1)})`,
        text: "Drag a blue value",
        dx: 30,
        dy: 150,
        bend: -0.15,
      },
      {
        el: `#backdrop mark:nth-of-type(${String(marks.findIndex(m => m === "[milk]") + 1)})`,
        text: "Click a [blank] to fill it",
        dx: -45,
        dy: 150,
        bend: 0.1,
      },
      { el: "#send", text: "Shift+Enter sends it back", dx: 0, dy: 100, bend: 0 },
      { el: "#journey", text: "Where you are and what to do now", dx: 0, dy: 230, ring: 8, bend: 0 },
    ]);
    await h.shot("overview.png", { x: 120, y: 0, width: 1140, height: 540 });
    await p.context().close();
  }

  // 2. A question you wrote gets answers, plus Explain me / Help me decide
  {
    const p = await page({ w: 1000, h: 760 });
    const h = helpers(p);
    await p.addStyleTag({ content: "#summary,.hint{display:none!important}" });
    await h.w(200);
    await h.ask(true);
    await h.click(h.mark("Which heating"));
    await h.w(700);
    await quiet(p);
    await p.mouse.move(990, 750);
    await h.w(300);
    const card = await boxOf(p.locator("#card"));
    const ox = card.x - 20,
      oy = card.y - 20;
    const hx = await boxOf(h.chip("Dual boiler")),
      so = await boxOf(p.locator('#pop [data-role="other"]'));
    await h.ann([
      {
        el: "#pop .chip:nth-of-type(3)",
        text: "Answers to your question",
        at: [ox + 680, hx.y + hx.height / 2],
        to: [hx.x + hx.width + 6, hx.y + hx.height / 2],
        bend: 0,
      },
      {
        el: '#pop [data-role="other"]',
        text: "or write your own",
        at: [ox + 680, so.y + so.height / 2 + 30],
        to: [so.x + so.width + 6, so.y + so.height / 2],
        bend: 0.1,
      },
      { el: '#pop [data-role="decide-open"]', text: "Not sure? Ask for help", dx: 60, dy: 75, bend: 0.2 },
    ]);
    const pb = await boxOf(p.locator("#pop"));
    await h.shot("question.png", { x: ox, y: oy, width: card.width + 40, height: pb.y + pb.height + 90 - oy });
    // picking one rewrites the question as a statement
    await p.evaluate(() => {
      document.getElementById("__ann")?.remove();
    });
    await h.click(h.chip("Dual boiler"));
    await h.w(900);
    await p.keyboard.press("Escape");
    await quiet(p);
    await p.mouse.move(990, 750);
    await h.w(400);
    const qi = (await markTexts(p)).findIndex(m => m.startsWith("For heating")) + 1;
    await h.ann([
      {
        el: `#backdrop mark:nth-of-type(${String(qi)})`,
        text: "Pick one and it becomes a statement",
        at: [ox + 420, card.y + card.height + 40],
        bend: 0,
      },
    ]);
    await h.shot("question-answered.png", { x: ox, y: oy, width: card.width + 40, height: card.height + 100 });
    await p.context().close();
  }

  // 3. Explain me
  {
    const p = await page({ w: 1000, h: 1180 });
    const h = helpers(p);
    await p.addStyleTag({ content: "#summary,.hint{display:none!important}" });
    await h.w(200);
    await h.click(h.mark("[milk]"));
    await h.w(600);
    await h.click(p.locator('#pop [data-role="explain"]'));
    await h.w(1400);
    await quiet(p);
    await p.mouse.move(995, 5);
    await h.w(300);
    const pop = await boxOf(p.locator("#pop"));
    const ox = pop.x - 20,
      oy = pop.y - 20;
    await h.ann([
      {
        el: '#pop [data-card="2"]',
        text: "What each option means, and who it suits",
        at: [ox + 560, oy + 415],
        bend: 0,
      },
      { el: '#pop [data-role="decide"]', text: "Questions about you, then a suggestion", dx: 330, dy: 0, bend: 0 },
    ]);
    await h.shot("explain.png", { x: ox, y: oy, width: pop.width + 40, height: pop.height + 40 });
    await p.context().close();
  }

  // 4. Help me decide
  {
    const p = await page({ w: 1000, h: 860 });
    const h = helpers(p);
    await h.click(h.mark("[milk]"));
    await h.w(600);
    await h.click(p.locator('#pop [data-role="explain"]'));
    await h.w(1300);
    await h.click(p.locator('#pop [data-role="decide"]'));
    await h.w(1500);
    // One answer at a time, as a person would: each answer changes the next question.
    /* oxlint-disable no-await-in-loop */
    for (let q = 0; q < 3; q++) {
      const c = p.locator(`#pop .chip[data-dq="${String(q)}"]`).first();
      if (await c.count()) {
        await h.click(c);
        await h.w(1300);
      }
    }
    /* oxlint-enable no-await-in-loop */
    await quiet(p);
    await p.mouse.move(995, 5);
    await h.w(300);
    const rec = await boxOf(p.locator(".decide-rec"));
    await h.ann([
      { el: '.sheet-you .chip[data-dq="1"]', text: "A few questions about you", at: [210, 560], bend: 0 },
      {
        el: ".decide-rec",
        text: "A suggested pick, and why",
        at: [520, 86],
        to: [rec.x + rec.width + 4, rec.y + 12],
        bend: 0.15,
      },
      { el: ".ocard.rec", text: "Marked in your options", at: [835, 500], bend: -0.2 },
    ]);
    await h.shot("decide.png");
    await p.context().close();
  }

  // 5. What was sent
  {
    const p = await page({ w: 1000, h: 820 });
    const h = helpers(p);
    await p.addStyleTag({ content: "#summary{display:none!important}" });
    await h.w(200);
    await h.click(h.mark("coffee machine"));
    await h.w(500);
    await h.click(h.chip("Espresso"));
    await h.w(600);
    await h.scrub(h.mark("[budget]"), 75);
    await h.w(600);
    await h.click(h.mark("[milk]"));
    await h.w(500);
    await h.click(h.chip("Steam wand"));
    await h.w(600);
    await p.keyboard.press("Escape");
    await p.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>("#ta");
      if (!ta) {
        throw new Error("no #ta textarea");
      }
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
    await p.keyboard.press("Shift+Enter");
    await h.w(1200);
    await h.click(p.locator("#endedShow"));
    await h.w(600);
    await quiet(p);
    await p.mouse.move(995, 5);
    await h.w(300);
    const a = await boxOf(p.locator("#endedBar")),
      pre = await boxOf(p.locator("#endedPrompt")),
      z = await boxOf(p.locator("#sentNotes"));
    const li = await p.evaluate((): Point => {
      const item = document.querySelector("#sentNotes li");
      if (!item) {
        throw new Error("nothing was left out");
      }
      const r = document.createRange();
      r.selectNodeContents(item);
      const box = r.getBoundingClientRect();
      return [box.right, box.y + box.height / 2];
    });
    await h.ann([
      {
        el: "#endedPrompt",
        text: "Exactly what your agent gets",
        at: [835, a.y + a.height / 2],
        to: [835, pre.y - 4],
        bend: 0,
      },
      { el: "#sentNotes", text: "and what was left out", at: [835, li[1] + 30], to: [li[0] + 8, li[1]], bend: -0.2 },
    ]);
    await h.shot("sent.png", { x: 100, y: a.y - 16, width: 860, height: z.y + z.height - a.y + 40 });
    await p.context().close();
  }

  // GIF clips (video at 1x; ffmpeg turns them into GIFs)
  const starts: Record<string, number> = {};
  const clip = async (
    name: string,
    w: number,
    h: number,
    fn: (p: Page, helper: Helpers, go: () => void) => Promise<void>,
  ): Promise<void> => {
    const t0 = Date.now();
    const p = await page({ w, h, video: true });
    await p.addStyleTag({
      content:
        "#summary,.hint,#journey{display:none!important} body{padding-top:0!important} .layout,main{padding-top:14px!important;margin-top:0!important}",
    });
    let start = 0;
    await fn(p, helpers(p), () => {
      start = (Date.now() - t0) / 1000;
    });
    const v = p.video();
    if (!v) {
      throw new Error("the page was not recorded");
    }
    await p.context().close();
    renameSync(await v.path(), join(VID, `${name}.webm`));
    starts[name] = start;
  };
  await clip("underlines", 860, 330, async (p, h, go) => {
    await p.mouse.move(450, 300);
    go();
    await h.w(500);
    await h.click(h.mark("coffee machine"), 300);
    await h.w(800);
    await h.click(h.chip("Espresso"));
    await h.w(1100);
    await h.scrub(h.mark("[budget]"), 75);
    await h.w(1400);
  });
  await clip("tidy", 860, 450, async (p, h, go) => {
    await h.scrub(h.mark("[budget]"), 75);
    await h.w(500);
    await h.click(h.mark("[milk]"));
    await h.w(400);
    await h.click(h.chip("Steam wand"));
    await h.w(400);
    await p.keyboard.press("Escape");
    await h.click(h.mark("[counter space]"));
    await h.w(400);
    await h.click(h.chip("About 40 cm"));
    await h.w(400);
    await p.keyboard.press("Escape");
    await h.w(500);
    await p.mouse.move(450, 480, { steps: 8 });
    go();
    await h.w(600);
    await h.click(p.locator("#tidy"), 400);
    await h.w(1800);
    const g = p.locator("#grips .grip");
    const n = await g.count();
    const [x, y] = await h.center(g.nth(n - 1));
    const [, y0] = await h.center(g.nth(0));
    await p.mouse.move(x, y, { steps: 14 });
    await h.w(400);
    await p.mouse.down();
    await h.w(150);
    await p.mouse.move(x, y0 - 18, { steps: 30 });
    await h.w(300);
    await p.mouse.up();
    await h.w(1800);
  });

  // GIFs: 12 fps, 720 px wide, 64 colours, duplicate frames dropped
  for (const [name, ss] of Object.entries(starts)) {
    execFileSync("ffmpeg", [
      "-loglevel",
      "error",
      "-y",
      "-ss",
      String(ss),
      "-i",
      join(VID, `${name}.webm`),
      "-vf",
      "fps=12,scale=720:-1:flags=lanczos,tpad=stop_mode=clone:stop_duration=1.5,mpdecimate=hi=64*24:lo=64*8:frac=0.2,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
      "-fps_mode",
      "vfr",
      join(OUT, `${name}.gif`),
    ]);
  }
  rmSync(VID, { recursive: true, force: true });
  // shrink the PNGs to 128 colours (about a quarter of the size) when Pillow is around
  try {
    execFileSync("python3", [
      "-c",
      'import sys,PIL.Image as I\nfor f in sys.argv[1:]: I.open(f).convert("RGB").quantize(128, I.Quantize.MEDIANCUT, dither=I.Dither.NONE).save(f, optimize=True)',
      ...readdirSync(OUT)
        .filter(f => f.endsWith(".png"))
        .map(f => join(OUT, f)),
    ]);
  } catch {
    console.warn("Pillow not found: PNGs left unquantized");
  }
  await b.close();
}

await main();
