// Records docs/demo.gif from demo mode (SHOTS=1 also saves checkpoint screenshots):
//   node docs/rec.ts --video
//   ffmpeg -ss 0.4 -i docs/vid/*.webm -vf "fps=12,scale=800:-1:flags=lanczos,tpad=stop_mode=clone:stop_duration=2,mpdecimate=hi=64*24:lo=64*8:frac=0.2,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" -fps_mode vfr docs/demo.gif
import { fileURLToPath } from "node:url";

import { type Locator, chromium } from "@playwright/test";

const VIDEO = process.argv.includes("--video");
const SHOTS = Boolean(process.env["SHOTS"]);
const PAGE = new URL("../skills/help-me/index.html", import.meta.url).href;
const VID = fileURLToPath(new URL("vid", import.meta.url));

// The caption element keeps the timer that hides it, so a new caption can cancel the old one.
type Caption = HTMLElement & { hideTimer?: ReturnType<typeof setTimeout> };

async function center(loc: Locator): Promise<[number, number]> {
  // first line box, so a mark that wraps is clicked on its text
  const r = await loc.evaluate(el => {
    const box = el.getClientRects()[0] ?? el.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  });
  return [r.x + r.width / 2, r.y + r.height / 2];
}

async function main(): Promise<void> {
  // Like playwright.config.ts: a machine with a Chromium already installed can skip `playwright install`.
  const executablePath = process.env["PLAYWRIGHT_CHROMIUM_PATH"];
  const b = await chromium.launch(executablePath === undefined ? {} : { executablePath });
  const W = 1000,
    H = 860;
  const ctx = await b.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    colorScheme: "light",
    ...(VIDEO ? { recordVideo: { dir: VID, size: { width: W, height: H } } } : {}),
  });
  await ctx.addInitScript(() => {
    addEventListener("DOMContentLoaded", () => {
      const c = document.createElement("div");
      c.style.cssText =
        "position:fixed;left:0;top:0;width:18px;height:18px;z-index:99999;pointer-events:none;transform:translate(-3px,-2px);transition:transform .08s";
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
      addEventListener(
        "mousedown",
        () => {
          c.style.transform = "translate(-3px,-2px) scale(.85)";
        },
        true,
      );
      addEventListener(
        "mouseup",
        () => {
          c.style.transform = "translate(-3px,-2px)";
        },
        true,
      );
      // caption for each step, top-left
      const cap = document.createElement("div");
      cap.id = "__cap";
      cap.style.cssText =
        "position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:99998;pointer-events:none;background:#111;color:#fff;font:600 15px/1.2 system-ui,sans-serif;padding:8px 14px;border-radius:999px;opacity:0;transition:opacity .25s";
      document.body.appendChild(cap);
    });
  });
  const p = await ctx.newPage();
  const w = (ms: number): Promise<void> => p.waitForTimeout(ms);
  let n = 0;
  const shot = async (name: string): Promise<void> => {
    if (SHOTS) {
      await p.screenshot({ path: `c${String(++n).padStart(2, "0")}-${name}.png` });
    }
  };
  const caption = (text: string): Promise<void> =>
    p.evaluate(t => {
      const c: Caption | null = document.getElementById("__cap");
      if (!c) {
        return;
      }
      clearTimeout(c.hideTimer);
      c.textContent = t;
      c.style.opacity = t ? "1" : "0";
      c.hideTimer = setTimeout(() => {
        c.style.opacity = "0";
      }, 2200);
    }, text);
  async function moveTo(x: number, y: number, steps = 16): Promise<void> {
    await p.mouse.move(x, y, { steps });
  }
  async function click(loc: Locator, pause = 250): Promise<void> {
    const [x, y] = await center(loc);
    await moveTo(x, y);
    await w(pause);
    await p.mouse.down();
    await w(60);
    await p.mouse.up();
  }
  const mark = (text: string): Locator => p.locator("#backdrop mark", { hasText: text }).first();
  const chip = (text: string): Locator => p.locator("#pop .chip", { hasText: text }).first();

  await p.goto(PAGE);
  await p.mouse.move(500, 620);
  await w(2200);
  await shot("start");

  await caption("Click an underline to flip it");
  await click(mark("coffee machine"), 300);
  await w(700);
  await click(chip("Espresso"));
  await w(1000);
  await shot("flip");

  await caption("Pick several");
  await click(mark("lattes"), 300);
  await w(600);
  await click(chip("Cappuccinos"));
  await w(700);
  await p.keyboard.press("Escape");
  await w(700);
  await shot("multi");

  await caption("Drag a blue value");
  {
    const [x, y] = await center(mark("[budget]"));
    await moveTo(x, y);
    await w(400);
    await p.mouse.down();
    await moveTo(x + 140, y, 30);
    await w(250);
    await moveTo(x + 75, y, 15);
    await w(200);
    await p.mouse.up();
  }
  await w(1000);
  await shot("scrub");

  await caption("Drop a sentence you don't need");
  await click(mark("[counter space]"), 300);
  await w(800);
  await shot("counter");
  await click(p.locator('#pop [data-role="remove"]'));
  await w(1100);
  await shot("removed");

  await caption("Ask a question in the text");
  {
    const [x, y] = await center(mark("lattes and cappuccinos"));
    await moveTo(x, y, 10);
  }
  await p.evaluate(() => {
    const ta = document.querySelector<HTMLTextAreaElement>("#ta");
    if (!ta) {
      throw new Error("no #ta textarea");
    }
    const i = ta.value.indexOf("cappuccinos.") + "cappuccinos.".length;
    ta.focus();
    ta.setSelectionRange(i, i);
  });
  await p.keyboard.type(" Which heating system should it have?", { delay: 45 });
  await w(1800);
  await shot("ask");

  await caption("Explain me");
  await click(mark("[milk]"), 300);
  await w(700);
  await click(p.locator('#pop [data-role="explain"]'));
  await w(1300);
  await shot("explain");
  const cards = p.locator("#pop [data-card]");
  {
    const [x, y] = await center(cards.nth(1));
    await moveTo(x, y, 20);
  }
  await w(900);
  await click(cards.nth(1));
  await w(1200);
  await shot("explained-pick");
  await p.keyboard.press("Escape");
  await w(500);

  await caption("Help me decide");
  await click(mark("Which heating system should it have?"), 300);
  await w(700);
  await shot("heat-pop");
  await click(p.locator('#pop [data-role="decide-open"]'));
  await w(1500);
  await shot("decide");
  await click(p.locator('#pop .chip[data-dq="0"]', { hasText: "A whole round" }));
  await w(1300);
  await shot("decide-answered");
  const q1 = p.locator('#pop .chip[data-dq="1"]', { hasText: "timer" });
  if (await q1.count()) {
    await click(q1);
    await w(1300);
  }
  await shot("decide-rec");
  await click(p.locator('#pop [data-role="decide-pick"]'));
  await w(1300);
  await shot("decide-picked");
  await p.keyboard.press("Escape");
  await w(700);

  await caption("Tidy up, then drag to rank");
  await click(p.locator("#tidy"), 300);
  await w(1600);
  await shot("tidy");
  const grips = p.locator("#grips .grip");
  {
    const [x, y] = await center(grips.nth(1));
    const [, y0] = await center(grips.nth(0));
    await moveTo(x, y);
    await w(400);
    await p.mouse.down();
    await w(150);
    await moveTo(x, y0 - 18, 28);
    await w(300);
    await p.mouse.up();
  }
  await w(1300);
  await shot("ranked");

  await caption("Shift+Enter sends it back to your agent");
  await p.evaluate(() => {
    const ta = document.querySelector<HTMLTextAreaElement>("#ta");
    if (!ta) {
      throw new Error("no #ta textarea");
    }
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  });
  await w(600);
  await p.keyboard.press("Shift+Enter");
  await w(1200);
  await caption("");
  await click(p.locator("#endedShow"), 300);
  await w(400);
  await shot("sent");
  {
    const pre = p.locator("#endedPrompt");
    if (await pre.isVisible()) {
      await pre.scrollIntoViewIfNeeded();
    }
  }
  await w(3200);
  await shot("sent2");
  console.log(JSON.stringify(await p.locator("#endedPrompt").textContent()));

  await caption("");
  await ctx.close();
  await b.close();
}

await main();
