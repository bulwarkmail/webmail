import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { JmapClient } from './helpers/jmap';
import { addRecipient, emailItem, openComposer, setSubject } from './helpers/app';
import {
  ORG,
  ORG_PASSWORD,
  adminContext,
  getPolicy,
  putPolicy,
  requireOrgEnv,
  shot,
  userPage,
} from './helpers/org';

/**
 * External sender label and external recipient warning (organisation
 * feature 2), through the real UI on a VM 106 test server. Test mail is
 * delivered over JMAP between the org-* accounts (SMTP on the VM doesn't
 * work). The admin's policy is put back afterwards.
 */

test.describe.configure({ mode: 'serial' });

const RUN = Date.now().toString(36);
const FROM_DAVE = `External check from dave ${RUN}`;
const FROM_BOB = `Internal check from bob ${RUN}`;
// The quick reply turns FROM_DAVE into a thread whose latest message is
// alice's own; the later checks read this one.
const FROM_DAVE_2 = `Second external check from dave ${RUN}`;

let original: Record<string, unknown>;

/** Sends a plain message from one org account to another, the way a mail app would. */
async function deliver(from: string, to: string, subject: string): Promise<void> {
  const client = await JmapClient.connect(from, ORG_PASSWORD);
  const [drafts, sent] = await Promise.all([client.mailboxByRole('drafts'), client.mailboxByRole('sent')]);
  const identity = (await client.identities()).find((i) => i.email === from);
  if (!drafts || !sent || !identity) throw new Error(`${from}: no drafts, sent or identity`);
  const r = await client.request([
    ['Email/set', {
      accountId: client.accountId,
      create: {
        m: {
          mailboxIds: { [drafts.id]: true },
          keywords: { $draft: true, $seen: true },
          from: [{ email: from }],
          to: [{ email: to }],
          subject,
          bodyValues: { b: { value: `Test message for the external mail spec (${RUN}).` } },
          textBody: [{ partId: 'b', type: 'text/plain' }],
        },
      },
    }, '0'],
    ['EmailSubmission/set', {
      accountId: client.accountId,
      create: { s: { identityId: identity.id, emailId: '#m' } },
      onSuccessUpdateEmail: { '#s': { [`mailboxIds/${drafts.id}`]: null, [`mailboxIds/${sent.id}`]: true, 'keywords/$draft': null } },
    }, '1'],
  ]);
  const submission = r.methodResponses[1][1];
  if (!submission.created?.s) throw new Error(`${from}: submission failed ${JSON.stringify(r.methodResponses)}`);
  const receiver = await JmapClient.connect(to, ORG_PASSWORD);
  await receiver.waitForEmail(subject, { timeoutMs: 30000 });
}

/** Polls until the account has a message with exactly this subject (the subject filter doesn't find "Re:" subjects). */
async function waitForSubject(account: string, subject: string, timeoutMs = 60000): Promise<void> {
  const client = await JmapClient.connect(account, ORG_PASSWORD);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await client.request([
      ['Email/query', { accountId: client.accountId, filter: { text: RUN }, limit: 50 }, '0'],
      ['Email/get', { accountId: client.accountId, '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' }, properties: ['subject'] }, '1'],
    ]);
    const subjects = (r.methodResponses[1][1].list as Array<{ subject: string }>).map((e) => e.subject);
    if (subjects.includes(subject)) return;
    if (Date.now() > deadline) throw new Error(`${account} has no "${subject}" (has: ${subjects.join(' | ')})`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function openMessage(page: Page, subject: string): Promise<void> {
  const row = emailItem(page, subject).first();
  await expect(row).toBeVisible({ timeout: 30000 });
  await row.click();
  await expect(page.getByRole('heading', { name: subject }).first()).toBeVisible({ timeout: 15000 });
}

const chip = (page: Page) => page.locator('[data-external-sender-chip]:visible');
const confirm = (page: Page) => page.locator('[data-external-recipient-confirm]');

async function composeTo(page: Page, to: string, subject: string): Promise<void> {
  await openComposer(page);
  await addRecipient(page, to);
  await setSubject(page, subject);
  // An empty body keeps Send disabled.
  await page.locator('[data-testid="email-composer"] [contenteditable="true"]').first().click();
  await page.keyboard.type('Hello');
  // Send with the shortcut: the recipient autocomplete can cover the button.
  await page.locator('[data-testid="composer-subject"]').first().focus();
  await page.keyboard.press('Control+Enter');
}

test.beforeAll(async ({ browser }) => {
  requireOrgEnv();
  const admin = await adminContext(browser);
  original = await getPolicy(admin);
  // Start from defaults: no scopes, both switches off.
  await putPolicy(admin, { ...original, scopes: [], organisation: {} });
  await admin.close();
  await deliver(ORG.dave, ORG.alice, FROM_DAVE);
  await deliver(ORG.bob, ORG.alice, FROM_BOB);
  await deliver(ORG.dave, ORG.alice, FROM_DAVE_2);
});

test.afterAll(async ({ browser }) => {
  const admin = await adminContext(browser);
  await putPolicy(admin, original);
  await admin.close();
});

test('with both switches off nothing is labelled or asked', async ({ browser }) => {
  const alice = await userPage(browser, ORG.alice);
  await openMessage(alice, FROM_DAVE);
  await expect(chip(alice)).toHaveCount(0);
  await composeTo(alice, ORG.dave, `Off ${RUN}`);
  await expect(alice.locator('[data-testid="email-composer"]')).toBeHidden({ timeout: 30000 });
  await expect(confirm(alice)).toHaveCount(0);
  await alice.context().close();
});

test('the admin turns both on in Organisation > Security', async ({ browser }) => {
  const admin = await adminContext(browser);
  const page = await admin.newPage();
  await page.goto('/admin/org-security');
  await expect(page.getByRole('heading', { name: 'External mail' })).toBeVisible();
  await page.getByTestId('org-external-sender-label').click();
  await page.getByTestId('org-external-recipient-warning').click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await page.locator('[data-settings-section="external"]').scrollIntoViewIfNeeded();
  await shot(page, 'external-admin-section');
  const policy = await getPolicy(admin);
  expect((policy.organisation as { externalMail: unknown }).externalMail).toMatchObject({ senderLabel: true, recipientWarning: true, trustContacts: true });
  await admin.close();
});

test('mail from org-dave is labelled External, mail from org-bob is not', async ({ browser }) => {
  const alice = await userPage(browser, ORG.alice);
  await openMessage(alice, FROM_DAVE);
  await expect(chip(alice).first()).toBeVisible();
  await expect(chip(alice).first()).toHaveAttribute('title', /org-two\.test/);
  await shot(alice, 'external-sender-chip');
  // A click (a tap on phones) names the domain.
  await chip(alice).first().click();
  await expect(alice.locator('[data-external-sender-detail]')).toContainText('org-two.test');

  await openMessage(alice, FROM_BOB);
  await expect(chip(alice)).toHaveCount(0);
  await alice.context().close();
});

test('sending to org-dave asks first, sending to org-bob does not', async ({ browser }) => {
  const alice = await userPage(browser, ORG.alice);
  await composeTo(alice, ORG.dave, `Asks ${RUN}`);
  await expect(confirm(alice)).toBeVisible();
  await expect(confirm(alice).locator('[data-external-recipients]')).toHaveText(/org-dave@org-two\.test/);
  await shot(alice, 'external-recipient-confirm');
  // Back keeps the message open and unsent.
  await confirm(alice).locator('[data-external-recipient-back]').click();
  await expect(confirm(alice)).toHaveCount(0);
  await expect(alice.locator('[data-testid="email-composer"]')).toBeVisible();
  await alice.keyboard.press('Escape');
  await alice.getByRole('button', { name: 'Discard', exact: true }).last().click();
  await expect(alice.locator('[data-testid="email-composer"]')).toBeHidden();

  await composeTo(alice, ORG.bob, `Internal ${RUN}`);
  await expect(alice.locator('[data-testid="email-composer"]')).toBeHidden({ timeout: 30000 });
  await expect(confirm(alice)).toHaveCount(0);
  await alice.context().close();
});

test('a quick reply to org-dave asks too: Back keeps the text, Send anyway sends it', async ({ browser }) => {
  const alice = await userPage(browser, ORG.alice);
  await openMessage(alice, FROM_DAVE);
  const box = alice.getByPlaceholder(/^Reply to /);
  await box.fill(`Quick reply ${RUN}`);
  await box.press('Control+Enter');
  await expect(confirm(alice)).toBeVisible();
  await confirm(alice).locator('[data-external-recipient-back]').click();
  await expect(confirm(alice)).toHaveCount(0);
  await expect(box).toHaveValue(`Quick reply ${RUN}`);
  await box.press('Control+Enter');
  await expect(confirm(alice)).toBeVisible();
  // Keys stay in the dialog: Escape answers Back and leaves the message open.
  await alice.keyboard.press('Escape');
  await expect(confirm(alice)).toHaveCount(0);
  await expect(box).toHaveValue(`Quick reply ${RUN}`);
  await box.press('Control+Enter');
  await expect(confirm(alice)).toBeVisible();
  await confirm(alice).locator('[data-external-recipient-send]').click();
  await expect(confirm(alice)).toHaveCount(0);
  await waitForSubject(ORG.dave, `Re: ${FROM_DAVE}`);
  await alice.context().close();
});

test('a scope for org-two.test with the label off applies to org-dave only', async ({ browser }) => {
  const admin = await adminContext(browser);
  const policy = await getPolicy(admin);
  await putPolicy(admin, {
    ...policy,
    scopes: [{ id: 'org-two', label: 'Org two', match: { domains: ['org-two.test'] }, policy: { organisation: { externalMail: { senderLabel: false } } } }],
  });

  // The scope shows on the admin page as an override.
  const page = await admin.newPage();
  await page.goto('/admin/org-security');
  await page.getByTestId('org-scope-bar').getByRole('button', { name: 'Org two' }).click();
  await expect(page.getByTestId('org-external-sender-label')).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByText('Everyone: on').first()).toBeVisible();
  await shot(page, 'external-admin-scope');
  await admin.close();

  // org-dave reads mail from outside org-two.test: no label for that domain.
  await deliver(ORG.alice, ORG.dave, `From alice ${RUN}`);
  const dave = await userPage(browser, ORG.dave);
  await openMessage(dave, `From alice ${RUN}`);
  await expect(chip(dave)).toHaveCount(0);
  await dave.context().close();

  // org-alice keeps it.
  const alice = await userPage(browser, ORG.alice);
  await openMessage(alice, FROM_DAVE_2);
  await expect(chip(alice).first()).toBeVisible();
  await alice.context().close();
});

test('the label and the confirm fit a phone', async ({ browser }) => {
  const alice = await userPage(browser, ORG.alice, true);
  await openMessage(alice, FROM_DAVE_2);
  await expect(chip(alice).first()).toBeVisible();
  const overflow = await alice.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const box = await chip(alice).first().boundingBox();
  expect(box && box.x + box.width).toBeLessThanOrEqual(390);
  await shot(alice, 'external-sender-chip-phone');

  await alice.goBack().catch(() => {});
  await composeTo(alice, ORG.dave, `Phone ${RUN}`);
  await expect(confirm(alice)).toBeVisible();
  const dialog = await confirm(alice).boundingBox();
  expect(dialog && dialog.x).toBeGreaterThanOrEqual(0);
  expect(dialog && dialog.x + dialog.width).toBeLessThanOrEqual(390);
  await shot(alice, 'external-recipient-confirm-phone');
  await confirm(alice).locator('[data-external-recipient-back]').click();
  await alice.context().close();
});

test('Organisation > Security fits a phone', async ({ browser }) => {
  const admin = await adminContext(browser, true);
  const page = await admin.newPage();
  await page.goto('/admin/org-security');
  await expect(page.getByTestId('org-external-sender-label')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByTestId('org-external-domains').scrollIntoViewIfNeeded();
  await shot(page, 'external-admin-section-phone');
  await admin.close();
});

// ─── The retired External Mail Warning plugin ─────────────────────────────
// Needs the 1.5.1 package (from before the plugin knew api.host): set
// IT_EMW_ZIP to its path. It is installed for this test and removed again.

test.describe('an installed External Mail Warning 1.5.1', () => {
  const zip = process.env.IT_EMW_ZIP;
  test.skip(!zip, 'set IT_EMW_ZIP to the external-mail-warning 1.5.1 zip');

  test.afterAll(async ({ browser }) => {
    const admin = await adminContext(browser);
    await admin.request.delete('/api/admin/plugins', { data: { id: 'external-mail-warning' } });
    await admin.close();
  });

  test('steps back one switch at a time, and its safe domains import', async ({ browser }) => {
    const admin = await adminContext(browser);
    // next dev compiles the sandbox page on first use, which can outlast the plugin's init timeout.
    await admin.request.get('/plugin-sandbox', { timeout: 120000 });
    const installed = await admin.request.post('/api/admin/plugins', {
      multipart: { file: { name: 'external-mail-warning.zip', mimeType: 'application/zip', buffer: readFileSync(zip!) } },
    });
    expect(installed.ok(), await installed.text()).toBe(true);
    const config = await admin.request.put('/api/admin/plugins/external-mail-warning/config', { data: { key: 'safeDomains', value: 'partner.example, other-partner.example' } });
    expect(config.ok(), await config.text()).toBe(true);

    // Core off, plugin on for everyone: the plugin asks, which shows it runs.
    const policy = await getPolicy(admin);
    const features = { ...(policy.features as Record<string, unknown>), pluginsEnabled: true };
    await putPolicy(admin, {
      ...policy, features, forceEnabledPlugins: ['external-mail-warning'], scopes: [],
      organisation: { externalMail: { senderLabel: false, recipientWarning: false } },
    });
    let alice = await userPage(browser, ORG.alice);
    // The plugin starts after the sign-in; its frame is the sign that it runs.
    await expect(alice.locator('iframe[src*="/plugin-sandbox"]').first()).toBeAttached({ timeout: 30000 });
    await composeTo(alice, ORG.dave, `Plugin asks ${RUN}`);
    const pluginDialog = alice.locator('[data-plugin-dialog="external-mail-warning"]');
    await expect(pluginDialog).toBeVisible({ timeout: 30000 });
    await expect(confirm(alice)).toHaveCount(0);
    await pluginDialog.getByRole('button', { name: 'Cancel' }).click();
    await alice.context().close();

    // The admin page asks to update the plugin and imports its list.
    await putPolicy(admin, { ...(await getPolicy(admin)), organisation: { externalMail: { senderLabel: true, recipientWarning: true } } });
    const page = await admin.newPage();
    await page.goto('/admin/org-security');
    await expect(page.getByTestId('org-external-plugin-note')).toContainText('Update or remove the External Mail Warning plugin');
    await page.getByTestId('org-external-import-plugin').click();
    await expect(page.getByTestId('org-external-domains')).toHaveValue('partner.example\nother-partner.example');
    await page.getByTestId('org-external-plugin-note').scrollIntoViewIfNeeded();
    await shot(page, 'external-admin-plugin-note');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    expect(((await getPolicy(admin)).organisation as { externalMail: { domains: string[] } }).externalMail.domains)
      .toEqual(['partner.example', 'other-partner.example']);
    await page.close();

    // Only the recipient warning on: one question on send, Bulwark's own;
    // the plugin keeps its banner.
    await putPolicy(admin, { ...(await getPolicy(admin)), organisation: { externalMail: { senderLabel: false, recipientWarning: true } } });
    alice = await userPage(browser, ORG.alice);
    await expect(alice.locator('iframe[src*="/plugin-sandbox"]').first()).toBeAttached({ timeout: 30000 });
    await openMessage(alice, FROM_DAVE_2);
    await expect(chip(alice)).toHaveCount(0);
    await expect(alice.locator('[data-plugin-slot="email-banner"]')).toHaveCount(1);
    await composeTo(alice, ORG.dave, `Core asks ${RUN}`);
    await expect(confirm(alice)).toBeVisible();
    await confirm(alice).locator('[data-external-recipient-send]').click();
    await expect(alice.locator('[data-testid="email-composer"]')).toBeHidden({ timeout: 30000 });
    await expect(alice.locator('[data-plugin-dialog="external-mail-warning"]')).toHaveCount(0);
    await waitForSubject(ORG.dave, `Core asks ${RUN}`);
    await alice.context().close();

    // Only the label on: Bulwark's chip instead of the plugin's banner; the
    // plugin still asks on send, Bulwark doesn't.
    await putPolicy(admin, { ...(await getPolicy(admin)), organisation: { externalMail: { senderLabel: true, recipientWarning: false } } });
    alice = await userPage(browser, ORG.alice);
    await expect(alice.locator('iframe[src*="/plugin-sandbox"]').first()).toBeAttached({ timeout: 30000 });
    await openMessage(alice, FROM_DAVE_2);
    await expect(chip(alice).first()).toBeVisible();
    await expect(alice.locator('[data-plugin-slot="email-banner"]')).toHaveCount(0);
    await composeTo(alice, ORG.dave, `Plugin still asks ${RUN}`);
    await expect(alice.locator('[data-plugin-dialog="external-mail-warning"]')).toBeVisible({ timeout: 30000 });
    await expect(confirm(alice)).toHaveCount(0);
    await alice.locator('[data-plugin-dialog="external-mail-warning"]').getByRole('button', { name: 'Cancel' }).click();
    await alice.context().close();
    await admin.close();
  });
});
