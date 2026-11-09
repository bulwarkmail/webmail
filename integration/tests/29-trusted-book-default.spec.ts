/**
 * "Keep the list in your address book" is on by default, in a real browser
 * on a production build: a device that kept a few trusted senders of its own
 * (the settings an older build stored, version 13, switch never touched)
 * files them into one "Trusted Senders" address book on the server, once.
 * Running the migration again, as another device with the same list would,
 * adds no second card or book.
 *
 * Runs as dso-ux-settings@example.org (seeded by
 * ~/desktop-offline/dso_ux_settings_provision.py on the VM; check it there
 * first), with IT_DSO_PASSWORD from the vault item "Stalwart test – dso-*
 * throwaway accounts", through desktop-offline-rig/run-spec.sh. The book is
 * removed at the start and at the end.
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { requireEntEnv, shot } from './helpers/ent';
import { neutralizeDevOverlay } from './helpers/app';
import { WEBMAIL_URL } from './helpers/config';
import { JmapClient } from './helpers/jmap';

requireEntEnv();
test.setTimeout(300_000);
test.use({ actionTimeout: 30_000 });

const USER = 'dso-ux-settings@example.org';
const PASSWORD = process.env.IT_DSO_PASSWORD ?? '';
if (!PASSWORD) throw new Error('Set IT_DSO_PASSWORD, and check the account on the VM first: see the top of this file');

const CORE = 'urn:ietf:params:jmap:core';
const CONTACTS = 'urn:ietf:params:jmap:contacts';
const BOOK_NAME = 'Trusted Senders';
const RUN = Date.now().toString(36);
const SENDERS = ['a', 'b', 'c'].map((x) => `tb-${x}-${RUN}@example.net`);

async function trustedBookIds(jmap: JmapClient): Promise<string[]> {
  const res = await jmap.request([['AddressBook/get', { accountId: jmap.accountId, ids: null }, '0']], [CORE, CONTACTS]);
  const list = (res.methodResponses[0][1].list ?? []) as Array<{ id: string; name: string }>;
  return list.filter((b) => b.name === BOOK_NAME).map((b) => b.id);
}

/** Every address on a card in a trusted senders book, once per card. */
async function trustedAddresses(jmap: JmapClient): Promise<string[]> {
  const books = new Set(await trustedBookIds(jmap));
  const res = await jmap.request([['ContactCard/get', { accountId: jmap.accountId, ids: null }, '0']], [CORE, CONTACTS]);
  const cards = (res.methodResponses[0][1].list ?? []) as Array<{ addressBookIds?: Record<string, boolean>; emails?: Record<string, { address: string }> }>;
  return cards
    .filter((c) => Object.keys(c.addressBookIds ?? {}).some((id) => books.has(id)))
    .flatMap((c) => Object.values(c.emails ?? {}).map((e) => e.address.toLowerCase()))
    .sort();
}

async function dropTrustedBooks(jmap: JmapClient): Promise<void> {
  const ids = await trustedBookIds(jmap);
  if (ids.length === 0) return;
  await jmap.request([['AddressBook/set', { accountId: jmap.accountId, destroy: ids, onDestroyRemoveContents: true }, '0']], [CORE, CONTACTS]);
}

async function signIn(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL: WEBMAIL_URL, locale: 'en-US', viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  await neutralizeDevOverlay(page);
  await page.goto('/login');
  await page.fill('#username', USER);
  await page.fill('#password', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 60_000 });
  await expect(page.getByRole('navigation', { name: /folders/i }).first()).toBeVisible({ timeout: 60_000 });
  return page;
}

/**
 * Puts the settings an older build stored on this device in place (switch
 * off, never touched, a few senders) and takes this account's server copy
 * away, so the next start migrates exactly that.
 */
async function seedOldDevice(page: Page, senders: string[]): Promise<void> {
  const deleted = await page.evaluate(async (list) => {
    const registry = JSON.parse(localStorage.getItem('account-registry') ?? '{}');
    const account = (registry.state?.accounts ?? [])[0];
    const res = await fetch('/api/settings', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: account?.username, serverUrl: account?.serverUrl }),
    });
    const stored = JSON.parse(localStorage.getItem('settings-storage') ?? '{}');
    const state = { ...(stored.state ?? {}), trustedSendersAddressBook: false, trustedSenders: list };
    state.explicitSettings = (state.explicitSettings ?? []).filter((key: string) => key !== 'trustedSendersAddressBook');
    localStorage.setItem('settings-storage', JSON.stringify({ state, version: 13 }));
    return res.status;
  }, senders);
  expect([200, 404], 'the server copy of the settings is gone').toContain(deleted);
}

test('a device\'s own trusted senders become one address book on the server, once', async ({ browser }) => {
  const jmap = await JmapClient.connect(USER, PASSWORD);
  await dropTrustedBooks(jmap);
  const page = await signIn(browser);
  try {
    // Signing in on this build already makes the (empty) book; start clean.
    await expect.poll(() => trustedBookIds(jmap), { timeout: 30_000 }).toHaveLength(1);
    await dropTrustedBooks(jmap);

    await seedOldDevice(page, SENDERS);
    await page.reload();
    await expect(page.getByRole('navigation', { name: /folders/i }).first()).toBeVisible({ timeout: 60_000 });

    await expect.poll(() => trustedAddresses(jmap), { timeout: 60_000 }).toEqual([...SENDERS].sort());
    expect(await trustedBookIds(jmap)).toHaveLength(1);
    const local = await page.evaluate(() => JSON.parse(localStorage.getItem('settings-storage') ?? '{}'));
    expect(local.version).toBe(14);
    expect(local.state.trustedSendersAddressBook).toBe(true);
    await expect.poll(async () => (await page.evaluate(() => JSON.parse(localStorage.getItem('settings-storage') ?? '{}'))).state.trustedSenders).toEqual([]);

    // The same old list migrated again (another device, or a second start
    // before the cleared list synced): nothing new on the server.
    await seedOldDevice(page, [...SENDERS, SENDERS[0].toUpperCase()]);
    await page.reload();
    await expect(page.getByRole('navigation', { name: /folders/i }).first()).toBeVisible({ timeout: 60_000 });
    await expect.poll(async () => (await page.evaluate(() => JSON.parse(localStorage.getItem('settings-storage') ?? '{}'))).state.trustedSenders, { timeout: 60_000 }).toEqual([]);
    expect(await trustedAddresses(jmap)).toEqual([...SENDERS].sort());
    expect(await trustedBookIds(jmap)).toHaveLength(1);

    // Settings > Privacy shows the switch on and the three senders.
    await page.goto('/settings/privacy');
    const toggle = page.getByTestId('trusted-senders-book-switch');
    await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 });
    await expect(toggle).toBeEnabled();
    await expect(page.getByRole('button', { name: /^3 senders$/ })).toBeVisible({ timeout: 30_000 });
    await shot(page, 'trusted-book-default-privacy');
  } finally {
    await dropTrustedBooks(jmap);
    await page.context().close();
  }
});
