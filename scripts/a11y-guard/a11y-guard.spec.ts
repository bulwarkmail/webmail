import { test, expect, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Fails when a main screen gets more serious or critical axe violations
 * than budget.json allows, or when one of the keyboard checks axe can't
 * make breaks. See playwright.config.ts.
 */

type Budget = Record<string, number>;
type AxeNode = { target: string[] };
type AxeViolation = { id: string; impact: string | null; nodes: AxeNode[] };

const UPDATE = process.env.A11Y_GUARD_UPDATE === "1";
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
/** The message list's rows (a treegrid, components/email/list-a11y.ts). */
const ROWS = '[data-tour="email-list"] [role="treegrid"] [role="row"]';

async function runAxe(page: Page, dir: string): Promise<AxeViolation[]> {
  // The app's CSP allows only nonce scripts, so addScriptTag is refused;
  // evaluate goes through the DevTools protocol, which CSP doesn't cover.
  if (!(await page.evaluate(() => "axe" in window))) {
    await page.evaluate(readFileSync(join(dir, "axe.min.js"), "utf8"));
  }
  return page.evaluate(async (tags) => {
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: AxeViolation[] }> } };
    const result = await w.axe.run(document, { runOnly: { type: "tag", values: tags }, resultTypes: ["violations"] });
    return result.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => ({ target: n.target })) }));
  }, TAGS);
}

const serious = (vs: AxeViolation[]) => vs.filter((v) => v.impact === "serious" || v.impact === "critical");
const nodeCount = (vs: AxeViolation[]) => vs.reduce((n, v) => n + v.nodes.length, 0);

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /^sign in$/i }).first().click();
  await page.locator('[data-tour="email-list"]').waitFor({ timeout: 90_000 });
  await page.waitForTimeout(1500);
  for (const name of [/^got it$/i, /^dismiss$/i]) {
    const button = page.getByRole("button", { name }).first();
    // Best effort: a banner may sit under another one or be gone already.
    if (await button.isVisible().catch(() => false)) await button.click({ timeout: 3000 }).catch(() => {});
  }
}

/** Rail navigation: a page.goto after sign-in would drop the session. */
async function openApp(page: Page, app: string) {
  await page.locator(`[data-tour="nav-${app}"]`).first().click();
  await page.waitForTimeout(1500);
}

test("main screens stay within their accessibility budget", async ({ page }, testInfo) => {
  const dir = testInfo.project.testDir;
  const budgetFile = join(dir, "budget.json");
  const budget: Budget = UPDATE ? {} : JSON.parse(readFileSync(budgetFile, "utf8"));
  const found: Budget = {};
  const details: string[] = [];

  const measure = async (screen: string) => {
    const vs = serious(await runAxe(page, dir));
    found[screen] = nodeCount(vs);
    if (!UPDATE && found[screen] > (budget[screen] ?? 0)) {
      details.push(`${screen}: ${found[screen]} nodes (budget ${budget[screen] ?? 0})\n` +
        vs.map((v) => `  ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(", ")}`).join("\n"));
    }
  };

  await signIn(page);
  await measure("mail-list");

  await page.locator(ROWS).first().click();
  await page.locator('[data-tour="email-viewer"]').waitFor();
  await page.waitForTimeout(1000);
  await measure("reading-pane");

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^(compose|new message)$/i }).first().click();
  await page.waitForTimeout(1200);
  await measure("compose");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);

  await openApp(page, "calendar");
  await measure("calendar");

  await openApp(page, "contacts");
  await measure("contacts");

  await openApp(page, "settings");
  await page.getByRole("button", { name: /^accessibility$/i }).first().click();
  await page.waitForTimeout(800);
  await measure("settings-accessibility");

  if (UPDATE) {
    writeFileSync(budgetFile, JSON.stringify(found, null, 2) + "\n");
    return;
  }
  expect(details, details.join("\n")).toEqual([]);
});

test("keyboard focus stays visible in Windows contrast themes", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active" });
  await signIn(page);
  // Tab to a few controls and check each draws a real outline, which forced
  // colours keep (a box-shadow ring would disappear).
  const outlines: string[] = [];
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    outlines.push(await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body || el.getAttribute("tabindex") === "-1") return "skip";
      const cs = getComputedStyle(el);
      return cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 2 ? "ok" : `${el.tagName}:${cs.outlineStyle}`;
    }));
  }
  expect(outlines.filter((o) => o !== "ok" && o !== "skip")).toEqual([]);
});

test("menus open in place under reduced motion", async ({ page }) => {
  // Reduce motion shortens transitions to 0.01ms, but Chrome paints a
  // transition's first frame at its start value: a menu moved from where it
  // was measured showed there for a frame (the Sort submenu in the corner).
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signIn(page);
  // Each frame, where every visible menu is painted.
  await page.evaluate(() => {
    const frames = new Map<Element, string[]>();
    (window as unknown as { __menuFrames: typeof frames }).__menuFrames = frames;
    const tick = () => {
      for (const menu of document.querySelectorAll('[role="menu"]')) {
        if (getComputedStyle(menu).visibility !== "visible") continue;
        const r = menu.getBoundingClientRect();
        frames.set(menu, [...(frames.get(menu) ?? []), `${Math.round(r.left)},${Math.round(r.top)}`]);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.getByTestId("mail-folder-menu").first().click();
  await page.getByTestId("mail-sort").click();
  await page.getByTestId("mail-sort-oldest").waitFor();
  await page.waitForTimeout(500);
  const result = await page.evaluate(() => {
    const frames = (window as unknown as { __menuFrames: Map<Element, string[]> }).__menuFrames;
    const jumps: string[] = [];
    for (const [menu, seen] of frames) {
      const r = menu.getBoundingClientRect();
      const final = `${Math.round(r.left)},${Math.round(r.top)}`;
      const elsewhere = seen.filter((at) => at !== final);
      if (elsewhere.length > 0) jumps.push(`${menu.getAttribute("aria-label") ?? "menu"} at ${elsewhere.join(" ")} before ${final}`);
    }
    return { jumps, menus: frames.size };
  });
  // The ⋮ menu and its Sort submenu.
  expect(result.menus).toBe(2);
  expect(result.jumps).toEqual([]);
});

test("single-key shortcuts don't act behind an open dialog", async ({ page }) => {
  await signIn(page);
  const rows = page.locator(ROWS);
  await rows.first().click();
  const before = await rows.count();
  await page.keyboard.press("Shift+?");
  await page.getByRole("dialog").first().waitFor();
  await page.keyboard.press("Tab");
  for (const key of ["Delete", "#", "e", "j", "ArrowDown"]) await page.keyboard.press(key);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);
  expect(await rows.count()).toBe(before);
});
