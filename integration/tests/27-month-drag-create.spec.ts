import { test, expect, type Browser, type Page } from '@playwright/test';
import { addDays, format, startOfWeek } from 'date-fns';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { contextOptions } from './helpers/ent';
import { JmapClient } from './helpers/jmap';
import { neutralizeDevOverlay } from './helpers/app';

/**
 * Usability report 2026-11-04: creating by dragging over the calendar.
 * - Month view: a drag over days (across week rows, either way), Shift+
 *   arrows and Enter, a long press and drag on a phone, all open the quick
 *   editor (the full one on a phone) for an all-day event over the days.
 * - Week view: the event created is the range the selection showed, the
 *   selection is drawn over the events it covers, the new event takes a
 *   column beside an overlapping one, and Save works without a title.
 * Against a VM 106 Stalwart (1.0 and 0.16); every save is checked on the
 * server and removed again.
 *
 * Account: dso-ux-pim, password IT_DSO_PASSWORD. Items are titled
 * "MDRAG <run> …" (the untitled one is found by its time) and deleted.
 * Screenshots go to IT_SHOTS_DIR, named month-drag-<server>-….
 */

const PASSWORD = process.env.IT_DSO_PASSWORD ?? '';
const A = 'dso-ux-pim@example.org';
const CORE = 'urn:ietf:params:jmap:core';
const CAL = 'urn:ietf:params:jmap:calendars';
const RUN = Date.now().toString(36);
const TZ = 'Europe/Berlin';
const prefix = `MDRAG ${RUN}`;
const SERVER = process.env.IT_ENT_SERVER ?? 'unknown';
const SHOTS = process.env.IT_SHOTS_DIR ?? path.join(tmpdir(), 'bulwark-month-drag');

test.skip(!PASSWORD, 'Set IT_DSO_PASSWORD (vault "Stalwart test – dso-* throwaway accounts")');

type Obj = { id: string; title?: string; start?: string; duration?: string; showWithoutTime?: boolean; calendarIds?: Record<string, boolean> };

async function events(c: JmapClient): Promise<Obj[]> {
  const r = await c.request([
    ['CalendarEvent/query', { accountId: c.accountId, limit: 2000 }, 'q'],
    ['CalendarEvent/get', {
      accountId: c.accountId,
      '#ids': { resultOf: 'q', name: 'CalendarEvent/query', path: '/ids' },
      properties: ['id', 'title', 'start', 'duration', 'showWithoutTime', 'calendarIds'],
    }, 'g'],
  ], [CORE, CAL]);
  return r.methodResponses[1][1].list as Obj[];
}

async function destroy(c: JmapClient, ids: string[]): Promise<void> {
  if (ids.length) await c.request([['CalendarEvent/set', { accountId: c.accountId, destroy: ids }, '0']], [CORE, CAL]);
}

async function defaultCalendar(c: JmapClient): Promise<string> {
  const r = await c.request([['Calendar/get', { accountId: c.accountId, properties: ['id', 'isDefault'] }, '0']], [CORE, CAL]);
  const list = r.methodResponses[0][1].list as Array<{ id: string; isDefault?: boolean }>;
  return (list.find((cal) => cal.isDefault) ?? list[0]).id;
}

async function create(c: JmapClient, title: string, start: string, duration: string, allDay = false): Promise<void> {
  await c.request([['CalendarEvent/set', {
    accountId: c.accountId,
    create: { n: { '@type': 'Event', title, start, duration, timeZone: allDay ? null : TZ, showWithoutTime: allDay, calendarIds: { [await defaultCalendar(c)]: true } } },
  }, '0']], [CORE, CAL]);
}

/** Waits for the server to hold an event that `match` accepts. */
async function serverEvent(c: JmapClient, match: (o: Obj) => boolean): Promise<Obj> {
  let found: Obj | undefined;
  await expect.poll(async () => {
    found = (await events(c)).find(match);
    return !!found;
  }, { timeout: 20000 }).toBe(true);
  return found!;
}

async function signIn(browser: Browser, opts: { dark?: boolean; width?: number; phone?: boolean } = {}): Promise<Page> {
  const base = contextOptions(opts.phone);
  const context = await browser.newContext({
    ...base,
    timezoneId: TZ,
    colorScheme: opts.dark ? 'dark' : 'light',
    viewport: opts.phone ? base.viewport : { width: opts.width ?? 1366, height: 860 },
  });
  const page = await context.newPage();
  await neutralizeDevOverlay(page);
  await page.goto('/');
  await page.locator('#username').waitFor({ state: 'visible', timeout: 60000 });
  await page.fill('#username', A);
  await page.fill('#password', PASSWORD);
  await page.click('button[type="submit"]');
  await page.locator('a[href$="/calendar"]').first().waitFor({ timeout: 60000 });
  await page.locator('a[href$="/calendar"]').first().click();
  await page.locator('[data-testid="calendar-item"]').first().waitFor({ timeout: 60000 }).catch(() => {});
  return page;
}

async function view(page: Page, key: 'm' | 'w'): Promise<void> {
  await page.locator('body').click({ position: { x: 1, y: 1 } }).catch(() => {});
  await page.keyboard.press(key);
  await page.keyboard.press('t');
  await page.waitForTimeout(800);
}

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `month-drag-${SERVER}-${name}.png`) });
}

const cell = (page: Page, day: Date) => page.locator(`[data-month-day="${format(day, 'yyyy-MM-dd')}"]`);
const picked = (page: Page) => page.$$eval('[data-month-day][aria-selected="true"]', (els) => els.map((e) => e.getAttribute('data-month-day')));
const quick = (page: Page) => page.getByRole('dialog').filter({ has: page.getByPlaceholder('Add title') });

/** Empty space of a day: just above the bottom edge of its cell. */
async function emptySpot(page: Page, day: Date): Promise<{ x: number; y: number }> {
  const box = (await cell(page, day).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height - 5 };
}

async function dragDays(page: Page, from: Date, to: Date, release = true): Promise<void> {
  const a = await emptySpot(page, from);
  const b = await emptySpot(page, to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / 10, a.y + ((b.y - a.y) * i) / 10);
  if (release) await page.mouse.up();
}

const days = (from: Date, to: Date) => {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(format(d, 'yyyy-MM-dd'));
  return out;
};

// Next week's Thursday to the Tuesday after: two week rows.
const nextMonday = addDays(startOfWeek(new Date(), { weekStartsOn: 1 }), 7);
const thursday = addDays(nextMonday, 3);
const tuesday = addDays(nextMonday, 8);

test.describe('Creating by dragging over the calendar', () => {
  test.describe.configure({ mode: 'serial' });
  let c: JmapClient;
  const untitled: string[] = [];

  test.beforeAll(async () => {
    c = await JmapClient.connect(A, PASSWORD);
  });

  test.afterAll(async () => {
    const all = await events(c);
    await destroy(c, [...all.filter((o) => o.title?.startsWith(prefix)).map((o) => o.id), ...untitled]);
  });

  test('month: a drag from Thursday to next Tuesday creates one all-day event over the days', async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await signIn(browser);
    await view(page, 'm');
    await dragDays(page, thursday, tuesday, false);
    // The days in reading order, wrapping at the end of the row.
    expect(await picked(page)).toEqual(expect.arrayContaining(days(thursday, tuesday)));
    await shot(page, 'dragging-light-1366');
    await page.mouse.up();

    const editor = quick(page);
    await expect(editor).toBeVisible();
    await expect(editor).toContainText(`${format(thursday, 'EEEE, MMMM d')} – ${format(tuesday, 'EEEE, MMMM d')}`);
    await expect(editor).toContainText('All day');
    // The placeholder spans the days while the editor is open.
    await expect(page.locator('[data-pending-preview]')).toHaveCount(2);
    await shot(page, 'popover-light-1366');
    await editor.getByPlaceholder('Add title').fill(`${prefix} trip`);
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(editor).toBeHidden();

    const saved = await serverEvent(c, (o) => o.title === `${prefix} trip`);
    expect(saved).toMatchObject({ start: `${format(thursday, 'yyyy-MM-dd')}T00:00:00`, duration: 'P6D', showWithoutTime: true });
    expect(Object.keys(saved.calendarIds ?? {})).toEqual([await defaultCalendar(c)]);
    await expect(page.locator('[data-month-day] [role="button"], [data-month-day] button').filter({ hasText: `${prefix} trip` }).first()).toBeVisible();
    await shot(page, 'saved-light-1366');
    await destroy(c, [saved.id]);
    await page.context().close();
  });

  test('month: backwards works, and Escape cancels and clears the mark (dark)', async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await signIn(browser, { dark: true });
    await view(page, 'm');
    await dragDays(page, tuesday, thursday, false);
    await shot(page, 'dragging-dark-1366');
    await page.mouse.up();
    const editor = quick(page);
    await expect(editor).toContainText(`${format(thursday, 'EEEE, MMMM d')} – ${format(tuesday, 'EEEE, MMMM d')}`);
    await shot(page, 'popover-dark-1366');
    await page.keyboard.press('Escape');
    await expect(editor).toBeHidden();
    expect((await picked(page)).filter((d) => days(thursday, tuesday).includes(d!))).toEqual([]);
    await page.context().close();
  });

  test('month: "More options" opens the full editor on the same days; a click still opens one day', async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await signIn(browser);
    await view(page, 'm');
    await dragDays(page, thursday, tuesday);
    await quick(page).getByRole('button', { name: 'More options' }).click();
    await expect(page.locator('input[type="date"]').first()).toHaveValue(format(thursday, 'yyyy-MM-dd'));
    await expect(page.locator('input[type="date"]').nth(1)).toHaveValue(format(tuesday, 'yyyy-MM-dd'));
    await expect(page.getByLabel('All-day event')).toBeChecked();
    await shot(page, 'more-options-light-1366');
    await page.getByRole('button', { name: 'Cancel' }).click();

    // A single click on empty space: the quick editor for that day, all day.
    const spot = await emptySpot(page, thursday);
    await page.mouse.click(spot.x, spot.y);
    await expect(quick(page)).toContainText(format(thursday, 'EEEE, MMMM d'));
    await expect(quick(page)).not.toContainText(' – ');
    await expect(quick(page)).toContainText('All day');
    await page.keyboard.press('Escape');
    await page.context().close();
  });

  test('month: Shift+arrows pick days and Enter opens the quick editor for them', async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await signIn(browser);
    await view(page, 'm');
    await page.locator(`[data-day-button="${format(thursday, 'yyyy-MM-dd')}"]`).focus();
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    expect(await picked(page)).toEqual(expect.arrayContaining(days(thursday, addDays(thursday, 2))));
    await page.keyboard.press('Enter');
    await expect(quick(page)).toContainText(`${format(thursday, 'EEEE, MMMM d')} – ${format(addDays(thursday, 2), 'EEEE, MMMM d')}`);
    await shot(page, 'keyboard-light-1366');
    await page.keyboard.press('Escape');
    await page.context().close();
  });

  test('month: moving an event by drag and opening it still work', async ({ browser }) => {
    test.setTimeout(180_000);
    // Next week's Sunday, a quiet day, to its Saturday.
    const sunday = addDays(nextMonday, 6);
    await create(c, `${prefix} move`, `${format(sunday, 'yyyy-MM-dd')}T00:00:00`, 'P1D', true);
    const page = await signIn(browser);
    await view(page, 'm');
    const bar = page.getByRole('button', { name: new RegExp(`${prefix} move`) }).first();
    await bar.dragTo(cell(page, addDays(sunday, -1)), { targetPosition: { x: 40, y: 90 } });
    const moved = await serverEvent(c, (o) => o.title === `${prefix} move` && o.start === `${format(addDays(sunday, -1), 'yyyy-MM-dd')}T00:00:00`);
    expect(moved.duration).toBe('P1D');
    await page.getByRole('button', { name: new RegExp(`${prefix} move`) }).first().click();
    await expect(page.getByRole('dialog').filter({ hasText: `${prefix} move` }).first()).toBeVisible();
    await page.keyboard.press('Escape');
    await page.context().close();
  });

  for (const dark of [false, true]) {
    test(`month at 800 px (${dark ? 'dark' : 'light'}): a drag over days opens an editor on them`, async ({ browser }) => {
      test.setTimeout(180_000);
      const page = await signIn(browser, { width: 800, dark });
      await view(page, 'm');
      await dragDays(page, thursday, tuesday, false);
      expect(await picked(page)).toEqual(expect.arrayContaining(days(thursday, tuesday)));
      await shot(page, `dragging-${dark ? 'dark' : 'light'}-800`);
      await page.mouse.up();
      // A narrow pane is the phone layout: the full editor; else the quick one.
      const full = page.locator('input[type="date"]').first();
      await expect(quick(page).or(full)).toBeVisible();
      if (await full.isVisible()) {
        await expect(full).toHaveValue(format(thursday, 'yyyy-MM-dd'));
        await expect(page.locator('input[type="date"]').nth(1)).toHaveValue(format(tuesday, 'yyyy-MM-dd'));
      } else {
        await expect(quick(page)).toContainText(`${format(thursday, 'EEEE, MMMM d')} – ${format(tuesday, 'EEEE, MMMM d')}`);
      }
      await shot(page, `editor-${dark ? 'dark' : 'light'}-800`);
      await page.context().close();
    });
  }

  test('phone: a long press and drag picks days; a swipe still scrolls', async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await signIn(browser, { phone: true });
    await view(page, 'm');
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: string, x?: number, y?: number) => cdp.send('Input.dispatchTouchEvent', {
      type, touchPoints: x === undefined ? [] : [{ x, y }],
    } as never);
    await cell(page, thursday).scrollIntoViewIfNeeded();
    const a = await emptySpot(page, thursday);
    const b = await emptySpot(page, tuesday);
    await touch('touchStart', a.x, a.y);
    await page.waitForTimeout(700);
    for (let i = 1; i <= 8; i++) await touch('touchMove', a.x + ((b.x - a.x) * i) / 8, a.y + ((b.y - a.y) * i) / 8);
    expect(await picked(page)).toEqual(expect.arrayContaining(days(thursday, tuesday)));
    await shot(page, 'phone-long-press');
    await touch('touchEnd');
    // Phones get the full editor, on the same days.
    await expect(page.locator('input[type="date"]').first()).toHaveValue(format(thursday, 'yyyy-MM-dd'));
    await expect(page.locator('input[type="date"]').nth(1)).toHaveValue(format(tuesday, 'yyyy-MM-dd'));
    await page.getByRole('button', { name: 'Cancel' }).click();

    const scroller = page.locator('[role="grid"] > div').first();
    const before = await scroller.evaluate((el) => el.scrollTop);
    const s = await emptySpot(page, thursday);
    await touch('touchStart', s.x, s.y);
    for (let i = 1; i <= 6; i++) await touch('touchMove', s.x, s.y - i * 40);
    await touch('touchEnd');
    await page.waitForTimeout(600);
    expect(await scroller.evaluate((el) => el.scrollTop)).not.toBe(before);
    expect((await picked(page)).length).toBeLessThanOrEqual(1);
    await expect(page.locator('input[type="date"]')).toHaveCount(0);
    await page.context().close();
  });

  test('week: the event created is the range the selection showed, beside the event it overlaps', async ({ browser }) => {
    test.setTimeout(180_000);
    // A Thursday weeks away: the account's sample events are around today, and on a
    // Thursday the drag below began on one of them (a resize handle at 11:15).
    const day = format(addDays(thursday, 35), 'yyyy-MM-dd');
    await create(c, `${prefix} Lernblock`, `${day}T12:30:00`, 'PT1H');
    for (const dark of [false, true]) {
      const page = await signIn(browser, { dark });
      await view(page, 'w');
      await page.goto(`/calendar/week/${day}`);
      const slot = page.locator(`[data-slot="${day}T11"]`);
      await slot.waitFor({ timeout: 60000 });
      await slot.scrollIntoViewIfNeeded();
      const box = (await slot.boundingBox())!;
      const y = (minutes: number) => box.y + ((minutes - 660) / 60) * box.height;
      const x = box.x + box.width / 2;
      // Nothing else where the drag begins.
      expect(await page.evaluate(([px, py]) => !document.elementFromPoint(px, py)?.closest('[data-calendar-event]'), [x, y(675)])).toBe(true);
      await page.mouse.move(x, y(675));
      await page.mouse.down();
      for (let m = 690; m <= 975; m += 15) await page.mouse.move(x, y(m));
      const selection = page.locator('[data-drag-selection]');
      await expect(selection).toContainText('11:15 – 16:15');
      // Drawn over the event it covers: the event doesn't show through.
      // (Both sit in the day's column: the higher z-index is on top, and the fill has no transparency.)
      const looks = await page.evaluate((title) => {
        const sel = document.querySelector('[data-drag-selection]')!;
        const ev = Array.from(document.querySelectorAll('[data-calendar-event]')).find((el) => el.textContent?.includes(title))!;
        return { selZ: Number(getComputedStyle(sel).zIndex), evZ: Number(getComputedStyle(ev).zIndex), fill: getComputedStyle(sel).backgroundColor, sameColumn: sel.parentElement === ev.parentElement };
      }, `${prefix} Lernblock`);
      expect(looks.sameColumn).toBe(true);
      expect(looks.selZ).toBeGreaterThan(looks.evZ);
      expect(looks.fill).not.toMatch(/rgba\(.*,\s*0(\.\d+)?\)|\/\s*0?\.\d+\)|transparent/);
      await shot(page, `week-dragging-${dark ? 'dark' : 'light'}-1366`);
      await page.mouse.up();
      const editor = quick(page);
      await expect(editor).toContainText('11:15 – 16:15');
      // The new event and the one it overlaps share the day's width.
      const placeholder = (await page.locator('[data-pending-preview]').boundingBox())!;
      const lernblock = (await page.locator('div[data-calendar-event]').filter({ hasText: `${prefix} Lernblock` }).first().boundingBox())!;
      expect(placeholder.x + placeholder.width <= lernblock.x + 1 || lernblock.x + lernblock.width <= placeholder.x + 1).toBe(true);
      await shot(page, `week-popover-${dark ? 'dark' : 'light'}-1366`);
      if (!dark) {
        // Save without a title.
        await editor.getByRole('button', { name: 'Save' }).click();
        // Untitled, not the words "(No title)" (0050c54b4).
        const saved = await serverEvent(c, (o) => o.start === `${day}T11:15:00` && !o.title);
        untitled.push(saved.id);
        expect(saved.duration).toBe('PT5H');
        await page.waitForTimeout(1000);
        await shot(page, 'week-saved-light-1366');
        // Out of the way of the next drag, which starts at the same spot.
        await destroy(c, [saved.id]);
      } else {
        await page.keyboard.press('Escape');
      }
      await page.context().close();
    }
  });
});
