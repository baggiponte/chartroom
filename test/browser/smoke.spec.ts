import { expect, type Page, test } from "@playwright/test";

const PAGE = new URL("../../skills/help-me/index.html", import.meta.url).href;

async function openDemo(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => {
    if (m.type() === "error") {
      errors.push(m.text());
    }
  });
  await page.goto(PAGE);
  await expect(page.locator(".backdrop mark").first()).toBeVisible();
  return errors;
}

// The marks sit behind the textarea (pointer-events: none), so a locator click lands on the textarea; click where the
// mark is drawn instead, as a person would.
async function clickMark(page: Page, text: string): Promise<void> {
  const box = await page
    .locator(".backdrop mark", { hasText: text })
    .first()
    .evaluate(m => {
      const r = m.getClientRects()[0];
      if (!r) {
        throw new Error("mark has no box");
      }
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
  await page.mouse.click(box.x, box.y);
}

test("the demo page loads with underlines and no errors", async ({ page }) => {
  const errors = await openDemo(page);
  await expect(page.locator(".backdrop mark", { hasText: "coffee machine" })).toHaveCount(1);
  await expect(page.locator(".backdrop mark", { hasText: "[budget]" })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("picking an option in an underline's popover rewrites the request", async ({ page }) => {
  await openDemo(page);
  await clickMark(page, "coffee machine");
  const pop = page.locator("#pop");
  await expect(pop).toBeVisible();
  await pop.getByRole("button", { name: "Pod" }).click();
  await expect(page.locator("#ta")).toHaveValue(/pod machine/);
});

test("tidy up reorders a long request and undo brings it back", async ({ page }) => {
  await openDemo(page);
  const ta = page.locator("#ta");
  const text =
    "Help me choose a home coffee machine for my small kitchen, something good for lattes. " +
    "I'm a beginner. My budget is up to €400. I like a retro look.";
  await ta.fill(text);
  const tidy = page.locator("#tidy");
  await expect(tidy).toBeVisible();
  await expect(tidy).toBeEnabled();
  await tidy.click();
  await expect(tidy).toHaveText(/Undo/);
  await expect(ta).not.toHaveValue(text);
  await tidy.click();
  await expect(ta).toHaveValue(text);
});

test("after Send the page shows what was sent and the popovers are read-only", async ({ page }) => {
  await openDemo(page);
  await page.locator("#send").click();
  await expect(page.locator("#endedBar")).toBeVisible();
  await page.locator("#endedShow").click();
  await expect(page.locator("#endedPrompt")).toContainText("coffee machine");
  await clickMark(page, "coffee machine");
  await expect(page.locator("#pop")).toBeVisible();
  await expect(page.locator("#pop .chip:enabled")).toHaveCount(0);
});

test("nothing overflows sideways on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  await openDemo(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
