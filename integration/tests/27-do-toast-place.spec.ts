/**
 * Where toasts stand, measured in a real browser after each step people take
 * while one is up: archive and Undo, another folder, the next message, the
 * quick reply box focused, the reply dock opened and closed, Calendar with its
 * event panel and back, window widths from 640 to 1920, a phone. After each
 * step every toast has to be inside the window, clear of the others, clear of
 * what is docked at the bottom (quick reply box, composer footer, the phone's
 * bars) and of the calendar's panel, and in the lower part of the window
 * unless it stepped up to the top corner for the focused element. And it
 * holds still while the mouse moves to it.
 *
 * Runs as dso-ux-mail@example.org on Stalwart 1.0 (seeded by
 * ~/desktop-offline/dso_uxmail_provision.py on the VM), with IT_DSO_PASSWORD
 * from the vault item "Stalwart test – dso-* throwaway accounts", through
 * desktop-offline-rig/run-spec.sh. Every archive is undone. IT_TOAST_SHOTS: a
 * folder for a screenshot of each step.
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { requireEntEnv } from './helpers/ent';
import { accountSwitcher, neutralizeDevOverlay } from './helpers/app';
import { WEBMAIL_URL } from './helpers/config';

requireEntEnv();
test.setTimeout(600_000);
test.use({ actionTimeout: 30_000 });

const USER = 'dso-ux-mail@example.org';
const PASSWORD = process.env.IT_DSO_PASSWORD ?? '';
if (!PASSWORD) throw new Error('Set IT_DSO_PASSWORD, and check the account on the VM first: see the top of this file');
const SHOTS = process.env.IT_TOAST_SHOTS ?? '';

interface Box { top: number; bottom: number; left: number; right: number }
interface Measured {
  vw: number;
  vh: number;
  dodging: boolean;
  toasts: (Box & { text: string })[];
  docked: (Box & { what: string })[];
  sheets: (Box & { footer: Box | null })[];
}

async function signIn(browser: Browser, opts: { width: number; height: number; phone?: boolean }): Promise<Page> {
  const context = await browser.newContext({
    baseURL: WEBMAIL_URL,
    locale: 'en-US',
    colorScheme: 'dark',
    viewport: { width: opts.width, height: opts.height },
    ...(opts.phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 3 } : {}),
  });
  const page = await context.newPage();
  await neutralizeDevOverlay(page);
  await page.goto('/');
  await page.fill('#username', USER);
  await page.fill('#password', PASSWORD);
  await page.click('button[type="submit"]');
  await accountSwitcher(page).waitFor({ state: 'attached', timeout: 60000 });
  await rows(page).first().waitFor({ timeout: 60000 });
  return page;
}

const rows = (page: Page) => page.locator('[data-testid=email-list-item]');
/**
 * Rows already read: opening them changes nothing on the server. With a
 * subject, since the steps find the message again by it.
 */
const readRows = (page: Page) => page.locator('[data-testid=email-list-item][data-unread="false"][data-subject]:not([data-subject=""])');
const folder = (page: Page, role: string) => page.locator(`[data-testid=folder-row][data-folder-role=${role}] button`).first();
const undoButton = (page: Page) => page.locator('[data-toast-container] button', { hasText: /^Undo$/ }).first();

/** Toasts and what they must keep clear of, as they are on screen now. */
async function measure(page: Page): Promise<Measured> {
  return page.evaluate(() => {
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    };
    const shown = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'
        && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    };
    const stack = document.querySelector<HTMLElement>('[data-toast-container]');
    const toasts = [...document.querySelectorAll('[data-toast-container] .toast-item')]
      .filter((t) => !t.classList.contains('toast-exit'))
      .map((t) => ({ ...box(t), text: (t as HTMLElement).innerText.replace(/\s+/g, ' ').slice(0, 40) }));
    // Docked at the bottom, named the way the app has always named them.
    const dockedSel = '[data-quick-reply-box], [data-composer-footer], nav[data-mobile-navigation]';
    const docked = [...document.querySelectorAll(dockedSel)].filter(shown).map((el) => ({
      ...box(el),
      what: el.hasAttribute('data-quick-reply-box') ? 'quick reply' : el.hasAttribute('data-composer-footer') ? 'composer footer' : 'tab bar',
    }));
    // The phone viewer's action bar: fixed at the bottom of the window.
    for (const nav of document.querySelectorAll('nav')) {
      const r = nav.getBoundingClientRect();
      if (shown(nav) && getComputedStyle(nav).position === 'fixed' && Math.abs(r.bottom - innerHeight) < 2 && r.height < 120) {
        docked.push({ ...box(nav), what: 'bottom bar' });
      }
    }
    const sheets = [...document.querySelectorAll('[data-end-sheet]')].filter(shown).map((s) => {
      const bars = [...s.querySelectorAll('.border-t')].filter(shown);
      const last = bars[bars.length - 1];
      return { ...box(s), footer: last ? box(last) : null };
    });
    return {
      vw: document.documentElement.clientWidth,
      vh: innerHeight,
      dodging: !!stack && stack.dataset.dodging !== undefined,
      toasts,
      docked,
      sheets,
    };
  });
}

const overlap = (a: Box, b: Box) =>
  Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;

/** What's wrong with where the toasts are now; empty when nothing is. */
function problems(m: Measured): string[] {
  const out: string[] = [];
  m.toasts.forEach((t, i) => {
    const name = `"${t.text}"`;
    if (t.left < -1 || t.top < -1 || t.right > m.vw + 1 || t.bottom > m.vh + 1) out.push(`${name} runs out of the window: ${JSON.stringify(t)}`);
    m.toasts.slice(i + 1).forEach((u) => { if (overlap(t, u)) out.push(`${name} overlaps "${u.text}"`); });
    for (const d of m.docked) if (overlap(t, d)) out.push(`${name} covers the ${d.what} (toast ${Math.round(t.top)}-${Math.round(t.bottom)}, ${d.what} from ${Math.round(d.top)})`);
    for (const s of m.sheets) {
      const room = m.vw - (s.right - s.left) - 40 >= t.right - t.left;
      if (room && overlap(t, s)) out.push(`${name} covers the panel beside which it has room`);
      if (s.footer && overlap(t, s.footer)) out.push(`${name} covers the panel's buttons`);
    }
    if (!m.dodging && t.top < m.vh * 0.35) out.push(`${name} stands in the middle of the window (top ${Math.round(t.top)} of ${m.vh})`);
    if (m.dodging && t.top > 160) out.push(`${name} is marked as moved to the top but is at ${Math.round(t.top)}`);
  });
  return out;
}

/** The toasts' enter (or exit) slide is over. */
async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => [...document.querySelectorAll('[data-toast-container] .toast-item')]
    .every((t) => t.getAnimations().every((a) => a.playState !== 'running')), undefined, { timeout: 5000 });
}

async function check(page: Page, step: string, found: string[], opts: { wantToast?: boolean } = {}): Promise<Measured> {
  // The enter animation slides in from the side; the place is what counts.
  await page.waitForTimeout(450);
  await settled(page).catch(() => {});
  const m = await measure(page);
  if (SHOTS) {
    if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, `toast-${step}.png`) });
  }
  const now = problems(m);
  if (opts.wantToast !== false && m.toasts.length === 0) now.push('no toast on screen to check');
  for (const p of now) found.push(`${step}: ${p}`);
  console.log(`${step}: ${m.toasts.length} toast(s)${m.dodging ? ', at the top' : ''}${now.length ? ' -- ' + now.join('; ') : ', fine'}`);
  return m;
}

const archived: string[] = [];

/** The subject of the selected row: the message that is open. */
async function openSubject(page: Page): Promise<string> {
  const subject = await page.locator('[data-testid=email-list-item][aria-selected="true"]').first().getAttribute('data-subject');
  if (!subject) throw new Error('no message open');
  return subject;
}

/** Archive the open message with its key (or `click`): an "Archived · Undo" toast. */
async function archive(page: Page, click?: () => Promise<void>): Promise<void> {
  await notLimited(page);
  const subject = await openSubject(page);
  const before = await page.locator('[data-toast-container] .toast-item', { hasText: 'Archived' }).count();
  if (click) await click(); else await page.keyboard.press('e');
  await expect.poll(() => page.locator('[data-toast-container] .toast-item', { hasText: 'Archived' }).count(), { timeout: 15000 }).toBeGreaterThan(before);
  archived.push(subject);
}

/** Undo the last archive with the keyboard, from the Inbox: the message is back in the list. */
async function undoLast(page: Page): Promise<void> {
  await notLimited(page);
  const subject = archived.pop();
  if (!subject) throw new Error('nothing to undo');
  await rows(page).first().focus();
  await page.keyboard.press('Control+z');
  await page.locator(`[data-testid=email-list-item][data-subject="${subject.replace(/"/g, '\\"')}"]`).first().waitFor({ state: 'attached', timeout: 60000 });
}

/**
 * The test server limits requests per address, which other runs on this
 * machine share: wait while the app says it's paused, so a step doesn't fail on it.
 */
async function notLimited(page: Page): Promise<void> {
  await expect(page.getByText('temporarily rate limited')).toHaveCount(0, { timeout: 120000 });
}

async function openRow(page: Page, n: number): Promise<void> {
  await notLimited(page);
  await readRows(page).nth(n).click();
  await page.locator('[data-quick-reply-box]').first().waitFor({ timeout: 30000 });
}

test('toasts keep their place on the desktop: folders, next message, reply box and dock, calendar, widths, hover', async ({ browser }) => {
  const page = await signIn(browser, { width: 1280, height: 720 });
  const found: string[] = [];
  const subjects = await rows(page).evaluateAll((els) => els.slice(0, 8).map((e) => e.getAttribute('data-subject')));
  const unread = await page.locator('[data-testid=email-list-item][data-unread="true"]').count();

  // Archive: the toast stands above the quick reply box of the next message.
  await openRow(page, 2);
  await archive(page);
  await check(page, 'desktop-archived', found);
  // Another folder while it's up, and back.
  await folder(page, 'sent').click();
  await check(page, 'desktop-sent', found);
  await folder(page, 'inbox').click();
  await rows(page).first().waitFor();
  await check(page, 'desktop-inbox-again', found);
  await undoLast(page);
  await check(page, 'desktop-moved-back', found);

  // The quick reply box grows when focused: toasts stay above it.
  await openRow(page, 3);
  await archive(page);
  await undoLast(page);
  await page.locator('[data-quick-reply-box] textarea').first().click();
  await check(page, 'desktop-quick-reply-focused', found);
  await page.keyboard.press('Escape');

  // The reply dock: above its footer while open, above the quick reply box
  // once it closes, and after the toolbar's Archive takes the dock away.
  await openRow(page, 3);
  await archive(page);
  await page.locator('button[title^="Reply ("]').first().click();
  const footer = page.locator('[data-composer-footer]').first();
  await footer.waitFor({ timeout: 20000 });
  await check(page, 'desktop-dock-open', found);
  await footer.locator('xpath=ancestor::*[.//button[@aria-label="Close" or @title="Close"]][1]')
    .locator('button[aria-label="Close"], button[title="Close"]').first().click();
  await footer.waitFor({ state: 'detached', timeout: 20000 });
  await page.locator('[data-quick-reply-box]').first().waitFor({ timeout: 20000 });
  await check(page, 'desktop-dock-closed', found);
  await undoLast(page);
  await openRow(page, 1);
  await page.locator('button[title^="Reply ("]').first().click();
  await footer.waitFor({ timeout: 20000 });
  await archive(page, () => page.locator('button[title^="Archive ("]').first().click());
  await footer.waitFor({ state: 'detached', timeout: 20000 });
  await check(page, 'desktop-dock-archived', found);
  await undoLast(page);

  // Calendar while a toast is up, its event panel, a narrow window, and back.
  await openRow(page, 2);
  await archive(page);
  await page.locator('a[href="/calendar"]').first().click();
  await page.waitForURL(/\/calendar/);
  await check(page, 'desktop-calendar', found);
  await page.getByRole('button', { name: /^create event$/i }).first().click();
  await page.locator('[data-end-sheet]').first().waitFor({ timeout: 20000 });
  await check(page, 'desktop-event-panel', found);
  await page.setViewportSize({ width: 760, height: 720 });
  await check(page, 'desktop-event-panel-760', found);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.keyboard.press('Escape');
  await page.locator('nav a[href="/"]').first().click();
  await rows(page).first().waitFor({ timeout: 30000 });
  await undoLast(page);
  await check(page, 'desktop-back-to-mail', found);

  // Window widths with a toast up and a message open.
  await openRow(page, 2);
  await archive(page);
  for (const width of [640, 1024, 1920, 1280]) {
    await page.setViewportSize({ width, height: 720 });
    await check(page, `desktop-width-${width}`, found);
  }
  await undoLast(page);

  // Moving the mouse to Undo: the toast holds still all the way. Once it has
  // slid in: the slide itself is no move, and ran into the first steps.
  await openRow(page, 3);
  await archive(page);
  await settled(page);
  const target = await undoButton(page).boundingBox();
  expect(target).not.toBeNull();
  const start = { x: 450, y: 300 };
  await page.mouse.move(start.x, start.y);
  const places: string[] = [];
  for (let i = 1; i <= 12; i++) {
    const x = start.x + ((target!.x + target!.width / 2 - start.x) * i) / 12;
    const y = start.y + ((target!.y + target!.height / 2 - start.y) * i) / 12;
    await page.mouse.move(x, y);
    const b = await undoButton(page).boundingBox();
    places.push(b ? `${Math.round(b.x)},${Math.round(b.y)}` : 'gone');
  }
  expect(new Set(places).size, `the Undo moved while the mouse went to it: ${places.join(' ')}`).toBe(1);
  await undoButton(page).click();
  const back = archived.pop()!;
  await page.locator(`[data-testid=email-list-item][data-subject="${back}"]`).first().waitFor({ state: 'attached', timeout: 15000 });
  await page.mouse.move(10, 10);

  // A position worked out for an element that then goes: the focused element
  // under the stack sends it to the top corner; once that element is gone the
  // stack comes back down in the next frame.
  await openRow(page, 3);
  await archive(page);
  await page.evaluate(() => {
    const b = document.createElement('button');
    b.id = 'toast-test-target';
    b.textContent = 'Save';
    // Right under the stack, where a form's Save button would be.
    const r = document.querySelector('[data-toast-container]')!.getBoundingClientRect();
    b.style.cssText = `position:fixed;left:${r.left + 20}px;top:${r.bottom - 40}px;width:80px;height:36px;z-index:1`;
    document.body.appendChild(b);
    b.focus();
  });
  await expect.poll(async () => (await measure(page)).dodging, { timeout: 3000 }).toBe(true);
  await page.evaluate(() => document.getElementById('toast-test-target')?.remove());
  await expect.poll(async () => (await measure(page)).dodging, { timeout: 3000, message: 'the stack stayed at the top after the focused element went' }).toBe(false);
  await check(page, 'desktop-focus-target-gone', found);
  await undoLast(page);

  // Everything archived came back.
  await folder(page, 'inbox').click();
  await page.waitForTimeout(1500);
  // (New mail may have come in meanwhile.)
  const after = await rows(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-subject')));
  for (const subject of subjects) expect(after).toContain(subject);
  expect(await page.locator('[data-testid=email-list-item][data-unread="true"]').count()).toBeGreaterThanOrEqual(unread);

  expect(found, found.join('\n')).toEqual([]);
  await page.context().close();
});

test('toasts keep their place on a phone: above the tab bar, the action bar and the quick reply box', async ({ browser }) => {
  const page = await signIn(browser, { width: 390, height: 844, phone: true });
  const found: string[] = [];
  const subject = await readRows(page).nth(3).getAttribute('data-subject');
  await readRows(page).nth(3).tap();
  await page.locator('[data-quick-reply-box]').first().waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: /^archive$/i }).last().tap();
  await undoButton(page).waitFor({ timeout: 15000 });
  await check(page, 'phone-archived-list', found);
  await readRows(page).nth(4).tap();
  await page.locator('[data-quick-reply-box]').first().waitFor({ timeout: 30000 });
  await check(page, 'phone-next-message', found);
  await undoButton(page).tap();
  await page.locator('[data-toast-container] .toast-item', { hasText: 'Moved back' }).first().waitFor({ state: 'attached', timeout: 15000 });
  await check(page, 'phone-moved-back', found);
  await page.getByRole('button', { name: /^back/i }).first().tap({ timeout: 5000 }).catch(() => {});
  await page.locator(`[data-testid=email-list-item][data-subject="${subject}"]`).first().waitFor({ state: 'attached', timeout: 15000 });
  expect(found, found.join('\n')).toEqual([]);
  await page.context().close();
});
