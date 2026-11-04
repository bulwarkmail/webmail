import { test, expect, type Page, type Locator } from '@playwright/test';
import { addDays, format } from 'date-fns';
import { contextOptions } from './helpers/ent';
import { JmapClient } from './helpers/jmap';
import { accountSwitcher, neutralizeDevOverlay } from './helpers/app';

/**
 * Usability fix pim-9: invitations the user hasn't answered look different
 * in the grid and can be answered from it, against a VM 106 Stalwart (1.0
 * and 0.16). Every answer is checked on the server: the user's own copy and,
 * where the server passes the reply on, the organiser's.
 *
 * Accounts: dso-ux-pim-b invites dso-ux-pim (both IT_DSO_PASSWORD). The spec
 * makes its own events, titled "UXFIX-grid …", and removes them again.
 */

const PASSWORD = process.env.IT_DSO_PASSWORD ?? '';
const A = 'dso-ux-pim@example.org';
const B = 'dso-ux-pim-b@example.org';
const CORE = 'urn:ietf:params:jmap:core';
const CAL = 'urn:ietf:params:jmap:calendars';
const MAIL = 'urn:ietf:params:jmap:mail';
const RUN = Date.now().toString(36);
const TZ = 'Europe/Berlin';

test.skip(!PASSWORD, 'Set IT_DSO_PASSWORD (vault "Stalwart test – dso-* throwaway accounts")');

type Participant = { calendarAddress?: string; participationStatus?: string };
type Obj = Record<string, unknown> & {
  id: string; title?: string; start?: string;
  participants?: Record<string, Participant> | null;
  recurrenceOverrides?: Record<string, Record<string, unknown>> | null;
};

async function defaultCalendar(c: JmapClient): Promise<string> {
  const r = await c.request([['Calendar/get', { accountId: c.accountId, properties: ['id', 'name', 'isDefault'] }, '0']], [CORE, CAL]);
  const list = r.methodResponses[0][1].list as Array<{ id: string; isDefault?: boolean }>;
  return (list.find((cal) => cal.isDefault) ?? list[0]).id;
}

async function objects(c: JmapClient, prefix: string): Promise<Obj[]> {
  const r = await c.request([
    ['CalendarEvent/query', { accountId: c.accountId, limit: 1000 }, 'q'],
    ['CalendarEvent/get', {
      accountId: c.accountId,
      '#ids': { resultOf: 'q', name: 'CalendarEvent/query', path: '/ids' },
      properties: ['id', 'title', 'start', 'participants', 'recurrenceOverrides'],
    }, 'g'],
  ], [CORE, CAL]);
  return (r.methodResponses[1][1].list as Obj[]).filter((o) => typeof o.title === 'string' && o.title.startsWith(prefix));
}

async function destroyAll(c: JmapClient, prefix: string): Promise<void> {
  const ids = (await objects(c, prefix)).map((o) => o.id);
  if (ids.length) await c.request([['CalendarEvent/set', { accountId: c.accountId, destroy: ids }, '0']], [CORE, CAL]);
}

async function destroyMails(c: JmapClient, word: string): Promise<void> {
  const r = await c.request([['Email/query', { accountId: c.accountId, filter: { subject: word }, limit: 100 }, 'q']], [CORE, MAIL]);
  const ids = r.methodResponses[0][1].ids as string[];
  if (ids.length) await c.request([['Email/set', { accountId: c.accountId, destroy: ids }, '0']], [CORE, MAIL]);
}

/** A's answer in a participants map (or an override's). */
function statusOf(participants: Record<string, Participant> | null | undefined, address: string): string | undefined {
  return Object.values(participants ?? {}).find((p) => p.calendarAddress?.toLowerCase() === `mailto:${address}`)?.participationStatus;
}

/** B invites A; returns once the invitation is in A's calendar. */
async function invite(b: JmapClient, a: JmapClient, title: string, start: string, extra: Record<string, unknown> = {}): Promise<void> {
  const r = await b.request([['CalendarEvent/set', {
    accountId: b.accountId,
    sendSchedulingMessages: true,
    create: {
      i: {
        '@type': 'Event', title, uid: `uxfix-grid-${title.replace(/\W+/g, '-')}`, start, duration: 'PT1H', timeZone: TZ,
        calendarIds: { [await defaultCalendar(b)]: true },
        participants: {
          o: { '@type': 'Participant', calendarAddress: `mailto:${B}`, roles: { owner: true, attendee: true }, participationStatus: 'accepted' },
          p: { '@type': 'Participant', calendarAddress: `mailto:${A}`, roles: { attendee: true }, participationStatus: 'needs-action', expectReply: true },
        },
        ...extra,
      },
    },
  }, '0']], [CORE, CAL]);
  expect(r.methodResponses[0][1].created?.i?.id, JSON.stringify(r.methodResponses[0][1].notCreated ?? {})).toBeTruthy();
  await expect.poll(async () => (await objects(a, title)).length, { timeout: 120000 }).toBeGreaterThan(0);
}

async function login(page: Page, email: string): Promise<void> {
  await neutralizeDevOverlay(page);
  await page.goto('/');
  await page.locator('#username').waitFor({ state: 'visible', timeout: 60000 });
  await page.fill('#username', email);
  await page.fill('#password', PASSWORD);
  await page.click('button[type="submit"]');
  await accountSwitcher(page).waitFor({ state: 'visible', timeout: 60000 });
}

/** The card of `title` on screen: the week view also renders the weeks beside it. */
async function cardOnScreen(page: Page, title: string): Promise<Locator> {
  const cards = page.locator(`button[aria-label^="${title},"]`);
  await cards.first().waitFor({ state: 'attached', timeout: 60000 });
  const { width, height } = page.viewportSize()!;
  for (let i = 0; i < await cards.count(); i++) {
    const box = await cards.nth(i).boundingBox();
    if (box && box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= height) return cards.nth(i);
  }
  throw new Error(`no card of ${title} on screen`);
}

const day = (offset: number) => format(addDays(new Date(), offset), 'yyyy-MM-dd');

test.describe('Answering invitations from the grid (pim-9)', () => {
  test.describe.configure({ mode: 'serial' });
  const prefix = `UXFIX-grid ${RUN}`;

  test.afterAll(async () => {
    const a = await JmapClient.connect(A, PASSWORD);
    const b = await JmapClient.connect(B, PASSWORD);
    await destroyAll(b, prefix);
    await destroyAll(a, prefix);
    await destroyMails(a, prefix);
    await destroyMails(b, prefix);
  });

  test('an unanswered invitation is marked in month, week and agenda, and its marker accepts it', async ({ browser }, info) => {
    test.setTimeout(300_000);
    const a = await JmapClient.connect(A, PASSWORD);
    const b = await JmapClient.connect(B, PASSWORD);
    // Three weeks out: the seeded days around today are full, and the month
    // view would fold the invitation into "+n more".
    const when = day(24);
    const title = `${prefix} single`;
    await invite(b, a, title, `${when}T10:00:00`);
    expect(statusOf((await objects(a, title))[0].participants, A)).toBe('needs-action');

    const context = await browser.newContext({ ...contextOptions(), timezoneId: TZ, viewport: { width: 1366, height: 768 } });
    const page = await context.newPage();
    await login(page, A);

    // Month: outlined, with the marker.
    await page.goto(`/calendar/month/${when}`);
    await expect(async () => {
      const card = await cardOnScreen(page, title);
      await expect(card).toHaveAttribute('data-reply-state', 'needs-action', { timeout: 2000 });
    }).toPass({ timeout: 60000 });
    expect(await (await cardOnScreen(page, title)).getAttribute('aria-label')).toContain('Not answered yet');

    // Agenda: a hollow dot and a Reply button.
    await page.goto(`/calendar/agenda/${when}`);
    const row = page.locator('[data-agenda-day] button[data-reply-state="needs-action"]', { hasText: title });
    await expect(row).toBeVisible({ timeout: 60000 });
    await expect(row.locator('[data-agenda-dot="needs-action"]')).toHaveCount(1);

    // Week: the marker offers the answers alone; Accept goes to the server.
    await page.goto(`/calendar/week/${when}`);
    let card!: Locator;
    await expect(async () => {
      card = await cardOnScreen(page, title);
      await expect(card).toHaveAttribute('data-reply-state', 'needs-action', { timeout: 2000 });
    }).toPass({ timeout: 60000 });
    await card.locator('xpath=..').locator('[data-reply-marker]').click();
    const items = page.getByRole('menuitem');
    await expect(items).toHaveText(['Accept', 'Maybe', 'Decline']);
    await page.getByRole('menuitem', { name: 'Accept' }).click();

    await expect.poll(async () => statusOf((await objects(a, title))[0]?.participants, A), { timeout: 30000 }).toBe('accepted');
    // The card turns solid.
    await expect(async () => {
      expect(await (await cardOnScreen(page, title)).getAttribute('data-reply-state')).toBeNull();
    }).toPass({ timeout: 30000 });

    // The organiser's copy, where the server passes the reply on.
    const organiser = await expect.poll(async () => statusOf((await objects(b, title))[0]?.participants, A), { timeout: 60000 })
      .toBe('accepted').then(() => 'accepted', () => 'not updated');
    info.annotations.push({ type: 'organiser copy', description: `single, accept: ${organiser}` });
    console.log(`[grid] organiser copy after accept: ${organiser}`);
    await context.close();
  });

  test('right-click on one occurrence answers maybe for it alone', async ({ browser }, info) => {
    test.setTimeout(300_000);
    const a = await JmapClient.connect(A, PASSWORD);
    const b = await JmapClient.connect(B, PASSWORD);
    const first = day(4);
    const second = day(11);
    const title = `${prefix} series`;
    await invite(b, a, title, `${first}T14:00:00`, {
      recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'weekly', count: 3 },
    });

    const context = await browser.newContext({ ...contextOptions(), timezoneId: TZ, viewport: { width: 1366, height: 768 } });
    const page = await context.newPage();
    await login(page, A);
    await page.goto(`/calendar/day/${second}`);
    let card!: Locator;
    await expect(async () => {
      card = await cardOnScreen(page, title);
      await expect(card).toHaveAttribute('data-reply-state', 'needs-action', { timeout: 2000 });
    }).toPass({ timeout: 60000 });

    await card.click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Accept' })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Maybe' }).click();
    const ask = page.getByRole('dialog', { name: 'Respond to recurring event' });
    await ask.getByRole('radio', { name: 'This event only' }).check();
    await ask.getByRole('button', { name: 'Respond', exact: true }).click();
    await expect(ask).toBeHidden({ timeout: 30000 });

    // The server: "maybe" on that occurrence, the series still unanswered.
    const key = `${second}T14:00:00`;
    await expect.poll(async () => {
      const [series] = await objects(a, title);
      const override = series?.recurrenceOverrides?.[key] as { participants?: Record<string, Participant> } & Record<string, unknown> | undefined;
      const patched = override && Object.entries(override)
        .find(([path, value]) => path.startsWith('participants/') && path.endsWith('/participationStatus') && value === 'tentative');
      return { series: statusOf(series?.participants, A), occurrence: statusOf(override?.participants, A) ?? (patched ? 'tentative' : undefined) };
    }, { timeout: 30000 }).toEqual({ series: 'needs-action', occurrence: 'tentative' });

    // The occurrence is drawn dashed now, the others stay marked.
    await page.reload();
    await expect(async () => {
      expect(await (await cardOnScreen(page, title)).getAttribute('data-reply-state')).toBe('tentative');
    }).toPass({ timeout: 60000 });

    const organiser = await expect.poll(async () => {
      const [series] = await objects(b, title);
      const override = series?.recurrenceOverrides?.[key] as { participants?: Record<string, Participant> } | undefined;
      return statusOf(override?.participants, A);
    }, { timeout: 60000 }).toBe('tentative').then(() => 'tentative', () => 'not updated');
    info.annotations.push({ type: 'organiser copy', description: `series, maybe on one: ${organiser}` });
    console.log(`[grid] organiser copy after maybe on one occurrence: ${organiser}`);
    await context.close();
  });
});
