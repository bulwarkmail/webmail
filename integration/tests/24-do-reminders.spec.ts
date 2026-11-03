import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { ENT, jmapAs, requireEntEnv, shot, userPage } from './helpers/ent';

/**
 * Calendar reminders from the local store, in a real browser on a production build and
 * a VM 106 test Stalwart, with real time passing: the store's worker has its own clock.
 *
 * The account is ent-dave, whom the other specs leave alone. Snooze and the native
 * buttons belong to the desktop app: repos/desktop test/reminders-real.spec.ts.
 */

test.describe.configure({ mode: 'serial' });
test.setTimeout(900_000);
// The headless shell denies notifications; full Chromium really shows them.
test.use({ channel: 'chromium' });

const RUN = Date.now().toString(36);
const USER = ENT.dave;
const ZONE = 'Europe/Berlin';
const CORE = 'urn:ietf:params:jmap:core';
const CALENDARS = 'urn:ietf:params:jmap:calendars';
/** ledger.ts AWAY_MS and a margin. */
const AWAY_MS = 6.5 * 60_000;
/** How long a change on the server may take to reach the store. */
const SYNC_MS = 30_000;

type J = Awaited<ReturnType<typeof jmapAs>>;
let client: J;
let context: BrowserContext;
let page: Page;
const created: string[] = [];

async function call(calls: [string, Record<string, unknown>, string][]) {
  const response = await client.request(calls, [CORE, CALENDARS]);
  for (const [name, result] of response.methodResponses) {
    if (name === 'error') throw new Error(`JMAP error: ${JSON.stringify(result)}`);
  }
  return response.methodResponses as [string, Record<string, unknown>, string][];
}

/** A wall clock in the event's zone. */
function wall(ms: number): string {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date(ms));
  return parts.replace(' ', 'T');
}

const OFFSET_MIN = 5;

/** An event whose alert fires at `fireAt`. */
async function eventFiringAt(title: string, fireAt: number, extra: Record<string, unknown> = {}): Promise<string> {
  const [[, calendars]] = await call([['Calendar/get', { accountId: client.accountId, properties: ['isDefault'] }, '0']]);
  const list = calendars.list as Array<{ id: string; isDefault: boolean }>;
  const calendar = list.find((entry) => entry.isDefault) ?? list[0];
  const [[, result]] = await call([['CalendarEvent/set', {
    accountId: client.accountId,
    create: {
      e: {
        '@type': 'Event',
        calendarIds: { [calendar.id]: true },
        timeZone: ZONE,
        title,
        start: wall(fireAt + OFFSET_MIN * 60_000),
        duration: 'PT30M',
        useDefaultAlerts: false,
        alerts: { a1: { '@type': 'Alert', action: 'display', trigger: { '@type': 'OffsetTrigger', offset: `-PT${OFFSET_MIN}M`, relativeTo: 'start' } } },
        ...extra,
      },
    },
    sendSchedulingMessages: false,
  }, '0']]);
  const id = (result.created as Record<string, { id: string }> | undefined)?.e?.id;
  if (!id) throw new Error(`Event not created: ${JSON.stringify(result)}`);
  created.push(id);
  return id;
}

/** Settings > Backup & reset > Offline, switched on, and the first sync done. */
async function enableOffline(target: Page): Promise<void> {
  await target.goto('/settings/backup/offline');
  const toggle = target.getByTestId('offline-switch');
  await toggle.waitFor({ state: 'visible', timeout: 60_000 });
  if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click();
  await expect(target.getByTestId('offline-status')).toContainText('updated', { timeout: 180_000 });
}

const toast = (target: Page, text: string) => target.locator('.toast-item').filter({ hasText: text });

test.beforeAll(async ({ browser }) => {
  requireEntEnv();
  client = await jmapAs(USER);
  page = await userPage(browser, USER);
  context = page.context();
  await enableOffline(page);
  await page.goto('/');
});

test.afterAll(async () => {
  if (created.length > 0) {
    await call([['CalendarEvent/set', { accountId: client.accountId, destroy: created, sendSchedulingMessages: false }, '0']]).catch(() => {});
  }
  await context?.close();
});

test('an occurrence of a series fires from the store with the network gone', async () => {
  const title = `rem-series-${RUN}`;
  const fireAt = Date.now() + SYNC_MS + 30_000;
  // The series began weeks ago, so only an expansion finds today's occurrence.
  const [day, time] = wall(fireAt + OFFSET_MIN * 60_000).split('T');
  const weeksAgo = new Date(Date.parse(`${day}T00:00:00Z`) - 28 * 24 * 3_600_000).toISOString().slice(0, 10);
  await eventFiringAt(title, fireAt, {
    start: `${weeksAgo}T${time}`,
    recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'weekly' },
  });
  await page.waitForTimeout(SYNC_MS);
  await context.setOffline(true);
  try {
    expect(await page.evaluate(() => navigator.onLine)).toBe(false);
    await page.waitForTimeout(Math.max(fireAt - Date.now() - 3000, 0));
    await expect(toast(page, title)).toHaveCount(0);
    await expect(toast(page, title)).toBeVisible({ timeout: 30_000 });
    await shot(page, 'desktop-reminders-offline-toast');
  } finally {
    await context.setOffline(false);
  }
  await toast(page, title).getByRole('button').first().click().catch(() => {});
});

test('fires in one tab of two', async () => {
  const second = await context.newPage();
  await second.goto('/');
  const title = `rem-tabs-${RUN}`;
  const fireAt = Date.now() + SYNC_MS + 20_000;
  await eventFiringAt(title, fireAt);
  // A reminder's toast leaves after a while, so note the most each tab ever showed.
  const most = [0, 0];
  const deadline = fireAt + 40_000;
  let lastSeen = 0;
  while (Date.now() < deadline && (lastSeen === 0 || Date.now() < lastSeen + 8000)) {
    const counts = await Promise.all([page, second].map((target) => toast(target, title).count()));
    counts.forEach((count, index) => {
      most[index] = Math.max(most[index], count);
    });
    if (lastSeen === 0 && counts.some((count) => count > 0)) lastSeen = Date.now();
    await second.waitForTimeout(250);
  }
  expect(most[0] + most[1]).toBe(1);
  await second.close();
  await page.bringToFront();
});

test('adds a system notification when permission is granted and the tab is not in front', async () => {
  await context.grantPermissions(['notifications']);
  await page.reload();
  await page.evaluate(() => {
    document.hasFocus = () => false;
  });
  const title = `rem-system-${RUN}`;
  const fireAt = Date.now() + SYNC_MS + 15_000;
  await eventFiringAt(title, fireAt);
  await expect(toast(page, title)).toBeVisible({ timeout: fireAt - Date.now() + 30_000 });
  const shown = await page.evaluate(async (wanted) => {
    const registration = await navigator.serviceWorker.ready;
    return (await registration.getNotifications()).filter((item) => item.title === wanted).map((item) => ({ tag: item.tag, data: item.data as unknown }));
  }, title);
  expect(shown).toHaveLength(1);
  expect(shown[0].tag).toContain('calendar-reminder:');
  expect(shown[0].data).toMatchObject({ kind: 'calendar-reminder', url: expect.stringMatching(/\/calendar$/) });
  await context.clearPermissions();
});

test('what came due with the app closed is summarised once, and not as a burst', async () => {
  const one = `rem-missed-a-${RUN}`;
  const two = `rem-missed-b-${RUN}`;
  const fireAt = Date.now() + SYNC_MS + 20_000;
  await eventFiringAt(one, fireAt);
  await eventFiringAt(two, fireAt + 20_000, { virtualLocations: { v: { '@type': 'VirtualLocation', name: 'Meet', uri: 'https://meet.jit.si/rem-test' } } });
  await page.waitForTimeout(SYNC_MS);

  // Closed like an app: nothing of the page is left, and the store's data stays.
  const closedAt = Date.now();
  await page.close();
  await new Promise((resolve) => setTimeout(resolve, Math.max(fireAt + 20_000 + AWAY_MS - closedAt, AWAY_MS)));

  page = await context.newPage();
  await page.goto('/');
  const summary = page.locator('.toast-item').filter({ hasText: one });
  await expect(summary).toBeVisible({ timeout: 60_000 });
  await expect(summary).toContainText(two);
  await expect(toast(page, one)).toHaveCount(1);
  await shot(page, 'desktop-reminders-missed-toast');

  await summary.getByRole('button', { name: 'Show' }).click();
  const list = page.getByTestId('missed-reminders');
  await expect(list).toContainText(one);
  await expect(list).toContainText(two);
  await expect(list.getByRole('button', { name: 'Join' })).toHaveCount(1);
  await shot(page, 'desktop-reminders-missed');
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(list).toHaveCount(0);

  // Once: not after a reload, nor from a new tab.
  await page.reload();
  await page.waitForTimeout(30_000);
  await expect(page.locator('.toast-item').filter({ hasText: 'rem-missed' })).toHaveCount(0);
  await expect(page.getByTestId('missed-reminders')).toHaveCount(0);
});

test('with the store off, the app reminds as it always did', async () => {
  await page.goto('/settings/backup/offline');
  const toggle = page.getByTestId('offline-switch');
  await toggle.waitFor({ state: 'visible', timeout: 60_000 });
  await toggle.click();
  const confirm = page.getByRole('button', { name: /turn off|switch off|delete/i }).last();
  if (await confirm.isVisible({ timeout: 3000 }).catch(() => false)) await confirm.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 30_000 });
  await page.goto('/');
  const title = `rem-plain-${RUN}`;
  const fireAt = Date.now() + 20_000;
  await eventFiringAt(title, fireAt);
  // The in-app path reads the server every five minutes, or on a push.
  await expect(toast(page, title)).toBeVisible({ timeout: 120_000 });
  await page.waitForTimeout(5000);
  await expect(toast(page, title)).toHaveCount(1);
});
