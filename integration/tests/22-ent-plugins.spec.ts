import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import {
  ENT,
  adminContext,
  deliver,
  getPolicy,
  jmapAs,
  putPolicy,
  requireEntEnv,
  shot,
  userPage,
} from './helpers/ent';

/**
 * Enterprise pack, package E (official plugins and the host API they need),
 * through the real UI on a VM 106 test Stalwart with the ent-* accounts:
 * - item 4: external-link-warning 2.0.0 asks a company link-check service
 *   (a mock started by this spec) at click time: an "unsafe" verdict warns,
 *   a "safe" link opens, the dialog names the real target domain, a service
 *   that is down follows the admin's fail-open / fail-closed choice, and the
 *   service stays reachable with "no third-party traffic" on;
 * - item 5: send-checks 1.0.0 warns about an IBAN or a card number, blocks a
 *   blocked rule, ignores internal recipients for an external-only rule
 *   (with an organisation domain set in a group scope only), refuses a
 *   disallowed attachment type, and runs on quick reply too;
 *   (an unsafe verdict also blocks when the admin says so);
 * - item 5 also: sending is held while the required check isn't running, and
 *   a rule the admin changes on the plugin's admin page applies;
 * - both dialogs at 390 px.
 *
 * Both plugins are installed from the local builds of the plugins worktree
 * (IT_PLUGINS_DIR) through the admin API and removed at the end. No request
 * goes to Google: the lookup mode is "endpoint", the Safe Browsing key is a
 * fake, so the Google verdict dialog is covered by the plugin's unit tests.
 *
 * The rig, from one shell (the spec checks both variables and stops early):
 *
 *   export PLUGIN_PROXY_PRIVATE_ORIGINS=http://127.0.0.1:3195   # the mock is plain HTTP on this PC
 *   export NEXT_PUBLIC_APP_VERSION=1.20.0                       # both plugins need 1.20.0; VERSION says 1.19.1
 *   BUILD=1 bash enterprise-rig/start-prod.sh <worktree> 3105 <jmap-url> e-1.0
 *   bash enterprise-rig/run-spec.sh <worktree> 3105 <jmap-url> 1.0 integration/tests/22-ent-plugins.spec.ts
 */

test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

const PLUGINS_DIR = process.env.IT_PLUGINS_DIR ?? 'C:/Users/info/worktrees/plugins-enterprise';
const LINK_ZIP = `${PLUGINS_DIR}/external-link-warning/external-link-warning.zip`;
const SEND_ZIP = `${PLUGINS_DIR}/send-checks/send-checks.zip`;
const LINK = 'external-link-warning';
const SEND = 'send-checks';
const MOCK_PORT = 3195;
const TOKEN = 'it-link-check-token';
const RUN = Date.now().toString(36);
const LINK_HOST = 'ent-link.example.org';

let original: Record<string, unknown>;
/** The policy as it was before this spec, put back untouched at the end. */
let untouched: Record<string, unknown> | undefined;
/** No third-party traffic as it was before this spec. */
let modeBefore: boolean | undefined;
let mock: Server;
const endpoint = { up: true, requests: [] as { url: string; host: string; auth: string }[] };

// ─── Setup ───────────────────────────────────────────────────

async function installPlugin(admin: BrowserContext, id: string, zip: string): Promise<void> {
  await admin.request.delete('/api/admin/plugins', { data: { id } });
  const installed = await admin.request.post('/api/admin/plugins', {
    multipart: { file: { name: `${id}.zip`, mimeType: 'application/zip', buffer: readFileSync(zip) } },
  });
  const text = await installed.text();
  if (/Needs Bulwark 1\.20\.0/.test(text)) {
    throw new Error(`${id} needs Bulwark 1.20.0: build and start the server with NEXT_PUBLIC_APP_VERSION=1.20.0 (see the header of this spec)`);
  }
  expect(installed.ok(), text).toBe(true);
}

/** The rig variables the server needs; the same shell starts the server and this spec. */
function requireRigEnv(): void {
  const origins = process.env.PLUGIN_PROXY_PRIVATE_ORIGINS ?? '';
  const missing = [
    ...(origins.split(',').map((o) => o.trim()).includes(`http://127.0.0.1:${MOCK_PORT}`) ? [] : [`PLUGIN_PROXY_PRIVATE_ORIGINS=http://127.0.0.1:${MOCK_PORT}`]),
    ...(process.env.NEXT_PUBLIC_APP_VERSION === '1.20.0' ? [] : ['NEXT_PUBLIC_APP_VERSION=1.20.0']),
  ];
  if (missing.length) {
    throw new Error(`Set ${missing.join(' and ')} in the shell that builds and starts the server and runs this spec (see the header of this spec)`);
  }
}

async function setConfig(browser: Browser, id: string, values: Record<string, unknown>): Promise<void> {
  const admin = await adminContext(browser);
  for (const [key, value] of Object.entries(values)) {
    const res = await admin.request.put(`/api/admin/plugins/${id}/config`, { data: { key, value } });
    expect(res.ok(), `${id}.${key}: ${await res.text()}`).toBe(true);
  }
  await admin.close();
}

async function setPolicy(browser: Browser, patch: Record<string, unknown>): Promise<void> {
  const admin = await adminContext(browser);
  await putPolicy(admin, { ...original, ...patch });
  await admin.close();
}

function startMock(): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        if (!endpoint.up) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end('{"error":"down"}');
          return;
        }
        let parsed: { url?: string; host?: string } = {};
        try { parsed = JSON.parse(body); } catch { /* bad request below */ }
        endpoint.requests.push({ url: parsed.url ?? '', host: parsed.host ?? '', auth: String(req.headers.authorization ?? '') });
        const unsafe = (parsed.url ?? '').includes('/unsafe');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(unsafe
          ? { verdict: 'unsafe', reason: 'Known phishing page', cacheSeconds: 0 }
          : { verdict: 'safe', cacheSeconds: 0 }));
      });
    });
    server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server));
  });
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  requireEntEnv();
  requireRigEnv();
  test.skip(!existsSync(LINK_ZIP) || !existsSync(SEND_ZIP), `build the plugins first: ${LINK_ZIP}, ${SEND_ZIP}`);
  mock = await startMock();
  const admin = await adminContext(browser);
  original = await getPolicy(admin);
  untouched = structuredClone(original);
  modeBefore = (await (await admin.request.get('/api/admin/outgoing-hosts')).json()).noThirdPartyTraffic === true;
  await admin.request.get('/plugin-sandbox', { timeout: 120_000 });
  await installPlugin(admin, LINK, LINK_ZIP);
  await installPlugin(admin, SEND, SEND_ZIP);
  const features = { ...(original.features as Record<string, unknown>), pluginsEnabled: true };
  const forced = [...new Set([...((original.forceEnabledPlugins as string[] | undefined) ?? []), LINK, SEND])];
  original = { ...original, features, forceEnabledPlugins: forced };
  await putPolicy(admin, original);
  await admin.close();
  await setConfig(browser, LINK, {
    trustedDomains: '',
    lookup: 'endpoint',
    endpointUrl: `http://127.0.0.1:${MOCK_PORT}/check`,
    endpointToken: TOKEN,
    // A fake: the lookup mode never asks Google.
    safeBrowsingKey: 'it-fake-safe-browsing-key',
    onFailure: 'open',
    onUnsafe: 'warn',
    skipTrusted: true,
  });
  await setConfig(browser, SEND, {
    ibanAction: 'warn', ibanExternalOnly: false,
    cardAction: 'warn', cardExternalOnly: false,
    keywords: `TOPSECRET-${RUN}`, keywordAction: 'block', keywordExternalOnly: false,
    patterns: '', patternAction: 'warn', patternExternalOnly: false,
    blockedTypes: 'exe, bat, application/x-msdownload', allowedTypes: '', maxSizeMb: 0,
    attachmentAction: 'block', attachmentExternalOnly: false,
  });
});

test.afterAll(async ({ browser }) => {
  test.setTimeout(120_000);
  mock?.close();
  // Our messages go, in every ent account the spec wrote to.
  for (const account of [ENT.alice, ENT.bob, ENT.carol]) {
    const client = await jmapAs(account);
    const r = await client.request([['Email/query', { accountId: client.accountId, filter: { text: RUN }, limit: 100 }, '0']]);
    const ids = r.methodResponses?.[0]?.[1]?.ids ?? [];
    if (ids.length) await client.request([['Email/set', { accountId: client.accountId, destroy: ids }, '0']]).catch(() => {});
  }
  if (!untouched) return;
  const admin = await adminContext(browser);
  await putPolicy(admin, untouched);
  if (modeBefore !== undefined) await admin.request.patch('/api/admin/config', { data: { noThirdPartyTraffic: modeBefore } }).catch(() => {});
  await admin.request.delete('/api/admin/plugins', { data: { id: LINK } });
  await admin.request.delete('/api/admin/plugins', { data: { id: SEND } });
  await admin.close();
});

// ─── Helpers ─────────────────────────────────────────────────

async function messages(account: string, needle: string): Promise<{ id: string; subject: string }[]> {
  const client = await jmapAs(account);
  const r = await client.request([
    ['Email/query', { accountId: client.accountId, filter: { text: needle }, limit: 50 }, '0'],
    ['Email/get', { accountId: client.accountId, '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' }, properties: ['id', 'subject'] }, '1'],
  ]);
  return r.methodResponses[1][1].list;
}

async function waitForMessage(account: string, subject: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await messages(account, RUN)).some((m) => m.subject === subject)) {
    if (Date.now() > deadline) throw new Error(`${account}: no "${subject}"`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Exactly one message with `subject` arrived: the send that was stopped
 * earlier went nowhere, and the one let through after it did. The later
 * send is the fence, so nothing waits on a clock.
 */
async function expectSentOnce(account: string, subject: string): Promise<void> {
  await waitForMessage(account, subject);
  expect((await messages(account, RUN)).filter((m) => m.subject === subject)).toHaveLength(1);
}

/**
 * Both plugins started (the host notes the hooks of every plugin once it
 * has started it) and the message list is there, so the start-up requests
 * are done before the test sends anything.
 */
async function pluginsReady(page: Page): Promise<void> {
  await page.waitForFunction((ids) => ids.every((id) => localStorage.getItem(`plugin-declared-hooks:${id}`)), [LINK, SEND], { timeout: 60_000 });
  await expect(page.locator('[data-testid="email-list-item"]').first()).toBeVisible({ timeout: 60_000 });
}

async function clearBody(page: Page): Promise<void> {
  const editor = page.locator('[data-testid="email-composer"] [contenteditable="true"]').first();
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
}

async function openMessage(page: Page, subject: string): Promise<void> {
  const row = page.locator('[data-testid="email-list-item"], [data-thread-keys]', { hasText: subject }).first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.click();
  await expect(page.getByRole('heading', { name: subject }).first()).toBeVisible({ timeout: 20_000 });
}

const linkDialog = (page: Page) => page.locator(`[data-plugin-dialog="${LINK}"]`);
const sendDialog = (page: Page) => page.locator(`[data-plugin-dialog="${SEND}"]`);
// The message body: the reader's iframe carries the mail in srcdoc (plugin frames load a URL).
const body = (page: Page) => page.frameLocator('iframe[srcdoc]:visible').first();

/** Answers every request to the test link host, so an opened tab lands somewhere. */
async function routeLinks(context: BrowserContext): Promise<void> {
  await context.route(`https://*.${LINK_HOST}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Target</h1>' }));
}

/** A mail to ent-alice with the three links. */
async function deliverLinks(subject: string): Promise<void> {
  await deliver({
    from: ENT.bob,
    to: [ENT.alice],
    subject,
    text: 'Links',
    html: [
      `<p><a href="https://bad.${LINK_HOST}/unsafe/${RUN}">https://bank.example.com/login</a></p>`,
      `<p><a href="https://good.${LINK_HOST}/safe/${RUN}">Safe page</a></p>`,
    ].join(''),
  });
  await waitForMessage(ENT.alice, subject);
}

async function compose(page: Page, to: string[], subject: string, text: string): Promise<void> {
  await page.keyboard.press('c');
  const composer = page.locator('[data-testid="email-composer"]');
  await composer.waitFor({ state: 'visible', timeout: 15_000 });
  const input = page.locator('[data-testid="composer-to"] input').first();
  for (const address of to) {
    await input.click();
    await input.fill(address);
    await input.press('Enter');
  }
  await page.locator('[data-testid="composer-subject"]').first().fill(subject);
  await composer.locator('[contenteditable="true"]').first().click();
  await page.keyboard.type(text);
}

async function pressSend(page: Page): Promise<void> {
  // A send still winding down after a "Go back" ignores another one.
  await expect(page.getByTestId('composer-send').first()).toBeEnabled({ timeout: 20_000 });
  await page.locator('[data-testid="composer-subject"]').first().focus();
  await page.keyboard.press('Control+Enter');
}

/** "Go back" in the send check's warning: it closes and the composer is ready again. */
async function goBack(page: Page): Promise<void> {
  const dialog = page.locator(`[data-plugin-dialog="${SEND}"]`);
  await dialog.getByRole('button', { name: 'Go back' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Message not sent').first()).toBeVisible({ timeout: 20_000 });
}

const IBAN = 'DE89 3704 0044 0532 0130 00';
const CARD = '4242 4242 4242 4242';

// ─── Item 4: link check ──────────────────────────────────────

test('item 4: an unsafe verdict warns, with the real target domain and what the link text claims', async ({ browser }) => {
  const subject = `Links unsafe ${RUN}`;
  await deliverLinks(subject);
  const alice = await userPage(browser, ENT.alice);
  await routeLinks(alice.context());
  await pluginsReady(alice);
  await openMessage(alice, subject);
  endpoint.requests = [];
  await body(alice).getByRole('link', { name: 'https://bank.example.com/login' }).click();
  const dialog = linkDialog(alice);
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await expect(dialog).toContainText('This link may be dangerous');
  await expect(dialog).toContainText(`bad.${LINK_HOST}`);
  await expect(dialog).toContainText('Known phishing page');
  await expect(dialog).toContainText(`The link text says bank.example.com, but the link goes to bad.${LINK_HOST}.`);
  // The service got the full URL, with the admin's token.
  expect(endpoint.requests).toEqual([{ url: `https://bad.${LINK_HOST}/unsafe/${RUN}`, host: `bad.${LINK_HOST}`, auth: `Bearer ${TOKEN}` }]);
  await shot(alice, 'e-link-unsafe');
  await dialog.getByRole('button', { name: 'Go back' }).click();
  await expect(dialog).toBeHidden();
  expect(alice.context().pages()).toHaveLength(1);
  await alice.context().close();
});

test('item 4: a safe link opens after the domain warning, and a middle-click goes through the check too', async ({ browser }) => {
  const subject = `Links safe ${RUN}`;
  await deliverLinks(subject);
  const alice = await userPage(browser, ENT.alice);
  await routeLinks(alice.context());
  await pluginsReady(alice);
  await openMessage(alice, subject);
  await body(alice).getByRole('link', { name: 'Safe page' }).click();
  const dialog = linkDialog(alice);
  await expect(dialog).toContainText('Open external link?', { timeout: 20_000 });
  await expect(dialog).toContainText(`good.${LINK_HOST}`);
  await expect(dialog).toContainText('Checked: no known threats.');
  const opened = alice.context().waitForEvent('page');
  await dialog.getByRole('button', { name: 'Continue' }).click();
  // "Always trust" comes next; this once only.
  const trust = linkDialog(alice).getByRole('button', { name: 'Just this once' });
  await trust.click({ timeout: 10_000 }).catch(() => {});
  const tab = await opened;
  expect(tab.url()).toBe(`https://good.${LINK_HOST}/safe/${RUN}`);
  await tab.close();

  // A middle-click used to open the link in a new tab with no check.
  await body(alice).getByRole('link', { name: 'https://bank.example.com/login' }).click({ button: 'middle' });
  await expect(linkDialog(alice)).toContainText('This link may be dangerous', { timeout: 20_000 });
  await linkDialog(alice).getByRole('button', { name: 'Go back' }).click();
  expect(alice.context().pages()).toHaveLength(1);
  await alice.context().close();
});

test('item 4: with the service down, fail open lets the user go on and fail closed does not', async ({ browser }) => {
  const subject = `Links down ${RUN}`;
  await deliverLinks(subject);
  endpoint.up = false;
  try {
    const alice = await userPage(browser, ENT.alice);
    await routeLinks(alice.context());
    await pluginsReady(alice);
    await openMessage(alice, subject);
    await body(alice).getByRole('link', { name: 'Safe page' }).click();
    const dialog = linkDialog(alice);
    await expect(dialog).toContainText("Couldn't check this link.", { timeout: 20_000 });
    await expect(dialog).toContainText(`good.${LINK_HOST}`);
    await expect(dialog.getByRole('button', { name: 'Continue' })).toBeEnabled();
    await shot(alice, 'e-link-fail-open');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await alice.context().close();

    await setConfig(browser, LINK, { onFailure: 'closed' });
    const again = await userPage(browser, ENT.alice);
    await routeLinks(again.context());
    await pluginsReady(again);
    await openMessage(again, subject);
    await body(again).getByRole('link', { name: 'Safe page' }).click();
    const closed = linkDialog(again);
    await expect(closed).toContainText("Link couldn't be checked", { timeout: 20_000 });
    await expect(closed).toContainText(`good.${LINK_HOST}`);
    await expect(closed.getByRole('button', { name: 'Continue' })).toHaveCount(0);
    await shot(again, 'e-link-fail-closed');
    await closed.getByRole('button', { name: 'Close' }).click();
    expect(again.context().pages()).toHaveLength(1);
    await again.context().close();
  } finally {
    endpoint.up = true;
    await setConfig(browser, LINK, { onFailure: 'open' });
  }
});

test('item 4: with no third-party traffic the company service still answers, and Security lists it', async ({ browser }) => {
  const subject = `Links mode ${RUN}`;
  await deliverLinks(subject);
  const admin = await adminContext(browser);
  const on = await admin.request.patch('/api/admin/config', { data: { noThirdPartyTraffic: true } });
  expect(on.ok(), await on.text()).toBe(true);
  try {
    const page = await admin.newPage();
    await page.goto('/admin/org-security');
    const reachable = page.getByTestId('third-party-reachable');
    await expect(reachable).toContainText(`127.0.0.1:${MOCK_PORT}`, { timeout: 20_000 });
    await expect(reachable).toContainText('Plugin External Link Warning');
    await expect(page.locator('[data-settings-section="third-party"]')).toContainText('safebrowsing.googleapis.com stays off');
    await shot(page, 'e-link-admin-security');

    const alice = await userPage(browser, ENT.alice);
    await routeLinks(alice.context());
    await pluginsReady(alice);
    await openMessage(alice, subject);
    endpoint.requests = [];
    await body(alice).getByRole('link', { name: 'https://bank.example.com/login' }).click();
    await expect(linkDialog(alice)).toContainText('This link may be dangerous', { timeout: 20_000 });
    expect(endpoint.requests).toHaveLength(1);
    await linkDialog(alice).getByRole('button', { name: 'Go back' }).click();
    await alice.context().close();
  } finally {
    await admin.request.patch('/api/admin/config', { data: { noThirdPartyTraffic: false } });
    await admin.close();
  }
});

test('item 4: the link dialog fits at 390 px', async ({ browser }) => {
  const subject = `Links phone ${RUN}`;
  await deliverLinks(subject);
  const alice = await userPage(browser, ENT.alice, true);
  await routeLinks(alice.context());
  await pluginsReady(alice);
  await openMessage(alice, subject);
  await body(alice).getByRole('link', { name: 'https://bank.example.com/login' }).click();
  const dialog = linkDialog(alice);
  await expect(dialog).toContainText('This link may be dangerous', { timeout: 20_000 });
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(await alice.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await shot(alice, 'e-link-phone');
  await alice.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await alice.context().close();
});

// ─── Item 5: send checks ─────────────────────────────────────

test('item 5: an IBAN and a card number warn, masked; Go back keeps the mail, Send anyway sends it', async ({ browser }) => {
  const subject = `Send IBAN ${RUN}`;
  const alice = await userPage(browser, ENT.alice);
  await pluginsReady(alice);
  await compose(alice, [ENT.bob], subject, `Please pay to ${IBAN}, card ${CARD}.`);
  await pressSend(alice);
  const dialog = sendDialog(alice);
  await expect(dialog).toContainText('Check before sending', { timeout: 20_000 });
  await expect(dialog).toContainText('IBAN DE89');
  await expect(dialog).toContainText('Card number ending 4242');
  await expect(dialog).not.toContainText('0532 0130');
  await expect(dialog).not.toContainText(CARD);
  await shot(alice, 'e-send-warn');
  await goBack(alice);
  await expect(alice.locator('[data-testid="email-composer"]')).toBeVisible();

  await pressSend(alice);
  await expect(dialog).toContainText('Check before sending', { timeout: 20_000 });
  await dialog.getByRole('button', { name: 'Send anyway' }).click();
  // One message: Go back sent nothing.
  await expectSentOnce(ENT.bob, subject);
  await alice.context().close();
});

test('item 5: a block rule stops the send', async ({ browser }) => {
  const subject = `Send block ${RUN}`;
  const alice = await userPage(browser, ENT.alice);
  await pluginsReady(alice);
  await compose(alice, [ENT.bob], subject, `This is TOPSECRET-${RUN} material.`);
  await pressSend(alice);
  const dialog = sendDialog(alice);
  await expect(dialog).toContainText("This message can't be sent", { timeout: 20_000 });
  await expect(dialog).toContainText(`TOPSECRET-${RUN}`);
  await expect(dialog.getByRole('button', { name: 'Send anyway' })).toHaveCount(0);
  await shot(alice, 'e-send-block');
  await alice.keyboard.press('Escape');
  await expect(alice.locator('[data-testid="email-composer"]')).toBeVisible();
  // Without the word it goes, once: the blocked send went nowhere.
  await clearBody(alice);
  await alice.keyboard.type('Nothing secret here.');
  await pressSend(alice);
  await expectSentOnce(ENT.bob, subject);
  await alice.context().close();
});

test('item 4: an unsafe verdict blocks the link when the admin says so', async ({ browser }) => {
  const subject = `Links block ${RUN}`;
  await deliverLinks(subject);
  await setConfig(browser, LINK, { onUnsafe: 'block' });
  try {
    const alice = await userPage(browser, ENT.alice);
    await routeLinks(alice.context());
    await pluginsReady(alice);
    await openMessage(alice, subject);
    await body(alice).getByRole('link', { name: 'https://bank.example.com/login' }).click();
    const dialog = linkDialog(alice);
    await expect(dialog).toContainText('Link blocked', { timeout: 20_000 });
    await expect(dialog).toContainText(`bad.${LINK_HOST}`);
    await expect(dialog.getByRole('button', { name: 'Open anyway' })).toHaveCount(0);
    await shot(alice, 'e-link-blocked');
    await dialog.getByRole('button', { name: 'Close' }).click();
    expect(alice.context().pages()).toHaveLength(1);
    await alice.context().close();
  } finally {
    await setConfig(browser, LINK, { onUnsafe: 'warn' });
  }
});

test('item 5: an external-only rule ignores internal recipients, with the domain from a group scope for its members only', async ({ browser }) => {
  await setConfig(browser, SEND, { ibanExternalOnly: true });
  // partner.invalid is internal for ent-team (ent-alice) only. An .invalid
  // domain: the copy the server tries to deliver there goes nowhere real.
  await setPolicy(browser, {
    scopes: [{ id: 'ent-e-partner', label: 'Partner', match: { groups: [ENT.team] }, policy: { organisation: { externalMail: { domains: ['partner.invalid'] } } } }],
  });
  try {
    const internal = `Send internal ${RUN}`;
    const alice = await userPage(browser, ENT.alice);
    await pluginsReady(alice);
    await compose(alice, [ENT.bob, 'someone@partner.invalid'], internal, `IBAN ${IBAN}`);
    await pressSend(alice);
    await waitForMessage(ENT.bob, internal);
    await expect(sendDialog(alice)).toHaveCount(0);
    await alice.context().close();

    // ent-carol is in no group: partner.invalid is outside for her.
    const outside = `Send outside ${RUN}`;
    const carol = await userPage(browser, ENT.carol);
    await pluginsReady(carol);
    await compose(carol, [ENT.bob, 'someone@partner.invalid'], outside, `IBAN ${IBAN}`);
    await pressSend(carol);
    const dialog = sendDialog(carol);
    await expect(dialog).toContainText('IBAN DE89', { timeout: 20_000 });
    await expect(dialog).toContainText('goes outside your organisation');
    await goBack(carol);
    await pressSend(carol);
    await sendDialog(carol).getByRole('button', { name: 'Send anyway' }).click();
    await expectSentOnce(ENT.bob, outside);
    await carol.context().close();
  } finally {
    await setConfig(browser, SEND, { ibanExternalOnly: false });
    await setPolicy(browser, { scopes: (original.scopes as unknown[] | undefined) ?? [] });
  }
});

test('item 5: a program is refused as an attachment, also renamed to .pdf', async ({ browser }) => {
  const alice = await userPage(browser, ENT.alice);
  await pluginsReady(alice);
  await compose(alice, [ENT.bob], `Send attachment ${RUN}`, 'See the file.');
  const program = Buffer.concat([Buffer.from('MZ'), Buffer.from([0x90, 0, 3, 0, 0, 0, 4, 0]), Buffer.alloc(200, 0)]);
  const input = alice.locator('[data-testid="email-composer"] input[type="file"]').first();
  await input.setInputFiles({ name: 'tool.exe', mimeType: 'application/octet-stream', buffer: program });
  const dialog = sendDialog(alice);
  await expect(dialog).toContainText("This file can't be attached", { timeout: 20_000 });
  await expect(dialog).toContainText('tool.exe');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toBeHidden();
  await input.setInputFiles({ name: 'invoice.pdf', mimeType: 'application/pdf', buffer: program });
  await expect(dialog).toContainText('invoice.pdf', { timeout: 20_000 });
  await shot(alice, 'e-send-attachment');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toBeHidden();
  await expect(alice.locator('[data-testid="email-composer"]').getByText('invoice.pdf')).toHaveCount(0);
  await expect(alice.locator('[data-testid="email-composer"]').getByText('tool.exe')).toHaveCount(0);
  await alice.context().close();
});

test('item 5: a quick reply is checked too', async ({ browser }) => {
  const subject = `Quick ${RUN}`;
  await deliver({ from: ENT.bob, to: [ENT.alice], subject, text: 'Where do I pay?' });
  await waitForMessage(ENT.alice, subject);
  const alice = await userPage(browser, ENT.alice);
  await pluginsReady(alice);
  await openMessage(alice, subject);
  const box = alice.getByPlaceholder('Write a quick reply...');
  await box.fill(`To ${IBAN} please`);
  await box.press('Control+Enter');
  const dialog = sendDialog(alice);
  await expect(dialog).toContainText('IBAN DE89', { timeout: 20_000 });
  await goBack(alice);
  // The typed text stays.
  await expect(box).toHaveValue(`To ${IBAN} please`);
  await box.fill('I will pay by card in person.');
  await box.press('Control+Enter');
  await expect(box).toHaveValue('', { timeout: 30_000 });
  // One reply: the stopped one went nowhere.
  await expectSentOnce(ENT.bob, `Re: ${subject}`);
  await alice.context().close();
});

test('item 5: the send dialog fits at 390 px', async ({ browser }) => {
  const alice = await userPage(browser, ENT.alice, true);
  await pluginsReady(alice);
  await alice.getByRole('button', { name: /^(Compose|New message|Write)/ }).first().click().catch(() => alice.keyboard.press('c'));
  const composer = alice.locator('[data-testid="email-composer"]');
  await composer.waitFor({ state: 'visible', timeout: 15_000 });
  const input = alice.locator('[data-testid="composer-to"] input').first();
  await input.fill(ENT.bob);
  await input.press('Enter');
  await alice.locator('[data-testid="composer-subject"]').first().fill(`Send phone ${RUN}`);
  await composer.locator('[contenteditable="true"]').first().click();
  await alice.keyboard.type(`Card ${CARD}`);
  await alice.getByTestId('composer-send').first().click();
  const dialog = sendDialog(alice);
  await expect(dialog).toContainText('Card number ending 4242', { timeout: 20_000 });
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(await alice.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await shot(alice, 'e-send-phone');
  await goBack(alice);
  await alice.context().close();
});

test('item 5: a keyword the admin adds on the plugin page warns at the next send', async ({ browser }) => {
  const word = `Projekt-${RUN}`;
  const admin = await adminContext(browser);
  const page = await admin.newPage();
  await page.goto(`/admin/plugins/${SEND}`);
  await expect(page.getByText('IBANs', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  const keywords = page.getByRole('textbox', { name: 'Keywords', exact: true });
  await keywords.fill(`TOPSECRET-${RUN}\n${word}`);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => {
    const res = await admin.request.get(`/api/admin/plugins/${SEND}/config`);
    return String((await res.json()).keywords ?? '');
  }, { timeout: 20_000 }).toContain(word);
  await shot(page, 'e-send-admin');
  await admin.close();

  const subject = `Send admin keyword ${RUN}`;
  const alice = await userPage(browser, ENT.alice);
  await pluginsReady(alice);
  await compose(alice, [ENT.bob], subject, `About ${word}.`);
  await pressSend(alice);
  // TOPSECRET is a block rule; the new word is on the same list, so it blocks too.
  await expect(sendDialog(alice)).toContainText(word, { timeout: 20_000 });
  await alice.keyboard.press('Escape');
  await alice.context().close();
  await setConfig(browser, SEND, { keywords: `TOPSECRET-${RUN}` });
});

// A required send check that never started used to let every message through.
test("item 5: sending is held while the required check isn't running", async ({ browser }) => {
  const subject = `Send held ${RUN}`;
  const alice = await userPage(browser, ENT.alice);
  await pluginsReady(alice);
  // From now on the plugin frames can't load: the next start of the plugins fails.
  await alice.context().route('**/plugin-sandbox**', (route) => route.abort());
  await alice.reload();
  await expect(alice.locator('[data-testid="email-list-item"]').first()).toBeVisible({ timeout: 60_000 });
  await compose(alice, [ENT.bob], subject, 'Nothing to check here.');
  await pressSend(alice);
  // First it waits for the check, then says it isn't running; once the start
  // has failed for good it says it stopped working.
  await expect(alice.getByText(/A check your organisation requires (isn't running|has stopped working)/).first()).toBeVisible({ timeout: 45_000 });
  await expect(alice.locator('[data-testid="email-composer"]')).toBeVisible();
  await shot(alice, 'e-send-held');
  // With the plugins running again the same message goes, once: the held
  // send went nowhere.
  await alice.context().unroute('**/plugin-sandbox**');
  await alice.reload();
  await pluginsReady(alice);
  await compose(alice, [ENT.bob], subject, 'Nothing to check here.');
  await pressSend(alice);
  await expectSentOnce(ENT.bob, subject);
  await alice.context().close();
});
