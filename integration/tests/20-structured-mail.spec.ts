/**
 * Booking, parcel and order cards end to end, at desktop width and at 390 px.
 *
 * The fixture mails are imported with blob upload + Email/import, each with
 * the Authentication-Results header it needs at the top (helpers/structured-mail.ts).
 * Through the real UI: the flight card shows the right facts, "Add to
 * calendar" creates the event (checked with CalendarEvent/get), the schedule
 * change updates the same event, the cancellation removes it, forged copies
 * show no card, the parcel and order cards show their links, and opening a
 * marked-up mail contacts no outside host a plain mail doesn't.
 *
 * Runs against a throwaway account (IT_ACCOUNT_USERS=sm-a,...): it deletes
 * its own mails (subject prefix "sm-e2e") and calendar events (uid prefix
 * "bulwark-sm-") but never calls reset().
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { ACCOUNTS, JMAP_URL, WEBMAIL_URL } from './helpers/config';
import { JmapClient } from './helpers/jmap';
import { contextOptions } from './helpers/org';
import { emailItem, login } from './helpers/app';
import { fixtureMails, importMail, testFlight, type FixtureName } from './helpers/structured-mail';

const CORE = 'urn:ietf:params:jmap:core';
const MAIL = 'urn:ietf:params:jmap:mail';
const CALENDARS = 'urn:ietf:params:jmap:calendars';

const account = ACCOUNTS.alice;
const auth = 'Basic ' + Buffer.from(`${account.email}:${account.password}`).toString('base64');

interface StoredEvent {
  id: string; uid: string; title: string; start: string; timeZone: string | null; duration: string;
  locations: Record<string, { name?: string; timeZone?: string | null; relativeTo?: string }> | null;
}

async function bookingEvents(client: JmapClient): Promise<StoredEvent[]> {
  const r = await client.request([
    ['CalendarEvent/query', { accountId: client.accountId }, 'q'],
    ['CalendarEvent/get', {
      accountId: client.accountId, '#ids': { resultOf: 'q', name: 'CalendarEvent/query', path: '/ids' },
      properties: ['uid', 'title', 'start', 'timeZone', 'duration', 'locations'],
    }, 'g'],
  ], [CORE, CALENDARS]);
  return (r.methodResponses[1][1].list as StoredEvent[]).filter((e) => e.uid?.startsWith('bulwark-sm-'));
}

async function cleanUp(client: JmapClient): Promise<void> {
  const events = await bookingEvents(client);
  if (events.length > 0) {
    await client.request([['CalendarEvent/set', { accountId: client.accountId, destroy: events.map((e) => e.id) }, '0']], [CORE, CALENDARS]);
  }
  const q = await client.request([['Email/query', { accountId: client.accountId, filter: { subject: 'sm-e2e' } }, '0']], [CORE, MAIL]);
  const ids: string[] = q.methodResponses[0][1].ids ?? [];
  if (ids.length > 0) await client.request([['Email/set', { accountId: client.accountId, destroy: ids }, '0']], [CORE, MAIL]);
}

async function openMail(page: Page, subject: string): Promise<void> {
  await page.goto('/');
  const row = emailItem(page, subject).first();
  try {
    await row.waitFor({ state: 'visible', timeout: 15000 });
  } catch {
    // The list is virtualised; find older mail through the search box.
    const search = page.locator('[data-tour="search-input"]:visible').first();
    await search.fill(subject);
    await search.press('Enter');
    await row.waitFor({ state: 'visible', timeout: 20000 });
  }
  await row.click();
}

const card = (page: Page, kind: string) => page.locator(`[data-testid="structured-mail-card"][data-kind="${kind}"]:visible`).first();

/**
 * The message body has rendered: the reader shows the mail's own text, as
 * plain text in the page or as HTML in the body frame.
 */
async function bodyShown(page: Page, text: string): Promise<void> {
  await expect.poll(async () => {
    if (await page.getByText(text).first().isVisible().catch(() => false)) return true;
    return page.frameLocator('iframe:visible').first().getByText(text).first().isVisible().catch(() => false);
  }, { timeout: 30000 }).toBe(true);
}

async function addToCalendar(page: Page): Promise<void> {
  await card(page, 'flight').getByRole('button', { name: 'Add to calendar' }).click();
  // With more than one writable calendar a picker opens; take the default (first).
  const menu = page.getByRole('menu', { name: 'Choose a calendar' });
  if (await menu.isVisible().catch(() => false)) await menu.getByRole('menuitem').first().click();
}

for (const phone of [false, true]) {
  test.describe.serial(`structured mail cards (${phone ? '390 px' : 'desktop'})`, () => {
    let client: JmapClient;
    let browser: Browser;
    let page: Page;
    let mails: ReturnType<typeof fixtureMails>;
    const flight = testFlight('10:15');
    const changed = testFlight('11:00');

    test.beforeAll(async ({ browser: b }) => {
      browser = b;
      client = await JmapClient.connect(account.email, account.password);
      await cleanUp(client);
      const inbox = await client.mailboxByRole('inbox');
      if (!inbox) throw new Error('no Inbox');
      mails = fixtureMails(account.email, phone ? 'phone' : 'desk');
      for (const name of Object.keys(mails) as FixtureName[]) {
        await importMail(client, auth, mails[name].raw, inbox.id);
      }
      const context = await browser.newContext(contextOptions(phone));
      page = await context.newPage();
      await login(page, account);
    });

    test.afterAll(async () => {
      await page?.context().close();
      if (client) await cleanUp(client);
    });

    test('the flight card shows the booking as the mail gives it', async () => {
      await openMail(page, mails.flight.subject);
      const flightCard = card(page, 'flight');
      await expect(flightCard).toBeVisible({ timeout: 30000 });
      await expect(flightCard).toContainText('FRA');
      await expect(flightCard).toContainText('JFK');
      await expect(flightCard).toContainText('400');
      await expect(flightCard).toContainText(flight.dep.time);
      await expect(flightCard).toContainText(flight.arr.time);
      await expect(flightCard).toContainText('E2EQ7K');
      await expect(flightCard).toContainText('Erika Mustermann');
      await expect(flightCard.getByTestId('structured-mail-link').filter({ hasText: 'Check in' })).toContainText('air.example.com');
      if (phone) {
        // Nothing sticks out of a 390 px screen.
        const box = await flightCard.boundingBox();
        expect(box && box.x + box.width).toBeLessThanOrEqual(390);
      }
    });

    test('"Add to calendar" creates the event in the airport time zones', async () => {
      await addToCalendar(page);
      await expect(card(page, 'flight')).toContainText('Added to your calendar', { timeout: 30000 });
      await expect.poll(async () => (await bookingEvents(client)).length, { timeout: 20000 }).toBe(1);
      const [event] = await bookingEvents(client);
      expect(event.uid).toMatch(/^bulwark-sm-flight-[0-9a-f]{16}@structured\.bulwark$/);
      expect(event.start).toBe(`${flight.dep.date}T10:15:00`);
      expect(event.timeZone).toBe('Europe/Berlin');
      expect(event.duration).toBe('PT8H50M');
      const locations = Object.values(event.locations ?? {});
      expect(locations).toEqual(expect.arrayContaining([
        expect.objectContaining({ timeZone: 'Europe/Berlin', relativeTo: 'start', name: expect.stringContaining('FRA') }),
        expect.objectContaining({ timeZone: 'America/New_York', relativeTo: 'end', name: expect.stringContaining('JFK') }),
      ]));
      // Opened again, the card finds the event by its uid.
      await openMail(page, mails.flight.subject);
      await expect(card(page, 'flight')).toContainText('In your calendar', { timeout: 30000 });
      await expect(card(page, 'flight').getByRole('button', { name: 'Add to calendar' })).toHaveCount(0);
    });

    test('the schedule change updates the same event', async () => {
      const [before] = await bookingEvents(client);
      await openMail(page, mails.flightUpdate.subject);
      await expect(card(page, 'flight')).toContainText(changed.dep.time, { timeout: 30000 });
      await card(page, 'flight').getByRole('button', { name: 'Update in calendar' }).click();
      await expect(card(page, 'flight')).toContainText('Calendar updated', { timeout: 30000 });
      await expect.poll(async () => (await bookingEvents(client))[0]?.start, { timeout: 20000 }).toBe(`${changed.dep.date}T11:00:00`);
      const events = await bookingEvents(client);
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe(before.id);
      expect(events[0].uid).toBe(before.uid);
    });

    test('the cancellation removes the event', async () => {
      await openMail(page, mails.flightCancel.subject);
      await expect(card(page, 'flight')).toContainText('Cancelled', { timeout: 30000 });
      await card(page, 'flight').getByRole('button', { name: 'Remove from calendar' }).click();
      await expect.poll(async () => (await bookingEvents(client)).length, { timeout: 20000 }).toBe(0);
    });

    test('forged copies show no card', async () => {
      for (const name of ['forged', 'localForged'] as const) {
        await openMail(page, mails[name].subject);
        await bodyShown(page, 'Your booking E2EQ7K is confirmed.');
        // Give the hook time to run before asserting the absence.
        await page.waitForTimeout(2000);
        await expect(page.locator('[data-testid="structured-mail-card"]:visible')).toHaveCount(0);
      }
    });

    test('parcel and order cards show their links', async () => {
      await openMail(page, mails.parcel.subject);
      const parcelCard = card(page, 'shipment');
      await expect(parcelCard).toBeVisible({ timeout: 30000 });
      await expect(parcelCard).toContainText('DHL');
      await expect(parcelCard).toContainText('00340434169999000001');
      await expect(parcelCard).toContainText('Shipped');
      await expect(parcelCard.getByTestId('structured-mail-link').filter({ hasText: 'Track' })).toContainText('dhl.de');

      await openMail(page, mails.order.subject);
      const orderCard = card(page, 'shipment');
      await expect(orderCard).toBeVisible({ timeout: 30000 });
      await expect(orderCard).toContainText('SO-E2E-1');
      await expect(orderCard).toContainText('Processing');
      await expect(orderCard.getByTestId('structured-mail-link').filter({ hasText: 'View order' })).toContainText('shop.example.com');
    });

    test('a marked-up mail contacts no outside host a plain mail does not', async () => {
      const own = new Set([new URL(WEBMAIL_URL).host, new URL(JMAP_URL).host]);
      const outside = async (subject: string, ready: () => Promise<void>) => {
        const hosts = new Set<string>();
        const listener = (request: { url: () => string }) => {
          const url = new URL(request.url());
          if ((url.protocol === 'http:' || url.protocol === 'https:') && !own.has(url.host)) hosts.add(url.host);
        };
        page.on('request', listener);
        await openMail(page, subject);
        await ready();
        await page.waitForTimeout(2000);
        page.off('request', listener);
        return hosts;
      };
      const plain = await outside(mails.plain.subject, () => bodyShown(page, 'Thanks for your order.'));
      const marked = await outside(mails.order.subject, () => expect(card(page, 'shipment')).toBeVisible({ timeout: 30000 }));
      expect([...marked].filter((host) => !plain.has(host))).toEqual([]);
    });
  });
}
