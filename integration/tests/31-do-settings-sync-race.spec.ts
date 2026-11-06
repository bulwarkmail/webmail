/**
 * Settings sync and a reload right after a change, in a real browser on a production
 * build. The change was written locally at once but pushed two seconds later; a reload
 * inside those two seconds lost the push, and the next load put the older server copy
 * back. Now the pending push goes out as the page goes, a change whose push still got
 * lost is kept and sent on the next load, and a later change on another device wins.
 *
 * Runs as dso-ux-settings@example.org (seeded by ~/desktop-offline/dso_ux_settings_provision.py
 * on the VM; check it there first), with IT_DSO_PASSWORD from the vault item
 * "Stalwart test – dso-* throwaway accounts", through desktop-offline-rig/run-spec.sh,
 * against a rig with settings sync on. The setting is put back at the end.
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { requireEntEnv } from './helpers/ent';
import { neutralizeDevOverlay } from './helpers/app';
import { WEBMAIL_URL } from './helpers/config';

requireEntEnv();
test.setTimeout(300_000);
test.use({ actionTimeout: 30_000 });
test.describe.configure({ mode: 'serial' });

const USER = 'dso-ux-settings@example.org';
const PASSWORD = process.env.IT_DSO_PASSWORD ?? '';
if (!PASSWORD) throw new Error('Set IT_DSO_PASSWORD, and check the account on the VM first: see the top of this file');

const LABEL = 'Confirm before deleting several messages';

interface Device {
  page: Page;
  /** The identity headers the app itself sends when it loads its settings. */
  identity: Promise<Record<string, string>>;
}

const isSettingsLoad = (url: string, method: string) => url.includes('/api/settings') && method === 'GET';
const isSettingsPush = (url: string, method: string) => url.includes('/api/settings') && method === 'POST';

async function signedIn(browser: Browser): Promise<Device> {
  const context = await browser.newContext({ baseURL: WEBMAIL_URL, locale: 'en-US', viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  await neutralizeDevOverlay(page);
  const identity = new Promise<Record<string, string>>((resolve) => {
    page.on('request', (request) => {
      const headers = request.headers();
      if (isSettingsLoad(request.url(), request.method()) && headers['x-settings-username']) {
        resolve({ 'x-settings-username': headers['x-settings-username'], 'x-settings-server': headers['x-settings-server'] });
      }
    });
  });
  await page.goto('/login');
  await page.fill('#username', USER);
  await page.fill('#password', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 60_000 });
  return { page, identity };
}

/** The account's settings copy on the server, read with the device's cookies. */
async function serverCopy(device: Device): Promise<Record<string, unknown>> {
  const headers = await device.identity;
  const res = await device.page.context().request.get(new URL('/api/settings', WEBMAIL_URL).toString(), { headers });
  return ((await res.json()) as { settings: Record<string, unknown> | null }).settings ?? {};
}

/** Runs `load` (a goto or a reload) and waits until the app has read and applied its server copy. */
async function loaded(page: Page, load: () => Promise<unknown>) {
  const read = page.waitForResponse((r) => isSettingsLoad(r.url(), r.request().method()), { timeout: 90_000 });
  await load();
  await read;
  const toggle = page.getByRole('switch', { name: LABEL });
  await expect(toggle).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(500);
  return toggle;
}

const openSetting = (page: Page) => loaded(page, () => page.goto('/settings/message_list'));

async function isOn(page: Page): Promise<boolean> {
  return (await page.getByRole('switch', { name: LABEL }).getAttribute('aria-checked')) === 'true';
}

async function waitForServer(device: Device, value: boolean) {
  await expect.poll(async () => (await serverCopy(device)).confirmBulkDelete, { timeout: 20_000 }).toBe(value);
}

/**
 * The tab goes with the push still waiting and runs no more script (as when
 * it's killed: no pagehide, nothing sent), and the app is opened again in the
 * same browser profile.
 */
async function crashAndReopen(device: Device): Promise<Page> {
  const context = device.page.context();
  const cdp = await context.newCDPSession(device.page);
  await cdp.send('Emulation.setScriptExecutionDisabled', { value: true });
  await device.page.close();
  const page = await context.newPage();
  await neutralizeDevOverlay(page);
  device.page = page;
  return page;
}

let original: boolean | null = null;

test('a change followed at once by a reload stays, and reaches the server', async ({ browser }) => {
  const device = await signedIn(browser);
  const { page } = device;
  const toggle = await openSetting(page);
  original = await isOn(page);
  const changed = !original;

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', String(changed));
  // Well inside the two-second debounce.
  await loaded(page, () => page.reload());
  expect(await isOn(page)).toBe(changed);
  await waitForServer(device, changed);
  await page.context().close();
});

test('a change whose push was lost is kept on the next load and sent then', async ({ browser }) => {
  const device = await signedIn(browser);
  const { page } = device;
  const toggle = await openSetting(page);
  const before = await isOn(page);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', String(!before));
  const next = await crashAndReopen(device);
  // The push never went out: the server copy still has the old value.
  expect((await serverCopy(device)).confirmBulkDelete).toBe(before);

  await openSetting(next);
  expect(await isOn(next)).toBe(!before);
  await waitForServer(device, !before);
  await next.context().close();
});

test('a later change on another device wins for that setting', async ({ browser }) => {
  const first = await signedIn(browser);
  const toggle = await openSetting(first.page);
  const before = await isOn(first.page);

  // This device's push is lost; then the other device sets the same setting.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', String(!before));
  const next = await crashAndReopen(first);

  const second = await signedIn(browser);
  const other = await openSetting(second.page);
  expect(await isOn(second.page)).toBe(before);
  const pushed = second.page.waitForResponse((r) => isSettingsPush(r.url(), r.request().method()), { timeout: 20_000 });
  await other.click();
  await other.click();
  await expect(other).toHaveAttribute('aria-checked', String(before));
  expect((await pushed).ok()).toBe(true);
  await second.page.context().close();

  await openSetting(next);
  expect(await isOn(next)).toBe(before);
  await first.page.context().close();
});

test('a change made offline syncs when the connection is back', async ({ browser }) => {
  const device = await signedIn(browser);
  const { page } = device;
  const toggle = await openSetting(page);
  const before = await isOn(page);

  await page.context().setOffline(true);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', String(!before));
  // Past the debounce: the push fails without a connection.
  await page.waitForTimeout(3_000);
  await page.context().setOffline(false);
  await waitForServer(device, !before);
  await page.context().close();
});

test.afterAll(async ({ browser }) => {
  if (original === null) return;
  const device = await signedIn(browser);
  const toggle = await openSetting(device.page);
  if ((await isOn(device.page)) !== original) {
    await toggle.click();
    await waitForServer(device, original);
  }
  await device.page.context().close();
});
