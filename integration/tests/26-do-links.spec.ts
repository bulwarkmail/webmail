import { test, expect, type Browser, type Page } from '@playwright/test';
import { accountSwitcher, neutralizeDevOverlay } from './helpers/app';
import { ENT, ENT_PASSWORD, contextOptions, jmapAs, requireEntEnv, shot } from './helpers/ent';

/**
 * The browser webmail as the mail and calendar app of the browser: Settings registers
 * navigator.registerProtocolHandler for mailto: and webcal:, and the address the browser
 * then opens fills the composer or the subscription.
 *
 * Chromium can't accept its own permission prompt from a test, so a stand-in records what the
 * page registers, and the spec opens that address the way the browser would, %s replaced by the
 * encoded link. A second context checks the real call is accepted without an error.
 *
 *   BUILD=1 bash desktop-offline-rig/start-prod.sh <worktree> 3241 <jmap-url> links-1.0
 *   bash desktop-offline-rig/run-spec.sh <worktree> 3241 <jmap-url> 1.0 integration/tests/26-do-links.spec.ts
 */

test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

const RUN = `lkb${Date.now().toString(36)}`;
const composer = (page: Page) => page.locator('[data-testid="email-composer"]').first();

/** Records navigator.registerProtocolHandler instead of asking Chromium. */
function recordRegistrations() {
  const calls: [string, string][] = [];
  (window as unknown as { __registered: [string, string][] }).__registered = calls;
  Object.defineProperty(Navigator.prototype, 'registerProtocolHandler', {
    configurable: true,
    value(scheme: string, url: string) {
      calls.push([scheme, url]);
    },
  });
}

async function signedIn(browser: Browser, record: boolean): Promise<Page> {
  const context = await browser.newContext(contextOptions());
  if (record) await context.addInitScript(recordRegistrations);
  const page = await context.newPage();
  await neutralizeDevOverlay(page);
  await page.goto('/');
  await page.fill('#username', ENT.alice);
  await page.fill('#password', ENT_PASSWORD);
  await page.click('button[type="submit"]');
  await accountSwitcher(page).waitFor({ state: 'visible', timeout: 60_000 });
  return page;
}

async function openDefaultApps(page: Page): Promise<void> {
  await page.goto('/settings/general');
  await expect(page.getByRole('heading', { name: 'Default apps' })).toBeVisible({ timeout: 60_000 });
}

/**
 * The tab the composer or calendar ended up in. With "Always open a new tab" a handler tab that
 * has history of its own hands the link to a fresh tab and closes, so it may not be this one.
 */
async function tabWith(page: Page, selector: string): Promise<Page> {
  let found: Page | undefined;
  await expect.poll(async () => {
    for (const candidate of page.context().pages()) {
      if (!candidate.isClosed() && await candidate.locator(selector).first().isVisible().catch(() => false)) {
        found = candidate;
        return true;
      }
    }
    return false;
  }, { timeout: 60_000 }).toBe(true);
  return found!;
}

/** The address the browser opens for a link, as Chromium fills in %s. */
const handlerAddress = (template: string, link: string) => template.replace('%s', encodeURIComponent(link));

let mailtoTemplate = '';
let webcalTemplate = '';

test.beforeAll(requireEntEnv);

test.afterAll(async () => {
  // Only this run's: a draft a composer may have saved.
  const client = await jmapAs(ENT.alice);
  const found = await client.request([['Email/query', { accountId: client.accountId, filter: { subject: RUN }, limit: 50 }, 'q']]);
  const ids = (found.methodResponses[0][1] as { ids: string[] }).ids;
  if (ids.length) await client.request([['Email/set', { accountId: client.accountId, destroy: ids }, 'd']]);
});

test('Settings registers both handlers with this app\'s own address', async ({ browser }) => {
  const page = await signedIn(browser, true);
  await openDefaultApps(page);
  await page.getByRole('button', { name: /for email links/ }).click();
  await expect(page.getByText('Email handler registration requested')).toBeVisible();
  await page.getByRole('button', { name: /for calendar links/ }).click();
  await expect(page.getByText('Calendar handler registration requested')).toBeVisible();
  const origin = new URL(page.url()).origin;
  const calls = await page.evaluate(() => (window as unknown as { __registered: [string, string][] }).__registered);
  expect(calls).toEqual([
    ['mailto', `${origin}/protocol/mailto?url=%s`],
    ['webcal', `${origin}/protocol/webcal?url=%s`],
  ]);
  [, mailtoTemplate] = calls[0];
  [, webcalTemplate] = calls[1];
  await shot(page, 'links-browser-default-apps');
  await page.context().close();
});

test('the real browser call takes the address without an error', async ({ browser }) => {
  const page = await signedIn(browser, false);
  await openDefaultApps(page);
  await page.getByRole('button', { name: /for email links/ }).click();
  await expect(page.getByText('Email handler registration requested')).toBeVisible();
  await expect(page.getByText('Protocol handler registration failed')).toHaveCount(0);
  await page.context().close();
});

test('a mail link opened by the browser fills the composer: every field, UTF-8 and line breaks', async ({ browser }) => {
  const page = await signedIn(browser, false);
  // The browser opens the handler in a tab of its own.
  const tab = await page.context().newPage();
  const subject = `${RUN} Grüße 😀`;
  const link = `mailto:J%C3%BCrgen%20%3Cjuergen%40example.org%3E,second%40example.org?cc=cc%40example.org&bcc=bcc%40example.org&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent('Zeile 1\r\nZeile 2\r\n€ 10 & more')}`;
  await tab.goto(handlerAddress(mailtoTemplate, link));
  const shown = await tabWith(page, '[data-testid="email-composer"]');
  expect(shown).not.toBe(page);
  await expect(shown.getByTestId('composer-subject')).toHaveValue(subject);
  const to = await shown.locator('[data-testid="composer-to"] [data-recipient-chip]').allTextContents();
  expect(to.join(' ')).toContain('Jürgen');
  expect(to.join(' ')).toContain('second@example.org');
  await expect(composer(shown)).toContainText('cc@example.org');
  await expect(composer(shown)).toContainText('bcc@example.org');
  const body = composer(shown).locator('[contenteditable="true"], textarea').last();
  await expect(body).toContainText('Zeile 1');
  await expect(body).toContainText('Zeile 2');
  await expect(body).toContainText('€ 10 & more');
  await shot(shown, 'links-browser-mailto');
  await page.context().close();
});

test('a link with a stray percent sign still opens the composer', async ({ browser }) => {
  const page = await signedIn(browser, false);
  const tab = await page.context().newPage();
  await tab.goto(handlerAddress(mailtoTemplate, `mailto:someone@example.org?subject=${RUN}%2050% off`));
  const shown = await tabWith(page, '[data-testid="composer-subject"]');
  await expect(shown.getByTestId('composer-subject')).toHaveValue(`${RUN} 50% off`);
  await page.context().close();
});

test('a calendar link opened by the browser goes to the subscription, filled in', async ({ browser }) => {
  const page = await signedIn(browser, false);
  const tab = await page.context().newPage();
  await tab.goto(handlerAddress(webcalTemplate, `webcal://feeds.example.org/${RUN}.ics`));
  const shown = await tabWith(page, '[role="dialog"]');
  await expect(shown).toHaveURL(/\/calendar/);
  const dialog = shown.getByRole('dialog', { name: 'Subscribe to a calendar' });
  await expect(dialog).toBeVisible({ timeout: 60_000 });
  await expect(shown.getByRole('dialog', { name: 'Open calendar link' })).toHaveCount(0);
  await expect(dialog.getByRole('textbox').first()).toHaveValue(`https://feeds.example.org/${RUN}.ics`);
  await expect(dialog.getByRole('textbox').nth(1)).toHaveValue(RUN);
  await shot(shown, 'links-browser-webcal');
  await page.context().close();
});
