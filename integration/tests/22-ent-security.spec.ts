import { test, expect, type Browser, type Page } from '@playwright/test';
import { folderRow } from './helpers/app';
import {
  ENT,
  ENT_PASSWORD,
  adminContext,
  contextOptions,
  deliver,
  getPolicy,
  jmapAs,
  putPolicy,
  rawMessage,
  requireEntEnv,
  shot,
  userPage,
} from './helpers/ent';
import { neutralizeDevOverlay, accountSwitcher } from './helpers/app';

/**
 * Enterprise pack, package A (mail security core), through the real UI on a
 * VM 106 test Stalwart with the ent-* accounts:
 * - item 1: the organisation's locked "block remote content" holds for
 *   trusted senders (list and address book; passes on main since
 *   f8805b8d5), the trusted-senders list offers no Add under the lock, and
 *   a reply draft started before the lock loads no remote image when
 *   reopened;
 * - item 2: Report phishing sends the message to ent-sec as an attachment
 *   (and as ARF), with no copy in Sent, and moves it to Junk with $phishing;
 * - item 3: a required classification label blocks sending until picked,
 *   SIO-Label and Sensitivity arrive, quick reply and a Pro compose tab keep
 *   it, a group scope gets its own scheme.
 * Setup goes through the admin API and JMAP; the policy is put back at the end.
 */

test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

const RUN = Date.now().toString(36);
const PIXEL = `https://ent-pixel.example.org/${RUN}.png`;
const LOCK = { externalContentPolicy: { locked: true, value: 'block' } };
const GENERIC_LABELS = [
  { id: 'public', name: 'Public', color: '#16a34a', marking: 'PUBLIC', description: '', sensitivity: '', subjectPrefix: '', extraHeaderValue: '' },
  { id: 'internal', name: 'Internal', color: '#2563eb', marking: 'INTERNAL', description: '', sensitivity: '', subjectPrefix: '', extraHeaderValue: '' },
  { id: 'confidential', name: 'Confidential', color: '#d97706', marking: 'CONFIDENTIAL', description: '', sensitivity: 'Company-Confidential', subjectPrefix: '[Confidential]', extraHeaderValue: '' },
];
const GERMAN_LABELS = [
  { id: 'offen', name: 'OFFEN', color: '#6b7280', marking: 'OFFEN', description: '', sensitivity: '', subjectPrefix: '', extraHeaderValue: '' },
  { id: 'vs-nfd', name: 'VS-NfD', color: '#b91c1c', marking: 'VS-NUR FÜR DEN DIENSTGEBRAUCH', description: '', sensitivity: 'Company-Confidential', subjectPrefix: 'VS-NfD', extraHeaderValue: '' },
];

let original: Record<string, unknown>;

interface Msg {
  id: string;
  subject: string;
  blobId: string;
  keywords: Record<string, boolean>;
  mailboxIds: Record<string, boolean>;
  attachments?: Array<{ type: string; name?: string }>;
}

/** Messages of `account` whose text has `needle` (the subject filter doesn't find "Re:" subjects). */
async function messages(account: string, needle: string): Promise<Msg[]> {
  const client = await jmapAs(account);
  const r = await client.request([
    ['Email/query', { accountId: client.accountId, filter: { text: needle }, limit: 50 }, '0'],
    ['Email/get', {
      accountId: client.accountId,
      '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' },
      properties: ['id', 'subject', 'blobId', 'keywords', 'mailboxIds', 'attachments'],
    }, '1'],
  ]);
  return r.methodResponses[1][1].list as Msg[];
}

async function waitForMessage(account: string, needle: string, match: (m: Msg) => boolean, timeoutMs = 60_000): Promise<Msg> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = (await messages(account, needle)).find(match);
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(`${account}: nothing for "${needle}" (has: ${(await messages(account, needle)).map((m) => m.subject).join(' | ')})`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function roleMailboxId(account: string, role: string): Promise<string> {
  return (await (await jmapAs(account)).mailboxByRole(role))!.id;
}

async function policy(patch: { organisation?: Record<string, unknown>; restrictions?: Record<string, unknown>; scopes?: unknown[] }, browser: Browser) {
  const admin = await adminContext(browser);
  await putPolicy(admin, {
    ...original,
    organisation: { ...((original.organisation as object) ?? {}), ...(patch.organisation ?? {}) },
    restrictions: { ...((original.restrictions as object) ?? {}), ...(patch.restrictions ?? {}) },
    scopes: patch.scopes ?? [],
  });
  await admin.close();
}

/** Signs in with settings seeded before the app boots. */
async function seededPage(browser: Browser, email: string, settings: Record<string, unknown>, phone = false): Promise<Page> {
  const context = await browser.newContext(contextOptions(phone));
  const page = await context.newPage();
  await neutralizeDevOverlay(page);
  await page.addInitScript((s) => {
    if (!sessionStorage.getItem('ent-seeded')) {
      localStorage.setItem('settings-storage', JSON.stringify({ state: s, version: 7 }));
      sessionStorage.setItem('ent-seeded', '1');
    }
  }, settings);
  await page.goto('/');
  await page.fill('#username', email);
  await page.fill('#password', ENT_PASSWORD);
  await page.click('button[type="submit"]');
  await accountSwitcher(page).waitFor({ state: 'visible', timeout: 60_000 });
  return page;
}

async function openMessage(page: Page, subject: string): Promise<void> {
  // By text: a thread row carries its newest message's subject.
  const row = page.locator('[data-testid="email-list-item"], [data-thread-keys]', { hasText: subject }).first();
  await expect(row).toBeVisible({ timeout: 60_000 }).catch(async (error) => {
    const rows = await page.locator('[data-testid="email-list-item"]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-subject')} | ${(e as HTMLElement).innerText.replace(/\s+/g, ' ').slice(0, 80)}`));
    console.log('rows:', JSON.stringify(rows), 'url:', page.url());
    await page.screenshot({ path: `C:/Users/info/AppData/Local/Temp/claude/ent-a-fail-${Date.now()}.png` }).catch(() => {});
    throw error;
  });
  await row.click();
  await expect(page.getByRole('heading', { name: subject }).first()).toBeVisible({ timeout: 20_000 });
}

/** Counts the requests the page makes to the test pixel. */
function pixelRequests(page: Page): { count: () => number } {
  let n = 0;
  void page.context().route('https://ent-pixel.example.org/**', (route) => {
    n++;
    void route.fulfill({ status: 200, contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAAAAACw=', 'base64') });
  });
  return { count: () => n };
}

/** Delivers and waits until every recipient has it, so the list shows it on sign-in. */
async function deliverAndWait(opts: Parameters<typeof deliver>[0]): Promise<void> {
  await deliver(opts);
  for (const to of opts.to) await waitForMessage(to, RUN, (m) => m.subject === opts.subject);
}

/**
 * The message/rfc822 part of a raw report, decoded. Stalwart writes a
 * message/rfc822 attachment base64-encoded (RFC 2046 §5.2.1 allows only
 * 7bit, 8bit or binary there); readers decode it either way.
 */
function attachedMessage(raw: string): string {
  const m = /Content-Type: message\/rfc822[\s\S]*?\r?\n\r?\n([\s\S]*?)\r?\n--/i.exec(raw);
  if (!m) return '';
  const head = raw.slice(m.index, m.index + m[0].length - m[1].length);
  return /Content-Transfer-Encoding:\s*base64/i.test(head) ? Buffer.from(m[1].replace(/\s+/g, ''), 'base64').toString('utf8') : m[1];
}

/** Trusts the open message's sender (a sender trusted in an earlier run already is). */
async function trustSender(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: 'Always trust this sender' });
  await page.waitForTimeout(1500);
  if (await button.isVisible()) await button.click();
  await expect(page.getByTestId('external-content-notice')).toBeHidden({ timeout: 20_000 });
}

const html = (text: string) => `<p>${text}</p><p><img src="${PIXEL}" alt="pixel"></p><p><a href="https://ent-link.example.org/login">Log in here</a></p>`;

async function composeAndSend(page: Page, to: string, subject: string, beforeSend?: () => Promise<void>): Promise<void> {
  await page.keyboard.press('c');
  const composer = page.locator('[data-testid="email-composer"]');
  await composer.waitFor({ state: 'visible', timeout: 15_000 });
  const input = page.locator('[data-testid="composer-to"] input').first();
  await input.click();
  await input.fill(to);
  await input.press('Enter');
  await page.locator('[data-testid="composer-subject"]').first().fill(subject);
  await composer.locator('[contenteditable="true"]').first().click();
  await page.keyboard.type(`Body of ${subject}`);
  if (beforeSend) await beforeSend();
  await page.locator('[data-testid="composer-subject"]').first().focus();
  await page.keyboard.press('Control+Enter');
}

test.beforeAll(async ({ browser }) => {
  requireEntEnv();
  const admin = await adminContext(browser);
  original = await getPolicy(admin);
  await putPolicy(admin, { ...original, scopes: [] });
  await admin.close();
});

test.afterAll(async ({ browser }) => {
  if (!original) return;
  const admin = await adminContext(browser);
  await putPolicy(admin, original);
  await admin.close();
});

// ─── Item 1: trusted senders vs the organisation's lock ──────────────────

test('item 1: a sender trusted in the list stays blocked once the organisation locks remote content (passes on main)', async ({ browser }) => {
  const subject = `Trust list ${RUN}`;
  await policy({}, browser);
  await deliverAndWait({ from: ENT.bob, to: [ENT.alice], subject, html: html('Newsletter') });
  const alice = await seededPage(browser, ENT.alice, { externalContentPolicy: 'block', trustedSendersAddressBook: false });
  const pixel = pixelRequests(alice);
  await openMessage(alice, subject);
  await trustSender(alice);
  await expect.poll(pixel.count, { timeout: 15_000 }).toBeGreaterThan(0);

  // Before the lock: a reply draft whose quote may load the image.
  await alice.keyboard.press('r');
  await alice.locator('[data-testid="email-composer"]').waitFor({ state: 'visible' });
  await alice.locator('[data-testid="email-composer"] [contenteditable="true"]').first().click();
  await alice.keyboard.type(`Draft before the lock ${RUN}`);
  await expect(alice.locator('[data-testid="composer-save-status"]')).toHaveAttribute('data-status', 'saved', { timeout: 30_000 });
  await alice.keyboard.press('Escape');
  await alice.context().close();

  await policy({ restrictions: LOCK }, browser);
  const locked = await seededPage(browser, ENT.alice, { externalContentPolicy: 'block' });
  const seen = await locked.evaluate(async () => (await (await fetch('/api/admin/policy')).json()).restrictions?.externalContentPolicy);
  expect(seen, 'the user gets the lock').toMatchObject({ locked: true, value: 'block' });
  const lockedPixel = pixelRequests(locked);
  await openMessage(locked, subject);
  await expect(locked.getByTestId('external-content-notice')).toContainText('Your organisation blocks content from other servers');
  await expect(locked.getByRole('button', { name: 'Always trust this sender' })).toHaveCount(0);
  const srcdoc = await locked.locator('iframe').first().getAttribute('srcdoc');
  // Blocked images keep the address only in data-blocked-src.
  expect(srcdoc ?? '').not.toMatch(/\ssrc="https:\/\/ent-pixel/);
  expect(lockedPixel.count()).toBe(0);
  await shot(locked, 'a-item1-locked-trusted');
  await locked.context().close();
});

test('item 1: under the lock the trusted senders list offers no Add (fails on main)', async ({ browser }) => {
  await policy({ restrictions: LOCK }, browser);
  const alice = await userPage(browser, ENT.alice);
  await alice.locator('a[href$="/settings"]').first().click();
  await alice.locator('[data-testid="settings-tab-reading"]').first().click();
  await expect(alice.getByText('Trusted senders').first()).toBeVisible();
  await alice.getByRole('button', { name: /^\d+ senders?$|None/ }).first().click();
  await expect(alice.getByText('Add sender manually')).toHaveCount(0);
  await shot(alice, 'a-item1-trusted-list-locked');
  await alice.context().close();
});

test('item 1: a reply draft from before the lock loads no remote image when reopened (fails on main)', async ({ browser }) => {
  await policy({ restrictions: LOCK }, browser);
  const alice = await seededPage(browser, ENT.alice, { externalContentPolicy: 'block' });
  const pixel = pixelRequests(alice);
  await folderRow(alice, { role: 'drafts' }).first().click();
  const row = alice.locator('[data-testid="email-list-item"], [data-thread-keys]', { hasText: `Trust list ${RUN}` }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await alice.getByTestId('edit-draft').waitFor({ state: 'visible' });
  await alice.waitForTimeout(2000);
  // Viewing the draft loads nothing either.
  expect(pixel.count(), 'requests while the draft is shown in the reader').toBe(0);
  await alice.getByTestId('edit-draft').click();
  await alice.locator('[data-testid="email-composer"]').waitFor({ state: 'visible', timeout: 20_000 });
  await alice.waitForTimeout(3000);
  expect(pixel.count()).toBe(0);
  const remote = await alice.locator(`[data-testid="email-composer"] img[src="${PIXEL}"]`).count();
  expect(remote).toBe(0);
  await alice.context().close();
});

test('item 1: a sender trusted in the address book stays blocked under the lock (passes on main)', async ({ browser }) => {
  const subject = `Trust book ${RUN}`;
  await policy({}, browser);
  await deliverAndWait({ from: ENT.carol, to: [ENT.alice], subject, html: html('From the book') });
  const alice = await seededPage(browser, ENT.alice, { externalContentPolicy: 'block', trustedSendersAddressBook: true });
  await openMessage(alice, subject);
  await trustSender(alice);
  await alice.context().close();

  await policy({ restrictions: LOCK }, browser);
  const locked = await seededPage(browser, ENT.alice, { externalContentPolicy: 'block', trustedSendersAddressBook: true });
  const pixel = pixelRequests(locked);
  await openMessage(locked, subject);
  await expect(locked.getByTestId('external-content-notice')).toContainText('Your organisation blocks content');
  expect(pixel.count()).toBe(0);
  await locked.context().close();
});

// ─── Item 2: Report phishing ─────────────────────────────────────────────

test('item 1: a lock set in a group scope holds for its members only, also before their groups are known', async ({ browser }) => {
  const subject = `Scoped lock ${RUN}`;
  await policy({ scopes: [{ id: 'team-lock', label: 'Team lock', match: { groups: [ENT.team] }, policy: { restrictions: LOCK } }] }, browser);
  await deliverAndWait({ from: ENT.bob, to: [ENT.alice, ENT.carol], subject, html: html('Scoped') });
  // ent-alice is in ent-team: blocked, with ent-bob trusted in the list.
  const alice = await seededPage(browser, ENT.alice, { externalContentPolicy: 'block', trustedSenders: [ENT.bob] });
  const pixel = pixelRequests(alice);
  await openMessage(alice, subject);
  await expect(alice.getByTestId('external-content-notice')).toContainText('Your organisation blocks content');
  expect(pixel.count()).toBe(0);
  await alice.context().close();
  // ent-carol isn't: her own choice applies, no organisation note.
  const carol = await seededPage(browser, ENT.carol, { externalContentPolicy: 'ask' });
  await openMessage(carol, subject);
  await expect(carol.getByTestId('external-content-notice')).toBeVisible();
  await expect(carol.getByTestId('external-content-notice')).not.toContainText('Your organisation blocks content');
  await carol.context().close();
});

test('item 2: the admin sets the report address on Organisation > Security', async ({ browser }) => {
  await policy({}, browser);
  const admin = await adminContext(browser);
  const page = await admin.newPage();
  await page.goto('/admin/org-security');
  const field = page.getByTestId('org-phishing-address');
  await field.scrollIntoViewIfNeeded();
  await field.fill('ent-sec@example.org');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await shot(page, 'a-phishing-admin');
  const stored = await getPolicy(admin);
  expect((stored.organisation as { phishingReport: unknown }).phishingReport).toEqual({ address: 'ent-sec@example.org', format: 'forward' });
  await admin.close();
});

test('item 2: Report phishing sends the message to ent-sec as an attachment and moves it to Junk with $phishing', async ({ browser }) => {
  const subject = `Phish one ${RUN}`;
  await policy({ organisation: { phishingReport: { address: ENT.sec, format: 'forward' } } }, browser);
  await deliverAndWait({ from: ENT.bob, to: [ENT.alice], subject, html: html('Your account is locked') });
  const alice = await userPage(browser, ENT.alice);
  await openMessage(alice, subject);
  await alice.getByRole('button', { name: 'More actions' }).first().click();
  await alice.getByTestId('ctx-report-phishing').click();
  const dialog = alice.getByTestId('phishing-report-dialog');
  await expect(dialog).toContainText(ENT.sec);
  await shot(alice, 'a-phishing-confirm');
  await alice.getByTestId('phishing-report-confirm').click();
  await expect(alice.getByText(`Reported to ${ENT.sec} and moved to Junk.`).first()).toBeVisible({ timeout: 30_000 });

  const report = await waitForMessage(ENT.sec, RUN, (m) => m.subject === `Phishing: ${subject}`);
  expect(report.attachments?.map((a) => a.type)).toEqual(['message/rfc822']);
  const raw = await rawMessage(ENT.sec, report.blobId);
  expect(raw).toContain('Reported as phishing by');
  expect(attachedMessage(raw)).toContain(`Subject: ${subject}`);

  const junk = await roleMailboxId(ENT.alice, 'junk');
  const moved = await waitForMessage(ENT.alice, RUN, (m) => m.subject === subject && !!m.mailboxIds[junk] && m.keywords.$phishing === true);
  expect(moved.keywords.$junk).toBe(true);
  // No copy in Sent.
  const sent = await roleMailboxId(ENT.alice, 'sent');
  expect((await messages(ENT.alice, RUN)).filter((m) => m.subject.startsWith('Phishing:') && m.mailboxIds[sent])).toEqual([]);

  // In Junk: the banner, and the link is off.
  await folderRow(alice, { role: 'junk' }).first().click();
  await openMessage(alice, subject);
  await expect(alice.getByTestId('phishing-mark-banner')).toContainText('You reported this message as phishing');
  const srcdoc = await alice.locator('iframe').first().getAttribute('srcdoc');
  expect(srcdoc ?? '').toContain('Log in here');
  expect(srcdoc ?? '').not.toContain('https://ent-link.example.org/login');
  await shot(alice, 'a-phishing-banner');
  await alice.context().close();
});

test('item 2: Undo after a report moves the message back and clears $phishing', async ({ browser }) => {
  const subject = `Phish undo ${RUN}`;
  await policy({ organisation: { phishingReport: { address: ENT.sec, format: 'forward' } } }, browser);
  await deliverAndWait({ from: ENT.bob, to: [ENT.alice], subject, text: 'Undo check' });
  const alice = await userPage(browser, ENT.alice);
  await openMessage(alice, subject);
  await alice.getByRole('button', { name: 'More actions' }).first().click();
  await alice.getByTestId('ctx-report-phishing').click();
  await alice.getByTestId('phishing-report-confirm').click();
  const toast = alice.getByText(`Reported to ${ENT.sec} and moved to Junk.`).first();
  await expect(toast).toBeVisible({ timeout: 30_000 });
  await alice.getByRole('button', { name: 'Undo', exact: true }).first().click();
  await expect(alice.getByText('Moved back. The report was already sent.').first()).toBeVisible({ timeout: 30_000 });
  const inbox = await roleMailboxId(ENT.alice, 'inbox');
  const back = await waitForMessage(ENT.alice, RUN, (m) => m.subject === subject && !!m.mailboxIds[inbox]);
  expect(back.keywords.$phishing).toBeUndefined();
  expect(back.keywords.$junk).toBeUndefined();
  // The report itself went out.
  await waitForMessage(ENT.sec, RUN, (m) => m.subject === `Phishing: ${subject}`);
  await alice.context().close();
});

test('item 2: the ARF format arrives as a feedback report', async ({ browser }) => {
  const subject = `Phish arf ${RUN}`;
  await policy({ organisation: { phishingReport: { address: ENT.sec, format: 'arf' } } }, browser);
  await deliverAndWait({ from: ENT.bob, to: [ENT.alice], subject, text: 'Click here' });
  const alice = await userPage(browser, ENT.alice);
  await alice.locator(`[data-testid="email-list-item"][data-subject="${subject}"]`).first().click({ button: 'right', timeout: 60_000 });
  await alice.getByTestId('ctx-report-phishing').click();
  await alice.getByTestId('phishing-report-confirm').click();
  await expect(alice.getByText(`Reported to ${ENT.sec} and moved to Junk.`).first()).toBeVisible({ timeout: 30_000 });
  const report = await waitForMessage(ENT.sec, RUN, (m) => m.subject === `Phishing: ${subject}`);
  const raw = await rawMessage(ENT.sec, report.blobId);
  expect(raw).toMatch(/Content-Type: multipart\/report; report-type=feedback-report/);
  expect(raw).toContain('Feedback-Type: fraud');
  expect(raw).toContain('Version: 1');
  expect(raw).toMatch(/User-Agent: Bulwark\//);
  expect(raw).toContain('Content-Type: message/rfc822');
  expect(attachedMessage(raw)).toContain(`Subject: ${subject}`);
  await alice.context().close();
});

test('item 2: a group scope reports for ent-team only; ent-carol has no action', async ({ browser }) => {
  const subject = `Phish scope ${RUN}`;
  await policy({
    organisation: { phishingReport: { address: '', format: 'forward' } },
    scopes: [{ id: 'team', label: 'Team', match: { groups: [ENT.team] }, policy: { organisation: { phishingReport: { address: ENT.sec } } } }],
  }, browser);
  await deliverAndWait({ from: ENT.bob, to: [ENT.carol, ENT.alice], subject, text: 'Scope check' });
  const carol = await userPage(browser, ENT.carol);
  await openMessage(carol, subject);
  await carol.getByRole('button', { name: 'More actions' }).first().click();
  await expect(carol.getByTestId('ctx-report-phishing')).toHaveCount(0);
  await carol.context().close();
  const alice = await userPage(browser, ENT.alice);
  await openMessage(alice, subject);
  await alice.getByRole('button', { name: 'More actions' }).first().click();
  await expect(alice.getByTestId('ctx-report-phishing')).toBeVisible();
  await alice.context().close();
});

test('item 2: the reader action and the confirm fit a phone', async ({ browser }) => {
  const subject = `Phish phone ${RUN}`;
  await policy({ organisation: { phishingReport: { address: ENT.sec, format: 'forward' } } }, browser);
  await deliverAndWait({ from: ENT.bob, to: [ENT.alice], subject, text: 'Phone check' });
  const alice = await userPage(browser, ENT.alice, true);
  await openMessage(alice, subject);
  await alice.getByRole('button', { name: 'More actions' }).first().click();
  const action = alice.getByText('Report phishing…').first();
  await expect(action).toBeVisible();
  await shot(alice, 'a-phishing-phone-menu');
  await action.click();
  const dialog = alice.getByTestId('phishing-report-dialog');
  const box = await dialog.boundingBox();
  expect(box && box.x).toBeGreaterThanOrEqual(0);
  expect(box && box.x + box.width).toBeLessThanOrEqual(390);
  await shot(alice, 'a-phishing-phone-confirm');
  await alice.getByTestId('phishing-report-cancel').click();
  await expect(dialog).toHaveCount(0);
  expect(await alice.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await alice.context().close();
});

// ─── Item 3: classification labels ───────────────────────────────────────

test('item 3: the admin applies a preset and requires a label on Organisation > Classification', async ({ browser }) => {
  await policy({}, browser);
  const admin = await adminContext(browser);
  const page = await admin.newPage();
  await page.goto('/admin/org-labels');
  await expect(page.getByTestId('org-labels-vsnfd-warning')).toBeVisible();
  await page.getByTestId('org-labels-preset').selectOption('generic');
  await expect(page.getByTestId('org-label-item')).toHaveCount(4);
  await page.getByTestId('org-labels-required').click();
  await page.getByTestId('org-labels-default').selectOption('');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await shot(page, 'a-labels-admin');
  const stored = (await getPolicy(admin)).organisation as { labels: { list: unknown[]; required: boolean; defaultId: string } };
  expect(stored.labels.list).toHaveLength(4);
  expect(stored.labels).toMatchObject({ required: true, defaultId: '' });
  await admin.close();
});

test('item 3: a required label blocks sending until one is picked; SIO-Label and Sensitivity arrive', async ({ browser }) => {
  const subject = `Label send ${RUN}`;
  await policy({ organisation: { labels: { list: GENERIC_LABELS, defaultId: '', required: true, extraHeader: '' } } }, browser);
  const alice = await userPage(browser, ENT.alice);
  await composeAndSend(alice, ENT.bob, subject);
  await expect(alice.getByText('Pick a classification label before sending.').first()).toBeVisible();
  await expect(alice.getByTestId('composer-classification-options')).toBeVisible();
  await expect(alice.locator('[data-testid="email-composer"]')).toBeVisible();
  await shot(alice, 'a-labels-required');
  await alice.getByTestId('composer-classification-option-confidential').click();
  await expect(alice.getByTestId('composer-classification-trigger')).toContainText('Confidential');
  await alice.locator('[data-testid="composer-subject"]').first().focus();
  await alice.keyboard.press('Control+Enter');
  await expect(alice.locator('[data-testid="email-composer"]')).toBeHidden({ timeout: 30_000 });

  const got = await waitForMessage(ENT.bob, RUN, (m) => m.subject === `[Confidential] ${subject}`);
  const raw = await rawMessage(ENT.bob, got.blobId);
  expect(raw).toMatch(/^SIO-Label: marking="CONFIDENTIAL"; fgcolor=#[0-9a-f]{6}; bgcolor=#d97706\r?$/m);
  expect(raw).toMatch(/^Sensitivity: Company-Confidential\r?$/m);
  await alice.context().close();

  // The recipient sees the label.
  const bob = await userPage(browser, ENT.bob);
  await openMessage(bob, `[Confidential] ${subject}`);
  await expect(bob.getByTestId('received-label-chip').first()).toHaveText('Confidential');
  await shot(bob, 'a-labels-received-chip');
  await bob.context().close();
});

test('item 3: Undo send brings the message back with its label', async ({ browser }) => {
  const subject = `Undo label ${RUN}`;
  await policy({ organisation: { labels: { list: GENERIC_LABELS, defaultId: 'internal', required: true, extraHeader: '' } } }, browser);
  const alice = await userPage(browser, ENT.alice);
  // Undo send on, through Settings (a synced setting).
  await alice.locator('a[href$="/settings"]').first().click();
  await alice.locator('[data-testid="settings-tab-composing"]').first().click();
  const delay = alice.locator('[data-search-label="Undo send / send delay"] select').first();
  await delay.selectOption('30');
  await alice.getByText('Back to mail').first().click();
  await folderRow(alice, { role: 'inbox' }).first().waitFor({ state: 'visible', timeout: 30_000 });
  await composeAndSend(alice, ENT.bob, subject, async () => {
    await alice.getByTestId('composer-classification-trigger').click();
    await alice.getByTestId('composer-classification-option-confidential').click();
  });
  await alice.getByRole('button', { name: 'Undo send' }).first().click({ timeout: 20_000 });
  await expect(alice.locator('[data-testid="email-composer"]')).toBeVisible({ timeout: 20_000 });
  // Not the default (Internal): the label it was sent with.
  await expect(alice.getByTestId('composer-classification-trigger')).toContainText('Confidential');
  await alice.locator('[data-testid="composer-subject"]').first().focus();
  await alice.keyboard.press('Control+Enter');
  await expect(alice.locator('[data-testid="email-composer"]')).toBeHidden({ timeout: 30_000 });
  const got = await waitForMessage(ENT.bob, RUN, (m) => m.subject === `[Confidential] ${subject}`, 90_000);
  expect(await rawMessage(ENT.bob, got.blobId)).toMatch(/^SIO-Label: marking="CONFIDENTIAL"/m);
  // Undo send off again, for the other tests.
  await alice.locator('a[href$="/settings"]').first().click();
  await alice.locator('[data-testid="settings-tab-composing"]').first().click();
  await alice.locator('[data-search-label="Undo send / send delay"] select').first().selectOption('0');
  await alice.waitForTimeout(1500);
  await alice.context().close();
});

test('item 3: a quick reply keeps the original’s label', async ({ browser }) => {
  const subject = `[Confidential] Label send ${RUN}`;
  await policy({ organisation: { labels: { list: GENERIC_LABELS, defaultId: '', required: true, extraHeader: '' } } }, browser);
  const bob = await userPage(browser, ENT.bob);
  await openMessage(bob, subject);
  const box = bob.getByPlaceholder('Write a quick reply...');
  await box.fill(`Quick reply ${RUN}`);
  await box.press('Control+Enter');
  await expect(box).toHaveValue('', { timeout: 30_000 });
  const reply = await waitForMessage(ENT.alice, RUN, (m) => m.subject === `[Confidential] Re: Label send ${RUN}`);
  expect(await rawMessage(ENT.alice, reply.blobId)).toMatch(/^SIO-Label: marking="CONFIDENTIAL"/m);
  await bob.context().close();
});

test('item 3: a quick reply with no label to keep opens the composer to pick one', async ({ browser }) => {
  const subject = `Unlabelled ${RUN}`;
  await policy({ organisation: { labels: { list: GENERIC_LABELS, defaultId: '', required: true, extraHeader: '' } } }, browser);
  await deliverAndWait({ from: ENT.carol, to: [ENT.bob], subject, text: 'No label' });
  const bob = await userPage(browser, ENT.bob);
  await openMessage(bob, subject);
  const box = bob.getByPlaceholder('Write a quick reply...');
  await box.fill(`Needs a label ${RUN}`);
  await box.press('Control+Enter');
  await expect(bob.locator('[data-testid="email-composer"]')).toBeVisible({ timeout: 20_000 });
  await expect(bob.getByTestId('composer-classification-trigger')).toContainText('Pick a label');
  // Nothing went out.
  await bob.waitForTimeout(3000);
  expect((await messages(ENT.carol, RUN)).filter((m) => m.subject.includes(`Re: ${subject}`))).toEqual([]);
  await bob.context().close();
});

test('item 3: a group scope gets its own scheme (VS-NfD, RFC 2231 marking); ent-carol keeps Everyone’s', async ({ browser }) => {
  const subject = `Scheme ${RUN}`;
  await policy({
    organisation: { labels: { list: GENERIC_LABELS, defaultId: 'internal', required: true, extraHeader: '' } },
    scopes: [{ id: 'team', label: 'Team', match: { groups: [ENT.team] }, policy: { organisation: { labels: { list: GERMAN_LABELS, defaultId: 'offen', required: true, extraHeader: '' } } } }],
  }, browser);
  const carol = await userPage(browser, ENT.carol);
  await carol.keyboard.press('c');
  await carol.locator('[data-testid="email-composer"]').waitFor({ state: 'visible' });
  await expect(carol.getByTestId('composer-classification-trigger')).toContainText('Internal');
  await carol.keyboard.press('Escape');
  await carol.context().close();

  const alice = await userPage(browser, ENT.alice);
  await composeAndSend(alice, ENT.bob, subject, async () => {
    await expect(alice.getByTestId('composer-classification-trigger')).toContainText('OFFEN');
    await alice.getByTestId('composer-classification-trigger').click();
    // Arrow keys move the pick; Enter closes.
    await alice.keyboard.press('ArrowDown');
    await alice.keyboard.press('Enter');
    await expect(alice.getByTestId('composer-classification-trigger')).toContainText('VS-NfD');
  });
  await expect(alice.locator('[data-testid="email-composer"]')).toBeHidden({ timeout: 30_000 });
  const got = await waitForMessage(ENT.bob, RUN, (m) => m.subject === `VS-NfD ${subject}`);
  const raw = await rawMessage(ENT.bob, got.blobId);
  expect(raw).toContain("marking*=utf-8''VS-NUR%20F%C3%9CR%20DEN%20DIENSTGEBRAUCH");
  await alice.context().close();
  const bob = await userPage(browser, ENT.bob);
  await openMessage(bob, `VS-NfD ${subject}`);
  await expect(bob.getByTestId('received-label-chip').first()).toHaveText('VS-NfD');
  await bob.context().close();
});

test('item 3: a Pro compose tab sends with its label and priority', async ({ browser }) => {
  const subject = `Pro tab ${RUN}`;
  await policy({ organisation: { labels: { list: GENERIC_LABELS, defaultId: 'confidential', required: true, extraHeader: '' } } }, browser);
  const alice = await seededPage(browser, ENT.alice, { proInterface: true, advancedSettings: true });
  await alice.goto('/pro').catch(() => {});
  await accountSwitcher(alice).waitFor({ state: 'visible', timeout: 60_000 }).catch(() => {});
  await composeAndSend(alice, ENT.bob, subject, async () => {
    await alice.getByTestId('composer-options-menu').first().click();
    await alice.getByTestId('composer-priority-high').click();
    await alice.keyboard.press('Escape');
  });
  const got = await waitForMessage(ENT.bob, RUN, (m) => m.subject === `[Confidential] ${subject}`);
  const raw = await rawMessage(ENT.bob, got.blobId);
  expect(raw).toMatch(/^SIO-Label: marking="CONFIDENTIAL"/m);
  expect(raw).toMatch(/^X-Priority: 1/m);
  await alice.context().close();
});

test('item 3: the picker and the admin pages fit a phone', async ({ browser }) => {
  await policy({ organisation: { labels: { list: GENERIC_LABELS, defaultId: '', required: true, extraHeader: '' }, phishingReport: { address: ENT.sec, format: 'forward' } } }, browser);
  const alice = await userPage(browser, ENT.alice, true);
  await alice.getByRole('button', { name: /Compose|New message|Write/ }).first().click().catch(async () => { await alice.keyboard.press('c'); });
  await alice.locator('[data-testid="email-composer"]').waitFor({ state: 'visible', timeout: 15_000 });
  const trigger = alice.getByTestId('composer-classification-trigger');
  await expect(trigger).toBeVisible();
  await trigger.click();
  const options = alice.getByTestId('composer-classification-options');
  const box = await options.boundingBox();
  expect(box && box.x).toBeGreaterThanOrEqual(0);
  expect(box && box.x + box.width).toBeLessThanOrEqual(390);
  await shot(alice, 'a-labels-phone-picker');
  await alice.keyboard.press('Escape');
  expect(await alice.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await alice.context().close();

  const admin = await adminContext(browser, true);
  for (const [path, name] of [['/admin/org-labels', 'a-labels-admin-phone'], ['/admin/org-security', 'a-phishing-admin-phone']] as const) {
    const page = await admin.newPage();
    await page.goto(path);
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await shot(page, name);
    await page.close();
  }
  await admin.close();
});
