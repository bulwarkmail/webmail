import { test, expect, type Page } from '@playwright/test';
import { addDays, format } from 'date-fns';
import { contextOptions } from './helpers/ent';
import { JmapClient } from './helpers/jmap';
import { accountSwitcher, neutralizeDevOverlay } from './helpers/app';

/**
 * Usability pass 2, calendar fixes pim-p2-5 (the event's time zone picker),
 * pim-p2-17 (Duplicate opens an unsaved copy) and pim-p2-8 (an invitation to
 * a series), against a VM 106 Stalwart (1.0 and 0.16). Every UI step is
 * checked on the server.
 *
 * Accounts: dso-ux-pim (A) and dso-ux-pim-b (B, the organiser of the series),
 * password IT_DSO_PASSWORD. The spec makes its own items, titled
 * "UXP2-calx <run> …", and removes them again on both accounts.
 */

const PASSWORD = process.env.IT_DSO_PASSWORD ?? '';
const A = 'dso-ux-pim@example.org';
const B = 'dso-ux-pim-b@example.org';
const CORE = 'urn:ietf:params:jmap:core';
const CAL = 'urn:ietf:params:jmap:calendars';
const MAIL = 'urn:ietf:params:jmap:mail';
const RUN = Date.now().toString(36);
const TZ = 'Europe/Berlin';
const PREFIX = `UXP2-calx ${RUN}`;

test.skip(!PASSWORD, 'Set IT_DSO_PASSWORD (vault "Stalwart test – dso-* throwaway accounts")');

type Participant = { calendarAddress?: string; participationStatus?: string };
type Obj = Record<string, unknown> & {
  id: string; uid?: string; title?: string; start?: string; timeZone?: string | null; duration?: string;
  recurrenceOverrides?: Record<string, Record<string, unknown>> | null;
  participants?: Record<string, Participant> | null;
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
      properties: ['id', 'uid', 'title', 'start', 'timeZone', 'duration', 'participants'],
    }, 'g'],
  ], [CORE, CAL]);
  return (r.methodResponses[1][1].list as Obj[]).filter((o) => typeof o.title === 'string' && o.title.startsWith(prefix));
}

/** Stalwart 1.0 refuses recurrenceOverrides in a get with other properties: on their own. */
async function overrides(c: JmapClient, id: string): Promise<Record<string, Record<string, unknown>>> {
  const r = await c.request([['CalendarEvent/get', { accountId: c.accountId, ids: [id], properties: ['id', 'recurrenceOverrides'] }, '0']], [CORE, CAL]);
  return (r.methodResponses[0][1].list?.[0]?.recurrenceOverrides ?? {}) as Record<string, Record<string, unknown>>;
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

async function login(page: Page, email: string): Promise<void> {
  await neutralizeDevOverlay(page);
  await page.goto('/');
  await page.locator('#username').waitFor({ state: 'visible', timeout: 60000 });
  await page.fill('#username', email);
  await page.fill('#password', PASSWORD);
  await page.click('button[type="submit"]');
  await accountSwitcher(page).waitFor({ state: 'visible', timeout: 60000 });
}

// Event chips are buttons named "<title>, <time>, <calendar>".
const card = (page: Page, title: string) => page.locator(`button[aria-label^="${title},"]`).first();
const day = (offset: number) => format(addDays(new Date(), offset), 'yyyy-MM-dd');

test.afterAll(async () => {
  if (!PASSWORD) return;
  for (const who of [A, B]) {
    const c = await JmapClient.connect(who, PASSWORD);
    await destroyAll(c, PREFIX);
    await destroyMails(c, PREFIX);
  }
});

test.describe('The event editor (pim-p2-5, pim-p2-17)', () => {
  test.describe.configure({ mode: 'serial' });

  test('picks a time zone by typing its city and saves the zone id', async ({ browser }) => {
    test.setTimeout(240_000);
    const a = await JmapClient.connect(A, PASSWORD);
    const when = day(10);
    const context = await browser.newContext({ ...contextOptions(), timezoneId: TZ });
    const page = await context.newPage();
    await login(page, A);
    await page.goto(`/calendar/week/${when}`);
    await expect(page.locator('[data-testid="calendar-item"]').first()).toBeVisible({ timeout: 60000 });
    const title = page.getByLabel('Title', { exact: true });
    await expect(async () => {
      await page.keyboard.press('n');
      await expect(title).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 60000 });
    await title.fill(`${PREFIX} Kolkata call`);
    await page.getByLabel('Start date', { exact: true }).fill(when);
    await page.getByLabel('Start time', { exact: true }).fill('10:00');
    await page.getByLabel('End date', { exact: true }).fill(when);
    await page.getByLabel('End time', { exact: true }).fill('11:00');
    await page.getByRole('button', { name: 'Time zone', exact: true }).click();

    // The list opens with a search: cities and offsets, no raw ids.
    const search = page.getByRole('combobox', { name: 'Search time zones' });
    await expect(search).toBeFocused();
    await expect(page.getByRole('option', { name: /^New York/ }).first()).toBeVisible();
    await expect(page.getByRole('option', { name: /Africa\/Abidjan/ })).toHaveCount(0);
    await search.fill('Kolkata');
    await expect(page.getByRole('option', { name: /^Kolkata.*GMT\+05:30/ })).toBeVisible();
    await search.press('Enter');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => {
      const [e] = await objects(a, `${PREFIX} Kolkata call`);
      return e && { start: e.start, timeZone: e.timeZone };
    }, { timeout: 30000 }).toMatchObject({ start: `${when}T10:00:00` });
    const [saved] = await objects(a, `${PREFIX} Kolkata call`);
    expect(['Asia/Kolkata', 'Asia/Calcutta']).toContain(saved.timeZone);
    await context.close();
  });

  test('Duplicate creates nothing until Save, at the same date and time', async ({ browser }) => {
    test.setTimeout(240_000);
    const a = await JmapClient.connect(A, PASSWORD);
    const when = day(11);
    const name = `${PREFIX} retro`;
    await createEvent(a, { title: name, uid: `uxp2-calx-dup-${RUN}`, start: `${when}T14:00:00`, timeZone: TZ, duration: 'PT1H' });

    const context = await browser.newContext({ ...contextOptions(), timezoneId: TZ });
    const page = await context.newPage();
    await login(page, A);
    await page.goto(`/calendar/week/${when}`);
    await expect(card(page, name)).toBeVisible({ timeout: 60000 });

    // Closed without saving: nothing on the server.
    await card(page, name).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Duplicate' }).click();
    const editor = page.getByRole('dialog', { name: 'Create event' });
    await expect(editor).toBeVisible();
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue(name);
    await expect(page.getByLabel('Start date', { exact: true })).toHaveValue(when);
    await expect(page.getByLabel('Start time', { exact: true })).toHaveValue('14:00');
    await page.waitForTimeout(2000);
    expect(await objects(a, name)).toHaveLength(1);
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(editor).toBeHidden();
    await page.waitForTimeout(2000);
    expect(await objects(a, name)).toHaveLength(1);

    // Saved: a second event, same day and time.
    await card(page, name).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Duplicate' }).click();
    await expect(editor).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => (await objects(a, name)).length, { timeout: 30000 }).toBe(2);
    const both = await objects(a, name);
    expect(both.map((e) => e.start)).toEqual([`${when}T14:00:00`, `${when}T14:00:00`]);
    expect(new Set(both.map((e) => e.uid)).size).toBe(2);
    await context.close();
  });
});

test.describe('An invitation to a series (pim-p2-8)', () => {
  test('says it repeats, names the week declined on its own, and answers the series', async ({ browser }) => {
    test.setTimeout(300_000);
    const a = await JmapClient.connect(A, PASSWORD);
    const b = await JmapClient.connect(B, PASSWORD);
    const first = day(14);
    const second = day(21);
    const name = `${PREFIX} weekly sync`;
    const uid = `uxp2-calx-series-${RUN}`;

    // B invites A to a weekly series; Stalwart delivers the invitation itself.
    const invite = await b.request([['CalendarEvent/set', {
      accountId: b.accountId,
      sendSchedulingMessages: true,
      create: {
        i: {
          '@type': 'Event', title: name, uid, start: `${first}T16:00:00`, duration: 'PT30M', timeZone: TZ,
          recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'weekly', count: 4 },
          calendarIds: { [await defaultCalendar(b)]: true },
          participants: {
            o: { '@type': 'Participant', calendarAddress: `mailto:${B}`, roles: { owner: true, attendee: true }, participationStatus: 'accepted' },
            p: { '@type': 'Participant', calendarAddress: `mailto:${A}`, roles: { attendee: true }, participationStatus: 'needs-action', expectReply: true },
          },
        },
      },
    }, '0']], [CORE, CAL]);
    expect(invite.methodResponses[0][1].created?.i?.id, JSON.stringify(invite.methodResponses[0][1].notCreated ?? {})).toBeTruthy();
    await expect.poll(async () => (await mails(a, PREFIX)).length, { timeout: 90000 }).toBeGreaterThan(0);
    const [mailId] = await mails(a, PREFIX);
    await expect.poll(async () => (await objects(a, name)).length, { timeout: 60000 }).toBeGreaterThan(0);
    const [copy] = await objects(a, name);
    const mine = Object.entries(copy.participants ?? {}).find(([, p]) => p.calendarAddress?.toLowerCase() === `mailto:${A}`);
    expect(mine, JSON.stringify(copy.participants)).toBeTruthy();
    const [pid] = mine!;

    // A declines the second week only, as the calendar does: a pointer patch
    // (Stalwart 1.0), or the whole participants map where that is refused.
    const recurrenceId = `${second}T16:00:00`;
    const pointer = await a.request([['CalendarEvent/set', {
      accountId: a.accountId,
      update: { [copy.id]: { [`recurrenceOverrides/${recurrenceId}`]: { [`participants/${pid}/participationStatus`]: 'declined' } } },
    }, '0']], [CORE, CAL]);
    const [kind, answer] = pointer.methodResponses[0];
    if (kind === 'error' || answer.notUpdated?.[copy.id]) {
      const participants = structuredClone(copy.participants ?? {});
      participants[pid] = { ...participants[pid], participationStatus: 'declined' };
      const whole = await a.request([['CalendarEvent/set', {
        accountId: a.accountId,
        update: { [copy.id]: { [`recurrenceOverrides/${recurrenceId}`]: { participants } } },
      }, '0']], [CORE, CAL]);
      expect(whole.methodResponses[0][1].notUpdated, JSON.stringify(whole.methodResponses[0][1].notUpdated ?? {})).toBeFalsy();
    }
    expect(Object.keys(await overrides(a, copy.id))).toContain(recurrenceId);

    const context = await browser.newContext({ ...contextOptions(), timezoneId: TZ });
    const page = await context.newPage();
    await login(page, A);
    await page.goto(`/mail/message/${mailId}`);

    // It repeats, the series is unanswered, and the declined week is named by its date.
    await expect(page.getByTestId('invitation-repeats')).toContainText('Weekly', { timeout: 60000 });
    const declinedDate = format(new Date(`${second}T12:00:00`), 'MMM d');
    await expect(page.getByTestId('invitation-declined-occurrences')).toHaveText(`You declined ${declinedDate}.`, { timeout: 30000 });
    await expect(page.getByText('Your response: Declined')).toHaveCount(0);
    await expect(page.getByText(/^You declined on /)).toHaveCount(0);
    await expect(page.getByTestId('invitation-answers-series')).toBeVisible();

    // Accept answers the series; the declined week stays declined.
    await page.getByRole('button', { name: 'Accept', exact: true }).first().click();
    await expect.poll(async () => {
      const [e] = await objects(a, name);
      return Object.values(e?.participants ?? {}).find((p) => p.calendarAddress?.toLowerCase() === `mailto:${A}`)?.participationStatus;
    }, { timeout: 30000 }).toBe('accepted');
    expect(Object.keys(await overrides(a, copy.id))).toContain(recurrenceId);
    await context.close();
  });
});
