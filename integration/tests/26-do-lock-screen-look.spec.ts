import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { ENT, ENT_PASSWORD, contextOptions, deliver, requireEntEnv } from './helpers/ent';
import { accountSwitcher } from './helpers/app';

/**
 * The lock screen's look, through the real UI on a production build, with the
 * throwaway ent-carol:
 * - in a window whose controls lie over the page (the desktop app, an installed PWA),
 *   the top row drags the window, and the PIN field and buttons don't;
 * - behind the card, the app's skeleton: shapes, no text, nothing of the mail that was
 *   on screen a moment before;
 * - screenshots light and dark, desktop and phone, to IT_LOCK_SHOTS when set.
 *
 * The overlay is Chromium's own API, stubbed: a browser has none, and the desktop app's
 * titleBarOverlay gives the page the same one. Its rect is a 40px row with 138px of
 * controls at the right, as on Windows.
 */

test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

const RUN = Date.now().toString(36);
const PIN = 'it-pin-4827';
const SUBJECT = `lockscreen-look-${RUN}`;
const ROW = 40;
const CONTROLS = 138;

test.beforeAll(async () => {
  requireEntEnv();
  await deliver({ from: ENT.bob, to: [ENT.carol], subject: SUBJECT, text: `Body of ${SUBJECT}` });
});

function stubOverlay(): void {
  const target = new EventTarget();
  Object.defineProperty(navigator, 'windowControlsOverlay', {
    configurable: true,
    value: Object.assign(target, {
      visible: true,
      getTitlebarAreaRect: () => ({ x: 0, y: 0, width: innerWidth - 138, height: 40, top: 0, left: 0, right: innerWidth - 138, bottom: 40 }),
    }),
  });
}

async function open(browser: Browser, opts: { phone?: boolean; dark?: boolean; overlay?: boolean } = {}): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext({ ...contextOptions(opts.phone), colorScheme: opts.dark ? 'dark' : 'light' });
  if (opts.overlay) await context.addInitScript(stubOverlay);
  const page = await context.newPage();
  return { page, context };
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.fill('#username', ENT.carol);
  await page.fill('#password', ENT_PASSWORD);
  await page.click('button[type="submit"]');
  await accountSwitcher(page).waitFor({ state: 'attached', timeout: 60_000 });
}

const softGoto = (page: Page, target: string) =>
  page.evaluate((to) => (window as unknown as { next: { router: { push(path: string): void } } }).next.router.push(to), target);

/** Lock with the mail loaded in this document, the delivered message among it. */
async function lockOverMail(page: Page): Promise<void> {
  await softGoto(page, '/settings/general');
  const toggle = page.getByTestId('app-lock-switch');
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  await toggle.click();
  await page.getByTestId('app-lock-new-pin').fill(PIN);
  await page.getByTestId('app-lock-repeat-pin').fill(PIN);
  await page.getByTestId('app-lock-dialog-save').click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 });
  // No reload in between: a reload would ask for the PIN.
  await softGoto(page, '/');
  await expect(page.getByText(SUBJECT).first()).toBeVisible({ timeout: 60_000 });
  await softGoto(page, '/settings/general');
  await page.getByTestId('app-lock-now').click();
  await expect(page.getByTestId('app-lock-form')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(500);
}

/**
 * What the window would do with a press at (x, y): Chromium takes every element with an
 * app-region, in document order, and each one's box replaces what was there. body::before
 * comes first. The property is inherited, so a fixed screen's no-drag is every child's too
 * unless it says otherwise.
 */
function regionAt(page: Page, x: number, y: number): Promise<string> {
  return page.evaluate(([px, py]) => {
    const of = (style: CSSStyleDeclaration) => (style as CSSStyleDeclaration & { appRegion?: string; webkitAppRegion?: string }).appRegion
      || (style as CSSStyleDeclaration & { webkitAppRegion?: string }).webkitAppRegion || '';
    let result = 'none';
    const before = getComputedStyle(document.body, '::before');
    if (before.content !== 'none' && py < parseFloat(before.height || '0') && ['drag', 'no-drag'].includes(of(before))) result = of(before);
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const style = getComputedStyle(el);
      const region = of(style);
      if (region !== 'drag' && region !== 'no-drag') continue;
      if (style.display === 'none') continue;
      const box = el.getBoundingClientRect();
      if (px >= box.left && px < box.right && py >= box.top && py < box.bottom) result = region;
    }
    return result;
  }, [x, y] as const);
}

async function lockShot(page: Page, name: string): Promise<void> {
  const dir = process.env.IT_LOCK_SHOTS;
  if (!dir) return;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `lock-screen-${name}.png`) });
}

test('the login drags by its top row under the window controls, its fields don\'t', async ({ browser }) => {
  const { page, context } = await open(browser, { overlay: true });
  await page.goto('/');
  await page.locator('#username').waitFor({ timeout: 60_000 });
  await expect(page.locator('html')).toHaveAttribute('data-window-controls', '');
  expect(await regionAt(page, 200, ROW / 2)).toBe('drag');
  const field = (await page.locator('#username').boundingBox())!;
  expect(await regionAt(page, field.x + field.width / 2, field.y + field.height / 2)).toBe('no-drag');
  await context.close();
});

test('locked, in a window with its controls over the page: the top row drags it, the card\'s fields and buttons don\'t', async ({ browser }) => {
  const { page, context } = await open(browser, { overlay: true, dark: true });
  await signIn(page);
  await lockOverMail(page);
  const width = page.viewportSize()!.width;
  // Empty parts of the top row, at both ends of it and in the middle.
  for (const x of [8, width / 2, width - CONTROLS - 8]) expect(await regionAt(page, x, ROW / 2)).toBe('drag');
  // Below the row, the lock screen is no window handle.
  expect(await regionAt(page, 8, ROW + 60)).toBe('no-drag');
  const clickable = page.locator('[data-app-lock-overlay] :is(input, button)');
  expect(await clickable.count()).toBeGreaterThan(1);
  for (const el of await clickable.all()) {
    const box = (await el.boundingBox())!;
    expect(await regionAt(page, box.x + box.width / 2, box.y + box.height / 2)).toBe('no-drag');
  }
  // A window so short that the card reaches the row: its field still takes the press.
  await page.setViewportSize({ width: 900, height: 260 });
  await page.waitForTimeout(300);
  const pin = page.getByTestId('app-lock-pin');
  await pin.scrollIntoViewIfNeeded();
  const box = (await pin.boundingBox())!;
  expect(await regionAt(page, box.x + box.width / 2, box.y + box.height / 2)).toBe('no-drag');
  await context.close();
});

for (const look of [
  { name: 'light', dark: false, phone: false },
  { name: 'dark', dark: true, phone: false },
  { name: 'phone-light', dark: false, phone: true },
  { name: 'phone-dark', dark: true, phone: true },
]) {
  test(`${look.name}: the app's skeleton behind the card, with nothing of the mail in it`, async ({ browser }) => {
    const { page, context } = await open(browser, { dark: look.dark, phone: look.phone, overlay: !look.phone });
    await signIn(page);
    await lockOverMail(page);
    const backdrop = page.locator('[data-app-lock-overlay] [data-app-lock-backdrop]');
    await expect(backdrop).toBeVisible();
    expect(await backdrop.locator('.sk-shape').count()).toBeGreaterThan(20);
    // Behind the card: the card is what's under its own centre.
    const card = (await page.locator('[data-app-lock-card]').boundingBox())!;
    const top = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-app-lock-card]') !== null, [card.x + card.width / 2, card.y + 8] as const);
    expect(top).toBe(true);
    expect(await backdrop.evaluate((el) => getComputedStyle(el).filter)).toContain('blur');
    // Shapes only, and nothing of what was on screen anywhere in the overlay.
    expect(await backdrop.evaluate((el) => el.textContent ?? '')).not.toMatch(/[\p{L}\p{N}]/u);
    const html = await page.locator('[data-app-lock-overlay]').evaluate((el) => el.outerHTML);
    expect(html).not.toContain(SUBJECT);
    expect(html).not.toContain('ent-carol');
    expect(await page.locator('body').innerText()).not.toContain(SUBJECT);
    await lockShot(page, look.name);
    await context.close();
  });
}

test('more contrast or reduced motion: the plain background, or shapes that stand still', async ({ browser }) => {
  const { page, context } = await open(browser, { overlay: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signIn(page);
  await lockOverMail(page);
  const backdrop = page.locator('[data-app-lock-overlay] [data-app-lock-backdrop]');
  expect(await backdrop.locator('.sk-shape').first().evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  await page.emulateMedia({ contrast: 'more' } as Parameters<Page['emulateMedia']>[0]);
  await expect(backdrop).toBeHidden();
  await page.emulateMedia({ contrast: 'no-preference', forcedColors: 'active' } as Parameters<Page['emulateMedia']>[0]);
  await expect(backdrop).toBeHidden();
  await context.close();
});

test('right to left: the skeleton mirrors with the page', async ({ browser }) => {
  const { page, context } = await open(browser, { overlay: true });
  await signIn(page);
  await lockOverMail(page);
  const rail = page.locator('[data-app-lock-backdrop] .w-14').first();
  expect((await rail.boundingBox())!.x).toBeLessThan(2);
  // The page's direction, as a right-to-left language sets it: logical sides throughout.
  await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
  const box = (await rail.boundingBox())!;
  expect(box.x + box.width).toBeGreaterThan(page.viewportSize()!.width - 2);
  await lockShot(page, 'rtl');
  await context.close();
});
