import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import {
  ENT,
  ENT_PASSWORD,
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
import { accountSwitcher, openFolder } from './helpers/app';
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
 * - a draft written offline with a file survives a reload without a network,
 *   is on the server once after reconnecting, with the file, and can be sent;
 * - a kept message shows its inline image and gives its attachment offline;
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

interface ServerDraft { id: string; subject: string; blobId: string; attachments: Array<{ blobId: string; name: string; size: number }> }

/** The account's Drafts folder as the server has it, for one subject. */
async function serverDrafts(account: string, subject: string): Promise<ServerDraft[]> {
  const client = await jmapAs(account);
  const boxes = await client.request([['Mailbox/get', { accountId: client.accountId, properties: ['id', 'role'] }, '0']]);
  const drafts = (boxes.methodResponses[0][1].list as Array<{ id: string; role: string | null }>).find((box) => box.role === 'drafts');
  const r = await client.request([
    ['Email/query', { accountId: client.accountId, filter: { inMailbox: drafts?.id }, limit: 200 }, '0'],
    ['Email/get', { accountId: client.accountId, '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' }, properties: ['id', 'subject', 'blobId', 'attachments'] }, '1'],
  ]);
  return (r.methodResponses[1][1].list as ServerDraft[]).filter((email) => email.subject === subject);
}

test('a draft written offline with a file survives a reload, is on the server once after reconnecting, and can be sent', async ({ browser }) => {
  const subject = `Offline draft ${RUN}`;
  const fileText = `Attached offline ${RUN}`;
  const page = await userPage(browser, ENT.alice);
  await enableOffline(page);
  await toMail(page);
  const context = page.context();
  await context.setOffline(true);

  await compose(page, ENT.bob, subject, `First words ${RUN}`);
  const composer = page.locator('[data-testid="email-composer"]');
  await composer.locator('input[type="file"]').first().setInputFiles({ name: 'offline-note.txt', mimeType: 'text/plain', buffer: Buffer.from(fileText) });
  await expect(composer).toContainText('offline-note.txt', { timeout: 15_000 });
  await expect(composer.getByText('Saved on this device').first()).toBeVisible({ timeout: 30_000 });
  await shot(page, 'f-offline-draft');
  // Saved again and again: still one draft in the end.
  for (const word of [' second', ' third', ' last']) {
    await composer.locator('[contenteditable="true"]').first().click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(word);
    await expect(composer.getByTestId('composer-save-status').first()).toHaveAttribute('data-status', 'saved', { timeout: 30_000 });
    await page.waitForTimeout(2500);
  }
  await page.getByTestId('composer-close').first().click();
  await expect(composer).toBeHidden({ timeout: 30_000 });
  expect(await serverDrafts(ENT.alice, subject)).toHaveLength(0);

  // A start without a network: it's in Drafts, with its text and its file.
  await page.reload();
  await expect(page.locator('[data-testid="email-list-item"]').first()).toBeVisible({ timeout: 60_000 });
  await openFolder(page, { role: 'drafts' });
  const row = page.locator('[data-testid="email-list-item"], [data-thread-keys]', { hasText: subject }).first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.click();
  await page.getByTestId('edit-draft').click();
  await expect(composer).toBeVisible({ timeout: 20_000 });
  await expect(composer.locator('[contenteditable="true"]').first()).toContainText('last', { timeout: 20_000 });
  await expect(composer).toContainText('offline-note.txt');
  await page.getByTestId('composer-close').first().click();
  await expect(composer).toBeHidden({ timeout: 30_000 });
  expect(await serverDrafts(ENT.alice, subject)).toHaveLength(0);

  // Back online: one draft, with the latest text and the file.
  await context.setOffline(false);
  await expect.poll(async () => (await serverDrafts(ENT.alice, subject)).length, { timeout: 180_000, intervals: [2000] }).toBe(1);
  await page.waitForTimeout(5000);
  const [draft] = await serverDrafts(ENT.alice, subject);
  expect(await serverDrafts(ENT.alice, subject)).toHaveLength(1);
  expect(draft.attachments.map((part) => part.name)).toEqual(['offline-note.txt']);
  expect(await rawMessage(ENT.alice, draft.attachments[0].blobId)).toContain(fileText);
  expect(await rawMessage(ENT.alice, draft.blobId)).toContain('last');

  // And it goes out from there, with the file.
  await page.goto('/mail');
  await expect(page.locator('[data-testid="email-list-item"]').first()).toBeVisible({ timeout: 60_000 });
  await openFolder(page, { role: 'drafts' });
  const again = page.locator('[data-testid="email-list-item"], [data-thread-keys]', { hasText: subject }).first();
  await expect(again).toBeVisible({ timeout: 60_000 });
  await again.click();
  await page.getByTestId('edit-draft').click();
  await expect(composer).toContainText('offline-note.txt', { timeout: 20_000 });
  await send(page);
  await expect(composer).toBeHidden({ timeout: 30_000 });
  const got = await waitForMessage(ENT.bob, (m) => m.subject === subject);
  expect(await rawMessage(ENT.bob, got.blobId)).toContain('offline-note.txt');
  await expect.poll(async () => (await serverDrafts(ENT.alice, subject)).length, { timeout: 30_000 }).toBe(0);
  await context.close();
});

const ONE_PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/7yMK/gAAAABJRU5ErkJggg==', 'base64');

async function uploadAs(account: string, data: Buffer, type: string): Promise<string> {
  const client = await jmapAs(account);
  const res = await fetch(`${JMAP_URL}/jmap/upload/${client.accountId}/`, {
    method: 'POST',
    headers: { 'Content-Type': type, Authorization: 'Basic ' + Buffer.from(`${account}:${ENT_PASSWORD}`).toString('base64') },
    body: new Uint8Array(data),
  });
  if (!res.ok) throw new Error(`upload: ${res.status}`);
  return (await res.json() as { blobId: string }).blobId;
}

test('a kept message shows its inline image and gives its attachment offline', async ({ browser }) => {
  const subject = `Offline files ${RUN}`;
  const fileText = `Kept attachment ${RUN}`;
  const client = await jmapAs(ENT.alice);
  const inbox = await client.mailboxByRole('inbox');
  const image = await uploadAs(ENT.alice, ONE_PIXEL, 'image/png');
  const file = await uploadAs(ENT.alice, Buffer.from(fileText), 'application/octet-stream');
  const made = await client.request([['Email/set', {
    accountId: client.accountId,
    create: {
      m: {
        mailboxIds: { [inbox!.id]: true },
        from: [{ email: ENT.bob }],
        to: [{ email: ENT.alice }],
        subject,
        bodyValues: { t: { value: `Text ${RUN}` }, h: { value: `<p>Html ${RUN}</p><img alt="pixel" src="cid:pixel@example.org">` } },
        bodyStructure: {
          type: 'multipart/mixed',
          subParts: [
            {
              type: 'multipart/alternative',
              subParts: [
                { partId: 't', type: 'text/plain' },
                { type: 'multipart/related', subParts: [{ partId: 'h', type: 'text/html' }, { blobId: image, type: 'image/png', name: 'pixel.png', disposition: 'inline', cid: 'pixel@example.org' }] },
              ],
            },
            { blobId: file, type: 'application/octet-stream', name: 'kept.bin', disposition: 'attachment' },
          ],
        },
      },
    },
  }, '0']]);
  expect(made.methodResponses[0][1].created?.m?.id, JSON.stringify(made.methodResponses[0][1].notCreated)).toBeTruthy();

  const page = await userPage(browser, ENT.alice);
  await enableOffline(page);
  await toMail(page);
  // Files come last in a pass, and yield to anything newer. This message's come first of them.
  await page.waitForTimeout(10_000);
  await page.context().setOffline(true);
  await openMessage(page, subject);

  const pixel = page.frameLocator('iframe').locator('img[alt="pixel"]').first();
  // A broken image is 0 wide until the app's placeholder comes in, so ask where it came from.
  await expect.poll(() => pixel.evaluate((img: HTMLImageElement) => (img.src.startsWith('blob:') ? img.naturalWidth : 0)).catch(() => 0), { timeout: 30_000 }).toBe(1);

  const chip = page.locator('[data-testid="attachment"][data-attachment-name="kept.bin"]').first();
  await expect(chip).toBeVisible({ timeout: 20_000 });
  const download = page.waitForEvent('download', { timeout: 30_000 });
  await chip.locator('button[title="Download"]').click();
  const saved = await (await download).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of saved) chunks.push(chunk as Buffer);
  expect(Buffer.concat(chunks).toString()).toBe(fileText);
  await page.context().close();
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
