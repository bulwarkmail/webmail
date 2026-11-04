import { test, expect, type Page } from '@playwright/test';
import { addDays, format } from 'date-fns';
import { contextOptions } from './helpers/ent';
import { JmapClient } from './helpers/jmap';
import { accountSwitcher, neutralizeDevOverlay } from './helpers/app';

/**
 * Usability fixes pim-2 (events keep their time zone) and pim-23 (the
 * invitation card), against a VM 106 Stalwart (1.0 and 0.16). Every UI step
 * is checked on the server.
 *
 * Accounts: dso-ux-pim (password IT_DSO_PASSWORD), and ent-alice
 * (IT_ENT_PASSWORD) as an outside organiser. The spec makes its own items,
 * titled "UXFIX-event …", and removes them again.
 */

const PASSWORD = process.env.IT_DSO_PASSWORD ?? '';
const ENT_PASSWORD = process.env.IT_ENT_PASSWORD ?? '';
const A = 'dso-ux-pim@example.org';
const ALICE = 'ent-alice@example.org';
const CORE = 'urn:ietf:params:jmap:core';
const CAL = 'urn:ietf:params:jmap:calendars';
const MAIL = 'urn:ietf:params:jmap:mail';
const RUN = Date.now().toString(36);
const TZ = 'Europe/Berlin';
const NY = 'America/New_York';

test.skip(!PASSWORD, 'Set IT_DSO_PASSWORD (vault "Stalwart test – dso-* throwaway accounts")');

type Obj = Record<string, unknown> & {
  id: string; uid?: string; title?: string; start?: string; timeZone?: string | null; duration?: string;
  // Stalwart names it as JSCalendar 2.0 does: one rule, singular.
  recurrenceRule?: Record<string, unknown> | null;
  recurrenceOverrides?: Record<string, Record<string, unknown>> | null;
  participants?: Record<string, { calendarAddress?: string; participationStatus?: string }> | null;
};

async function defaultCalendar(c: JmapClient): Promise<string> {
  const r = await c.request([['Calendar/get', { accountId: c.accountId, properties: ['id', 'name', 'isDefault'] }, '0']], [CORE, CAL]);
  const list = r.methodResponses[0][1].list as Array<{ id: string; isDefault?: boolean }>;
  return (list.find((cal) => cal.isDefault) ?? list[0]).id;
}

/** Events whose title starts with `prefix`, as the server keeps them (base events, not expanded). */
async function objects(c: JmapClient, prefix: string): Promise<Obj[]> {
  const r = await c.request([
    ['CalendarEvent/query', { accountId: c.accountId, limit: 1000 }, 'q'],
    ['CalendarEvent/get', {
      accountId: c.accountId,
      '#ids': { resultOf: 'q', name: 'CalendarEvent/query', path: '/ids' },
      properties: ['id', 'uid', 'title', 'start', 'timeZone', 'duration', 'recurrenceRule', 'recurrenceOverrides', 'participants'],
    }, 'g'],
  ], [CORE, CAL]);
  return (r.methodResponses[1][1].list as Obj[]).filter((o) => typeof o.title === 'string' && o.title.startsWith(prefix));
}

async function destroyAll(c: JmapClient, prefix: string): Promise<void> {
  const ids = (await objects(c, prefix)).map((o) => o.id);
  if (ids.length) await c.request([['CalendarEvent/set', { accountId: c.accountId, destroy: ids }, '0']], [CORE, CAL]);
}

async function mails(c: JmapClient, word: string): Promise<string[]> {
  const r = await c.request([['Email/query', { accountId: c.accountId, filter: { subject: word }, limit: 50 }, 'q']], [CORE, MAIL]);
  return r.methodResponses[0][1].ids as string[];
}

async function destroyMails(c: JmapClient, word: string): Promise<void> {
  const ids = await mails(c, word);
  if (ids.length) await c.request([['Email/set', { accountId: c.accountId, destroy: ids }, '0']], [CORE, MAIL]);
}

async function createEvent(c: JmapClient, event: Record<string, unknown>): Promise<string> {
  const r = await c.request([['CalendarEvent/set', {
    accountId: c.accountId,
    create: { e: { '@type': 'Event', calendarIds: { [await defaultCalendar(c)]: true }, ...event } },
  }, '0']], [CORE, CAL]);
  const id = r.methodResponses[0][1].created?.e?.id as string | undefined;
  expect(id, JSON.stringify(r.methodResponses[0][1].notCreated ?? {})).toBeTruthy();
  return id!;
}

async function login(page: Page, email: string, password = PASSWORD): Promise<void> {
  await neutralizeDevOverlay(page);
  await page.goto('/');
  await page.locator('#username').waitFor({ state: 'visible', timeout: 60000 });
  await page.fill('#username', email);
  await page.fill('#password', password);
  await page.click('button[type="submit"]');
  await accountSwitcher(page).waitFor({ state: 'visible', timeout: 60000 });
}

// Event chips are buttons named "<title>, <time>, <calendar>".
const card = (page: Page, title: string) => page.locator(`button[aria-label^="${title},"]`).first();

/**
 * The chip of a series on screen: the week view keeps the weeks next to the
 * shown one in the page too, with chips of the same name.
 */
async function cardOnScreen(page: Page, title: string) {
  const cards = page.locator(`button[aria-label^="${title},"]`);
  await cards.first().waitFor({ state: 'attached', timeout: 60000 });
  const width = page.viewportSize()!.width;
  for (let i = 0; i < await cards.count(); i++) {
    const box = await cards.nth(i).boundingBox();
    if (box && box.x >= 0 && box.x + box.width <= width) return cards.nth(i);
  }
  throw new Error(`no chip of ${title} on screen`);
}

const day = (offset: number) => format(addDays(new Date(), offset), 'yyyy-MM-dd');

test.describe('Events keep their time zone (pim-2)', () => {
  test.describe.configure({ mode: 'serial' });
  const prefix = `UXFIX-event ${RUN}`;

  test.afterAll(async () => {
    const a = await JmapClient.connect(A, PASSWORD);
    await destroyAll(a, prefix);
  });

  test('a title change keeps a New York event in New York, and Tokyo can be picked for a new one', async ({ browser }) => {
    test.setTimeout(240_000);
    const a = await JmapClient.connect(A, PASSWORD);
    const when = day(9);
    const id = await createEvent(a, {
      title: `${prefix} NY call`, uid: `uxfix-event-ny-${RUN}`, start: `${when}T10:00:00`, timeZone: NY, duration: 'PT1H',
    });

    const context = await browser.newContext({ ...contextOptions(), timezoneId: TZ });
    const page = await context.newPage();
    await login(page, A);

    // The popover names the event's zone and the user's time.
    await page.goto(`/calendar/week/${when}`);
    await card(page, `${prefix} NY call`).click();
    const pop = page.getByRole('dialog', { name: `${prefix} NY call` });
    await expect(pop.getByTestId('event-zone-times')).toHaveText(/^10:00–11:00 New York \(\d\d:00–\d\d:00 your time\)$/);
    await pop.getByRole('button', { name: 'Edit event' }).click();

    // The form shows the event's own clock and says which zone it is on.
    await expect(page.getByLabel('Start time', { exact: true })).toHaveValue('10:00');
    await expect(page.getByRole('button', { name: 'Time zone: New York' })).toBeVisible();
    await page.getByLabel('Title', { exact: true }).fill(`${prefix} NY call, room 2`);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => {
      const [e] = await objects(a, `${prefix} NY call`);
      return e && { id: e.id, title: e.title, start: e.start, timeZone: e.timeZone, duration: e.duration };
    }, { timeout: 30000 }).toEqual({ id, title: `${prefix} NY call, room 2`, start: `${when}T10:00:00`, timeZone: NY, duration: 'PT1H' });

    // A new event in Tokyo through the picker.
    const tokyoDay = day(10);
    await page.goto(`/calendar/week/${tokyoDay}`);
    await expect(page.getByRole('button', { name: 'Today', exact: true })).toBeVisible({ timeout: 60000 });
    // The calendars first: a form opened before they load has none picked.
    await expect(page.locator('[data-testid="calendar-item"]').first()).toBeVisible({ timeout: 60000 });
    const title = page.getByLabel('Title', { exact: true });
    // "n" opens a new event once the page listens for keys.
    await expect(async () => {
      await page.keyboard.press('n');
      await expect(title).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 60000 });
    await title.fill(`${prefix} Tokyo sync`);
    await page.getByLabel('Start date', { exact: true }).fill(tokyoDay);
    await page.getByLabel('Start time', { exact: true }).fill('10:00');
    await page.getByLabel('End date', { exact: true }).fill(tokyoDay);
    await page.getByLabel('End time', { exact: true }).fill('11:00');
    await page.getByRole('button', { name: 'Time zone', exact: true }).click();
    await page.getByLabel('Time zone', { exact: true }).selectOption('Asia/Tokyo');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => {
      const [e] = await objects(a, `${prefix} Tokyo sync`);
      return e && { start: e.start, timeZone: e.timeZone, duration: e.duration };
    }, { timeout: 30000 }).toEqual({ start: `${tokyoDay}T10:00:00`, timeZone: 'Asia/Tokyo', duration: 'PT1H' });
    await context.close();
  });

  test('a New York series keeps its zone and its exceptions for every scope', async ({ browser }) => {
    test.setTimeout(300_000);
    const a = await JmapClient.connect(A, PASSWORD);
    // Weekly, six times, 10:00 in New York; the second one has a title of its own.
    const d = [0, 7, 14, 21, 28, 35].map((n) => day(n + 2));
    const own = `${prefix} series (budget)`;
    const id = await createEvent(a, {
      title: `${prefix} series`, uid: `uxfix-event-series-${RUN}`, start: `${d[0]}T10:00:00`, timeZone: NY, duration: 'PT1H',
      recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'weekly', count: 6 },
      recurrenceOverrides: { [`${d[1]}T10:00:00`]: { title: own } },
    });
    const series = async () => (await objects(a, prefix)).find((e) => e.id === id)!;

    const context = await browser.newContext({ ...contextOptions(), timezoneId: TZ });
    const page = await context.newPage();
    await login(page, A);

    async function edit(on: string, from: string, to: string, scope: 'This event only' | 'This and following events' | 'All events') {
      await page.goto(`/calendar/week/${on}`);
      await page.locator('[data-testid="calendar-item"]').first().waitFor({ timeout: 60000 });
      await expect(async () => (await cardOnScreen(page, from)).click()).toPass({ timeout: 60000 });
      await page.getByRole('dialog', { name: from }).getByRole('button', { name: 'Edit event' }).click();
      await expect(page.getByLabel('Start time', { exact: true })).toHaveValue('10:00');
      await page.getByLabel('Title', { exact: true }).fill(to);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      const ask = page.getByRole('dialog', { name: 'Edit recurring event' });
      await ask.getByRole('radio', { name: scope }).check();
      await ask.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(ask).toBeHidden({ timeout: 30000 });
    }

    // All events, from the third.
    await edit(d[2], `${prefix} series`, `${prefix} series v2`, 'All events');
    await expect.poll(async () => {
      const e = await series();
      return { title: e.title, start: e.start, timeZone: e.timeZone, keys: Object.keys(e.recurrenceOverrides ?? {}) };
    }, { timeout: 30000 }).toEqual({ title: `${prefix} series v2`, start: `${d[0]}T10:00:00`, timeZone: NY, keys: [`${d[1]}T10:00:00`] });
    expect((await series()).recurrenceOverrides![`${d[1]}T10:00:00`].title).toBe(own);

    // This event only, the fourth.
    await edit(d[3], `${prefix} series v2`, `${prefix} series v2 (fourth)`, 'This event only');
    await expect.poll(async () => {
      const e = await series();
      return { start: e.start, timeZone: e.timeZone, keys: Object.keys(e.recurrenceOverrides ?? {}).sort() };
    }, { timeout: 30000 }).toEqual({ start: `${d[0]}T10:00:00`, timeZone: NY, keys: [`${d[1]}T10:00:00`, `${d[3]}T10:00:00`].sort() });
    const fourth = (await series()).recurrenceOverrides![`${d[3]}T10:00:00`];
    expect(fourth.title).toBe(`${prefix} series v2 (fourth)`);
    // The occurrence stays at 10:00 in New York: no time or a New York one of its own.
    expect([undefined, NY]).toContain(fourth.timeZone);
    expect([undefined, `${d[3]}T10:00:00`]).toContain(fourth.start);

    // This and following, from the fifth.
    await edit(d[4], `${prefix} series v2`, `${prefix} series v3`, 'This and following events');
    await expect.poll(async () => {
      const rest = (await objects(a, `${prefix} series v3`)).find((e) => e.id !== id);
      return rest && { start: rest.start, timeZone: rest.timeZone };
    }, { timeout: 30000 }).toEqual({ start: `${d[4]}T10:00:00`, timeZone: NY });
    const old = await series();
    expect(old).toMatchObject({ start: `${d[0]}T10:00:00`, timeZone: NY });
    expect(Object.keys(old.recurrenceOverrides ?? {}).sort()).toEqual([`${d[1]}T10:00:00`, `${d[3]}T10:00:00`].sort());
    expect(old.recurrenceRule?.until).toBeTruthy();
    await context.close();
  });
});

test.describe('The invitation card (pim-23)', () => {
  test.describe.configure({ mode: 'serial' });
  const prefix = `UXFIX-event ${RUN} invite`;

  test.afterAll(async () => {
    const a = await JmapClient.connect(A, PASSWORD);
    await destroyAll(a, prefix);
    await destroyMails(a, prefix);
    if (ENT_PASSWORD) {
      const alice = await JmapClient.connect(ALICE, ENT_PASSWORD);
      await destroyAll(alice, prefix);
      await destroyMails(alice, prefix);
    }
  });

  test('shows a same-day invitation with its date once and no zone, then says what the user answered', async ({ browser }) => {
    test.skip(!ENT_PASSWORD, 'IT_ENT_PASSWORD for the outside organiser');
    test.setTimeout(240_000);
    const a = await JmapClient.connect(A, PASSWORD);
    const alice = await JmapClient.connect(ALICE, ENT_PASSWORD);
    const when = day(11);
    const invite = await alice.request([['CalendarEvent/set', {
      accountId: alice.accountId,
      sendSchedulingMessages: true,
      create: {
        i: {
          '@type': 'Event', title: prefix, uid: `uxfix-event-inv-${RUN}`, start: `${when}T10:00:00`, duration: 'PT1H30M', timeZone: TZ,
          calendarIds: { [await defaultCalendar(alice)]: true },
          participants: {
            o: { '@type': 'Participant', calendarAddress: `mailto:${ALICE}`, roles: { owner: true, attendee: true }, participationStatus: 'accepted' },
            p: { '@type': 'Participant', calendarAddress: `mailto:${A}`, roles: { attendee: true }, participationStatus: 'needs-action', expectReply: true },
          },
        },
      },
    }, '0']], [CORE, CAL]);
    expect(invite.methodResponses[0][1].created?.i?.id, JSON.stringify(invite.methodResponses[0][1].notCreated ?? {})).toBeTruthy();
    await expect.poll(async () => (await mails(a, prefix)).length, { timeout: 90000 }).toBeGreaterThan(0);
    const [mailId] = await mails(a, prefix);

    const context = await browser.newContext({ ...contextOptions(), timezoneId: TZ });
    const page = await context.newPage();
    await login(page, A);
    await page.goto(`/mail/message/${mailId}`);

    // "Thu, Nov 5, 10:00 – 11:30": the date once, no "GMT+1".
    const whenLine = page.getByTestId('invitation-when');
    await expect(whenLine).toBeVisible({ timeout: 60000 });
    const text = (await whenLine.textContent()) ?? '';
    const weekday = format(new Date(`${when}T12:00:00`), 'EEE');
    expect(text).toMatch(new RegExp(`^${weekday}, \\w{3} \\d{1,2}, 10:00\\s(AM\\s)?–\\s11:30(\\sAM)?$`));
    expect(text).not.toContain('GMT');

    await expect(page.getByText(/^You've been invited/)).toBeVisible();
    await page.getByRole('button', { name: 'Accept', exact: true }).first().click();
    await expect(page.getByText(/^You accepted on \w{3}, \w{3} \d{1,2}\.$/)).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(/^You've been invited/)).toBeHidden();
    await expect.poll(async () => {
      const [e] = await objects(a, prefix);
      return Object.values(e?.participants ?? {}).find((p) => p.calendarAddress?.toLowerCase() === `mailto:${A}`)?.participationStatus;
    }, { timeout: 30000 }).toBe('accepted');

    // Opened again later, it still says so.
    await page.reload();
    await expect(page.getByText(/^You accepted on \w{3}, \w{3} \d{1,2}\.$/)).toBeVisible({ timeout: 60000 });
    await context.close();
  });
});
