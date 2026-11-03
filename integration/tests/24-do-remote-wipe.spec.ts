import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { ENT, ENT_PASSWORD, adminContext, contextOptions, deliver, requireEntEnv, shot, userPage } from './helpers/ent';
import { JMAP_URL } from './helpers/config';

/**
 * Remote wipe, through the real UI on a production build, on both VM 106
 * Stalwarts, with the ent-* accounts:
 * - a browser with offline on registers; the admin wipes it from
 *   Organisation > Devices; at its next connect the raw OPFS files, the key
 *   database, plugin databases and the handoff cache are gone, sign-in is
 *   required, the login page gives the count of lost mail, the instance has the
 *   confirmation and the audit log has both entries;
 * - at a start the wipe comes before anything from the device is shown;
 * - with the instance out of reach mail stays and the wipe keeps waiting, and it
 *   happens once the device is back;
 * - "Remove everything from this device" in settings.
 */

test.describe.configure({ mode: 'serial' });
test.setTimeout(300_000);

const RUN = Date.now().toString(36);

interface Device {
  id: string;
  user: string;
  platform: string;
  firstSeen: string;
  wipe: { requestedAt: string } | null;
  wipedAt: string | null;
  wipeReason: string | null;
}

async function devicesOf(admin: BrowserContext, email: string): Promise<Device[]> {
  const res = await admin.request.get(`/api/admin/devices?q=${encodeURIComponent(email)}`);
  expect(res.ok(), `listing devices: ${res.status()}`).toBe(true);
  return (await res.json() as { devices: Device[] }).devices;
}

/** Rows earlier runs left. */
async function forgetDevices(admin: BrowserContext, email: string): Promise<void> {
  for (const device of await devicesOf(admin, email)) {
    const res = await admin.request.post('/api/admin/devices', { data: { action: 'forget', id: device.id } });
    expect(res.ok()).toBe(true);
  }
}

async function theDevice(admin: BrowserContext, email: string): Promise<Device> {
  let found: Device | undefined;
  await expect.poll(async () => {
    found = (await devicesOf(admin, email))[0];
    return found?.id ?? '';
  }, { timeout: 60_000, message: `${email} registers` }).not.toBe('');
  return found!;
}

async function adminWipe(admin: BrowserContext, id: string): Promise<void> {
  const res = await admin.request.post('/api/admin/devices', { data: { action: 'wipe', id } });
  expect(res.ok()).toBe(true);
}

async function enableOffline(page: Page): Promise<void> {
  await page.goto('/settings/backup/offline');
  const toggle = page.getByTestId('offline-switch');
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('offline-status')).toContainText('updated', { timeout: 180_000 });
}

async function toMail(page: Page, subject: string): Promise<void> {
  await page.goto('/mail');
  await expect(page.locator('[data-testid="email-list-item"]', { hasText: subject }).first()).toBeVisible({ timeout: 60_000 });
}

async function seedMail(to: string, subject: string): Promise<void> {
  await deliver({ from: ENT.bob, to: [to], subject, text: `Body of ${subject}` });
}

/** What's in the browser's storage for this origin, read raw, opening nothing that would create it. */
async function rawStorage(page: Page): Promise<{ databases: string[]; storeFiles: string[]; caches: string[]; keyRecords: number }> {
  return page.evaluate(async () => {
    const databases = (await indexedDB.databases()).map((database) => database.name ?? '');
    const storeFiles: string[] = [];
    const root = await navigator.storage.getDirectory();
    const list = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
      for await (const handle of (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
        if (handle.kind === 'directory') await list(handle as FileSystemDirectoryHandle, `${prefix}${handle.name}/`);
        else storeFiles.push(`${prefix}${handle.name}`);
      }
    };
    await list(root, '');
    let keyRecords = 0;
    if (databases.includes('bulwark-store')) {
      keyRecords = await new Promise<number>((resolve) => {
        const open = indexedDB.open('bulwark-store');
        open.onerror = () => resolve(-1);
        open.onsuccess = () => {
          const db = open.result;
          const count = db.transaction('accounts').objectStore('accounts').count();
          count.onsuccess = () => { db.close(); resolve(count.result); };
          count.onerror = () => { db.close(); resolve(-1); };
        };
      });
    }
    return { databases, storeFiles, caches: await caches.keys(), keyRecords };
  });
}

async function expectStoreGone(page: Page): Promise<void> {
  await expect.poll(async () => {
    const raw = await rawStorage(page);
    return {
      keys: raw.keyRecords,
      store: raw.databases.includes('bulwark-store'),
      legacy: raw.databases.includes('bulwark-offline'),
      files: raw.storeFiles,
    };
  }, { timeout: 30_000, message: 'nothing of the store is left' }).toEqual({ keys: 0, store: false, legacy: false, files: [] });
}

async function expectSignedOut(page: Page): Promise<void> {
  await expect(page.locator('#username')).toBeVisible({ timeout: 60_000 });
  const cookies = (await page.context().cookies()).map((cookie) => cookie.name);
  expect(cookies.filter((name) => /^jmap_(session|stalwart_ctx|rt|at)/.test(name))).toEqual([]);
  // And it stays that way.
  await page.reload();
  await expect(page.locator('#username')).toBeVisible({ timeout: 60_000 });
}

test.beforeAll(() => {
  requireEntEnv();
});

test('the admin wipes a device: at its next connect everything on it goes, and the instance hears', async ({ browser }) => {
  const subject = `Wipe me ${RUN}`;
  const unsent = `Unsent secret ${RUN}`;
  const admin = await adminContext(browser);
  await forgetDevices(admin, ENT.dave);
  await forgetDevices(admin, ENT.alice);
  await seedMail(ENT.dave, subject);

  // A second user, so the page shows what an admin really sees.
  const other = await userPage(browser, ENT.alice);
  await enableOffline(other);
  const otherDevice = await theDevice(admin, ENT.alice);

  const page = await userPage(browser, ENT.dave);
  await enableOffline(page);
  await toMail(page, subject);
  const device = await theDevice(admin, ENT.dave);
  expect(device.user).toBe(ENT.dave);
  expect(device.platform).toContain('Chrom');
  expect(device.wipe).toBeNull();

  const before = await rawStorage(page);
  expect(before.keyRecords).toBe(1);
  expect(before.storeFiles.length).toBeGreaterThan(0);

  // What plugins and the launch handoff would have left.
  await page.evaluate(async (run) => {
    for (const name of ['smime-plugin-store', 'bulwark-openpgp', `plugin-made-${run}`]) {
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(name, 1);
        open.onupgradeneeded = () => { open.result.createObjectStore('keys'); };
        open.onsuccess = () => { open.result.close(); resolve(); };
        open.onerror = () => reject(open.error);
      });
    }
    const cache = await caches.open('bulwark-launch-handoff-v1');
    await cache.put('/handoff-test', new Response('secret file'));
  }, RUN);

  // A message waits in the outbox, so the note has something to count.
  await page.context().setOffline(true);
  await page.keyboard.press('c');
  const composer = page.locator('[data-testid="email-composer"]');
  await composer.waitFor({ state: 'visible', timeout: 15_000 });
  const to = page.locator('[data-testid="composer-to"] input').first();
  await to.click();
  await to.fill(ENT.bob);
  await to.press('Enter');
  await page.locator('[data-testid="composer-subject"]').first().fill(unsent);
  await composer.locator('[contenteditable="true"]').first().click();
  await page.keyboard.type('Never sent');
  await page.locator('[data-testid="composer-subject"]').first().focus();
  await page.keyboard.press('Control+Enter');
  await expect(page.getByTestId('offline-banner-outbox')).toHaveText('1 message in the outbox', { timeout: 30_000 });

  // The admin's side, through the page.
  const adminPage = await admin.newPage();
  await adminPage.goto('/admin/org-devices');
  const section = adminPage.locator('[data-user="ent-dave@example.org"]');
  await expect(section.getByTestId('device-row')).toBeVisible({ timeout: 30_000 });
  await expect(adminPage.locator('[data-user="ent-alice@example.org"]').getByTestId('device-row')).toBeVisible();
  await section.scrollIntoViewIfNeeded();
  await shot(adminPage, 'desktop-offline-admin-devices');
  await section.getByTestId('device-wipe').click();
  await expect(adminPage.getByRole('dialog').or(adminPage.getByRole('alertdialog')).first()).toContainText('imported in that browser or app go for every account');
  await adminPage.getByRole('button', { name: 'Wipe', exact: true }).last().click();
  await expect(section.getByTestId('device-row')).toContainText('Wipe waiting', { timeout: 15_000 });
  await shot(adminPage, 'desktop-offline-admin-devices-waiting');
  expect((await devicesOf(admin, ENT.dave))[0].wipe).not.toBeNull();

  // Back on the network, with the mail server gone: the word comes from the
  // instance and needs nothing of the mail server. The outbox can't leave either.
  await page.context().route(`${new URL(JMAP_URL).origin}/**`, (route) => route.abort('internetdisconnected'));
  await page.context().setOffline(false);

  await expect(page.locator('#username')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('device-wipe-note')).toContainText('Unsent messages deleted: 1');
  expect(await page.getByTestId('device-wipe-note').textContent()).not.toContain(unsent);

  await expectStoreGone(page);
  const raw = await rawStorage(page);
  expect(raw.databases).not.toContain('smime-plugin-store');
  expect(raw.databases).not.toContain('bulwark-openpgp');
  expect(raw.databases).not.toContain(`plugin-made-${RUN}`);
  expect(raw.caches).not.toContain('bulwark-launch-handoff-v1');
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(stored).not.toContain(unsent);
  await page.context().unroute(`${new URL(JMAP_URL).origin}/**`);

  await expectSignedOut(page);

  // The note shows once.
  await expect(page.getByTestId('device-wipe-note')).toHaveCount(0);

  const confirmed = (await devicesOf(admin, ENT.dave))[0];
  expect(confirmed.id).toBe(device.id);
  expect(confirmed.wipe).toBeNull();
  expect(confirmed.wipedAt).not.toBeNull();
  expect(confirmed.wipeReason).toBe('admin');

  // The other user's row isn't touched.
  expect((await devicesOf(admin, ENT.alice)).find((row) => row.id === otherDevice.id)?.wipe).toBeNull();

  const audit = async (action: string) => {
    const res = await admin.request.get(`/api/admin/audit?action=${action}&limit=50`);
    expect(res.ok()).toBe(true);
    return (await res.json() as { entries: Array<{ detail: Record<string, unknown> }> }).entries.filter((entry) => entry.detail.device === device.id);
  };
  expect(await audit('device.wipe.request')).toHaveLength(1);
  const confirmations = await audit('device.wipe.confirm');
  expect(confirmations).toHaveLength(1);
  expect(confirmations[0].detail).toMatchObject({ user: ENT.dave, reason: 'admin', unsentDeleted: 1 });

  await adminPage.reload();
  await expect(adminPage.locator('[data-user="ent-dave@example.org"]').getByTestId('device-row')).toContainText('Wiped', { timeout: 30_000 });

  // A new sign-in is a new device.
  await page.fill('#username', ENT.dave);
  await page.fill('#password', ENT_PASSWORD);
  await page.click('button[type="submit"]');
  await expect(page.locator('#username')).toBeHidden({ timeout: 60_000 });
  await enableOffline(page);
  await expect.poll(async () => (await devicesOf(admin, ENT.dave)).length, { timeout: 60_000 }).toBe(2);

  await Promise.all([page.context().close(), other.context().close(), admin.close()]);
});

test('at a start, the wipe comes before anything from the device is shown', async ({ browser }) => {
  const subject = `Start wipe ${RUN}`;
  const admin = await adminContext(browser);
  await forgetDevices(admin, ENT.alice);
  await seedMail(ENT.alice, subject);
  const page = await userPage(browser, ENT.alice);
  await enableOffline(page);
  await toMail(page, subject);
  const device = await theDevice(admin, ENT.alice);
  const context = page.context();

  // The mail was on screen here a moment ago, and comes from the device at a start.
  await context.addInitScript(() => {
    const look = () => {
      if (document.querySelector('[data-testid="email-list-item"]')) sessionStorage.setItem('wipe-test-saw-mail', 'yes');
    };
    new MutationObserver(look).observe(document, { childList: true, subtree: true });
  });
  await page.close();
  await adminWipe(admin, device.id);

  const next = await context.newPage();
  await next.goto('/mail');
  await expect(next.locator('#username')).toBeVisible({ timeout: 60_000 });
  expect(await next.evaluate(() => sessionStorage.getItem('wipe-test-saw-mail'))).toBeNull();
  await expect(next.getByTestId('device-wipe-note')).toContainText('removed this account');
  await expectStoreGone(next);
  await expect.poll(async () => (await devicesOf(admin, ENT.alice))[0].wipedAt, { timeout: 30_000 }).not.toBeNull();

  await Promise.all([context.close(), admin.close()]);
});

test('with the instance out of reach the mail stays and the wipe waits, until the device is back', async ({ browser }) => {
  const subject = `Waits ${RUN}`;
  const admin = await adminContext(browser);
  await forgetDevices(admin, ENT.carol);
  await seedMail(ENT.carol, subject);
  const page = await userPage(browser, ENT.carol);
  await enableOffline(page);
  await toMail(page, subject);
  const device = await theDevice(admin, ENT.carol);
  await adminWipe(admin, device.id);

  // A start with no network at all: the local copy, as ever.
  await page.context().setOffline(true);
  await page.reload();
  await expect(page.locator('[data-testid="email-list-item"]', { hasText: subject }).first()).toBeVisible({ timeout: 60_000 });
  expect((await rawStorage(page)).keyRecords).toBe(1);

  // The device never got the message, and the row keeps saying so.
  const waiting = (await devicesOf(admin, ENT.carol))[0];
  expect(waiting.wipe).not.toBeNull();
  expect(waiting.wipedAt).toBeNull();

  await page.context().setOffline(false);
  await expect(page.locator('#username')).toBeVisible({ timeout: 90_000 });
  await expectStoreGone(page);
  await expect.poll(async () => (await devicesOf(admin, ENT.carol))[0].wipedAt, { timeout: 30_000 }).not.toBeNull();

  await Promise.all([page.context().close(), admin.close()]);
});

test('the user removes everything from this device, from settings', async ({ browser }) => {
  const admin = await adminContext(browser);
  await forgetDevices(admin, ENT.bob);
  const page = await userPage(browser, ENT.bob);
  // Switched on and no more: this account has a lot of mail, so the wipe lands in
  // the middle of its first sync, with the worker busy writing.
  await page.goto('/settings/backup/offline');
  const toggle = page.getByTestId('offline-switch');
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => (await rawStorage(page)).keyRecords, { timeout: 60_000 }).toBe(1);
  await expect(page.getByTestId('offline-status')).toBeVisible({ timeout: 30_000 });
  const device = await theDevice(admin, ENT.bob);

  await page.getByTestId('wipe-device-button').scrollIntoViewIfNeeded();
  await page.getByTestId('wipe-device-button').click();
  const details = page.getByTestId('wipe-device-details');
  await expect(details).toContainText('S/MIME and OpenPGP keys');
  await expect(details).toContainText('All accounts are signed out');
  await shot(page, 'desktop-offline-remove-everything');
  // Nothing has happened yet.
  expect((await rawStorage(page)).keyRecords).toBe(1);
  await page.getByRole('button', { name: 'Remove everything', exact: true }).last().click();

  await expect(page.locator('#username')).toBeVisible({ timeout: 60_000 });
  await expectStoreGone(page);
  await expectSignedOut(page);
  await expect.poll(async () => (await devicesOf(admin, ENT.bob)).find((row) => row.id === device.id)?.wipeReason, { timeout: 30_000 }).toBe('user');

  await Promise.all([page.context().close(), admin.close()]);
});

test('the sign-in page says what waits for a new password, in numbers', async ({ browser }) => {
  const context = await browser.newContext(contextOptions());
  const page = await context.newPage();
  await page.goto('/login');
  await expect(page.locator('#username')).toBeVisible({ timeout: 30_000 });
  const at = Date.now();
  await page.evaluate((now) => {
    localStorage.setItem('bulwark-offline-evicted', JSON.stringify({ 'someone@example.org': now }));
    localStorage.setItem('bulwark-credentials-refused', JSON.stringify({ 'someone@example.org': { at: now, unsent: 3, certain: true } }));
  }, at);
  await page.reload();
  const note = page.getByTestId('login-refused-waiting');
  await expect(note).toBeVisible({ timeout: 30_000 });
  await expect(note).toContainText('3 unsent messages wait for your new password');
  await expect(note).not.toContainText('someone');
  await context.close();
});

test('an account without offline mode has no row', async ({ browser }) => {
  const admin = await adminContext(browser);
  await forgetDevices(admin, ENT.carol);
  const page = await userPage(browser, ENT.carol);
  await page.waitForTimeout(3_000);
  expect(await devicesOf(admin, ENT.carol)).toEqual([]);
  await Promise.all([page.context().close(), admin.close()]);
});
