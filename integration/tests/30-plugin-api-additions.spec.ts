import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { adminContext, contextOptions, getPolicy, putPolicy, requireEntEnv, shot } from './helpers/ent';
import { accountSwitcher, neutralizeDevOverlay } from './helpers/app';
import { JMAP_URL } from './helpers/config';
import { JmapClient } from './helpers/jmap';

/**
 * The plugin API of Bulwark 1.21 through the real UI, with a test plugin
 * (integration/fixtures/plugin-api-probe) that uses it and records what it
 * got: api.composer.setSubject from a button in the composer's top bar, the
 * composer id in onBeforeEmailSend and onTransformOutgoingEmail, keywords on
 * the Sent copy, api.ui.openFile and api.ui.print with a PDF in the file
 * preview, reader buttons in a message window, top-bar buttons in a composer
 * window, and parameters for the plugin from a new-message link and a
 * mailto: link.
 *
 * Accounts: dso-ux-compose and dso-ux-compose-b (password IT_DSO_PASSWORD).
 * Check them on the VM first:
 *   vw exec --stdin "vault://Stalwart test – dso-* throwaway accounts/password" -- ssh stw-test "python3 ~/desktop-offline/dso_ux_compose_provision.py stw-v1 check"
 * The rig, from one shell:
 *   BUILD=1 bash desktop-offline-rig/start-prod.sh <worktree> 3217 https://stalwart-1.internal.bulwarkmail.org pa-1.0
 *   vw exec --env IT_DSO_PASSWORD="vault://Stalwart test – dso-* throwaway accounts/password" -- bash desktop-offline-rig/run-spec.sh <worktree> 3217 https://stalwart-1.internal.bulwarkmail.org 1.0 integration/tests/30-plugin-api-additions.spec.ts
 */

test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);
// Chromium itself, not the headless shell: the shell has no PDF viewer, and
// the preview then draws the PDF with pdf.js, which has no Print.
test.use({ channel: 'chromium' });

const PASSWORD = process.env.IT_DSO_PASSWORD ?? '';
const USER = 'dso-ux-compose@example.org';
const OTHER = 'dso-ux-compose-b@example.org';
const ID = 'it-plugin-api-probe';
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'plugin-api-probe');
const RUN = `PA${Date.now().toString(36)}`;
const INBOX_SUBJECT = `Probe inbox ${RUN}`;

test.skip(!PASSWORD, 'Set IT_DSO_PASSWORD (vault "Stalwart test – dso-* throwaway accounts")');

let original: Record<string, unknown>;
let jmap: Promise<JmapClient> | null = null;
const account = () => (jmap ??= JmapClient.connect(USER, PASSWORD));

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

async function mailboxId(role: string): Promise<string> {
  const client = await account();
  const r = await client.request([['Mailbox/get', { accountId: client.accountId, properties: ['id', 'role'] }, '0']]);
  return (r.methodResponses[0][1].list as Array<{ id: string; role: string | null }>).find((m) => m.role === role)!.id;
}

/** Messages of this run, with their folders and keywords. */
async function messages(text: string): Promise<Array<{ id: string; subject: string; mailboxIds: Record<string, boolean>; keywords: Record<string, boolean> }>> {
  const client = await account();
  const r = await client.request([
    ['Email/query', { accountId: client.accountId, filter: { subject: text }, limit: 50 }, 'q'],
    ['Email/get', { accountId: client.accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['id', 'subject', 'mailboxIds', 'keywords'] }, 'g'],
  ]);
  return r.methodResponses[1][1].list;
}

/** What the plugin recorded under `key` (its api.storage, per account). */
async function recorded<T>(page: Page, key: string): Promise<T[]> {
  return page.evaluate(({ id, key: name }) => {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (k.startsWith(`plugin:${id}:`) && k.endsWith(`:${name}`)) return JSON.parse(localStorage.getItem(k)!);
    }
    return [];
  }, { id: ID, key }) as Promise<T[]>;
}

async function login(browser: Browser): Promise<Page> {
  const context = await browser.newContext(contextOptions());
  const page = await context.newPage();
  await neutralizeDevOverlay(page);
  await page.goto('/');
  await page.locator('#username').waitFor({ state: 'visible', timeout: 60_000 });
  await page.fill('#username', USER);
  await page.fill('#password', PASSWORD);
  await page.click('button[type="submit"]');
  await accountSwitcher(page).waitFor({ state: 'visible', timeout: 60_000 });
  return page;
}

const header = (page: Page) => page.locator('[data-composer-header]').first();
const subjectField = (page: Page) => page.locator('[data-testid="composer-subject"]').first();

async function openComposer(page: Page, subject: string): Promise<void> {
  await page.keyboard.press('c');
  await page.locator('[data-testid="email-composer"]').waitFor({ state: 'visible', timeout: 15_000 });
  await subjectField(page).fill(subject);
}

let page: Page;

test.beforeAll(async ({ browser }) => {
  requireEntEnv();
  const admin = await adminContext(browser);
  original = await getPolicy(admin);
  await putPolicy(admin, { ...original, features: { ...(original.features as object), pluginsEnabled: true } });
  await admin.request.get('/plugin-sandbox', { timeout: 120_000 });
  await install(admin);
  await admin.close();

  // A message in the inbox to read.
  const client = await account();
  const raw = `From: Kanzlei <${OTHER}>\r\nTo: ${USER}\r\nSubject: ${INBOX_SUBJECT}\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <${RUN}@example.org>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBody of ${INBOX_SUBJECT}\r\n`;
  const up = await fetch(`${JMAP_URL}/jmap/upload/${client.accountId}/`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${USER}:${PASSWORD}`).toString('base64'), 'Content-Type': 'message/rfc822' },
    body: raw,
  });
  expect(up.ok).toBe(true);
  const { blobId } = await up.json();
  const res = await client.request([['Email/import', { accountId: client.accountId, emails: { e: { blobId, mailboxIds: { [await mailboxId('inbox')]: true }, keywords: {} } } }, '0']]);
  expect(res.methodResponses[0][1].created?.e?.id, JSON.stringify(res.methodResponses[0][1])).toBeTruthy();

  page = await login(browser);
});

test.afterAll(async ({ browser }) => {
  test.setTimeout(120_000);
  const client = await account();
  const ids = (await messages(RUN)).map((m) => m.id);
  if (ids.length) await client.request([['Email/set', { accountId: client.accountId, destroy: ids }, '0']]).catch(() => {});
  if (!original) return;
  const admin = await adminContext(browser);
  await putPolicy(admin, original);
  await admin.request.delete('/api/admin/plugins', { data: { id: ID } });
  await admin.close();
});

test('a top-bar button sets the subject, which Ctrl+Z takes back, and the draft saves it', async () => {
  await openComposer(page, `Mahnung ${RUN}`);
  const button = header(page).getByRole('button', { name: 'Probe: case subject' });
  await expect(button).toBeVisible({ timeout: 60_000 });
  await button.click();
  await expect(subjectField(page)).toHaveValue(`Akte 01/2026: Mahnung ${RUN}`);
  await shot(page, 'plugin-api-composer-top-bar');

  await subjectField(page).click();
  await page.keyboard.press('Control+z');
  await expect(subjectField(page)).toHaveValue(`Mahnung ${RUN}`);
  await button.click();
  await expect(subjectField(page)).toHaveValue(`Akte 01/2026: Mahnung ${RUN}`);

  await expect(page.locator('[data-testid="composer-save-status"]').first()).toHaveAttribute('data-status', 'saved', { timeout: 30_000 });
  await expect.poll(async () => (await messages(RUN)).filter((m) => m.keywords.$draft).map((m) => m.subject), { timeout: 30_000 })
    .toContain(`Akte 01/2026: Mahnung ${RUN}`);
});

test('the send hooks get the composer id, and the Sent copy carries the keywords', async () => {
  const to = page.locator('[data-testid="composer-to"] input').first();
  await to.click();
  await to.fill(OTHER);
  await to.press('Enter');
  await page.locator('[data-testid="email-composer"] [contenteditable="true"]').first().click();
  await page.keyboard.type(`Body ${RUN}`);
  // The bottom bar's Send (the header has one of its own on phones).
  await page.locator('[data-testid="composer-send"]:visible').first().click();

  const sent = await mailboxId('sent');
  await expect.poll(async () => (await messages(`Akte 01/2026: Mahnung ${RUN}`)).find((m) => m.mailboxIds[sent])?.keywords ?? null, { timeout: 90_000 })
    .toMatchObject({ 'akte-01-2026': true, $flagged: true, $seen: true });
  const copy = (await messages(`Akte 01/2026: Mahnung ${RUN}`)).find((m) => m.mailboxIds[sent])!;
  // No $seen from the plugin, no other system keyword; Stalwart 1.0 adds $hasnoattachment itself.
  expect(Object.keys(copy.keywords).filter((k) => !/^\$has(no)?attachment$/.test(k)).sort()).toEqual(['$flagged', '$seen', 'akte-01-2026'].sort());

  const actions = await recorded<{ actionId: string; composerId: string }>(page, 'actions');
  const composerId = actions.filter((a) => a.actionId === 'subject').at(-1)!.composerId;
  expect(composerId).toBeTruthy();
  const checks = await recorded<{ composerId: string; subject: string }>(page, 'sendChecks');
  expect(checks.at(-1)).toEqual({ composerId, subject: `Akte 01/2026: Mahnung ${RUN}` });
  const transforms = await recorded<{ composerId: string; keywords: string[] }>(page, 'transforms');
  expect(transforms.at(-1)).toEqual({ composerId, keywords: [] });
});

async function openInboxMessage(p: Page): Promise<void> {
  const row = p.locator('[data-testid="email-list-item"]', { hasText: INBOX_SUBJECT }).first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.click();
  await expect(p.getByText(`Body of ${INBOX_SUBJECT}`).first()).toBeVisible({ timeout: 30_000 });
}

/** A reader button of the plugin, from the toolbar or the menu its overflow went to. */
async function clickReaderAction(p: Page, label: string): Promise<void> {
  const button = p.getByRole('button', { name: label }).first();
  if (await button.isVisible({ timeout: 30_000 }).catch(() => false)) {
    await button.click();
    return;
  }
  await p.getByRole('button', { name: 'More actions' }).first().click();
  await p.getByRole('menuitem', { name: label }).first().click();
}

test('a reader button opens a PDF in the file preview, with Print and Download', async () => {
  await page.goto('/');
  await openInboxMessage(page);
  const revoked: string[] = [];
  await page.exposeFunction('__revoked', (url: string) => { revoked.push(url); });
  await page.evaluate(() => {
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url: string) => { (window as unknown as { __revoked: (u: string) => void }).__revoked(url); revoke(url); };
  });
  await clickReaderAction(page, 'Probe: case PDF');
  const frame = page.locator('iframe[title="Akte 01-2026.pdf"]');
  await expect(frame).toBeVisible({ timeout: 30_000 });
  const src = await frame.getAttribute('src');
  expect(src).toMatch(/^blob:/);
  await expect(page.getByTestId('preview-print')).toBeVisible();
  await shot(page, 'plugin-api-open-file');
  await page.keyboard.press('Escape');
  await expect(frame).toHaveCount(0);
  await expect.poll(() => revoked).toContain(src);
});

test('print with a PDF opens it in the preview and prints it from a frame of its own', async () => {
  // A real print dialog would hang (or crash) the headless page: count the
  // print() calls on a PDF frame instead.
  await page.evaluate(() => {
    const own = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow')!;
    const counter = window as unknown as { __pdfPrints: string[] };
    counter.__pdfPrints = [];
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
      configurable: true,
      get(this: HTMLIFrameElement) {
        const view = own.get!.call(this) as Window | null;
        const src = this.getAttribute('src') ?? '';
        if (!view || !src.startsWith('blob:')) return view;
        return new Proxy(view, {
          get(target, key) {
            if (key === 'print') return () => { counter.__pdfPrints.push(src); };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    });
  });
  await clickReaderAction(page, 'Probe: print PDF');
  const shown = page.locator('iframe[title="Alles drucken.pdf"]');
  await expect(shown).toBeVisible({ timeout: 30_000 });
  // Printed once, from a frame of its own holding the same PDF, off screen.
  await expect.poll(() => page.evaluate(() => (window as unknown as { __pdfPrints: string[] }).__pdfPrints)).toHaveLength(1);
  const printed = await page.evaluate(() => (window as unknown as { __pdfPrints: string[] }).__pdfPrints[0]);
  expect(printed).toBe(await shown.getAttribute('src'));
  await expect(page.locator(`iframe[aria-hidden="true"][src="${printed}"]`)).toHaveCount(1);
  // The page keeps the keyboard: Escape closes the preview.
  await page.keyboard.press('Escape');
  await expect(shown).toHaveCount(0);
});

test('the reader buttons are in a message window too, with the same message', async () => {
  // The window "Open in new window" opens (offered in an installed app and the
  // desktop app), beside the main window it takes the session from.
  await page.goto('/');
  await accountSwitcher(page).waitFor({ state: 'visible', timeout: 60_000 });
  const inboxId = (await messages(INBOX_SUBJECT))[0].id;
  const popup = await page.context().newPage();
  await popup.goto(`/popout/message/${encodeURIComponent(inboxId)}`);
  await expect(popup.locator('[data-popout-window="message"][data-popout-status="ready"]')).toBeVisible({ timeout: 60_000 });
  await expect(popup.getByText(`Body of ${INBOX_SUBJECT}`).first()).toBeVisible({ timeout: 60_000 });
  const before = (await recorded<{ actionId: string; emailId: string }>(page, 'actions')).length;
  await clickReaderAction(popup, 'Probe: case PDF');
  await expect(popup.locator('iframe[title="Akte 01-2026.pdf"]')).toBeVisible({ timeout: 30_000 });
  await shot(popup, 'plugin-api-message-window');
  const actions = await recorded<{ actionId: string; emailId: string }>(page, 'actions');
  expect(actions.length).toBeGreaterThan(before);
  const inbox = (await messages(INBOX_SUBJECT))[0];
  expect(actions.at(-1)).toMatchObject({ actionId: 'reader-pdf', emailId: inbox.id });
  await popup.close();
});

test('the top-bar buttons are in a composer window too', async () => {
  // A new message in a window of its own, as the desktop app's File menu and quick compose open it.
  const popup = await page.context().newPage();
  await popup.goto('/popout/compose');
  await expect(popup.locator('[data-popout-window="compose"]')).toBeVisible({ timeout: 60_000 });
  await subjectField(popup).fill(`Window ${RUN}`);
  const button = header(popup).getByRole('button', { name: 'Probe: case subject' });
  await expect(button).toBeVisible({ timeout: 60_000 });
  await button.click();
  await expect(subjectField(popup)).toHaveValue(`Akte 01/2026: Window ${RUN}`);
  await shot(popup, 'plugin-api-composer-window');
  await popup.close();
});

test('a new-message link hands the plugin its parameters, and only its own', async () => {
  await page.goto(`/?compose=1&x-${ID}-case=01%2F2026&x-someone-else-case=nope`);
  await expect(subjectField(page)).toHaveValue('Link case 01/2026', { timeout: 60_000 });
  // The address doesn't keep them.
  expect(page.url()).not.toContain(`x-${ID}`);
  const links = await recorded<{ composerId: string; params: Record<string, string> }>(page, 'links');
  expect(links.at(-1)!.params).toEqual({ case: '01/2026' });
  await page.keyboard.press('Escape');
});

test('a mailto: link hands the plugin its parameters', async () => {
  const mailto = `mailto:${OTHER}?subject=${encodeURIComponent(`Mailto ${RUN}`)}&x-${ID}-case=02%2F2026`;
  await page.goto('/');
  await accountSwitcher(page).waitFor({ state: 'visible', timeout: 60_000 });
  // Clicked somewhere else, through Bulwark's mail link handler: the open Bulwark tab writes it.
  const handler = await page.context().newPage();
  await handler.goto(`/protocol/mailto?url=${encodeURIComponent(mailto)}`);
  // The composer opens in a tab of the app (this one or one the handler opens).
  let shown: Page | null = null;
  await expect.poll(async () => {
    for (const candidate of page.context().pages()) {
      if (candidate.isClosed()) continue;
      const value = await subjectField(candidate).inputValue({ timeout: 500 }).catch(() => null);
      if (value === 'Link case 02/2026') { shown = candidate; return true; }
    }
    return false;
  }, { timeout: 60_000 }).toBe(true);
  const links = await recorded<{ composerId: string; params: Record<string, string> }>(shown!, 'links');
  expect(links.at(-1)!.params).toEqual({ case: '02/2026' });
  await handler.close().catch(() => {});
});
