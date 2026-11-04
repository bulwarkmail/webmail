/**
 * Usability pass 3, settings and sign-in, in a real browser on a production build:
 * the address handed to the sign-in page (login_hint), a second address on the same
 * domain reusing the first one's server, "Your name" saved when leaving the page, the
 * signature editor's short toolbar, Do not disturb on Notifications, and no second
 * Compose in the empty reading pane.
 *
 * Runs as dso-ux-settings and dso-ux-settings-b @example.org (seeded by
 * ~/desktop-offline/dso_ux_settings_provision.py on the VM; check them there first),
 * with IT_DSO_PASSWORD from the vault item "Stalwart test – dso-* throwaway accounts",
 * through desktop-offline-rig/run-spec.sh, against a rig started with
 * ALLOW_CUSTOM_JMAP_ENDPOINT=true. "Your name" is put back at the end.
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { requireEntEnv } from './helpers/ent';
import { neutralizeDevOverlay } from './helpers/app';
import { WEBMAIL_URL } from './helpers/config';

requireEntEnv();
test.setTimeout(300_000);
test.use({ actionTimeout: 30_000 });

const USER = 'dso-ux-settings@example.org';
const SECOND = 'dso-ux-settings-b@example.org';
const PASSWORD = process.env.IT_DSO_PASSWORD ?? '';
if (!PASSWORD) throw new Error('Set IT_DSO_PASSWORD, and check the accounts on the VM first: see the top of this file');

async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL: WEBMAIL_URL, locale: 'en-US', viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  await neutralizeDevOverlay(page);
  return page;
}

async function signedIn(browser: Browser): Promise<Page> {
  const page = await newPage(browser);
  await page.goto(`/login?login_hint=${encodeURIComponent(USER)}`);
  await expect(page.locator('#username')).toHaveValue(USER);
  // The address came along: the caret is in the password field.
  await expect(page.locator('#password')).toBeFocused();
  await page.fill('#password', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 60_000 });
  return page;
}

test('the sign-in page takes the address it is handed, and signs in with only the password typed', async ({ browser }) => {
  const page = await signedIn(browser);
  await expect(page.getByRole('navigation', { name: /folders/i }).first()).toBeVisible({ timeout: 60_000 });
  // No second Compose in the empty reading pane: the sidebar's is right there.
  await expect(page.getByText('No conversation selected')).toBeVisible();
  const pane = page.locator('main, [data-pane]').filter({ hasText: 'No conversation selected' }).last();
  await expect(pane.getByRole('button', { name: /^compose$/i })).toHaveCount(0);
  await page.context().close();
});

test('a second address on the same domain goes to the first one\'s server without a lookup', async ({ browser }) => {
  const page = await signedIn(browser);
  const lookups: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/auth/discover-server')) lookups.push(request.url());
  });
  await page.goto('/login?mode=add-account');
  await page.fill('#username', SECOND);
  await expect(page.getByTestId('login-server-found')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  expect(lookups).toEqual([]);
  // Change still offers another server.
  await page.getByTestId('login-server-change').click();
  await expect(page.locator('#jmap-endpoint')).toHaveValue(new URL(process.env.IT_JMAP_URL ?? 'https://x').host);
  await page.context().close();
});

test('Your name is saved when the page is left, with no Save button', async ({ browser }) => {
  const page = await signedIn(browser);
  await page.goto('/settings/account');
  const field = () => page.getByRole('textbox', { name: 'Your name' });
  await expect(field()).toBeVisible({ timeout: 30_000 });
  const before = await field().inputValue();
  await expect(page.getByRole('button', { name: /^save$/i })).toHaveCount(0);
  const changed = `${before || 'Sam'} P3`;
  const leaveAndComeBack = async () => {
    // As a person does it: straight to Security in the list, no Save, no Enter.
    await page.getByText('Security', { exact: true }).first().click();
    await page.waitForURL(/settings\/security/);
    await page.getByText('Account', { exact: true }).first().click();
    await expect(field()).toBeVisible({ timeout: 30_000 });
  };
  try {
    await field().fill(changed);
    await leaveAndComeBack();
    await expect(field()).toHaveValue(changed, { timeout: 30_000 });
    // And after a reload, so it's the server's copy and not the page's.
    await page.reload();
    await expect(field()).toHaveValue(changed, { timeout: 30_000 });
  } finally {
    if ((await field().inputValue()) !== before) {
      await field().fill(before);
      await field().press('Enter');
      await expect(page.getByText('Your name is saved.')).toBeVisible({ timeout: 15_000 });
    }
  }
  await page.context().close();
});

test('the signature editor has the short toolbar and a Picture button', async ({ browser }) => {
  const page = await signedIn(browser);
  await page.goto('/settings/composing');
  const toolbar = page.getByRole('toolbar', { name: /formatting/i }).first();
  await expect(toolbar).toBeVisible({ timeout: 30_000 });
  const items = await toolbar.locator('[data-toolbar-item]').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.toolbarItem));
  expect(items).toEqual(['bold', 'italic', 'underline', 'bullet-list', 'ordered-list', 'link', 'picture']);
  await page.context().close();
});

test('Notifications starts with Do not disturb', async ({ browser }) => {
  const page = await signedIn(browser);
  await page.goto('/settings/notifications');
  await expect(page.getByText('Pause notifications').first()).toBeVisible({ timeout: 30_000 });
  await page.goto('/settings/accessibility');
  await expect(page.getByRole('switch', { name: /pause notifications|do not disturb/i })).toHaveCount(0);
  await page.context().close();
});
