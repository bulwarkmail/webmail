/**
 * Printing one message of a conversation, and print styles, in the real app.
 *
 * - Print in an older message's own ⋮ prints that message alone, in the
 *   reader's Print window layout.
 * - Ctrl+P (the browser's printing, File > Print in the desktop app) while
 *   that message has the focus prints it alone; otherwise the open one.
 * - A theme's --print-* variables and a plugin's print style (picked under
 *   Settings > Appearance > Printing) change the printout; the style's
 *   remote URL is gone.
 *
 * Throwaway ent-* accounts only. A tiny plugin is built here and installed
 * through the admin API, and removed again with the messages at the end.
 * PDFs of each printout go to IT_PRINT_PDF_DIR when it is set.
 *
 *   BUILD=1 bash desktop-offline-rig/start-prod.sh <worktree> <port> <jmap-url> <rig>
 *   IT_PRINT_PDF_DIR=... bash desktop-offline-rig/run-spec.sh <worktree> <port> <jmap-url> <0.16|1.0> integration/tests/30-do-print.spec.ts
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { ENT, ENT_SERVER, adminContext, deliver, getPolicy, jmapAs, putPolicy, requireEntEnv, userPage } from './helpers/ent';

test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

const RUN = Date.now().toString(36);
const SUBJECT = `Print check ${RUN}`;
const FIRST = `First message ${RUN}-A`;
const SECOND = `Second message ${RUN}-B`;
const PLUGIN = 'it-print-style';
const PDF_DIR = process.env.IT_PRINT_PDF_DIR ?? '';

let untouched: Record<string, unknown> | undefined;

async function pluginZip(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify({
    id: PLUGIN, name: 'Print style test', version: '1.0.0', author: 'Bulwark tests',
    description: 'Registers a print style with a letterhead.', type: 'hook', permissions: [], entrypoint: 'index.js',
  }));
  zip.file('index.js', `"use strict";
exports.activate = async function (api) {
  await api.ui.registerPrintTheme({
    id: 'company',
    label: 'Company letterhead',
    css: ":root { --print-font-family: Georgia, serif; --print-heading-color: #003366; --print-rule-color: #003366; }"
      + " .pr-letterhead-header { font-size: 13pt; font-weight: 600; color: #003366; }"
      + " .pr-header { background: url(https://tracker.example.org/p.png); }"
      + " @page { margin: 22mm 18mm; }",
    header: "Example Logistics GmbH\\nHarbour Road 7, 20457 Hamburg",
    footer: "example.org · +49 40 1234567",
  });
};
`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function pdf(page: Page, name: string): Promise<void> {
  if (!PDF_DIR) return;
  if (!existsSync(PDF_DIR)) mkdirSync(PDF_DIR, { recursive: true });
  await page.pdf({ path: path.join(PDF_DIR, `print-${name}-${ENT_SERVER}.pdf`), format: 'A4', printBackground: true });
}

/** A Print window's page as a PDF, from the HTML the app wrote into it. */
async function windowPdf(page: Page, html: string, name: string): Promise<void> {
  if (!PDF_DIR) return;
  const sheet = await page.context().newPage();
  await sheet.setContent(html);
  await pdf(sheet, name);
  await sheet.close();
}

/** window.open records what the app writes into its Print window, and opens nothing. */
async function catchPrintWindows(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __printed: string[] };
    w.__printed = [];
    window.open = () => {
      let html = '';
      return {
        opener: null,
        document: { write: (s: string) => { html += s; }, close: () => { w.__printed.push(html); } },
        focus() {},
        print() {},
        close() {},
        closed: false,
      } as unknown as Window;
    };
  });
}

const printed = (page: Page) => page.evaluate(() => (window as unknown as { __printed: string[] }).__printed);

async function openConversation(page: Page): Promise<Locator> {
  const row = page.locator('[data-testid="email-list-item"], [data-thread-keys]', { hasText: SUBJECT }).first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.click();
  // The row opens the first message; the follow-up is unread, so it shows
  // unfolded under it, with its own ⋮.
  const card = page.locator('[data-mv-conversation-expanded][data-conversation-message]').first();
  await expect(card).toContainText(SECOND, { timeout: 30_000 });
  return card;
}

/** What Ctrl+P puts on paper: the print copy's title and body text, read while printing. */
async function printCopy(page: Page): Promise<{ title: string; body: string; theme: string | null; letterhead: string }> {
  return page.evaluate(() => {
    window.dispatchEvent(new Event('beforeprint'));
    const root = document.querySelector('body > [data-print-root]');
    const out = {
      title: root?.querySelector('.pr-title')?.textContent ?? '',
      body: root?.querySelector('[data-message-print-body]')?.shadowRoot?.textContent ?? '',
      theme: root?.getAttribute('data-print-theme') ?? null,
      letterhead: root?.querySelector('[data-print-letterhead="header"]')?.textContent ?? '',
    };
    window.dispatchEvent(new Event('afterprint'));
    return out;
  });
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  requireEntEnv();
  const admin = await adminContext(browser);
  const policy = await getPolicy(admin);
  untouched = structuredClone(policy);
  await admin.request.get('/plugin-sandbox', { timeout: 120_000 });
  await admin.request.delete('/api/admin/plugins', { data: { id: PLUGIN } });
  const installed = await admin.request.post('/api/admin/plugins', {
    multipart: { file: { name: `${PLUGIN}.zip`, mimeType: 'application/zip', buffer: await pluginZip() } },
  });
  expect(installed.ok(), await installed.text()).toBe(true);
  const features = { ...(policy.features as Record<string, unknown>), pluginsEnabled: true };
  const forced = [...new Set([...((policy.forceEnabledPlugins as string[] | undefined) ?? []), PLUGIN])];
  await putPolicy(admin, { ...policy, features, forceEnabledPlugins: forced });
  await admin.close();

  // A conversation of two: bob writes, then follows up in the same thread.
  await deliver({ from: ENT.bob, to: [ENT.alice], subject: SUBJECT, text: `Hello Alice,\n\n${FIRST}\n\nBob` });
  const bob = await jmapAs(ENT.bob);
  const sent = await bob.request([
    ['Email/query', { accountId: bob.accountId, filter: { text: RUN }, limit: 5 }, '0'],
    ['Email/get', { accountId: bob.accountId, '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' }, properties: ['messageId'] }, '1'],
  ]);
  const messageId = sent.methodResponses[1][1].list[0]?.messageId?.[0];
  expect(messageId, 'the first message has a Message-ID').toBeTruthy();
  await deliver({
    from: ENT.bob, to: [ENT.alice], subject: `Re: ${SUBJECT}`, text: `One more thing:\n\n${SECOND}\n\nBob`,
    headers: { 'In-Reply-To': `<${messageId}>`, References: `<${messageId}>` },
  });
  const alice = await jmapAs(ENT.alice);
  await expect.poll(async () => {
    const r = await alice.request([['Email/query', { accountId: alice.accountId, filter: { text: RUN }, limit: 5 }, '0']]);
    return r.methodResponses[0][1].ids.length;
  }, { timeout: 60_000 }).toBe(2);
});

test.afterAll(async ({ browser }) => {
  test.setTimeout(120_000);
  for (const account of [ENT.alice, ENT.bob]) {
    const client = await jmapAs(account);
    const r = await client.request([['Email/query', { accountId: client.accountId, filter: { text: RUN }, limit: 20 }, '0']]);
    const ids = r.methodResponses?.[0]?.[1]?.ids ?? [];
    if (ids.length) await client.request([['Email/set', { accountId: client.accountId, destroy: ids }, '0']]).catch(() => {});
  }
  if (!untouched) return;
  const admin = await adminContext(browser);
  await putPolicy(admin, untouched);
  await admin.request.delete('/api/admin/plugins', { data: { id: PLUGIN } });
  await admin.close();
});

test('Print in a message\'s own menu and Ctrl+P print that message of the conversation alone', async ({ browser }) => {
  const page = await userPage(browser, ENT.alice);
  await catchPrintWindows(page);
  const card = await openConversation(page);

  await card.locator('[data-conversation-message-menu]').click();
  await page.getByTestId('conversation-message-print').click();
  const [html] = await printed(page);
  expect(html).toContain(SECOND);
  expect(html).not.toContain(FIRST);
  expect(html).not.toContain('data-print-theme');
  await windowPdf(page, html, 'conversation-menu');

  // Nothing of the conversation has the focus: the open message, as before.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const open = await printCopy(page);
  expect(open.body).toContain(FIRST);

  // A click in the follow-up: Ctrl+P prints it alone.
  await card.getByText(SECOND).click();
  const focused = await printCopy(page);
  expect(focused.title).toBe(`Re: ${SUBJECT}`);
  expect(focused.body).toContain(SECOND);
  expect(focused.body).not.toContain(FIRST);
  await card.getByText(SECOND).click();
  await pdf(page, 'conversation-ctrlp');
  await page.context().close();
});

test("a theme's print tokens and a plugin's print style shape the printout", async ({ browser }) => {
  const page = await userPage(browser, ENT.alice);

  // What a theme's :root block with print tokens sets.
  await page.addStyleTag({ content: ':root { --print-font-family: "Trebuchet MS", sans-serif; --print-heading-color: #1373d9; --print-rule-color: #1373d9; --print-page-margin: 16mm; }' });
  await catchPrintWindows(page);
  let card = await openConversation(page);
  await card.locator('[data-conversation-message-menu]').click();
  await page.getByTestId('conversation-message-print').click();
  const [themed] = await printed(page);
  expect(themed).toContain('--print-heading-color: #1373d9');
  expect(themed).toContain('@page { margin: 16mm; }');
  await windowPdf(page, themed, 'theme-tokens');
  await card.getByText(SECOND).click();
  await pdf(page, 'theme-tokens-ctrlp');

  // The plugin's print style, picked under Settings > Appearance > Printing.
  await page.goto('/settings/appearance');
  const select = page.locator('[data-settings-section="printing"] select');
  await expect(select.locator('option', { hasText: 'Company letterhead' })).toHaveCount(1, { timeout: 60_000 });
  // Settings sync saves the change a moment later; a page load before that
  // would bring back the server's copy.
  const saved = page.waitForResponse((r) => r.url().includes('/api/settings') && r.request().method() !== 'GET', { timeout: 30_000 });
  await select.selectOption(`${PLUGIN}/company`);
  await saved;
  await page.goto('/');
  await catchPrintWindows(page);
  card = await openConversation(page);
  // After a page load the plugin starts once the page is idle, and registers
  // its style again then: print until it is there.
  let styled = '';
  await expect.poll(async () => {
    await card.locator('[data-conversation-message-menu]').click();
    await page.getByTestId('conversation-message-print').click();
    styled = (await printed(page)).at(-1) ?? '';
    return styled.includes('data-print-theme=');
  }, { timeout: 60_000, intervals: [2_000] }).toBe(true);
  expect(styled).toContain(`data-print-theme="${PLUGIN}/company"`);
  expect(styled).toContain('Example Logistics GmbH');
  expect(styled).toContain('[data-print-theme] .pr-letterhead-header');
  expect(styled).not.toContain('tracker.example.org');
  expect(styled).not.toMatch(/<script/i);
  await windowPdf(page, styled, 'plugin-letterhead');

  await card.getByText(SECOND).click();
  const copy = await printCopy(page);
  expect(copy.theme).toBe(`${PLUGIN}/company`);
  expect(copy.letterhead).toContain('Harbour Road 7');
  expect(copy.body).toContain(SECOND);
  await card.getByText(SECOND).click();
  await pdf(page, 'plugin-letterhead-ctrlp');

  // Back to Standard for the next run.
  await page.goto('/settings/appearance');
  const reset = page.waitForResponse((r) => r.url().includes('/api/settings') && r.request().method() !== 'GET', { timeout: 30_000 });
  await page.locator('[data-settings-section="printing"] select').selectOption('standard');
  await reset;
  await page.context().close();
});
