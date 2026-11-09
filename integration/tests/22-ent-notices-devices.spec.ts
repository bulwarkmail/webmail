import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { JMAP_URL } from './helpers/config';
import { accountSwitcher, addAccount, driveEntry, emailItem, folderRow, neutralizeDevOverlay, openCalendar, openFiles, switchAccount } from './helpers/app';
import {
  ENT,
  ENT_PASSWORD,
  adminContext,
  contextOptions,
  getPolicy,
  jmapAs,
  putPolicy,
  requireEntEnv,
  shot,
  userPage,
} from './helpers/ent';

/**
 * Enterprise pack, package D, through the real UI on a VM 106 test Stalwart
 * with the ent-* accounts:
 * - item 10: the announcement shows in mail, calendar, contacts and files,
 *   ends at its end time without a reload, stays closed after a reload,
 *   shows again after the admin edits it, and only for its scope; at 390 px
 *   it wraps and its close button is 44 px;
 * - item 11: out-of-office templates fill their placeholders and nothing is
 *   saved before the deputy is filled in;
 * - item 12: the retention line in Trash and Junk;
 * - item 13: each device policy holds in the real UI, a unified view with
 *   two accounts follows each message's own account, and the push preview
 *   route holds back sender, subject and text.
 * Setup goes through the admin API and JMAP; the policy is put back at the end.
 */

test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

const RUN = Date.now().toString(36);
const CORE = 'urn:ietf:params:jmap:core';
const MAIL = 'urn:ietf:params:jmap:mail';
const SUBMISSION = 'urn:ietf:params:jmap:submission';
const FILENODE = 'urn:ietf:params:jmap:filenode';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const ZIP = Buffer.from('UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==', 'base64');

let original: Record<string, unknown>;

const basic = (email: string) => 'Basic ' + Buffer.from(`${email}:${ENT_PASSWORD}`).toString('base64');

async function upload(account: string, bytes: Buffer, type: string): Promise<string> {
  const client = await jmapAs(account);
  const res = await fetch(`${JMAP_URL}/jmap/upload/${client.accountId}/`, {
    method: 'POST',
    headers: { Authorization: basic(account), 'Content-Type': type },
    body: bytes,
  });
  if (!res.ok) throw new Error(`upload: ${res.status}`);
  return (await res.json()).blobId as string;
}

/** Delivers a message with a picture and a ZIP attached, and waits until the recipient has it. */
async function deliverWithFiles(from: string, to: string, subject: string): Promise<void> {
  const client = await jmapAs(from);
  const png = await upload(from, PNG, 'image/png');
  const zip = await upload(from, ZIP, 'application/zip');
  const identity = (await client.identities()).find((i) => i.email === from)!;
  const drafts = (await client.mailboxByRole('drafts'))!.id;
  const sent = (await client.mailboxByRole('sent'))!.id;
  const r = await client.request([
    ['Email/set', { accountId: client.accountId, create: { m: {
      mailboxIds: { [drafts]: true },
      keywords: { $draft: true, $seen: true },
      from: [{ email: from }],
      to: [{ email: to }],
      subject,
      bodyValues: { t: { value: `Report for ${subject}. Confidential numbers inside.` } },
      textBody: [{ partId: 't', type: 'text/plain' }],
      attachments: [
        { blobId: png, type: 'image/png', name: 'chart.png', disposition: 'attachment' },
        { blobId: zip, type: 'application/zip', name: 'figures.zip', disposition: 'attachment' },
      ],
    } } }, '0'],
    ['EmailSubmission/set', {
      accountId: client.accountId,
      create: { s: { identityId: identity.id, emailId: '#m' } },
      onSuccessUpdateEmail: { '#s': { [`mailboxIds/${drafts}`]: null, [`mailboxIds/${sent}`]: true, 'keywords/$draft': null } },
    }, '1'],
  ], [CORE, MAIL, SUBMISSION]);
  if (!r.methodResponses?.[1]?.[1]?.created?.s) throw new Error(`deliver: ${JSON.stringify(r.methodResponses).slice(0, 400)}`);
  const recipient = await jmapAs(to);
  const deadline = Date.now() + 60_000;
  for (;;) {
    const q = await recipient.request([['Email/query', { accountId: recipient.accountId, filter: { text: RUN }, limit: 50 }, '0'],
      ['Email/get', { accountId: recipient.accountId, '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' }, properties: ['subject'] }, '1']]);
    if ((q.methodResponses[1][1].list as Array<{ subject: string }>).some((m) => m.subject === subject)) return;
    if (Date.now() > deadline) throw new Error(`${to} never got ${subject}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function setPolicy(browser: Browser, patch: { organisation?: Record<string, unknown>; scopes?: unknown[]; restrictions?: Record<string, unknown>; features?: Record<string, unknown> }) {
  const admin = await adminContext(browser);
  await putPolicy(admin, {
    ...original,
    organisation: { ...((original.organisation as object) ?? {}), ...(patch.organisation ?? {}) },
    restrictions: { ...((original.restrictions as object) ?? {}), ...(patch.restrictions ?? {}) },
    features: { ...((original.features as object) ?? {}), ...(patch.features ?? {}) },
    scopes: patch.scopes ?? [],
  });
  await admin.close();
}

const DEVICES_OFF = { noDownloads: false, noExport: false, noPrint: false, noInstallPrompt: false, pushWithoutContent: false, watermark: false, noOffline: false };
const devices = (on: Partial<typeof DEVICES_OFF>) => ({ devices: { ...DEVICES_OFF, ...on } });

async function openMessage(page: Page, subject: string): Promise<void> {
  const row = emailItem(page, subject).first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.click();
  await expect(page.getByRole('heading', { name: subject }).first()).toBeVisible({ timeout: 20_000 });
}

async function openSettingsTab(page: Page, tab: string): Promise<void> {
  await page.locator('a[href$="/settings"]').first().click();
  await page.locator(`[data-testid="settings-tab-${tab}"]`).first().click();
}

const banner = (page: Page) => page.getByTestId('org-announcement');

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

// ─── Item 10: announcement ───────────────────────────────────────────────

test('item 10: the admin writes an announcement on Organisation > Notices', async ({ browser }) => {
  await setPolicy(browser, {});
  const admin = await adminContext(browser);
  const page = await admin.newPage();
  await page.goto('/admin/org-notices');
  await page.getByTestId('org-announcement-add').click();
  await page.getByTestId('org-announcement-text').fill(`Mail maintenance tonight ${RUN}. Details: https://status.example.org/maintenance`);
  await page.getByTestId('org-announcement-severity').selectOption('warning');
  await expect(page.getByTestId('org-announcement-preview')).toContainText(`Mail maintenance tonight ${RUN}`);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await shot(page, 'd-announcement-admin');
  const stored = (await getPolicy(admin)).organisation as { announcement: { id: string; severity: string; text: Record<string, string> } };
  expect(stored.announcement.severity).toBe('warning');
  expect(stored.announcement.id).not.toBe('');
  expect(stored.announcement.text.en).toContain(RUN);
  await admin.close();
});

test('item 10: the announcement shows in mail, calendar, contacts and files', async ({ browser }) => {
  const alice = await userPage(browser, ENT.alice);
  await expect(banner(alice)).toContainText(`Mail maintenance tonight ${RUN}`, { timeout: 30_000 });
  await expect(banner(alice)).toHaveAttribute('data-severity', 'warning');
  await expect(banner(alice).getByRole('link', { name: 'https://status.example.org/maintenance' })).toBeVisible();
  await shot(alice, 'd-announcement-mail');
  await openCalendar(alice);
  await expect(banner(alice)).toBeVisible();
  await alice.locator('a[href$="/contacts"]').first().click();
  await expect(banner(alice)).toBeVisible({ timeout: 30_000 });
  await openFiles(alice);
  await expect(banner(alice)).toBeVisible();
  await alice.context().close();
});

test('item 10: closed stays closed after a reload, and an edit shows it again', async ({ browser }) => {
  const alice = await userPage(browser, ENT.alice);
  await expect(banner(alice)).toBeVisible({ timeout: 30_000 });
  await alice.getByTestId('org-announcement-dismiss').click();
  await expect(banner(alice)).toHaveCount(0);
  await alice.reload();
  await accountSwitcher(alice).waitFor({ state: 'visible', timeout: 60_000 });
  await alice.waitForTimeout(3000);
  await expect(banner(alice)).toHaveCount(0);

  const admin = await adminContext(browser);
  const policy = await getPolicy(admin);
  const org = policy.organisation as { announcement: { text: Record<string, string> } };
  await putPolicy(admin, { ...policy, organisation: { ...org, announcement: { ...org.announcement, text: { en: `Maintenance moved to Friday ${RUN}` } } } });
  await admin.close();
  await alice.reload();
  await expect(banner(alice)).toContainText(`Maintenance moved to Friday ${RUN}`, { timeout: 30_000 });
  await alice.context().close();
});

test('item 10: it goes away at its end time without a reload', async ({ browser }) => {
  const endsAt = new Date(Date.now() + 75_000).toISOString();
  await setPolicy(browser, { organisation: { announcement: { id: `end-${RUN}`, severity: 'critical', text: { en: `Outage until soon ${RUN}` }, fallbackLocale: 'en', startsAt: '', endsAt, dismissible: true } } });
  const alice = await userPage(browser, ENT.alice);
  await expect(banner(alice)).toContainText(`Outage until soon ${RUN}`, { timeout: 30_000 });
  // Read out through a live region that fills a moment after the strip appears.
  await expect(alice.getByTestId('org-announcement-live')).toHaveAttribute('role', 'alert');
  await expect(alice.getByTestId('org-announcement-live')).toContainText(`Outage until soon ${RUN}`);
  await expect(banner(alice)).toHaveCount(0, { timeout: 120_000 });
  await alice.context().close();
});

test('item 10: a scope shows it only to its members', async ({ browser }) => {
  await setPolicy(browser, {
    scopes: [{ id: 'team-notice', label: 'Team', match: { groups: [ENT.team] }, policy: { organisation: { announcement: { id: `team-${RUN}`, severity: 'info', text: { en: `Team meeting at 10 ${RUN}` }, fallbackLocale: 'en', startsAt: '', endsAt: '', dismissible: true } } } }],
  });
  const alice = await userPage(browser, ENT.alice);
  await expect(banner(alice)).toContainText(`Team meeting at 10 ${RUN}`, { timeout: 30_000 });
  await alice.context().close();
  const carol = await userPage(browser, ENT.carol);
  await carol.waitForTimeout(4000);
  await expect(banner(carol)).toHaveCount(0);
  await carol.context().close();
});

test('item 10: at 390 px the text wraps and the close button is 44 px', async ({ browser }) => {
  await setPolicy(browser, { organisation: { announcement: { id: `phone-${RUN}`, severity: 'warning', text: { en: `Planned maintenance on Saturday from 22:00 to 02:00. Sending and receiving may be slow. ${RUN}` }, fallbackLocale: 'en', startsAt: '', endsAt: '', dismissible: true } } });
  const alice = await userPage(browser, ENT.alice, true);
  await expect(banner(alice)).toBeVisible({ timeout: 30_000 });
  const box = await banner(alice).boundingBox();
  expect(box!.width).toBeLessThanOrEqual(390);
  // At least two lines of text: it wraps rather than running off the side.
  const lines = await banner(alice).locator('p').evaluate((p) => p.getBoundingClientRect().height / parseFloat(getComputedStyle(p).lineHeight));
  expect(lines).toBeGreaterThanOrEqual(2);
  const close = await alice.getByTestId('org-announcement-dismiss').boundingBox();
  expect(close!.width).toBeGreaterThanOrEqual(44);
  expect(close!.height).toBeGreaterThanOrEqual(44);
  const overflow = await alice.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  await shot(alice, 'd-announcement-phone');
  await alice.context().close();
});

// ─── Item 11: out-of-office templates ────────────────────────────────────

test('item 11: a template fills its placeholders, and nothing is saved before the deputy is in', async ({ browser }) => {
  await setPolicy(browser, { organisation: { vacationTemplates: { library: [{
    id: `holiday-${RUN}`, name: `Holiday ${RUN}`, category: 'Standard', subject: 'Out of office until {end}',
    text: 'Hello,\n\nI am away until {end}.\nFor urgent matters, please write to {deputy}.\n\n{name}', html: '',
  }] } } });
  const client = await jmapAs(ENT.alice);
  const vacation = async () => (await client.request([['VacationResponse/get', { accountId: client.accountId, ids: ['singleton'] }, '0']],
    [CORE, 'urn:ietf:params:jmap:vacationresponse'])).methodResponses[0][1].list[0] as { subject: string | null; textBody: string | null; toDate: string | null; fromDate: string | null; isEnabled: boolean; htmlBody: string | null };
  const before = await vacation();
  const toDate = '2027-01-04T08:00:00Z';
  await client.request([['VacationResponse/set', { accountId: client.accountId, update: { singleton: { isEnabled: false, fromDate: '2026-12-21T08:00:00Z', toDate, subject: 'Old', textBody: 'Old text', htmlBody: null } } }, '0']],
    [CORE, 'urn:ietf:params:jmap:vacationresponse']);
  try {
    const alice = await userPage(browser, ENT.alice);
    await openSettingsTab(alice, 'vacation');
    const picker = alice.getByTestId('vacation-template-select');
    await picker.scrollIntoViewIfNeeded();
    await picker.selectOption({ label: `Holiday ${RUN}` });
    await alice.getByTestId('vacation-template-apply').click();
    await expect(alice.getByText("Enter your deputy's address first.")).toBeVisible();
    await alice.waitForTimeout(2500);
    expect((await vacation()).textBody, 'nothing saved before the deputy is filled in').toBe('Old text');

    await alice.getByTestId('vacation-template-deputy').fill('ent-bob@example.org');
    await alice.waitForTimeout(2000);
    expect((await vacation()).textBody).toBe('Old text');
    await alice.getByTestId('vacation-template-apply').click();
    await shot(alice, 'd-vacation-template');
    await expect.poll(async () => (await vacation()).textBody, { timeout: 20_000 }).toContain('please write to ent-bob@example.org');
    const saved = await vacation();
    // en-US, in the browser's zone (no zone set in Bulwark): 08:00 UTC is a time of day, so it is written out.
    expect(saved.textBody).toMatch(/I am away until Monday, January 4, 2027 at \d{1,2}:00/);
    // {name} is the identity's name.
    expect(saved.textBody).toMatch(/\n\n\S.*$/);
    expect(saved.textBody).not.toContain('{');
    expect(saved.subject).toMatch(/^Out of office until Monday, January 4, 2027 at \d{1,2}:00/);
    await alice.context().close();
  } finally {
    await client.request([['VacationResponse/set', { accountId: client.accountId, update: { singleton: {
      isEnabled: before.isEnabled, fromDate: before.fromDate, toDate: before.toDate, subject: before.subject, textBody: before.textBody, htmlBody: before.htmlBody,
    } } }, '0']], [CORE, 'urn:ietf:params:jmap:vacationresponse']);
  }
});

// ─── Item 12: retention ──────────────────────────────────────────────────

test('item 12: Trash and Junk say how long they keep mail', async ({ browser }) => {
  await setPolicy(browser, { organisation: { retention: { trashDays: 30, junkDays: 14 } } });
  const alice = await userPage(browser, ENT.alice);
  await folderRow(alice, { role: 'trash' }).first().click();
  await expect(alice.getByTestId('retention-notice')).toHaveText('Messages here are deleted 30 days after they were moved here.', { timeout: 20_000 });
  await shot(alice, 'd-retention-trash');
  await folderRow(alice, { role: 'junk' }).first().click();
  await expect(alice.getByTestId('retention-notice')).toHaveText('Messages here are deleted 14 days after they were moved here.', { timeout: 20_000 });
  await folderRow(alice, { role: 'inbox' }).first().click();
  await expect(alice.getByTestId('retention-notice')).toHaveCount(0);
  await alice.context().close();
});

// ─── Item 13: device policies ────────────────────────────────────────────

test('item 13: the admin turns the device policies on, on Organisation > Devices', async ({ browser }) => {
  await setPolicy(browser, {});
  const admin = await adminContext(browser);
  const page = await admin.newPage();
  await page.goto('/admin/org-devices');
  await expect(page.getByTestId('org-devices-warning')).toContainText("They don't stop screenshots");
  for (const key of ['noDownloads', 'noExport', 'noPrint', 'watermark']) await page.getByTestId(`org-devices-${key}`).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await shot(page, 'd-devices-admin');
  const stored = (await getPolicy(admin)).organisation as { devices: Record<string, boolean> };
  expect(stored.devices).toMatchObject({ noDownloads: true, noExport: true, noPrint: true, watermark: true, noInstallPrompt: false });
  await admin.close();
});

test('item 13: no downloads, no export and no print hold in the reader, with the watermark', async ({ browser }) => {
  const subject = `Device report ${RUN}`;
  await setPolicy(browser, { organisation: devices({ noDownloads: true, noExport: true, noPrint: true, watermark: true }) });
  await deliverWithFiles(ENT.bob, ENT.alice, subject);
  const alice = await userPage(browser, ENT.alice);
  const downloads: string[] = [];
  alice.on('download', (d) => downloads.push(d.suggestedFilename()));
  // The list row's attachment chip opens nothing either.
  await emailItem(alice, subject).first().getByText('figures.zip').click().catch(() => {});
  await openMessage(alice, subject);
  const attachments = alice.getByTestId('reader-attachments').first();
  await expect(attachments).toBeVisible();
  await expect(attachments.getByText('Download all')).toHaveCount(0);
  await attachments.getByRole('button', { name: /figures\.zip/ }).click({ modifiers: ['Control'], force: true });
  // aria-disabled: Playwright would wait for it to be enabled; a user can still click it.
  await attachments.getByRole('button', { name: /figures\.zip/ }).click({ force: true });
  await alice.waitForTimeout(2000);
  expect(downloads, 'no download started').toEqual([]);
  await expect(attachments.getByRole('button', { name: /^Download / })).toHaveCount(0);
  await expect(alice.getByTestId('attachments-downloads-off').first()).toBeVisible();
  // The ZIP opens nothing; the picture previews, without Download or a new tab.
  await expect(attachments.getByRole('button', { name: /figures\.zip/ })).toHaveAttribute('aria-disabled', 'true');
  await attachments.getByRole('button', { name: /chart\.png/ }).first().click();
  await expect(alice.getByAltText('chart.png')).toBeVisible({ timeout: 20_000 });
  await expect(alice.getByRole('button', { name: 'Download', exact: true })).toHaveCount(0);
  await expect(alice.getByRole('button', { name: 'Open in new tab' })).toHaveCount(0);
  await expect(alice.getByTestId('watermark').last()).toContainText(ENT.alice);
  await alice.keyboard.press('Escape');

  // The watermark lies over the message.
  await expect(alice.locator('.email-content-wrapper [data-testid="watermark"]').first()).toContainText(ENT.alice);
  await shot(alice, 'd-devices-reader');
  // No Print and no export in the toolbar and the menu.
  await expect(alice.getByRole('button', { name: 'Print', exact: true })).toHaveCount(0);
  await alice.getByRole('button', { name: 'More actions' }).first().click();
  await expect(alice.getByRole('menuitem', { name: 'Export as .eml' })).toHaveCount(0);
  await expect(alice.getByRole('menuitem', { name: 'View source' })).toHaveCount(0);
  await expect(alice.getByRole('menuitem', { name: 'Print' })).toHaveCount(0);
  await alice.keyboard.press('Escape');

  // Ctrl+P prints only the note.
  await alice.emulateMedia({ media: 'print' });
  await expect(alice.locator('[data-print-blocked]')).toBeVisible();
  await expect(alice.locator('[data-print-blocked]')).toHaveText('Printing is turned off by your organisation.');
  await expect(alice.locator('nav[aria-label="Navigation"]').first()).toBeHidden();
  await alice.emulateMedia({ media: 'screen' });

  // No folder export from the folder menu, and Settings shows it set by the organisation.
  await folderRow(alice, { role: 'inbox' }).first().click({ button: 'right' });
  await expect(alice.getByTestId('mailbox-export')).toHaveCount(0);
  await alice.keyboard.press('Escape');
  await openSettingsTab(alice, 'backup');
  await expect(alice.getByTestId('settings-mail-export')).toBeDisabled();
  await alice.context().close();
});

test('item 13: Files offers no download under "No downloads"', async ({ browser }) => {
  await setPolicy(browser, { organisation: devices({ noDownloads: true }) });
  const client = await jmapAs(ENT.alice);
  const name = `ent-d-${RUN}.zip`;
  const blobId = await upload(ENT.alice, ZIP, 'application/zip');
  const session = await (await fetch(`${JMAP_URL}/jmap/session`, { headers: { Authorization: basic(ENT.alice) } })).json();
  const filesAccount = session.primaryAccounts?.[FILENODE] ?? client.accountId;
  const typed = 'supportedNodeTypes' in (session.accounts?.[filesAccount]?.accountCapabilities?.[FILENODE] ?? {});
  const created = await client.request([['FileNode/set', { accountId: filesAccount, create: { f: { name, blobId, type: 'application/zip', ...(typed ? { '@type': 'File' } : {}) } } }, '0']], [CORE, FILENODE]);
  const fileId = created.methodResponses[0][1].created?.f?.id as string | undefined;
  test.skip(!fileId, `this server refused the file node: ${JSON.stringify(created.methodResponses[0][1]).slice(0, 200)}`);
  try {
    const alice = await userPage(browser, ENT.alice);
    await openFiles(alice);
    const row = driveEntry(alice, name).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row.getByRole('button', { name: 'Download' })).toHaveCount(0);
    await row.click({ button: 'right' });
    await expect(alice.getByRole('menuitem', { name: 'Info' }).or(alice.getByRole('menuitem', { name: 'Details' })).first()).toBeVisible();
    await expect(alice.getByRole('menuitem', { name: 'Download', exact: true })).toHaveCount(0);
    await shot(alice, 'd-devices-files');
    await alice.context().close();
  } finally {
    if (fileId) await client.request([['FileNode/set', { accountId: filesAccount, destroy: [fileId] }, '0']], [CORE, FILENODE]);
  }
});

test('item 13: with printing allowed the print popup carries the watermark', async ({ browser }) => {
  const subject = `Watermark print ${RUN}`;
  await setPolicy(browser, { organisation: devices({ watermark: true }) });
  await deliverWithFiles(ENT.bob, ENT.alice, subject);
  const alice = await userPage(browser, ENT.alice);
  await alice.context().addInitScript(() => { window.print = () => {}; });
  await openMessage(alice, subject);
  const popupPromise = alice.context().waitForEvent('page');
  // The toolbar's Print moves into More actions when the toolbar is narrow.
  const toolbarPrint = alice.getByRole('button', { name: 'Print', exact: true });
  if (await toolbarPrint.first().isVisible()) await toolbarPrint.first().click();
  else {
    await alice.getByRole('button', { name: 'More actions' }).first().click();
    await alice.getByRole('menuitem', { name: 'Print' }).first().click();
  }
  const popup = await popupPromise;
  await expect(popup.locator('[data-testid="watermark"]')).toContainText(ENT.alice, { timeout: 10_000 });
  await expect(popup.locator('.subject')).toHaveText(subject);
  await popup.close();
  await alice.context().close();
});

test('item 13: no install card under "No install prompt"', async ({ browser }) => {
  await setPolicy(browser, { organisation: devices({ noInstallPrompt: true }) });
  const alice = await userPage(browser, ENT.alice);
  await alice.waitForTimeout(1500);
  const prevented = await alice.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, { prompt: () => Promise.resolve(), userChoice: Promise.resolve({ outcome: 'dismissed' }) });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(true);
  await alice.waitForTimeout(1000);
  await expect(alice.getByText(/^Install /)).toHaveCount(0);
  await alice.context().close();
});

test('item 13: the push preview holds back sender, subject and text under the policy', async ({ browser }) => {
  const subject = `Push secret ${RUN}`;
  await deliverWithFiles(ENT.bob, ENT.alice, subject);
  const client = await jmapAs(ENT.alice);
  await setPolicy(browser, { organisation: devices({}) });
  const alice = await userPage(browser, ENT.alice);
  const open = await (await alice.request.get(`/api/push/preview?accountId=${client.accountId}`)).json();
  expect(open.redacted).toBeUndefined();
  expect(open.email?.subject, 'without the policy the preview names the newest unread message').toBeTruthy();

  await setPolicy(browser, { scopes: [{ id: 'team-push', label: 'Team', match: { groups: [ENT.team] }, policy: { organisation: devices({ pushWithoutContent: true }) } }] });
  const res = await alice.request.get(`/api/push/preview?accountId=${client.accountId}`);
  expect(res.ok()).toBe(true);
  const body = await res.json();
  expect(body.redacted).toBe(true);
  expect(body.email).toBeTruthy();
  expect(body.email.from).toBeUndefined();
  expect(body.email.subject).toBeUndefined();
  expect(body.email.preview).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain('Confidential numbers');
  await alice.context().close();
});

test('item 13: in a unified inbox with two accounts each message follows its own account', async ({ browser }) => {
  const forAlice = `Unified alice ${RUN}`;
  const forCarol = `Unified carol ${RUN}`;
  await setPolicy(browser, {
    features: { unifiedCrossAccountEnabled: true },
    restrictions: { enableUnifiedMailbox: { locked: true, value: true }, unifiedCrossAccount: { locked: true, value: true } },
    // ent-alice is in ent-team, ent-carol isn't.
    scopes: [{ id: 'team-devices', label: 'Team', match: { groups: [ENT.team] }, policy: { organisation: devices({ noDownloads: true, watermark: true }) } }],
  });
  await deliverWithFiles(ENT.bob, ENT.alice, forAlice);
  await deliverWithFiles(ENT.bob, ENT.carol, forCarol);
  const context: BrowserContext = await browser.newContext(contextOptions());
  const page = await context.newPage();
  await neutralizeDevOverlay(page);
  await page.goto('/');
  await page.fill('#username', ENT.alice);
  await page.fill('#password', ENT_PASSWORD);
  await page.click('button[type="submit"]');
  await accountSwitcher(page).waitFor({ state: 'visible', timeout: 60_000 });
  await addAccount(page, { user: 'ent-carol', email: ENT.carol, password: ENT_PASSWORD });
  await folderRow(page, { name: 'unified-inbox' }).first().click({ timeout: 60_000 });

  await openMessage(page, forAlice);
  const attachments = page.getByTestId('reader-attachments').first();
  await expect(attachments.getByText('Download all')).toHaveCount(0);
  await expect(page.locator('.email-content-wrapper [data-testid="watermark"]').first()).toContainText(ENT.alice);

  await openMessage(page, forCarol);
  await expect(page.getByTestId('reader-attachments').first().getByText('Download all')).toBeVisible();
  await expect(page.locator('.email-content-wrapper [data-testid="watermark"]')).toHaveCount(0);
  // The download detector of the blocked cases does see a real download.
  const download = page.waitForEvent('download', { timeout: 30_000 });
  await page.getByTestId('reader-attachments').first().getByText('Download all').click();
  expect((await download).suggestedFilename()).toMatch(/\.zip$/);
  await shot(page, 'd-devices-unified');
  // What isn't about one message follows the strictest account: Ctrl+P is still allowed here.
  await context.close();
});

test('item 13: in the Pro shell another account\u2019s folder opened from the sidebar follows that account', async ({ browser }) => {
  const forAlice = `Sidebar alice ${RUN}`;
  await setPolicy(browser, {
    organisation: { announcement: { id: `pro-${RUN}`, severity: 'info', text: { en: `Pro notice ${RUN}` }, fallbackLocale: 'en', startsAt: '', endsAt: '', dismissible: true } },
    scopes: [{ id: 'team-devices', label: 'Team', match: { groups: [ENT.team] }, policy: { organisation: devices({ noDownloads: true, noPrint: true, watermark: true }) } }],
  });
  await deliverWithFiles(ENT.bob, ENT.alice, forAlice);
  const context: BrowserContext = await browser.newContext(contextOptions());
  const page = await context.newPage();
  await neutralizeDevOverlay(page);
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('ent-seeded')) {
      localStorage.setItem('settings-storage', JSON.stringify({ state: { proInterface: true, advancedSettings: true }, version: 7 }));
      sessionStorage.setItem('ent-seeded', '1');
    }
  });
  await page.goto('/');
  await page.fill('#username', ENT.carol);
  await page.fill('#password', ENT_PASSWORD);
  await page.click('button[type="submit"]');
  await accountSwitcher(page).waitFor({ state: 'visible', timeout: 60_000 });
  await addAccount(page, { user: 'ent-alice', email: ENT.alice, password: ENT_PASSWORD });
  await switchAccount(page, ENT.carol);
  await page.goto('/pro').catch(() => {});
  await accountSwitcher(page).waitFor({ state: 'visible', timeout: 60_000 }).catch(() => {});
  // One announcement for the whole shell, however many panes.
  await expect(banner(page)).toHaveCount(1, { timeout: 30_000 });
  // ent-carol is active; ent-alice's Inbox is the other one in the sidebar.
  await folderRow(page, { role: 'inbox' }).and(page.locator(':not([data-selected="true"])')).first().click({ timeout: 60_000 });
  await openMessage(page, forAlice);
  const attachments = page.getByTestId('reader-attachments').first();
  await expect(attachments).toBeVisible();
  await expect(attachments.getByText('Download all')).toHaveCount(0);
  await expect(page.locator('.email-content-wrapper [data-testid="watermark"]').first()).toContainText(ENT.alice);
  await page.getByRole('button', { name: 'More actions' }).first().click();
  await expect(page.getByRole('menuitem', { name: 'Print' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await shot(page, 'd-devices-pro-sidebar');
  await context.close();
});

test('item 10 and 13: a tab left open picks up an announcement and a device policy when the user comes back', async ({ browser }) => {
  test.setTimeout(300_000);
  const subject = `Mid session ${RUN}`;
  await setPolicy(browser, {});
  await deliverWithFiles(ENT.bob, ENT.alice, subject);
  const alice = await userPage(browser, ENT.alice);
  const opened = Date.now();
  await openMessage(alice, subject);
  await expect(alice.getByTestId('reader-attachments').first().getByText('Download all')).toBeVisible();
  // Saved while the tab is open; it starts after the tab opened and before the user comes back.
  await setPolicy(browser, {
    organisation: {
      announcement: { id: `mid-${RUN}`, severity: 'warning', text: { en: `Started meanwhile ${RUN}` }, fallbackLocale: 'en', startsAt: new Date(opened + 20_000).toISOString(), endsAt: '', dismissible: true },
      ...devices({ noDownloads: true }),
    },
  });
  // Coming back to the tab fetches the policy again (at most once a minute).
  await alice.waitForTimeout(Math.max(0, opened + 65_000 - Date.now()));
  await alice.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(banner(alice)).toContainText(`Started meanwhile ${RUN}`, { timeout: 20_000 });
  await expect(alice.getByTestId('reader-attachments').first().getByText('Download all')).toHaveCount(0);
  await alice.context().close();
});

test('admin pages at 390 px', async ({ browser }) => {
  await setPolicy(browser, { organisation: { vacationTemplates: { library: [{ id: `p-${RUN}`, name: 'Holiday', category: '', subject: 'Away', text: 'Back on {end}.', html: '' }] } } });
  const admin = await adminContext(browser, true);
  const page = await admin.newPage();
  for (const [path, name] of [['/admin/org-notices', 'd-admin-notices-phone'], ['/admin/org-devices', 'd-admin-devices-phone'], ['/admin/org-templates', 'd-admin-templates-phone']] as const) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('[data-testid="org-scope-bar"]')).toBeVisible({ timeout: 30_000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(overflow, `${path} scrolls sideways`).toBe(false);
    await shot(page, name);
  }
  await admin.close();
});
