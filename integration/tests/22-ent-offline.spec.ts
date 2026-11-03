import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import {
  ENT,
  adminContext,
  deliver,
  getPolicy,
  jmapAs,
  putPolicy,
  rawMessage,
  requireEntEnv,
  shot,
  userPage,
} from './helpers/ent';
import { accountSwitcher } from './helpers/app';
import { JMAP_URL } from './helpers/config';

/**
 * Enterprise pack, package F: offline mode (#523), through the real UI on a
 * VM 106 test Stalwart with the ent-* accounts, on a production build (dev
 * mode unregisters every service worker):
 * - with the browser offline, mail kept on the device opens, also after a
 *   reload without a network (the service worker's app shell);
 * - a mail written offline waits in the outbox; the required classification
 *   label still stops it; once online it goes out with SIO-Label;
 * - read, flag and delete to Trash made offline reach the server;
 * - a change the server can no longer take shows as changed on another device;
 * - the Trash emptied offline is emptied on the server after;
 * - a send whose response got lost is looked up and goes out once;
 * - a sign-out the user starts asks first when unsent mail would be lost,
 *   then wipes the device; the idle sign-out wipes it and the login page
 *   names the lost message;
 * - the admin forbids offline mode (Organisation > Devices, and a group
 *   scope by API): the next policy fetch wipes the device and hides the
 *   switch, only for accounts in the scope;
 * - the reload prompt after a deploy, the settings and the outbox at 390 px;
 * - a real deploy (a second build with another build id) when
 *   IT_OFFLINE_REDEPLOY names the command that swaps the builds and restarts
 *   the server (see the header of the rig's f-redeploy.sh).
 *
 * Playwright's setOffline also cuts the service worker's own fetches in
 * Chromium (checked in the first test). Where the webmail must stay
 * reachable while the mail server is gone, the spec blocks the mail server's
 * origin instead.
 */

test.describe.configure({ mode: 'serial' });
test.setTimeout(300_000);

const RUN = Date.now().toString(36);
let original: Record<string, unknown>;

const LABELS = [
  { id: 'internal', name: 'Internal', color: '#2563eb', marking: 'INTERNAL', description: '', sensitivity: '', subjectPrefix: '', extraHeaderValue: '' },
  { id: 'confidential', name: 'Confidential', color: '#d97706', marking: 'CONFIDENTIAL', description: '', sensitivity: 'Company-Confidential', subjectPrefix: '[Confidential]', extraHeaderValue: '' },
];

interface Msg { id: string; subject: string; blobId: string; keywords: Record<string, boolean>; mailboxIds: Record<string, boolean> }

async function messages(account: string, needle: string): Promise<Msg[]> {
  const client = await jmapAs(account);
  const r = await client.request([
    ['Email/query', { accountId: client.accountId, filter: { text: needle }, limit: 50 }, '0'],
    ['Email/get', { accountId: client.accountId, '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' }, properties: ['id', 'subject', 'blobId', 'keywords', 'mailboxIds'] }, '1'],
  ]);
  return r.methodResponses[1][1].list as Msg[];
}

async function waitForMessage(account: string, match: (m: Msg) => boolean, timeoutMs = 90_000): Promise<Msg> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = (await messages(account, RUN)).find(match);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`${account}: no match (has: ${(await messages(account, RUN)).map((m) => m.subject).join(' | ')})`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function deliverAndWait(subject: string, text: string, to: string = ENT.alice): Promise<void> {
  // HTML, so the reader shows it in its frame (plain text isn't framed).
  await deliver({ from: ENT.bob, to: [to], subject, text, html: `<p>${text}</p>` });
  await waitForMessage(to, (m) => m.subject === subject);
}

async function setPolicy(browser: Browser, patch: { organisation?: Record<string, unknown>; scopes?: unknown[] }): Promise<void> {
  const admin = await adminContext(browser);
  await putPolicy(admin, {
    ...original,
    organisation: { ...((original.organisation as object) ?? {}), ...(patch.organisation ?? {}) },
    scopes: patch.scopes ?? [],
  });
  await admin.close();
}

/** Settings > Backup & reset > Offline, switched on, and the first sync done. */
async function enableOffline(page: Page, phone = false): Promise<void> {
  await page.goto('/settings/backup/offline');
  const toggle = page.getByTestId('offline-switch');
  if (phone && !(await toggle.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true, () => false))) {
    // On a phone the settings list may come first.
    await page.getByText('Backup & reset', { exact: true }).first().click();
  }
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('offline-status')).toContainText('updated', { timeout: 180_000 });
}

async function toMail(page: Page): Promise<void> {
  await page.goto('/mail');
  await expect(page.locator('[data-testid="email-list-item"]').first()).toBeVisible({ timeout: 60_000 });
}

async function openMessage(page: Page, subject: string): Promise<void> {
  const row = page.locator('[data-testid="email-list-item"], [data-thread-keys]', { hasText: subject }).first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.click();
  await expect(page.getByRole('heading', { name: subject }).first()).toBeVisible({ timeout: 20_000 });
}

// The reader's body (a simple message isn't framed).
const body = (page: Page) => page.locator('[data-plugin-source="email-body"]').first();

/** The mail server's origin unreachable while the webmail stays up. */
async function blockMailServer(context: BrowserContext): Promise<void> {
  await context.route(`${new URL(JMAP_URL).origin}/**`, (route) => route.abort('internetdisconnected'));
}

/** Waits until the app counts the mail server as gone (a request failed and the probe too). */
async function waitUntilOffline(page: Page): Promise<void> {
  await page.keyboard.press('Shift+G');
  // The browser is online: the banner says the server is gone, not the network.
  await expect(page.getByTestId('offline-banner')).toContainText("The mail server can't be reached", { timeout: 60_000 });
}

async function compose(page: Page, to: string, subject: string, text: string): Promise<void> {
  await page.keyboard.press('c');
  const composer = page.locator('[data-testid="email-composer"]');
  await composer.waitFor({ state: 'visible', timeout: 15_000 });
  const input = page.locator('[data-testid="composer-to"] input').first();
  await input.click();
  await input.fill(to);
  await input.press('Enter');
  await page.locator('[data-testid="composer-subject"]').first().fill(subject);
  await composer.locator('[contenteditable="true"]').first().click();
  await page.keyboard.type(text);
}

async function send(page: Page): Promise<void> {
  await page.locator('[data-testid="composer-subject"]').first().focus();
  await page.keyboard.press('Control+Enter');
}

/** Whether anything of the local store is left, without opening it (opening would create it). */
async function offlineDatabaseExists(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    if ((await indexedDB.databases()).some((d) => d.name === 'bulwark-store' || d.name === 'bulwark-offline')) return true;
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle('.bulwark-store').then(() => true, () => false);
  });
}

/** The accounts the local store holds a key for. Their mail is in encrypted files nothing here can read. */
async function offlineDatabase(page: Page): Promise<{ exists: boolean; accounts: number }> {
  return page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    if (!dbs.some((d) => d.name === 'bulwark-store')) return { exists: false, accounts: 0 };
    return new Promise<{ exists: boolean; accounts: number }>((resolve) => {
      const req = indexedDB.open('bulwark-store');
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('accounts')) { db.close(); resolve({ exists: true, accounts: 0 }); return; }
        const count = db.transaction('accounts').objectStore('accounts').count();
        count.onsuccess = () => { db.close(); resolve({ exists: true, accounts: count.result }); };
      };
      req.onerror = () => resolve({ exists: false, accounts: 0 });
    });
  });
}

async function shellCaches(page: Page): Promise<string[]> {
  return page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith('bulwark-shell-')));
}

test.beforeAll(async ({ browser }) => {
  requireEntEnv();
  const admin = await adminContext(browser);
  original = await getPolicy(admin);
  await putPolicy(admin, { ...original, scopes: [] });
  await admin.close();
});

test.afterAll(async ({ browser }) => {
  test.setTimeout(120_000);
  for (const account of [ENT.alice, ENT.bob, ENT.carol]) {
    const client = await jmapAs(account);
    const r = await client.request([['Email/query', { accountId: client.accountId, filter: { text: RUN }, limit: 100 }, '0']]);
    const ids = r.methodResponses?.[0]?.[1]?.ids ?? [];
    if (ids.length) await client.request([['Email/set', { accountId: client.accountId, destroy: ids }, '0']]).catch(() => {});
  }
  const admin = await adminContext(browser);
  await putPolicy(admin, original);
  await admin.close();
});

test('with the browser offline, kept mail opens, also after a reload without a network', async ({ browser }) => {
  const first = `Offline read one ${RUN}`;
  const second = `Offline read two ${RUN}`;
  await deliverAndWait(first, `Body one ${RUN}`);
  await deliverAndWait(second, `Body two ${RUN}`);
  const page = await userPage(browser, ENT.alice);
  await enableOffline(page);
  await shot(page, 'f-offline-settings');
  await toMail(page);

  await page.context().setOffline(true);
  // setOffline cuts the service worker's own fetches too (R11).
  const worker = page.context().serviceWorkers()[0];
  expect(worker, 'the service worker runs').toBeTruthy();
  expect(await worker.evaluate(() => fetch('/api/version').then(() => 'reached', () => 'blocked'))).toBe('blocked');

  // Never opened in this tab: the body comes from the device.
  await openMessage(page, second);
  await expect(body(page)).toContainText(`Body two ${RUN}`, { timeout: 20_000 });
  await expect(page.getByTestId('offline-banner')).toContainText("You're offline");
  await shot(page, 'f-offline-reading');

  // A start without a network: the app shell from the service worker, the mail from the device.
  await page.reload();
  await expect(page.locator('[data-testid="email-list-item"]', { hasText: first }).first()).toBeVisible({ timeout: 60_000 });
  await openMessage(page, first);
  await expect(body(page)).toContainText(`Body one ${RUN}`, { timeout: 20_000 });
  await shot(page, 'f-offline-start');

  // Back online: a reload signs in as usual.
  await page.context().setOffline(false);
  await expect(page.getByText('You’re online again', { exact: false }).or(page.getByText("You're online again", { exact: false })).first()).toBeVisible({ timeout: 30_000 });
  await page.context().close();
});

test('a mail written offline waits in the outbox, the required label still stops it, and it goes out labelled when back online', async ({ browser }) => {
  const subject = `Outbox label ${RUN}`;
  await setPolicy(browser, { organisation: { labels: { list: LABELS, defaultId: '', required: true, extraHeader: '' } } });
  const page = await userPage(browser, ENT.alice);
  await enableOffline(page);
  await toMail(page);
  await page.context().setOffline(true);

  await compose(page, ENT.bob, subject, `Written offline ${RUN}`);
  await send(page);
  // The label check runs offline as it does online.
  await expect(page.getByText('Pick a classification label before sending.').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-testid="email-composer"]')).toBeVisible();
  await page.getByTestId('composer-classification-option-confidential').click();
  await send(page);
  await expect(page.locator('[data-testid="email-composer"]')).toBeHidden({ timeout: 30_000 });
  await expect(page.getByText('Saved in the outbox', { exact: false }).first()).toBeVisible();
  await expect(page.getByTestId('offline-banner-outbox')).toHaveText('1 message in the outbox');

  // Nothing left the device yet.
  await page.waitForTimeout(3000);
  expect((await messages(ENT.bob, RUN)).filter((m) => m.subject.includes(subject))).toHaveLength(0);

  await page.getByTestId('offline-banner-outbox').click();
  const row = page.getByTestId('offline-outbox-row').first();
  await expect(row).toContainText(`[Confidential] ${subject}`, { timeout: 20_000 });
  await expect(row).toHaveAttribute('data-status', 'waiting');
  await row.scrollIntoViewIfNeeded();
  await shot(page, 'f-outbox');

  await page.context().setOffline(false);
  const got = await waitForMessage(ENT.bob, (m) => m.subject === `[Confidential] ${subject}`);
  const raw = await rawMessage(ENT.bob, got.blobId);
  expect(raw).toMatch(/^SIO-Label: marking="CONFIDENTIAL"/m);
  expect(raw).toMatch(/^Sensitivity: Company-Confidential\r?$/m);
  await expect(page.getByTestId('offline-outbox-empty')).toBeVisible({ timeout: 30_000 });
  expect((await messages(ENT.bob, RUN)).filter((m) => m.subject.includes(subject))).toHaveLength(1);
  await page.context().close();
  await setPolicy(browser, {});
});

test('the warning about recipients outside the organisation asks before a mail goes to the outbox', async ({ browser }) => {
  const subject = `Outbox external ${RUN}`;
  await setPolicy(browser, { organisation: { externalMail: { senderLabel: false, recipientWarning: true, domains: [], trustContacts: false } } });
  const page = await userPage(browser, ENT.alice);
  await enableOffline(page);
  await toMail(page);
  await page.context().setOffline(true);
  await compose(page, ENT.bob, subject, `To the partner too ${RUN}`);
  const input = page.locator('[data-testid="composer-to"] input').first();
  await input.click();
  await input.fill('someone@partner.invalid');
  await input.press('Enter');
  await send(page);
  const confirm = page.locator('[data-external-recipient-confirm]');
  await expect(confirm).toBeVisible({ timeout: 15_000 });
  await expect(confirm.locator('[data-external-recipients]')).toHaveText(/someone@partner\.invalid/);
  // Back: nothing waits.
  await confirm.locator('[data-external-recipient-back]').click();
  await expect(page.locator('[data-testid="email-composer"]')).toBeVisible();
  await expect(page.getByTestId('offline-banner-outbox')).toHaveCount(0);
  // Send anyway: it waits in the outbox, then goes out.
  await send(page);
  await confirm.locator('[data-external-recipient-send]').click();
  await expect(page.getByTestId('offline-banner-outbox')).toHaveText('1 message in the outbox', { timeout: 30_000 });
  await page.context().setOffline(false);
  await waitForMessage(ENT.bob, (m) => m.subject === subject);
  await page.context().close();
  await setPolicy(browser, {});
});

test('read, flag and delete to Trash made offline reach the server once back online', async ({ browser }) => {
  const read = `Offline mark read ${RUN}`;
  const flag = `Offline flag ${RUN}`;
  const trash = `Offline trash ${RUN}`;
  await deliverAndWait(read, 'Read me');
  await deliverAndWait(flag, 'Flag me');
  await deliverAndWait(trash, 'Bin me');
  const page = await userPage(browser, ENT.alice);
  await enableOffline(page);
  await toMail(page);
  await page.context().setOffline(true);

  await openMessage(page, read);
  await page.keyboard.press('Shift+I');
  await openMessage(page, flag);
  await page.keyboard.press('s');
  await openMessage(page, trash);
  await page.keyboard.press('Delete');
  await expect(page.locator('[data-testid="email-list-item"]', { hasText: trash })).toHaveCount(0, { timeout: 15_000 });
  await page.waitForTimeout(1500);
  // Nothing reached the server yet.
  expect((await waitForMessage(ENT.alice, (m) => m.subject === read)).keywords.$seen).toBeFalsy();

  await page.context().setOffline(false);
  const trashId = (await (await jmapAs(ENT.alice)).mailboxByRole('trash'))!.id;
  await expect.poll(async () => (await waitForMessage(ENT.alice, (m) => m.subject === read)).keywords.$seen === true, { timeout: 60_000 }).toBe(true);
  await expect.poll(async () => (await waitForMessage(ENT.alice, (m) => m.subject === flag)).keywords.$flagged === true, { timeout: 60_000 }).toBe(true);
  await expect.poll(async () => !!(await waitForMessage(ENT.alice, (m) => m.subject === trash)).mailboxIds[trashId], { timeout: 60_000 }).toBe(true);
  await page.context().close();
});

test('a change the server can no longer take is shown as changed on another device', async ({ browser }) => {
  const subject = `Offline conflict ${RUN}`;
  await deliverAndWait(subject, 'Moved twice');
  const page = await userPage(browser, ENT.alice);
  await enableOffline(page);
  await toMail(page);
  await page.context().setOffline(true);

  await openMessage(page, subject);
  await page.keyboard.press('Delete');
  await expect(page.locator('[data-testid="email-list-item"]', { hasText: subject })).toHaveCount(0, { timeout: 15_000 });

  // Meanwhile another device files it elsewhere.
  const other = await jmapAs(ENT.alice);
  const junk = (await other.mailboxByRole('junk'))!.id;
  const id = (await waitForMessage(ENT.alice, (m) => m.subject === subject)).id;
  await other.request([['Email/set', { accountId: other.accountId, update: { [id]: { mailboxIds: { [junk]: true } } } }, '0']]);

  await page.context().setOffline(false);
  await page.getByTestId('offline-banner-conflicts').click({ timeout: 90_000 });
  const row = page.getByTestId('offline-conflict-row').filter({ hasText: subject });
  await expect(row).toHaveAttribute('data-reason', 'changed');
  await expect(row).toContainText('Changed on another device');
  // The other device's move stands.
  expect(Object.keys((await waitForMessage(ENT.alice, (m) => m.subject === subject)).mailboxIds)).toEqual([junk]);
  await shot(page, 'f-offline-conflict');
  await row.getByRole('button', { name: /^Dismiss/ }).click();
  await expect(page.getByTestId('offline-conflict-row').filter({ hasText: subject })).toHaveCount(0);
  await page.context().close();
});

test('emptying the Trash offline shows at once and reaches the server once back online', async ({ browser }) => {
  const subject = `Offline empty trash ${RUN}`;
  await deliverAndWait(subject, 'Gone for good');
  const client = await jmapAs(ENT.alice);
  const trash = (await client.mailboxByRole('trash'))!.id;
  const id = (await waitForMessage(ENT.alice, (m) => m.subject === subject)).id;
  await client.request([['Email/set', { accountId: client.accountId, update: { [id]: { mailboxIds: { [trash]: true } } } }, '0']]);
  const page = await userPage(browser, ENT.alice);
  await enableOffline(page);
  await toMail(page);
  await page.context().setOffline(true);

  await page.getByText('Trash', { exact: true }).first().click();
  await expect(page.locator('[data-testid="email-list-item"]', { hasText: subject }).first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Empty folder' }).first().click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Empty folder' }).click();
  await expect(page.locator('[data-testid="email-list-item"]', { hasText: subject })).toHaveCount(0, { timeout: 15_000 });
  // Nothing reached the server yet.
  expect((await messages(ENT.alice, RUN)).some((m) => m.subject === subject)).toBe(true);

  await page.context().setOffline(false);
  await expect.poll(async () => (await messages(ENT.alice, RUN)).some((m) => m.subject === subject), { timeout: 90_000 }).toBe(false);
  await page.context().close();
});

test('a send whose response got lost goes out once', async ({ browser }) => {
  const subject = `Offline lost response ${RUN}`;
  const page = await userPage(browser, ENT.alice);
  await enableOffline(page);
  await toMail(page);
  const context = page.context();
  await blockMailServer(context);
  await waitUntilOffline(page);
  await compose(page, ENT.bob, subject, 'Only one copy');
  await send(page);
  await expect(page.getByTestId('offline-banner-outbox')).toHaveText('1 message in the outbox', { timeout: 30_000 });

  // The server comes back, and takes the send, but its answer never arrives.
  const origin = `${new URL(JMAP_URL).origin}/**`;
  let lost = 0;
  await context.unroute(origin);
  await context.route(origin, async (route) => {
    if (lost === 0 && (route.request().postData() ?? '').includes('EmailSubmission/set')) {
      lost += 1;
      await route.fetch();
      await route.abort('connectionreset');
      return;
    }
    await route.continue();
  });

  await expect.poll(() => lost, { timeout: 120_000 }).toBe(1);
  // Looked up, found in Sent, done: the row goes without another submission.
  await expect(page.getByTestId('offline-banner-outbox')).toHaveCount(0, { timeout: 120_000 });
  await waitForMessage(ENT.bob, (m) => m.subject === subject);
  const copies = (await messages(ENT.alice, RUN)).filter((m) => m.subject === subject);
  expect(copies).toHaveLength(1);
  expect(copies[0].keywords.$draft).toBeFalsy();
  await context.close();
});

test('signing out asks first when unsent mail would be lost, then wipes the device', async ({ browser }) => {
  const subject = `Unsent at sign-out ${RUN}`;
  const page = await userPage(browser, ENT.alice);
  await enableOffline(page);
  await toMail(page);
  await blockMailServer(page.context());
  await waitUntilOffline(page);
  await compose(page, ENT.bob, subject, 'Never sent');
  await send(page);
  await expect(page.getByTestId('offline-banner-outbox')).toHaveText('1 message in the outbox', { timeout: 30_000 });
  expect((await offlineDatabase(page)).accounts).toBeGreaterThan(0);

  // Sign out from the account menu: asked first, and Cancel keeps everything.
  await accountSwitcher(page).click();
  await page.getByRole('menuitem', { name: /^Sign out/ }).first().click().catch(async () => {
    await page.getByRole('button', { name: /^Sign out/ }).first().click();
  });
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText("1 message hasn't been sent. Signing out deletes them.");
  await shot(page, 'f-signout-confirm');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(accountSwitcher(page)).toBeVisible();
  expect(await offlineDatabaseExists(page)).toBe(true);

  await accountSwitcher(page).click();
  await page.getByRole('menuitem', { name: /^Sign out/ }).first().click().catch(async () => {
    await page.getByRole('button', { name: /^Sign out/ }).first().click();
  });
  await page.getByRole('alertdialog').getByRole('button', { name: 'Sign out' }).click();
  await expect(page.locator('#username')).toBeVisible({ timeout: 60_000 });
  // The user agreed to lose it: the sign-in page doesn't bring it up again.
  await expect(page.getByTestId('session-outbox-lost')).toHaveCount(0);
  await expect.poll(() => offlineDatabaseExists(page), { timeout: 20_000 }).toBe(false);
  await expect.poll(() => shellCaches(page), { timeout: 20_000 }).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('bulwark-offline-accounts'))).toBeNull();
  // It never went out.
  expect((await messages(ENT.bob, RUN)).filter((m) => m.subject === subject)).toHaveLength(0);
  await page.context().close();
});

test('the idle sign-out wipes the device and the login page names the lost message', async ({ browser }) => {
  test.setTimeout(360_000);
  const subject = `Unsent at idle ${RUN}`;
  await setPolicy(browser, { organisation: { session: { idleMinutes: 1, maxHours: 0, warnSeconds: 30 } } });
  const page = await userPage(browser, ENT.alice);
  await enableOffline(page);
  await toMail(page);
  await blockMailServer(page.context());
  await waitUntilOffline(page);
  await compose(page, ENT.bob, subject, 'Lost at idle');
  await send(page);
  await expect(page.getByTestId('offline-banner-outbox')).toHaveText('1 message in the outbox', { timeout: 30_000 });

  // Left alone for the minute.
  await expect(page.getByTestId('session-outbox-lost')).toContainText(subject, { timeout: 150_000 });
  await shot(page, 'f-idle-lost');
  await expect.poll(() => offlineDatabaseExists(page), { timeout: 20_000 }).toBe(false);
  await expect.poll(() => shellCaches(page), { timeout: 20_000 }).toEqual([]);
  await page.context().close();
  await setPolicy(browser, {});
});

test('the admin forbids offline mode on Organisation > Devices', async ({ browser }) => {
  const admin = await adminContext(browser);
  const page = await admin.newPage();
  await page.goto('/admin/org-devices');
  const toggle = page.getByTestId('org-devices-noOffline');
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await expect.poll(async () => ((await getPolicy(admin)).organisation as { devices?: { noOffline?: boolean } })?.devices?.noOffline, { timeout: 15_000 }).toBe(true);
  await page.getByTestId('org-devices-noOffline').scrollIntoViewIfNeeded();
  await shot(page, 'f-admin-offline');
  await admin.close();
  await setPolicy(browser, {});
});

test('forbidding offline mode wipes the device at the next policy fetch and hides the switch, only in its scope', async ({ browser }) => {
  const alice = await userPage(browser, ENT.alice);
  await enableOffline(alice);
  const carol = await userPage(browser, ENT.carol);
  await enableOffline(carol);
  await toMail(alice);
  const loadedAt = Date.now();
  expect((await offlineDatabase(alice)).accounts).toBeGreaterThan(0);

  // Waiting starts now: the app may fetch the policy again at any time, not
  // only on focus, and the notice doesn't stay.
  const notice = alice.getByText('Your organisation turned off offline mode', { exact: false }).first().waitFor({ state: 'visible', timeout: 180_000 });
  // ent-team (alice, not carol) may no longer keep mail on devices.
  await setPolicy(browser, {
    scopes: [{ id: 'no-offline', label: 'No offline', match: { groups: [ENT.team] }, policy: { organisation: { devices: { noOffline: true } } } }],
  });
  // The open tab fetches the policy again when it gets focus (at most once a minute).
  await alice.waitForTimeout(Math.max(0, 62_000 - (Date.now() - loadedAt)));
  await alice.evaluate(() => window.dispatchEvent(new Event('focus'))).catch(() => {});
  await notice;
  await expect.poll(async () => (await offlineDatabase(alice)).accounts, { timeout: 20_000 }).toBe(0);
  await alice.goto('/settings/backup/offline');
  await expect(alice.getByTestId('offline-forbidden')).toBeVisible({ timeout: 30_000 });
  await expect(alice.getByTestId('offline-switch')).toHaveCount(0);
  await shot(alice, 'f-offline-forbidden');

  // carol is outside the scope: her switch and her mail stay.
  await carol.reload();
  await expect(carol.getByTestId('offline-switch')).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 });
  expect((await offlineDatabase(carol)).accounts).toBeGreaterThan(0);
  await alice.context().close();
  await carol.context().close();
  await setPolicy(browser, {});
});

test('at 390 px: the offline settings, the outbox and the reload prompt fit', async ({ browser }) => {
  const subject = `Phone outbox ${RUN}`;
  const page = await userPage(browser, ENT.alice, true);
  await enableOffline(page, true);
  await shot(page, 'f-offline-settings-phone');
  await toMail(page);
  await blockMailServer(page.context());
  await waitUntilOffline(page);
  await shot(page, 'f-offline-banner-phone');
  await compose(page, ENT.bob, subject, 'From the phone');
  await send(page);
  await expect(page.getByTestId('offline-banner-outbox')).toHaveText('1 message in the outbox', { timeout: 30_000 });
  await page.getByTestId('offline-banner-outbox').click();
  const row = page.getByTestId('offline-outbox-row').first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  const box = await row.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await row.scrollIntoViewIfNeeded();
  await shot(page, 'f-outbox-phone');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('offline-outbox-dialog')).toBeHidden();
  // One toast at a time, as after a real deploy.
  await expect(page.getByText('Saved in the outbox', { exact: false })).toHaveCount(0, { timeout: 30_000 });

  // The reload prompt: the server says another build runs, and a chunk of this one failed to load.
  await page.context().route('**/api/version', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"buildId":"another-build"}' }));
  await page.evaluate(() => {
    const script = document.createElement('script');
    script.src = '/_next/static/chunks/gone-after-a-deploy.js';
    document.head.appendChild(script);
  });
  const prompt = page.getByText('A new version of Bulwark is ready.').first();
  await expect(prompt).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Reload' }).first()).toBeVisible();
  // Once it has slid in, the whole toast is on the screen.
  const toastCard = page.locator('.toast-item', { hasText: 'A new version of Bulwark is ready.' }).first();
  await expect.poll(async () => {
    const box = await toastCard.boundingBox();
    return box ? box.x >= 0 && box.x + box.width <= 390 : false;
  }, { timeout: 10_000 }).toBe(true);
  await shot(page, 'f-reload-prompt-phone');
  await page.context().close();
});

// ---- What a device keeps (design A4, A7, A8, A9) ----

/** A message from long ago, in ent-alice's Inbox. Email/import takes the received date. */
async function importOld(account: string, subject: string, daysAgo: number): Promise<void> {
  const client = await jmapAs(account);
  const receivedAt = new Date(Date.now() - daysAgo * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z');
  const raw = `From: ${ENT.bob}\r\nTo: ${account}\r\nSubject: ${subject}\r\nDate: ${new Date(receivedAt).toUTCString()}\r\nMessage-ID: <${subject.replace(/\W/g, '')}@example.org>\r\nContent-Type: text/plain\r\n\r\nOld body ${RUN}\r\n`;
  const auth = 'Basic ' + Buffer.from(`${account}:${process.env.IT_ENT_PASSWORD}`).toString('base64');
  const upload = await fetch(`${JMAP_URL}/jmap/upload/${client.accountId}/`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'message/rfc822' }, body: raw });
  if (!upload.ok) throw new Error(`upload: ${upload.status}`);
  const { blobId } = await upload.json() as { blobId: string };
  const boxes = await client.request([['Mailbox/query', { accountId: client.accountId, filter: { role: 'inbox' } }, '0']]);
  const inbox = boxes.methodResponses[0][1].ids[0] as string;
  const done = await client.request([['Email/import', { accountId: client.accountId, emails: { a: { blobId, mailboxIds: { [inbox]: true }, keywords: {}, receivedAt } } }, '0']]);
  if (!done.methodResponses[0][1].created?.a) throw new Error(`import: ${JSON.stringify(done.methodResponses[0][1])}`);
}

/** How many messages the settings page says are kept. */
async function keptMessages(page: Page): Promise<number> {
  const text = await page.getByTestId('offline-usage').locator('[data-part="mail"] dd').innerText();
  return Number(text.match(/\(([\d.,]+) /)?.[1].replace(/[.,]/g, '') ?? NaN);
}

async function statusSettled(page: Page): Promise<void> {
  await expect(page.getByTestId('offline-status')).toContainText('updated', { timeout: 180_000 });
}

test('a cap from the organisation prunes kept mail at the next policy fetch, and lifting it fetches the mail back', async ({ browser }) => {
  const old = `Old message ${RUN}`;
  await importOld(ENT.alice, old, 200);
  const page = await userPage(browser, ENT.alice);
  await enableOffline(page);
  const windowRow = page.locator('[data-search-label="How far back to keep"]');
  await windowRow.locator('select').selectOption('all');
  await expect.poll(() => keptMessages(page), { timeout: 120_000 }).toBeGreaterThan(0);
  await statusSettled(page);
  await expect(async () => {
    await page.getByTestId('offline-status').waitFor();
    const client = await jmapAs(ENT.alice);
    const total = await client.request([['Email/query', { accountId: client.accountId, calculateTotal: true, limit: 0 }, '0']]);
    expect(await keptMessages(page)).toBe(total.methodResponses[0][1].total);
  }).toPass({ timeout: 180_000, intervals: [2000] });
  const before = await keptMessages(page);

  await setPolicy(browser, { organisation: { devices: { offlineMaxDays: 30, noOfflineAttachments: true } } });
  await page.reload();
  await expect(windowRow.locator('select')).toHaveValue('30', { timeout: 60_000 });
  await expect(windowRow.locator('select option')).toHaveText(['30 days']);
  await expect(windowRow.getByText('Set by your organisation')).toBeVisible();
  const attachments = page.getByTestId('offline-attachments');
  await expect(attachments).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('[data-search-label="Keep attachments"]').getByText('Set by your organisation')).toBeVisible();
  await expect.poll(() => keptMessages(page), { timeout: 60_000 }).toBeLessThan(before);
  await windowRow.scrollIntoViewIfNeeded();
  await shot(page, 'do-storage-page-capped');

  // Offline, the old message isn't there either: it left the device, not only the list.
  await toMail(page);
  await blockMailServer(page.context());
  await waitUntilOffline(page);
  await page.goto('/mail?q=' + encodeURIComponent(`"Old message"`)).catch(() => {});
  await expect(page.locator('[data-testid="email-list-item"]', { hasText: old })).toHaveCount(0);
  await page.context().unroute(`${new URL(JMAP_URL).origin}/**`);

  await setPolicy(browser, {});
  await page.goto('/settings/backup/offline');
  await expect(windowRow.locator('select')).toHaveValue('all', { timeout: 60_000 });
  await expect.poll(() => keptMessages(page), { timeout: 180_000, intervals: [2000] }).toBe(before);
  await page.context().close();
});

test('the storage page: usage, choices, clearing an account', async ({ browser }) => {
  const subject = `Cleared and fetched again ${RUN}`;
  await deliverAndWait(subject, `Body ${RUN}`);
  const page = await userPage(browser, ENT.alice);
  await enableOffline(page);
  await expect(page.getByTestId('offline-usage')).toContainText('Messages and search index');
  await expect.poll(() => keptMessages(page), { timeout: 60_000 }).toBeGreaterThan(0);
  await shot(page, 'do-storage-page');

  // Keyboard: the choices are native controls in tab order, and the state survives a reload.
  const select = page.locator('[data-search-label="How far back to keep"] select');
  await select.focus();
  await select.selectOption('365');
  await page.reload();
  await expect(select).toHaveValue('365', { timeout: 60_000 });
  await expect(page.getByTestId('offline-status')).toContainText('updated', { timeout: 180_000 });

  const before = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('bulwark-store'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const all = await new Promise<Array<{ file: string }>>((resolve) => { const r = db.transaction('accounts').objectStore('accounts').getAll(); r.onsuccess = () => resolve(r.result); });
    db.close();
    return all.map((record) => record.file);
  });
  expect(before).toHaveLength(1);

  await page.getByTestId('offline-clear').click();
  await expect(page.getByRole('alertdialog').or(page.getByRole('dialog'))).toContainText('Clear this account on this device?');
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  // A new key and file, and the mail comes back by itself, with the window kept.
  await expect(async () => {
    const after = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('bulwark-store'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const all = await new Promise<Array<{ file: string }>>((resolve) => { const r = db.transaction('accounts').objectStore('accounts').getAll(); r.onsuccess = () => resolve(r.result); });
      db.close();
      return all.map((record) => record.file);
    });
    expect(after).toHaveLength(1);
    expect(after).not.toEqual(before);
  }).toPass({ timeout: 60_000 });
  await expect.poll(() => keptMessages(page), { timeout: 180_000, intervals: [2000] }).toBeGreaterThan(0);
  await expect(select).toHaveValue('365');
  await page.context().close();
});

test('the storage page fits at 390 px', async ({ browser }) => {
  const phone = await userPage(browser, ENT.alice, true);
  await enableOffline(phone, true);
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(phone, 'do-storage-page-390');
  await phone.context().close();
});

test('a store the browser deleted is noticed, says what was lost and syncs again', async ({ browser }) => {
  const subject = `After the eviction ${RUN}`;
  await deliverAndWait(subject, `Body ${RUN}`);
  const page = await userPage(browser, ENT.alice);
  await enableOffline(page);

  // No app on this page, so no worker holds the files, as after closing the tab.
  await page.goto('/manifest.webmanifest');
  await expect.poll(() => page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const raw = localStorage.getItem('bulwark-offline-health');
    const health = JSON.parse(raw ?? '{}') as Record<string, { pending?: number }>;
    for (const entry of Object.values(health)) entry.pending = 2;
    localStorage.setItem('bulwark-offline-health', JSON.stringify(health));
    return root.removeEntry('.bulwark-store', { recursive: true }).then(() => 'gone', (error: Error) => error.name);
  }), { timeout: 30_000 }).toBe('gone');

  await page.goto('/settings/backup/offline');
  await expect(page.getByTestId('offline-evicted')).toContainText('The browser deleted the mail kept on this device', { timeout: 60_000 });
  await expect(page.getByTestId('offline-evicted')).toContainText('2 unsent messages or changes were lost');
  await expect.poll(() => keptMessages(page), { timeout: 180_000, intervals: [2000] }).toBeGreaterThan(0);
  await page.getByTestId('offline-evicted').getByRole('button', { name: 'OK' }).click();
  await expect(page.getByTestId('offline-evicted')).toHaveCount(0);

  // The key gone and the file still there: nobody can read it, so it goes too.
  await page.goto('/manifest.webmanifest');
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const r = indexedDB.open('bulwark-store');
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const tx = r.result.transaction('accounts', 'readwrite');
      tx.objectStore('accounts').clear();
      tx.oncomplete = () => { r.result.close(); resolve(); };
    };
  }));
  await page.goto('/settings/backup/offline');
  await expect(page.getByTestId('offline-evicted')).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => keptMessages(page), { timeout: 180_000, intervals: [2000] }).toBeGreaterThan(0);
  await page.context().close();
});

test('a browser that refuses to keep the data gets a warning and can be asked again', async ({ browser }) => {
  const page = await userPage(browser, ENT.alice);
  await page.context().addInitScript(() => {
    const answer = () => Promise.resolve(Boolean((window as unknown as { __grant?: boolean }).__grant));
    StorageManager.prototype.persist = answer;
    StorageManager.prototype.persisted = answer;
  });
  await enableOffline(page);
  await expect(page.getByTestId('offline-persist-refused')).toContainText('This browser may delete the kept mail');
  await page.evaluate(() => { (window as unknown as { __grant?: boolean }).__grant = true; });
  await page.getByTestId('offline-persist-retry').click();
  await expect(page.getByTestId('offline-persist-refused')).toHaveCount(0);
  await page.context().close();
});

test('nothing of a kept message is readable on the device', async ({ browser }) => {
  const subject = `Rawcheck ${RUN} ${RUN}quokka`;
  const text = `Rawbody ${RUN} ${RUN}wombat`;
  await deliverAndWait(subject, text);
  const page = await userPage(browser, ENT.alice);
  await toMail(page);
  await openMessage(page, subject);

  /** Everything this origin has stored, as raw bytes where it's a file, looked through for a term. */
  const findIn = (term: string) => page.evaluate(async (needle) => {
    const hits: string[] = [];
    const encoded = new TextEncoder().encode(needle);
    const has = (bytes: Uint8Array) => {
      outer: for (let i = 0; i <= bytes.length - encoded.length; i += 1) {
        for (let j = 0; j < encoded.length; j += 1) if (bytes[i + j] !== encoded[j]) continue outer;
        return true;
      }
      return false;
    };
    let files = 0;
    let bytesRead = 0;
    const walk = async (dir: FileSystemDirectoryHandle, path: string) => {
      for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
        if (handle.kind === 'directory') { await walk(handle as FileSystemDirectoryHandle, `${path}/${name}`); continue; }
        // Works while the worker holds the handles.
        const bytes = new Uint8Array(await (await (handle as FileSystemFileHandle).getFile()).arrayBuffer());
        files += 1;
        bytesRead += bytes.length;
        if (has(bytes)) hits.push(`opfs:${path}/${name}`);
      }
    };
    await walk(await navigator.storage.getDirectory(), '');

    const flatten = (value: unknown): string => {
      if (value instanceof ArrayBuffer) return new TextDecoder('latin1').decode(value);
      if (ArrayBuffer.isView(value)) return new TextDecoder('latin1').decode(value as Uint8Array);
      if (typeof value === 'string') return value;
      if (Array.isArray(value)) return value.map(flatten).join(' ');
      if (value && typeof value === 'object' && !(value instanceof CryptoKey)) return Object.entries(value).map(([key, inner]) => `${key} ${flatten(inner)}`).join(' ');
      return String(value);
    };
    for (const info of await indexedDB.databases()) {
      if (!info.name) continue;
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(info.name!); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      for (const store of db.objectStoreNames) {
        const rows = await new Promise<unknown[]>((resolve) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => resolve([]); });
        if (flatten(rows).includes(needle)) hits.push(`indexeddb:${info.name}/${store}`);
      }
      db.close();
    }
    for (const [label, storage] of [['localStorage', localStorage], ['sessionStorage', sessionStorage]] as const) {
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i)!;
        if (`${key} ${storage.getItem(key)}`.includes(needle)) hits.push(`${label}:${key}`);
      }
    }
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        if (response && (await response.clone().text()).includes(needle)) hits.push(`cache:${name}:${request.url}`);
      }
    }
    return { hits, files, bytesRead };
  }, term);

  // The check can see plaintext: without the store, the boot snapshot has the subject.
  await expect.poll(async () => (await findIn(subject)).hits, { timeout: 15_000 }).toContain('localStorage:email-snapshot');

  await enableOffline(page);
  await expect(async () => {
    const client = await jmapAs(ENT.alice);
    const total = await client.request([['Email/query', { accountId: client.accountId, calculateTotal: true, limit: 0 }, '0']]);
    expect(await keptMessages(page)).toBeGreaterThanOrEqual(total.methodResponses[0][1].total);
  }).toPass({ timeout: 180_000, intervals: [2000] });
  await toMail(page);
  await openMessage(page, subject);
  await expect(body(page)).toContainText(text, { timeout: 20_000 });
  await page.waitForTimeout(1500);

  for (const term of [subject, text, `${RUN}quokka`, `${RUN}wombat`]) {
    const { hits, files, bytesRead } = await findIn(term);
    expect(files, 'the store has its files').toBeGreaterThan(0);
    expect(bytesRead, 'and they hold something').toBeGreaterThan(100_000);
    expect(hits, `plaintext "${term}"`).toEqual([]);
  }
  await page.reload();
  await expect(page.locator('[data-testid="email-list-item"]', { hasText: subject }).first()).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  expect((await findIn(subject)).hits).toEqual([]);
  await page.context().close();
});

test('the admin page saves the caps and no longer promises 30 days or 250 MB', async ({ browser }) => {
  const admin = await adminContext(browser);
  const page = await admin.newPage();
  await page.goto('/admin/org-devices');
  const days = page.getByTestId('org-devices-offlineMaxDays');
  await expect(days).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('body')).not.toContainText('250 MB');
  await days.fill('45');
  await page.getByTestId('org-devices-noOfflineAttachments').click();
  await page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await expect.poll(async () => ((await getPolicy(admin)).organisation as { devices?: { offlineMaxDays?: number; noOfflineAttachments?: boolean } }).devices, { timeout: 15_000 })
    .toMatchObject({ offlineMaxDays: 45, noOfflineAttachments: true });
  await shot(page, 'do-admin-offline-caps');
  await putPolicy(admin, { ...original, scopes: [] });
  await admin.close();
});

test('a deploy makes the open tab offer a reload and serves no stale chunks', async ({ browser }) => {
  const redeploy = process.env.IT_OFFLINE_REDEPLOY;
  test.skip(!redeploy, 'set IT_OFFLINE_REDEPLOY to the command that deploys a second build (enterprise-rig/scratch/f-redeploy.sh)');
  test.setTimeout(900_000);
  const page = await userPage(browser, ENT.carol);
  await enableOffline(page);
  await toMail(page);
  const loadedAt = Date.now();
  const before = (await (await page.context().request.get('/api/version')).json()).buildId as string;
  expect(await shellCaches(page)).toEqual([`bulwark-shell-${before}`]);

  execSync(redeploy!, { stdio: 'inherit', timeout: 600_000 });
  const after = (await (await page.context().request.get('/api/version')).json()).buildId as string;
  expect(after).not.toBe(before);

  // The open tab, still on the old build, notices at its next check: focus
  // here, which asks at most once a minute.
  await page.waitForTimeout(Math.max(0, 62_000 - (Date.now() - loadedAt)));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const prompt = page.getByText('A new version of Bulwark is ready.').first();
  await expect(prompt).toBeVisible({ timeout: 30_000 });
  await shot(page, 'f-reload-prompt');
  await page.getByRole('button', { name: 'Reload' }).first().click();
  await expect(page.locator('[data-testid="email-list-item"]').first()).toBeVisible({ timeout: 60_000 });

  // Every chunk the reloaded page runs exists on the server now: none of the old build's.
  const chunks = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/_next/static/')));
  expect(chunks.length).toBeGreaterThan(0);
  for (const url of chunks) {
    expect((await page.context().request.get(url)).status(), url).toBe(200);
  }
  // The new build's worker runs, and the old build's files are gone with its last tab.
  await expect.poll(() => shellCaches(page), { timeout: 60_000 }).toEqual([`bulwark-shell-${after}`]);
  await page.context().close();
});
