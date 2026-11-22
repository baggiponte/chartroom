// Records the annotated README images in docs/img/ from demo mode:
//   node docs/shots.js     (needs Playwright's Chromium and ffmpeg)
const { chromium } = require("playwright");
const path = require("path"),
  fs = require("fs");
const PAGE = "file://" + path.resolve(__dirname, "../skills/help-me/index.html");
const OUT = path.resolve(__dirname, "img"),
  VID = path.resolve(__dirname, "vid");
fs.mkdirSync(OUT, { recursive: true });

const ACCENT = "#e8590c";
// Draws labelled arrows over the page. Each note: { el: selector | [x,y,w,h], text, dx, dy | at, to, ring, bend }
// dx/dy place the label's center relative to the target's center (at: absolute viewport point instead);
// to overrides where the arrow ends; ring outlines the target.
function annotate(notes, accent) {
  document.getElementById("__ann")?.remove();
  const NS = "http://www.w3.org/2000/svg";
  const root = document.createElement("div");
  root.id = "__ann";
  root.style.cssText =
    "position:absolute;left:0;top:0;width:100%;height:" +
    document.documentElement.scrollHeight +
    "px;pointer-events:none;z-index:99990";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.style.cssText = "position:absolute;inset:0;overflow:visible";
  svg.innerHTML = `<defs><marker id="__ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${accent}"/></marker></defs>`;
  root.appendChild(svg);
  document.body.appendChild(root);
  const box = el => {
    if (Array.isArray(el)) return { x: el[0], y: el[1] + scrollY, w: el[2], h: el[3] };
    const n = typeof el === "string" ? document.querySelector(el) : el;
    if (!n) throw new Error("annotate: no element " + el);
    const r = n.getClientRects()[0] || n.getBoundingClientRect();
    return { x: r.x, y: r.y + scrollY, w: r.width, h: r.height };
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
      lx = (n.at ? n.at[0] : cx + n.dx) - lw / 2,
      ly = (n.at ? n.at[1] + scrollY : cy + n.dy) - lh / 2;
    lab.style.left = lx + "px";
    lab.style.top = ly + "px";
    if (n.ring) {
      const r = document.createElementNS(NS, "rect");
      const pad = n.ring === true ? 5 : n.ring;
      Object.entries({
        x: t.x - pad,
        y: t.y - pad,
        width: t.w + 2 * pad,
        height: t.h + 2 * pad,
        rx: 10,
        fill: "none",
        stroke: accent,
        "stroke-width": 2.5,
        "stroke-dasharray": "6 4",
      }).forEach(([k, v]) => r.setAttribute(k, v));
      svg.appendChild(r);
    }
    if (n.arrow === false) continue;
    // start on the label's edge facing the target, end just outside the target's box
    const lcx = lx + lw / 2,
      lcy = ly + lh / 2;
    const clampTo = (px, py, b, pad) => [
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
    Object.entries({
      d: `M${sx} ${sy} Q${mx} ${my} ${ex} ${ey}`,
      fill: "none",
      stroke: accent,
      "stroke-width": 2.5,
      "stroke-linecap": "round",
      "marker-end": "url(#__ah)",
    }).forEach(([k, v]) => p.setAttribute(k, v));
    svg.appendChild(p);
  }
}

(async () => {
  const b = await chromium.launch();
  const page = async (opts = {}) => {
    const ctx = await b.newContext({
      viewport: { width: opts.w || 1360, height: opts.h || 760 },
      deviceScaleFactor: opts.video ? 1 : 2,
      colorScheme: "light",
      ...(opts.video ? { recordVideo: { dir: VID, size: { width: opts.w, height: opts.h } } } : {}),
    });
    if (opts.video)
      await ctx.addInitScript(() =>
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
              c.style.left = e.clientX + "px";
              c.style.top = e.clientY + "px";
            },
            true,
          );
        }),
      );
    const p = await ctx.newPage();
    p.ctx = ctx;
    await p.goto(PAGE);
    await p.waitForTimeout(2300);
    return p;
  };
  const H = p => ({
    w: ms => p.waitForTimeout(ms),
    mark: t => p.locator("#backdrop mark", { hasText: t }).first(),
    chip: t => p.locator("#pop .chip", { hasText: t }).first(),
    async center(loc) {
      const r = await loc.evaluate(el => {
        const b = el.getClientRects()[0] || el.getBoundingClientRect();
        return [b.x + b.width / 2, b.y + b.height / 2];
      });
      return r;
    },
    async click(loc, pause = 200) {
      const [x, y] = await this.center(loc);
      await p.mouse.move(x, y, { steps: 14 });
      await p.waitForTimeout(pause);
      await p.mouse.down();
      await p.waitForTimeout(60);
      await p.mouse.up();
    },
    async scrub(loc, dx) {
      const [x, y] = await this.center(loc);
      await p.mouse.move(x, y, { steps: 12 });
      await p.waitForTimeout(300);
      await p.mouse.down();
      await p.mouse.move(x + dx * 1.8, y, { steps: 28 });
      await p.waitForTimeout(250);
      await p.mouse.move(x + dx, y, { steps: 14 });
      await p.waitForTimeout(200);
      await p.mouse.up();
    },
    async ask(atEnd) {
      await p.evaluate(atEnd => {
        const ta = document.getElementById("ta");
        const i = atEnd ? ta.value.length : ta.value.indexOf("lattes.") + "lattes.".length;
        ta.focus();
        ta.setSelectionRange(i, i);
      }, !!atEnd);
      await p.keyboard.type(" Which heating system should it have?", { delay: 0 });
      await p.waitForTimeout(1600);
    },
    ann: notes =>
      p.evaluate(([n, a]) => (0, eval)("(" + n.f + ")")(n.notes, a), [{ f: annotate.toString(), notes }, ACCENT]),
    shot: (name, clip) => p.screenshot({ path: path.join(OUT, name), clip }),
  });
  const quiet = p =>
    p.evaluate(() => {
      document.activeElement?.blur();
    });

  // 1. Overview: every kind of mark in one request, plus the timeline
  {
    const p = await page({ h: 640 });
    const h = H(p);
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
    const marks = await p.evaluate(() => [...document.querySelectorAll("#backdrop mark")].map(m => m.textContent));
    console.log("marks", marks);
    await h.ann([
      {
        el: `#backdrop mark:nth-of-type(${marks.findIndex(m => m.startsWith("espresso")) + 1})`,
        text: "Click an underline to flip it",
        dx: -90,
        dy: -78,
        bend: -0.2,
      },
      {
        el: `#backdrop mark:nth-of-type(${marks.findIndex(m => m.startsWith("Which")) + 1})`,
        text: "A question you asked: pick an answer",
        dx: 230,
        dy: -128,
        bend: 0.1,
      },
      {
        el: `#backdrop mark:nth-of-type(${marks.findIndex(m => m.startsWith("up to")) + 1})`,
        text: "Drag a blue value",
        dx: 30,
        dy: 150,
        bend: -0.15,
      },
      {
        el: `#backdrop mark:nth-of-type(${marks.findIndex(m => m === "[milk]") + 1})`,
        text: "Click a [blank] to fill it",
        dx: -45,
        dy: 150,
        bend: 0.1,
      },
      { el: "#send", text: "Shift+Enter sends it back", dx: 0, dy: 100, bend: 0 },
      { el: "#journey", text: "Where you are and what to do now", dx: 0, dy: 230, ring: 8, bend: 0 },
    ]);
    await h.shot("overview.png", { x: 120, y: 0, width: 1140, height: 540 });
    await p.ctx.close();
  }

  // 2. A question you wrote gets answers, plus Explain me / Help me decide
  {
    const p = await page({ w: 1000, h: 760 });
    const h = H(p);
    await p.addStyleTag({ content: "#summary,.hint{display:none!important}" });
    await h.w(200);
    await h.ask(true);
    await h.click(h.mark("Which heating"));
    await h.w(700);
    await quiet(p);
    await p.mouse.move(990, 750);
    await h.w(300);
    const card = await p.locator("#card").boundingBox();
    const ox = card.x - 20,
      oy = card.y - 20;
    const hx = await h.chip("Dual boiler").boundingBox(),
      so = await p.locator('#pop [data-role="other"]').boundingBox();
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
    const pb = await p.locator("#pop").boundingBox();
    await h.shot("question.png", { x: ox, y: oy, width: card.width + 40, height: pb.y + pb.height + 90 - oy });
    // picking one rewrites the question as a statement
    await p.evaluate(() => document.getElementById("__ann")?.remove());
    await h.click(h.chip("Dual boiler"));
    await h.w(900);
    await p.keyboard.press("Escape");
    await quiet(p);
    await p.mouse.move(990, 750);
    await h.w(400);
    const qi = await p.evaluate(
      () =>
        [...document.querySelectorAll("#backdrop mark")].findIndex(m => m.textContent.startsWith("For heating")) + 1,
    );
    const st = await p.evaluate(i => {
      const r = document.querySelector(`#backdrop mark:nth-of-type(${i})`).getClientRects()[0];
      return [r.right, r.top];
    }, qi);
    await h.ann([
      {
        el: `#backdrop mark:nth-of-type(${qi})`,
        text: "Pick one and it becomes a statement",
        at: [ox + 420, card.y + card.height + 40],
        bend: 0,
      },
    ]);
    await h.shot("question-answered.png", { x: ox, y: oy, width: card.width + 40, height: card.height + 100 });
    await p.ctx.close();
  }

  // 3. Explain me
  {
    const p = await page({ w: 1000, h: 1180 });
    const h = H(p);
    await p.addStyleTag({ content: "#summary,.hint{display:none!important}" });
    await h.w(200);
    await h.click(h.mark("[milk]"));
    await h.w(600);
    await h.click(p.locator('#pop [data-role="explain"]'));
    await h.w(1400);
    await quiet(p);
    await p.mouse.move(995, 5);
    await h.w(300);
    const pop = await p.locator("#pop").boundingBox();
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
    await p.ctx.close();
  }

  // 4. Help me decide
  {
    const p = await page({ w: 1000, h: 860 });
    const h = H(p);
    await h.click(h.mark("[milk]"));
    await h.w(600);
    await h.click(p.locator('#pop [data-role="explain"]'));
    await h.w(1300);
    await h.click(p.locator('#pop [data-role="decide"]'));
    await h.w(1500);
    for (let q = 0; q < 3; q++) {
      const c = p.locator(`#pop .chip[data-dq="${q}"]`).first();
      if (await c.count()) {
        await h.click(c);
        await h.w(1300);
      }
    }
    await quiet(p);
    await p.mouse.move(995, 5);
    await h.w(300);
    const rec = await p.locator(".decide-rec").boundingBox();
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
    await p.ctx.close();
  }

  // 5. What was sent
  {
    const p = await page({ w: 1000, h: 820 });
    const h = H(p);
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
      const ta = document.getElementById("ta");
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
    const a = await p.locator("#endedBar").boundingBox(),
      pre = await p.locator("#endedPrompt").boundingBox(),
      z = await p.locator("#sentNotes").boundingBox();
    const li = await p.evaluate(() => {
      const r = document.createRange();
      r.selectNodeContents(document.querySelector("#sentNotes li"));
      const b = r.getBoundingClientRect();
      return [b.right, b.y + b.height / 2];
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
    await p.ctx.close();
  }

  // GIF clips (video at 1x; ffmpeg turns them into GIFs)
  const starts = {};
  const clip = async (name, w, h, fn) => {
    const t0 = Date.now();
    const p = await page({ w, h, video: true });
    await p.addStyleTag({
      content:
        "#summary,.hint,#journey{display:none!important} body{padding-top:0!important} .layout,main{padding-top:14px!important;margin-top:0!important}",
    });
    let start = 0;
    await fn(p, H(p), () => {
      start = (Date.now() - t0) / 1000;
    });
    const v = p.video();
    await p.ctx.close();
    fs.renameSync(await v.path(), path.join(VID, name + ".webm"));
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
  const { execFileSync } = require("child_process");
  for (const [name, ss] of Object.entries(starts))
    execFileSync("ffmpeg", [
      "-loglevel",
      "error",
      "-y",
      "-ss",
      String(ss),
      "-i",
      path.join(VID, name + ".webm"),
      "-vf",
      "fps=12,scale=720:-1:flags=lanczos,tpad=stop_mode=clone:stop_duration=1.5,mpdecimate=hi=64*24:lo=64*8:frac=0.2,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
      "-fps_mode",
      "vfr",
      path.join(OUT, name + ".gif"),
    ]);
  fs.rmSync(VID, { recursive: true, force: true });
  // shrink the PNGs to 128 colours (about a quarter of the size) when Pillow is around
  try {
    execFileSync("python3", [
      "-c",
      'import sys,PIL.Image as I\nfor f in sys.argv[1:]: I.open(f).convert("RGB").quantize(128, I.Quantize.MEDIANCUT, dither=I.Dither.NONE).save(f, optimize=True)',
      ...fs
        .readdirSync(OUT)
        .filter(f => f.endsWith(".png"))
        .map(f => path.join(OUT, f)),
    ]);
  } catch {
    console.warn("Pillow not found: PNGs left unquantized");
  }
  await b.close();
})();
