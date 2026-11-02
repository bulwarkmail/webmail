import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { ENT, ENT_PASSWORD, adminContext, contextOptions, getPolicy, putPolicy, requireEntEnv, shot, userPage } from './helpers/ent';

/**
 * Proofreading (#1397) through the real UI, with a checker plugin that
 * answers from two fixed rules (integration/fixtures/proofreading-checker),
 * so this tests the host: underlines, the popup, the keyboard, the issue
 * list, plain text, the send warning and the admin's "required".
 *
 * The rig, from one shell (no extra variables: the checker needs no proxy):
 *   BUILD=1 bash enterprise-rig/start-prod.sh <worktree> 3105 <jmap-url> pr-1.0
 *   bash enterprise-rig/run-spec.sh <worktree> 3105 <jmap-url> 1.0 integration/tests/23-proofreading.spec.ts
 */

test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

const ID = 'it-proofreading-checker';
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'proofreading-checker');
const GERMAN = 'Ich habe gestern dem Brief geschrieben.';

let original: Record<string, unknown>;
/** The policy this spec runs with: the original, with plugins on. */
let base: Record<string, unknown>;

async function pluginZip(): Promise<Buffer> {
  const zip = new JSZip();
  for (const file of ['manifest.json', 'index.js']) zip.file(file, readFileSync(path.join(FIXTURE, file)));
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function install(admin: BrowserContext): Promise<void> {
  await admin.request.delete('/api/admin/plugins', { data: { id: ID } });
  const res = await admin.request.post('/api/admin/plugins', {
    multipart: { file: { name: `${ID}.zip`, mimeType: 'application/zip', buffer: await pluginZip() } },
  });
  expect(res.ok(), await res.text()).toBe(true);
  const on = await admin.request.patch('/api/admin/plugins', { data: { id: ID, enabled: true, forceEnabled: true } });
  expect(on.ok(), await on.text()).toBe(true);
}

async function setPolicy(browser: Browser, patch: Record<string, unknown>): Promise<void> {
  const admin = await adminContext(browser);
  await putPolicy(admin, { ...base, ...patch });
  await admin.close();
}

const editor = (page: Page) => page.locator('[data-testid="email-composer"] [contenteditable="true"]').first();
const status = (page: Page) => page.getByTestId('proofreading-status').first();
const popup = (page: Page) => page.getByTestId('proofreading-popup');
const underline = (page: Page, word: string) => page.locator('[data-text-issue]', { hasText: word }).first();

async function openComposer(page: Page, text: string): Promise<void> {
  await page.keyboard.press('c');
  await page.locator('[data-testid="email-composer"]').waitFor({ state: 'visible', timeout: 15_000 });
  // A new message puts the focus in To a moment after it opens.
  await expect(page.locator('[data-testid="composer-to"] input').first()).toBeFocused({ timeout: 10_000 }).catch(() => {});
  await page.locator('[data-testid="composer-subject"]').first().fill(`Proofreading ${Date.now().toString(36)}`);
  await editor(page).click();
  await page.keyboard.type(text);
}

/** Proofreading on for this user: through the status control, as a user would. */
async function turnOn(page: Page): Promise<void> {
  await expect(status(page)).toBeVisible({ timeout: 30_000 });
  if ((await status(page).textContent())?.includes('off')) {
    await status(page).click();
    await page.getByTestId('proofreading-turn-on').click();
    await page.keyboard.press('Escape');
  }
}

async function closeComposer(page: Page): Promise<void> {
  await page.getByTestId('composer-discard').first().click().catch(() => {});
  const confirm = page.getByRole('alertdialog');
  if (await confirm.isVisible().catch(() => false)) await confirm.getByRole('button').last().click();
}

test.beforeAll(async ({ browser }) => {
  requireEntEnv();
  const admin = await adminContext(browser);
  original = await getPolicy(admin);
  // A fresh rig has plugins turned off.
  base = { ...original, features: { ...(original.features as object), pluginsEnabled: true } };
  await putPolicy(admin, base);
  await install(admin);
  await admin.close();
});

test.afterAll(async ({ browser }) => {
  const admin = await adminContext(browser);
  await putPolicy(admin, original);
  await admin.request.delete('/api/admin/plugins', { data: { id: ID } });
  await admin.close();
});

test('underlines a mistake, fixes it with the mouse, and Ctrl+Z takes it back', async ({ browser }) => {
  const page = await userPage(browser, ENT.alice);
  await openComposer(page, GERMAN);
  await turnOn(page);
  // Turned on from the status control, which said what is sent where: no second notice.
  await expect(page.getByTestId('proofreading-notice')).toHaveCount(0);

  const dem = underline(page, 'dem');
  await expect(dem).toBeVisible({ timeout: 15_000 });
  await expect(dem).toHaveClass(/text-issue-grammar/);
  // The browser's own spell check steps back while the checker checks spelling.
  await expect(editor(page)).toHaveAttribute('spellcheck', 'false');
  await expect(status(page)).toContainText('1 issue');

  await dem.click();
  await expect(popup(page)).toBeVisible();
  await expect(popup(page)).toContainText('Use the accusative');
  await shot(page, 'proofreading-popup-light');
  await popup(page).getByRole('button', { name: 'Replace with den' }).click();
  await expect(editor(page)).toContainText('Ich habe gestern den Brief geschrieben.');
  await expect(popup(page)).toBeHidden();

  await page.keyboard.press('Control+z');
  await expect(editor(page)).toContainText('Ich habe gestern dem Brief geschrieben.');
  await closeComposer(page);
  await page.context().close();
});

test('fixes a mistake with the keyboard only', async ({ browser }) => {
  const page = await userPage(browser, ENT.alice);
  await openComposer(page, 'Thanks for teh offer.');
  await turnOn(page);
  await expect(underline(page, 'teh')).toBeVisible({ timeout: 15_000 });
  await editor(page).press('Control+Home');
  await page.keyboard.press("Control+'");
  await expect(popup(page)).toBeVisible();
  // The first suggestion has the focus; Enter takes it.
  await expect(popup(page).getByRole('button', { name: 'Replace with the' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(editor(page)).toContainText('Thanks for the offer.');
  await expect(editor(page)).toBeFocused();
  // Escape closes the popup without closing the composer.
  await page.keyboard.type(' And teh rest.');
  await expect(underline(page, 'teh')).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Control+'");
  await expect(popup(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popup(page)).toBeHidden();
  await expect(page.locator('[data-testid="email-composer"]')).toBeVisible();
  await closeComposer(page);
  await page.context().close();
});

test('a right-click on an underline opens its popup, and the issue list jumps to the text', async ({ browser }) => {
  const page = await userPage(browser, ENT.alice);
  await openComposer(page, GERMAN);
  await turnOn(page);
  await expect(underline(page, 'dem')).toBeVisible({ timeout: 15_000 });
  await underline(page, 'dem').click({ button: 'right' });
  await expect(popup(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await status(page).click();
  await expect(page.getByTestId('proofreading-panel')).toBeVisible();
  await shot(page, 'proofreading-list-light');
  await page.getByTestId('proofreading-issue-list').getByRole('button').first().click();
  await expect(popup(page)).toBeVisible();
  await closeComposer(page);
  await page.context().close();
});

test('asks before sending with open issues when the checker wants that', async ({ browser }) => {
  const page = await userPage(browser, ENT.alice);
  await openComposer(page, 'See teh file.');
  const to = page.locator('[data-testid="composer-to"] input').first();
  await to.click();
  await to.fill(ENT.bob);
  await to.press('Enter');
  await turnOn(page);
  await expect(underline(page, 'teh')).toBeVisible({ timeout: 15_000 });
  await page.locator('[data-testid="composer-subject"]').first().focus();
  await page.keyboard.press('Control+Enter');
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Send with open issues?');
  await dialog.getByRole('button', { name: 'Review' }).click();
  await expect(popup(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await closeComposer(page);
  await page.context().close();
});

test('in plain text, lists the issues and fixes them there', async ({ browser }) => {
  const page = await userPage(browser, ENT.alice);
  await page.keyboard.press('c');
  await page.locator('[data-testid="email-composer"]').waitFor({ state: 'visible', timeout: 15_000 });
  await page.getByTestId('composer-options-menu').click();
  await page.getByTestId('composer-format-toggle').click();
  await page.keyboard.press('Escape');
  const textarea = page.locator('[data-testid="email-composer"] textarea').first();
  await textarea.click();
  await page.keyboard.type(GERMAN);
  await turnOn(page);
  await expect(status(page)).toContainText('1 issue', { timeout: 15_000 });
  await status(page).click();
  await shot(page, 'proofreading-plain-text-light');
  await page.getByTestId('proofreading-issue-list').getByRole('button', { name: 'Replace with den' }).click();
  await expect(textarea).toHaveValue(/Ich habe gestern den Brief geschrieben\./);
  await closeComposer(page);
  await page.context().close();
});

test('required by the organisation: no switch, a notice in its words, and still on after the user turned it off', async ({ browser }) => {
  // The user's own choice is off.
  const page = await userPage(browser, ENT.carol);
  await setPolicy(browser, { restrictions: { ...(base.restrictions as object), proofreading: { locked: true, value: true } } });
  await page.reload();
  await openComposer(page, GERMAN);
  await expect(page.getByTestId('proofreading-notice')).toContainText('Your organisation turned on proofreading');
  await expect(underline(page, 'dem')).toBeVisible({ timeout: 15_000 });
  await status(page).click();
  await expect(page.getByTestId('proofreading-panel')).toContainText('Required by your organisation');
  await expect(page.getByTestId('proofreading-composer-switch')).toHaveCount(0);
  await shot(page, 'proofreading-required-light');
  await closeComposer(page);
  await setPolicy(browser, {});
  await page.context().close();
});

test('works at phone width', async ({ browser }) => {
  const page = await userPage(browser, ENT.alice, true);
  await page.getByRole('button', { name: /compose|new message/i }).first().click();
  await page.locator('[data-testid="email-composer"]').waitFor({ state: 'visible', timeout: 15_000 });
  await expect(page.locator('[data-testid="composer-to"] input').first()).toBeFocused({ timeout: 10_000 }).catch(() => {});
  await editor(page).click();
  await page.keyboard.type(GERMAN);
  await turnOn(page);
  await expect(underline(page, 'dem')).toBeVisible({ timeout: 15_000 });
  await underline(page, 'dem').tap();
  await expect(popup(page)).toBeVisible();
  // The popup fits the screen.
  const box = (await popup(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await shot(page, 'proofreading-phone-popup-light');
  await page.keyboard.press('Escape');
  await status(page).click();
  const panel = (await page.getByTestId('proofreading-panel').boundingBox())!;
  expect(panel.x).toBeGreaterThanOrEqual(0);
  expect(panel.x + panel.width).toBeLessThanOrEqual(390);
  await shot(page, 'proofreading-phone-panel-light');
  await closeComposer(page);
  await page.context().close();
});

test('works right to left (Arabic)', async ({ browser }) => {
  const context = await browser.newContext({ ...contextOptions(), locale: 'ar' });
  const page = await context.newPage();
  await page.goto('/');
  await page.fill('#username', ENT.alice);
  await page.fill('#password', ENT_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => document.documentElement.dir === 'rtl', null, { timeout: 60_000 });
  await page.locator('[data-testid="email-list-item"], [data-testid="empty-state"], main').first().waitFor({ timeout: 60_000 });
  await openComposer(page, GERMAN);
  await turnOn(page);
  await expect(underline(page, 'dem')).toBeVisible({ timeout: 15_000 });
  await underline(page, 'dem').click();
  await expect(popup(page)).toBeVisible();
  await page.waitForTimeout(800);
  await shot(page, 'proofreading-rtl-popup-light');
  await popup(page).getByTestId('proofreading-replacement').first().click();
  await expect(editor(page)).toContainText('den Brief');
  await closeComposer(page);
  await context.close();
});
