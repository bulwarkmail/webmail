/**
 * Hovering the folded folder column must not move anything under the pointer.
 * It floated the whole tree out from the window's edge, over the app rail,
 * with the account header, section headings and subfolders added above the
 * hovered rows: every icon moved and the item under the pointer changed. Now
 * the column shows its names beside the same items, from its own edge.
 *
 * Measures real layout in Chromium: each item's icon, the header's buttons
 * and All folders, folded and with the names shown, left to right and right
 * to left, at the top of the column and scrolled. Reads only; signs in as
 * ent-alice. Run with desktop-offline-rig/run-spec.sh.
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { ENT, ENT_PASSWORD, requireEntEnv, shot } from './helpers/ent';
import { accountSwitcher, neutralizeDevOverlay } from './helpers/app';
import { WEBMAIL_URL } from './helpers/config';

requireEntEnv();

type Box = { x: number; y: number };

async function signIn(browser: Browser, locale: string, height: number): Promise<Page> {
  const context = await browser.newContext({ baseURL: WEBMAIL_URL, locale, viewport: { width: 1280, height } });
  const page = await context.newPage();
  await neutralizeDevOverlay(page);
  await page.goto('/');
  await page.fill('#username', ENT.alice);
  await page.fill('#password', ENT_PASSWORD);
  await page.click('button[type="submit"]');
  await accountSwitcher(page).waitFor({ state: 'visible', timeout: 60000 });
  await page.locator('[data-folder-nav] [data-rail-key]').first().waitFor({ timeout: 60000 });
  if (!(await page.locator('[data-folder-rail]').count())) await page.getByTestId('sidebar-collapse').click();
  await page.locator('[data-folder-rail]').waitFor();
  // Folding with » is a 300 ms width transition: let it end before measuring.
  await page.waitForTimeout(800);
  return page;
}

/** Where every icon and button of the column is, by key. */
function positions(page: Page): Promise<Record<string, Box>> {
  return page.evaluate(() => {
    const out: Record<string, { x: number; y: number }> = {};
    const put = (key: string, el: Element | null | undefined) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width) out[key] = { x: r.left, y: r.top };
    };
    for (const row of document.querySelectorAll<HTMLElement>('[data-folder-nav] [data-rail-key]')) {
      put(row.dataset.railKey!, row.querySelector(':scope > button [data-rail-icon]'));
    }
    put('collapse', document.querySelector('[data-testid="sidebar-collapse"]'));
    put('compose', document.querySelector('[data-sidebar-compose]'));
    put('all-folders', document.querySelector('[data-testid="folded-all-folders"]'));
    return out;
  });
}

const railKeyAt = (page: Page, x: number, y: number) =>
  page.evaluate(([px, py]) => (document.elementFromPoint(px, py)?.closest('[data-rail-key]') as HTMLElement | null)?.dataset.railKey ?? null, [x, y]);

async function check(page: Page, name: string, scroll: number) {
  const nav = page.locator('[data-folder-nav]');
  await page.mouse.move(900, 400);
  await nav.evaluate((el, top) => { el.scrollTop = top; }, scroll);
  const scrolled = await nav.evaluate((el) => el.scrollTop);
  const column = await page.locator('[data-folder-nav]').evaluate((el) => el.parentElement!.getBoundingClientRect().toJSON());
  const list = await page.locator('[data-pane="list"]').first().boundingBox();
  const before = await positions(page);
  expect(Object.keys(before).length).toBeGreaterThan(4);

  // Rest the pointer on the last item in view.
  const items = page.locator('[data-folder-nav] [data-rail-key] > button');
  const count = await items.count();
  let target = items.nth(0);
  for (let i = count - 1; i >= 0; i--) {
    const b = await items.nth(i).boundingBox();
    const view = await nav.boundingBox();
    if (b && view && b.y >= view.y && b.y + b.height <= view.y + view.height) { target = items.nth(i); break; }
  }
  const tb = (await target.boundingBox())!;
  const px = tb.x + tb.width / 2;
  const py = tb.y + tb.height / 2;
  await page.mouse.move(px, py, { steps: 3 });
  const under = await railKeyAt(page, px, py);
  const root = page.locator('[data-folder-rail-labels]');
  await expect(root).toHaveCount(1);
  // At once, not after a width transition that slides the icons on the way.
  const atOnce = await positions(page);
  await page.waitForTimeout(400);
  await shot(page, `rail-hover-it-${name}`);

  // Nothing moved, the same item is under the pointer, the list stayed.
  expect(await railKeyAt(page, px, py)).toBe(under);
  const after = await positions(page);
  for (const [when, now] of [['at once', atOnce], ['settled', after]] as const) {
    for (const [key, b] of Object.entries(before)) {
      expect(now[key], `${key} is still there (${when})`).toBeTruthy();
      expect(Math.abs(now[key].x - b.x), `${key} x (${when})`).toBeLessThanOrEqual(0.5);
      expect(Math.abs(now[key].y - b.y), `${key} y (${when})`).toBeLessThanOrEqual(0.5);
    }
  }
  expect(await nav.evaluate((el) => el.scrollTop)).toBe(scrolled);
  expect(await page.locator('[data-folder-drawer]').count()).toBe(0);
  const open = await root.boundingBox();
  // Grows from the column's own start edge, away from the app rail.
  const rtl = await page.evaluate(() => document.documentElement.dir === 'rtl');
  if (rtl) expect(Math.abs(open!.x + open!.width - column.right)).toBeLessThanOrEqual(0.5);
  else expect(Math.abs(open!.x - column.left)).toBeLessThanOrEqual(0.5);
  expect(open!.width).toBeGreaterThan(column.width + 100);
  expect(await page.locator('[data-pane="list"]').first().boundingBox()).toEqual(list);

  // Off the column: the names fold after a moment, and the icons stay put
  // as they go.
  await page.mouse.move(900, 400);
  await expect(root).toHaveCount(0);
  const folded = await positions(page);
  for (const [key, b] of Object.entries(before)) {
    expect(Math.abs(folded[key].x - b.x), `${key} x (folding)`).toBeLessThanOrEqual(0.5);
  }
}

test.describe('the folded folder column on hover', () => {
  test('keeps every icon in place, left to right', async ({ browser }) => {
    const page = await signIn(browser, 'en-US', 800);
    await check(page, 'ltr', 0);
    await page.context().close();
  });

  test('keeps every icon in place when scrolled, in a short window', async ({ browser }) => {
    const page = await signIn(browser, 'en-US', 480);
    await check(page, 'scrolled', 120);
    await page.context().close();
  });

  test('keeps every icon in place, right to left', async ({ browser }) => {
    const page = await signIn(browser, 'ar', 800);
    await check(page, 'rtl', 0);
    await page.context().close();
  });
});
