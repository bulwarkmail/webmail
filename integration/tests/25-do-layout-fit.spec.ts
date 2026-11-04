/**
 * Nothing cut off at common window sizes: the main screens at 1280×720 and 1366×768,
 * and at 125 % and 150 % zoom (the same windows in CSS pixels), in English, German
 * (long words) and Arabic (right to left). Each screen fails on a line of text that
 * runs past the edge of the box it sits in or hides behind a scroll bar
 * (helpers/layout-fit.ts). The message details panel also has to give the sender's
 * address room and show its dates on one line.
 *
 * Runs as dso-menus@example.org on Stalwart 1.0: check or create the account on the
 * VM first (~/desktop-offline/dso_menus_provision.py stw-v1, then
 * dso_menus_authmail.py stw-v1 for the message with long sign-in results), then
 * desktop-offline-rig/run-spec.sh with IT_DSO_PASSWORD from the vault item
 * "Stalwart test – dso-* throwaway accounts". Reads only; changes nothing.
 * IT_LAYOUT_SHOTS: a folder for a screenshot of each screen. IT_LAYOUT_SCREENS=mail:
 * the mail screens only.
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { requireEntEnv } from './helpers/ent';
import { accountSwitcher, neutralizeDevOverlay } from './helpers/app';
import { WEBMAIL_URL } from './helpers/config';
import { findCutOffText, type CutOff } from './helpers/layout-fit';

requireEntEnv();
test.setTimeout(600_000);

const USER = 'dso-menus@example.org';
const PASSWORD = process.env.IT_DSO_PASSWORD ?? '';
if (!PASSWORD) throw new Error('Set IT_DSO_PASSWORD, and check the account on the VM first: see the top of this file');
const AUTH_SUBJECT = 'Your weekly account summary is ready for review';
const SHOTS = process.env.IT_LAYOUT_SHOTS ?? '';
const MAIL_ONLY = process.env.IT_LAYOUT_SCREENS === 'mail';

const SETTINGS_TABS = ['account', 'security', 'notifications', 'general', 'appearance', 'accessibility', 'reading',
  'composing', 'organize', 'filters', 'vacation', 'calendar', 'contacts', 'files', 'backup'];

interface Scenario { name: string; locale: string; language: string; width: number; height: number }

const SCENARIOS: Scenario[] = [
  { name: '1280x720-en', locale: 'en-US', language: 'en', width: 1280, height: 720 },
  { name: '1366x768-de', locale: 'de-DE', language: 'de', width: 1366, height: 768 },
  // 1280×720 at 125 % and 1366×768 at 150 %: the same window in CSS pixels.
  { name: '1280x720-125-de', locale: 'de-DE', language: 'de', width: 1024, height: 576 },
  { name: '1366x768-150-de', locale: 'de-DE', language: 'de', width: 911, height: 512 },
  { name: '1280x720-ar', locale: 'ar', language: 'ar', width: 1280, height: 720 },
];

function viewerText(language: string): Record<string, string> {
  const file = path.join(__dirname, '..', '..', 'locales', language, 'common.json');
  const viewer = JSON.parse(readFileSync(file, 'utf-8')).email_viewer;
  return { showDetails: viewer.show_details, routing: viewer.details.recipients_routing };
}

async function signIn(browser: Browser, scenario: Scenario): Promise<Page> {
  const context = await browser.newContext({
    baseURL: WEBMAIL_URL,
    locale: scenario.locale,
    viewport: { width: scenario.width, height: scenario.height },
  });
  const page = await context.newPage();
  await neutralizeDevOverlay(page);
  await page.goto('/');
  await page.fill('#username', USER);
  await page.fill('#password', PASSWORD);
  await page.click('button[type="submit"]');
  await accountSwitcher(page).waitFor({ state: 'visible', timeout: 60000 });
  return page;
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(800);
}

async function check(page: Page, scenario: Scenario, screen: string, found: Map<string, CutOff[]>): Promise<void> {
  await settle(page);
  if (SHOTS) {
    if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, `${screen}-${scenario.name}.png`) });
  }
  const cut = await findCutOffText(page);
  if (cut.length) found.set(screen, cut);
}

function report(found: Map<string, CutOff[]>): string {
  return [...found].map(([screen, list]) => `${screen}:\n${list.map((c) => `  ${c.px}px ${c.where} "${c.text}"`).join('\n')}`).join('\n');
}

for (const scenario of SCENARIOS) {
  test(`nothing is cut off at ${scenario.name}`, async ({ browser }) => {
    const page = await signIn(browser, scenario);
    const text = viewerText(scenario.language);
    const found = new Map<string, CutOff[]>();

    // Mail: the list, a message with long sign-in results and its details open.
    const item = page.locator('[data-testid="email-list-item"]', { hasText: AUTH_SUBJECT }).first();
    await item.waitFor({ state: 'visible', timeout: 60000 });
    await check(page, scenario, 'mail-list', found);
    await item.click();
    await page.getByRole('button', { name: text.showDetails }).first().click();
    const routing = page.locator('section', { has: page.getByText(text.routing, { exact: true }) }).first();
    await expect(routing).toBeVisible();
    await check(page, scenario, 'mail-details', found);

    // The sender's address gets a column of its own width, not a sliver, and a date
    // takes one line. Rows: From, To, Sent, Received.
    const fit = await routing.evaluate((section) => {
      const values = Array.from(section.querySelectorAll('dl > dd'));
      const from = values[0].getBoundingClientRect();
      const sent = values[values.length - 2];
      const lineHeight = parseFloat(getComputedStyle(sent).lineHeight) || 20;
      return { fromWidth: Math.round(from.width), sentLines: Math.round(sent.getBoundingClientRect().height / lineHeight) };
    });
    expect.soft(fit.fromWidth, 'width of the From value in the details panel').toBeGreaterThanOrEqual(220);
    expect.soft(fit.sentLines, 'lines the Sent date takes in the details panel').toBeLessThanOrEqual(1);

    if (scenario.language === 'ar' || MAIL_ONLY) {
      expect(found, report(found)).toEqual(new Map());
      return;
    }

    // Composer.
    await page.keyboard.press('Escape');
    await page.keyboard.press('c');
    await page.locator('[data-testid="email-composer"]').waitFor({ state: 'visible', timeout: 15000 });
    await check(page, scenario, 'composer', found);
    await page.keyboard.press('Escape');

    // Calendar, contacts, files.
    await page.goto('/calendar');
    await page.waitForTimeout(1500);
    await page.keyboard.press('w');
    await check(page, scenario, 'calendar-week', found);
    await page.keyboard.press('m');
    await check(page, scenario, 'calendar-month', found);
    await page.goto('/contacts');
    await check(page, scenario, 'contacts', found);
    await page.goto('/files');
    await check(page, scenario, 'files', found);

    for (const tab of SETTINGS_TABS) {
      await page.goto(`/settings/${tab}`);
      await check(page, scenario, `settings-${tab}`, found);
    }

    expect(found, report(found)).toEqual(new Map());
  });
}
