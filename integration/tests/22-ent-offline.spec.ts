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
 *   then wipes the device; the idle sign-out hides the mail, the login page
 *   says how many messages wait, and signing in again sends them; with the
 *   organisation's immediate deletion it wipes and names the lost message;
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
  await page.goto('/settings/offline');
  const toggle = page.getByTestId('offline-switch');
  if (phone && !(await toggle.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true, () => false))) {
    // On a phone the settings list may come first.
    await page.getByTestId('settings-tab-offline').click();
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

/**
 * The store's files as bytes, with no worker holding them: which of `needles`
 * occur in them. Goes to a same-origin file without scripts first, so that
 * leaving the app ends the owner.
 */
async function rawStoreFiles(page: Page, needles: string[]): Promise<{ bytes: number; found: string[] }> {
  await page.goto(new URL('/sw.js', page.url()).href);
  return page.evaluate(async (wanted) => {
    const read = async (dir: FileSystemDirectoryHandle): Promise<string[]> => {
      const parts: string[] = [];
      for await (const handle of (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
        if (handle.kind === 'directory') parts.push(...await read(handle as FileSystemDirectoryHandle));
        else parts.push(new TextDecoder('latin1').decode(await (await (handle as FileSystemFileHandle).getFile()).arrayBuffer()));
      }
      return parts;
    };
    const root = await navigator.storage.getDirectory();
    const files = await read(await root.getDirectoryHandle('.bulwark-store'));
    return {
      bytes: files.reduce((sum, file) => sum + file.length, 0),
      found: wanted.filter((needle) => files.some((file) => file.includes(needle))),
    };
  }, needles);
}

/** The file of the account's store, from the key database. */
async function storeFileName(page: Page): Promise<string> {
  return page.evaluate(() => new Promise<string>((resolve, reject) => {
    const open = indexedDB.open('bulwark-store');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const all = open.result.transaction('accounts').objectStore('accounts').getAll();
      all.onsuccess = () => {
        open.result.close();
        resolve((all.result as Array<{ file: string }>)[0].file);
      };
    };
  }));
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

test('the files on the device hold no readable mail, and a store whose key went starts over', async ({ browser }) => {
  const subject = `Offline encrypted ${RUN}`;
  const secret = `Secret body ${RUN}`;
  await deliverAndWait(subject, secret);
  const page = await userPage(browser, ENT.alice);
  await enableOffline(page);
  await toMail(page);
  await expect.poll(async () => (await offlineDatabase(page)).accounts, { timeout: 30_000 }).toBeGreaterThan(0);
  await openMessage(page, subject);
  await expect(body(page)).toContainText(secret, { timeout: 20_000 });
  // Long enough for the store to have the message and its text on disk.
  await page.waitForTimeout(5_000);
  const file = await storeFileName(page);

  const raw = await rawStoreFiles(page, [subject, secret, 'SQLite format 3', file]);
  expect(raw.bytes).toBeGreaterThan(100_000);
  // The name of the file is the one thing here in the clear: the search works.
  expect(raw.found).toEqual([file]);

  // The browser clears the key database and leaves the files.
  await page.evaluate(() => new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase('bulwark-store');
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  }));
  await page.goto(new URL('/', page.url()).href);
  // Once on screen and once for screen readers.
  await expect(page.locator('p', { hasText: "couldn't be read" }).first()).toBeVisible({ timeout: 60_000 });
  await toMail(page);
  await expect(page.locator('[data-testid="email-list-item"]', { hasText: subject }).first()).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => (await offlineDatabase(page)).accounts, { timeout: 30_000 }).toBeGreaterThan(0);
  const newFile = await storeFileName(page);
  expect(newFile).not.toBe(file);
  const after = await rawStoreFiles(page, [file, newFile]);
  expect(after.found).toEqual([newFile]);
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
  await page.getByRole('button', { name: 'Empty Trash' }).first().click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Empty Trash' }).click();
  await expect(page.locator('[data-testid="email-list-item"]', { hasText: subject })).toHaveCount(0, { timeout: 15_000 });
  // Nothing reached the server yet.
  expect((await messages(ENT.alice, RUN)).some((m) => m.subject === subject)).toBe(true);

  await page.context().setOffline(false);
  await expect.poll(async () => (await messages(ENT.alice, RUN)).some((m) => m.subject === subject), { timeout: 90_000 }).toBe(false);
  await page.context().close();
});

/** A send taken from the outbox gets no answer. `arrives` is what reached the server of it. */
async function loseResponse(browser: Browser, subject: string, arrives: (body: { methodCalls: Array<[string, unknown, string]> }) => void) {
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
    const sent = route.request().postData() ?? '';
    if (lost === 0 && sent.includes('EmailSubmission/set')) {
      lost += 1;
      const body = JSON.parse(sent);
      arrives(body);
      await route.fetch({ postData: JSON.stringify(body) });
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
}

test('a send whose response got lost goes out once', async ({ browser }) => {
  await loseResponse(browser, `Offline lost response ${RUN}`, () => {});
});

test('a send of which only the draft arrived is submitted, and goes out once', async ({ browser }) => {
  await loseResponse(browser, `Offline lost submission ${RUN}`, (body) => {
    body.methodCalls = body.methodCalls.filter(([name]) => name === 'Email/set');
  });
});

interface ServerDraft { id: string; subject: string; blobId: string; attachments: Array<{ blobId: string; name: string; size: number }> }

/**
 * The account's Drafts folder as the server has it, for one subject. Polled, on
 * an account the app under test and other runs use too: the server's rate limit
 * says nothing about the draft, so it waits that out.
 */
async function serverDrafts(account: string, subject: string): Promise<ServerDraft[]> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const client = await jmapAs(account);
      const boxes = await client.request([['Mailbox/get', { accountId: client.accountId, properties: ['id', 'role'] }, '0']]);
      const drafts = (boxes.methodResponses[0][1].list as Array<{ id: string; role: string | null }>).find((box) => box.role === 'drafts');
      const r = await client.request([
        ['Email/query', { accountId: client.accountId, filter: { inMailbox: drafts?.id }, limit: 200 }, '0'],
        ['Email/get', { accountId: client.accountId, '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' }, properties: ['id', 'subject', 'blobId', 'attachments'] }, '1'],
      ]);
      return (r.methodResponses[1][1].list as ServerDraft[]).filter((email) => email.subject === subject);
    } catch (error) {
      if (attempt >= 6 || !/\b429\b/.test(String(error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }
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
  // A draft opens straight in the composer (e7cef5ba1).
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
  // A draft opens straight in the composer (e7cef5ba1).
  await expect(composer).toContainText('offline-note.txt', { timeout: 20_000 });
  await send(page);
  await expect(composer).toBeHidden({ timeout: 30_000 });
  const got = await waitForMessage(ENT.bob, (m) => m.subject === subject);
  expect(await rawMessage(ENT.bob, got.blobId)).toContain('offline-note.txt');
  await expect.poll(async () => (await serverDrafts(ENT.alice, subject)).length, { timeout: 30_000 }).toBe(0);
  await context.close();
});

test('an open composer keeps its file through a flush: the next save and the send still have it', async ({ browser }) => {
  const subject = `Offline open composer ${RUN}`;
  const fileText = `Stays attached ${RUN}`;
  const page = await userPage(browser, ENT.alice);
  await enableOffline(page);
  await toMail(page);
  const context = page.context();

  // Saved online, so the composer holds a part of that message.
  await compose(page, ENT.bob, subject, `Online words ${RUN}`);
  const composer = page.locator('[data-testid="email-composer"]');
  await composer.locator('input[type="file"]').first().setInputFiles({ name: 'stays.txt', mimeType: 'text/plain', buffer: Buffer.from(fileText) });
  await expect(composer).toContainText('stays.txt', { timeout: 15_000 });
  await expect.poll(async () => (await serverDrafts(ENT.alice, subject)).length, { timeout: 30_000 }).toBe(1);
  await expect.poll(async () => (await serverDrafts(ENT.alice, subject))[0]?.attachments.length ?? 0, { timeout: 30_000 }).toBe(1);
  const before = (await serverDrafts(ENT.alice, subject))[0];
  await page.waitForTimeout(2500);

  // The server goes, and this edit stays on the device.
  await blockMailServer(context);
  await composer.locator('[contenteditable="true"]').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' offline edit');
  await expect(composer.getByText('Saved on this device').first()).toBeVisible({ timeout: 60_000 });
  expect(await serverDrafts(ENT.alice, subject)).toHaveLength(1);

  // Back: the new version replaces the old one, and the old one's part dies with it.
  await context.unroute(`${new URL(JMAP_URL).origin}/**`);
  await expect.poll(async () => (await serverDrafts(ENT.alice, subject)).map((draft) => draft.id).join(), { timeout: 180_000, intervals: [2000] }).not.toBe(before.id);
  await expect.poll(async () => (await serverDrafts(ENT.alice, subject)).length, { timeout: 60_000 }).toBe(1);

  // The composer never closed. Saving again works, with the file.
  await composer.locator('[contenteditable="true"]').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' later edit');
  await expect(composer.getByTestId('composer-save-status').first()).toHaveAttribute('data-status', 'saved', { timeout: 30_000 });
  await expect.poll(async () => {
    const [draft] = await serverDrafts(ENT.alice, subject);
    return draft ? (await rawMessage(ENT.alice, draft.blobId)).includes('later edit') : false;
  }, { timeout: 30_000 }).toBe(true);
  const [saved] = await serverDrafts(ENT.alice, subject);
  expect(await rawMessage(ENT.alice, saved.attachments[0].blobId)).toContain(fileText);

  await send(page);
  await expect(composer).toBeHidden({ timeout: 30_000 });
  const got = await waitForMessage(ENT.bob, (m) => m.subject === subject);
  expect(await rawMessage(ENT.bob, got.blobId)).toContain('stays.txt');
  await expect.poll(async () => (await serverDrafts(ENT.alice, subject)).length, { timeout: 30_000 }).toBe(0);
  await context.close();
});

test('a draft whose answer got lost is on the server once, with the latest text', async ({ browser }) => {
  const subject = `Offline draft lost answer ${RUN}`;
  const page = await userPage(browser, ENT.alice);
  await enableOffline(page);
  await toMail(page);
  const context = page.context();
  const origin = `${new URL(JMAP_URL).origin}/**`;
  await blockMailServer(context);
  await waitUntilOffline(page);
  await compose(page, ENT.bob, subject, `Only one copy ${RUN}`);
  const composer = page.locator('[data-testid="email-composer"]');
  await expect(composer.getByText('Saved on this device').first()).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('composer-close').first().click();
  await expect(composer).toBeHidden({ timeout: 30_000 });

  // The server comes back and takes the draft, but its answer never arrives.
  let lost = 0;
  await context.unroute(origin);
  await context.route(origin, async (route) => {
    const body = route.request().postData() ?? '';
    if (lost === 0 && body.includes('Email/set') && body.includes(subject)) {
      lost += 1;
      await route.fetch();
      await route.abort('connectionreset');
      return;
    }
    await route.continue();
  });
  await expect.poll(() => lost, { timeout: 180_000 }).toBe(1);
  await expect.poll(async () => (await serverDrafts(ENT.alice, subject)).length, { timeout: 30_000 }).toBe(1);
  // Looked up by its Message-ID and found, on this server's own figures: no second copy.
  await expect(page.getByTestId('offline-banner-drafts-waiting')).toHaveCount(0, { timeout: 180_000 });
  await page.waitForTimeout(5000);
  expect(await serverDrafts(ENT.alice, subject)).toHaveLength(1);
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

/** Signed in, offline mode on, a message to bob waiting in the outbox with the mail server gone. */
async function unsentWithServerGone(browser: Browser, subject: string): Promise<Page> {
  const page = await userPage(browser, ENT.alice);
  await enableOffline(page);
  await toMail(page);
  await blockMailServer(page.context());
  await waitUntilOffline(page);
  await compose(page, ENT.bob, subject, 'Waiting at idle');
  await send(page);
  await expect(page.getByTestId('offline-banner-outbox')).toHaveText('1 message in the outbox', { timeout: 30_000 });
  return page;
}

const IDLE = { idleMinutes: 1, maxHours: 0, warnSeconds: 30 };

test('the idle sign-out keeps unsent mail for the next sign-in, which sends it', async ({ browser }) => {
  test.setTimeout(420_000);
  const subject = `Unsent at idle ${RUN}`;
  await setPolicy(browser, { organisation: { session: IDLE } });
  const page = await unsentWithServerGone(browser, subject);

  // Left alone for the minute: signed out, the mail hidden but kept. The
  // sign-in page gives a count and a date only, since whoever reads it may
  // not be the one who wrote it.
  const waiting = page.getByTestId('login-refused-waiting');
  await expect(waiting).toContainText('1 unsent message waits for you to sign in again', { timeout: 150_000 });
  await shot(page, 'f-idle-waiting');
  await expect(waiting).not.toContainText(subject);
  await expect(page.getByTestId('session-outbox-lost')).toHaveCount(0);
  expect(await offlineDatabaseExists(page)).toBe(true);
  expect((await messages(ENT.bob, RUN)).filter((m) => m.subject === subject)).toHaveLength(0);

  // Signing in again brings it back, and with the server there it goes out, once.
  await setPolicy(browser, {});
  await page.context().unroute(`${new URL(JMAP_URL).origin}/**`);
  await page.fill('#username', ENT.alice);
  await page.fill('#password', process.env.IT_ENT_PASSWORD ?? '');
  await page.click('button[type="submit"]');
  await expect(accountSwitcher(page)).toBeVisible({ timeout: 60_000 });
  await waitForMessage(ENT.bob, (m) => m.subject === subject, 120_000);
  await page.waitForTimeout(5_000);
  expect((await messages(ENT.bob, RUN)).filter((m) => m.subject === subject)).toHaveLength(1);
  await page.context().close();
});

test('with immediate deletion the idle sign-out wipes the device and the login page names the lost message', async ({ browser }) => {
  test.setTimeout(360_000);
  const subject = `Lost at idle ${RUN}`;
  const devices = ((original.organisation as { devices?: object } | undefined)?.devices) ?? {};
  await setPolicy(browser, { organisation: { session: IDLE, devices: { ...devices, wipeOnForcedSignOut: true } } });
  const page = await unsentWithServerGone(browser, subject);
  expect((await offlineDatabase(page)).accounts).toBeGreaterThan(0);

  // Left alone for the minute.
  await expect(page.getByTestId('session-outbox-lost')).toContainText(subject, { timeout: 150_000 });
  await shot(page, 'f-idle-lost');
  // The account's own data goes, its key with it, so nothing kept can be read.
  // Shared databases stay, as for any deletion after a forced sign-out.
  await expect.poll(async () => (await offlineDatabase(page)).accounts, { timeout: 20_000 }).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('bulwark-offline-accounts') ?? '[]')).not.toContain('ent-alice');
  await expect.poll(() => shellCaches(page), { timeout: 20_000 }).toEqual([]);
  await expect(page.getByTestId('login-refused-waiting')).toHaveCount(0);
  await page.context().close();
  await setPolicy(browser, {});
  expect((await messages(ENT.bob, RUN)).filter((m) => m.subject === subject)).toHaveLength(0);
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
  const recent = `Recent message ${RUN}`;
  await importOld(ENT.alice, old, 200);
  await deliverAndWait(recent, `Recent body ${RUN}`);
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
  const search = async (term: string) => {
    const box = page.getByPlaceholder('Search mail').first();
    await box.fill(term);
    await box.press('Enter');
  };
  const rows = page.locator('[data-testid="email-list-item"]');
  // A word of a message that stayed finds it, so the search does work here.
  await search(recent);
  await expect(rows.filter({ hasText: recent }).first()).toBeVisible({ timeout: 30_000 });
  await search(old);
  await expect(rows.filter({ hasText: recent })).toHaveCount(0, { timeout: 30_000 });
  await expect(rows.filter({ hasText: old })).toHaveCount(0);
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
  // Scrolling happens in the pane, so the page's own width says nothing: nothing may reach past the screen.
  const section = phone.locator('[data-settings-section="offline"]');
  await expect(section).toBeVisible();
  const past = await section.evaluate((root) => {
    const width = document.documentElement.clientWidth;
    const out: string[] = [];
    for (const el of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
      const box = el.getBoundingClientRect();
      if (box.width > 0 && (box.right > width + 1 || box.left < -1)) out.push(`${el.tagName} ${el.getAttribute('data-testid') ?? ''} ${Math.round(box.right)}`);
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible' && getComputedStyle(el).overflowX !== 'hidden') out.push(`scrolls: ${el.tagName} ${el.className}`);
    }
    return out;
  });
  expect(past).toEqual([]);
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
  await expect(page.getByText("Offline mail on this device couldn't be read", { exact: false }).first()).toBeVisible();
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

/** A message with a text attachment of `size` bytes, repeating `term`, imported so the bytes stay as they are. */
async function importWithAttachment(account: string, subject: string, term: string, size: number): Promise<void> {
  const client = await jmapAs(account);
  const content = `${term} `.repeat(Math.ceil(size / (term.length + 1)));
  const boundary = `b${RUN}`;
  const raw = [
    `From: ${ENT.bob}`, `To: ${account}`, `Subject: ${subject}`, `Date: ${new Date().toUTCString()}`, `Message-ID: <${RUN}att@example.org>`, 'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`, 'Content-Type: text/plain', '', `See the file ${RUN}`, `--${boundary}`,
    'Content-Type: text/plain; name="kept.txt"', 'Content-Disposition: attachment; filename="kept.txt"', 'Content-Transfer-Encoding: 8bit', '', content, `--${boundary}--`, '',
  ].join('\r\n');
  const auth = 'Basic ' + Buffer.from(`${account}:${process.env.IT_ENT_PASSWORD}`).toString('base64');
  const upload = await fetch(`${JMAP_URL}/jmap/upload/${client.accountId}/`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'message/rfc822' }, body: raw });
  if (!upload.ok) throw new Error(`upload: ${upload.status}`);
  const { blobId } = await upload.json() as { blobId: string };
  const boxes = await client.request([['Mailbox/query', { accountId: client.accountId, filter: { role: 'inbox' } }, '0']]);
  const inbox = boxes.methodResponses[0][1].ids[0] as string;
  const done = await client.request([['Email/import', { accountId: client.accountId, emails: { a: { blobId, mailboxIds: { [inbox]: true }, keywords: {}, receivedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z') } } }, '0']]);
  if (!done.methodResponses[0][1].created?.a) throw new Error(`import: ${JSON.stringify(done.methodResponses[0][1])}`);
}

/** How many bytes of attachments the settings page says are kept, roughly: it's what the store counts. */
async function keptAttachmentBytes(page: Page): Promise<number> {
  const row = page.getByTestId('offline-usage').locator('[data-part="attachments"] dd');
  if ((await row.count()) === 0) return 0;
  const match = (await row.innerText()).replace(',', '.').match(/([\d.]+)\s*(B|KB|MB|GB)/);
  return match ? Number(match[1]) * { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[match[2] as 'B' | 'KB' | 'MB' | 'GB'] : 0;
}

test('nothing of a kept message is readable on the device', async ({ browser }) => {
  const subject = `Rawcheck ${RUN} ${RUN}quokka`;
  const text = `Rawbody ${RUN} ${RUN}wombat`;
  const inFile = `${RUN}platypus`;
  await deliverAndWait(subject, text);
  await importWithAttachment(ENT.alice, `Rawfile ${RUN}`, inFile, 300_000);
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
    // The default window: the old message of the cap test stays out.
    const after = new Date(Date.now() - 90 * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z');
    const total = await client.request([['Email/query', { accountId: client.accountId, filter: { after }, calculateTotal: true, limit: 0 }, '0']]);
    expect(await keptMessages(page)).toBeGreaterThanOrEqual(total.methodResponses[0][1].total);
  }).toPass({ timeout: 180_000, intervals: [2000] });
  await toMail(page);
  await openMessage(page, subject);
  await expect(body(page)).toContainText(text, { timeout: 20_000 });
  await page.waitForTimeout(1500);

  // The file has to be on the device for this to say anything: 300 KB of it.
  await page.goto('/settings/backup/offline');
  await expect.poll(() => keptAttachmentBytes(page), { timeout: 180_000, intervals: [2000] }).toBeGreaterThan(300_000);
  for (const term of [subject, text, `${RUN}quokka`, `${RUN}wombat`, inFile]) {
    const { hits, files, bytesRead } = await findIn(term);
    expect(files, 'the store has its files').toBeGreaterThan(0);
    expect(bytesRead, 'and they hold something').toBeGreaterThan(100_000);
    expect(hits, `plaintext "${term}"`).toEqual([]);
  }
  await page.goto('/mail');
  await expect(page.locator('[data-testid="email-list-item"]', { hasText: subject }).first()).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  expect((await findIn(subject)).hits).toEqual([]);
  await page.context().close();
});

test('Keep offline in the Files app keeps the file, and the settings list it', async ({ browser }) => {
  const name = `kept-${RUN}.txt`;
  const client = await jmapAs(ENT.alice);
  const auth = 'Basic ' + Buffer.from(`${ENT.alice}:${process.env.IT_ENT_PASSWORD}`).toString('base64');
  const upload = await fetch(`${JMAP_URL}/jmap/upload/${client.accountId}/`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'text/plain' }, body: `Kept file ${RUN}` });
  expect(upload.ok).toBe(true);
  const { blobId } = await upload.json() as { blobId: string };
  const made = await client.request([['FileNode/set', { accountId: client.accountId, create: { f: { name, blobId, parentId: null, type: 'text/plain' } } }, '0']], ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:filenode']);
  const created = made.methodResponses[0][1].created?.f as { id: string } | undefined;
  expect(created, JSON.stringify(made.methodResponses[0][1])).toBeTruthy();
  try {
    const page = await userPage(browser, ENT.alice);
    await enableOffline(page);
    await page.goto('/files');
    const row = page.getByText(name, { exact: true }).first();
    await expect(row).toBeVisible({ timeout: 60_000 });
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Keep offline' }).click();
    await page.goto('/settings/backup/offline');
    await expect(page.getByTestId('offline-kept-file').filter({ hasText: name })).toHaveAttribute('data-kept', 'true', { timeout: 120_000 });
    await page.getByTestId('offline-kept-files').scrollIntoViewIfNeeded();
    await shot(page, 'do-storage-page-kept-files');

    await page.goto('/files');
    await expect(row).toBeVisible({ timeout: 60_000 });
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Stop keeping offline' }).click();
    await page.goto('/settings/backup/offline');
    await expect(page.getByTestId('offline-account')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('offline-kept-file').filter({ hasText: name })).toHaveCount(0, { timeout: 30_000 });
    await page.context().close();
  } finally {
    await client.request([['FileNode/set', { accountId: client.accountId, destroy: [created!.id] }, '0']], ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:filenode']).catch(() => {});
  }
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
