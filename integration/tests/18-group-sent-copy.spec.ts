import { test, expect, type Page } from '@playwright/test';
import { ACCOUNTS, GROUP } from './helpers/config';
import { JmapClient } from './helpers/jmap';
import {
  login,
  forceSync,
  openComposer,
  addRecipient,
  setSubject,
  selectComposerFrom,
  selectedComposerFrom,
  expandSharedFolders,
  openFolder,
  expectEmailVisible,
  emailItem,
  waitDraftSaved,
} from './helpers/app';

/**
 * Issue #1090: a message sent as the group's identity must be filed in the
 * GROUP account's Sent folder - for compose, reply and forward alike - not in
 * the member's own Sent.
 *
 * carol is a member of the `team` group (pre-provisioned). Stalwart lists the
 * group's team@ identity among carol's own identities too, which is how the
 * send used to slip through carol's account whenever the group account could
 * not be matched by name (e.g. a sub-addressed From, an alias identity, or an
 * account named by its bare principal name).
 */
const { bob, carol } = ACCOUNTS;
const { team } = GROUP;

let seq = 0;
const subj = (l: string) => `IT ${l} ${Date.now()}-${seq++}`;

async function send(page: Page): Promise<void> {
  // Focus without a click: the recipient autocomplete can overlay the field.
  await page.locator('[data-testid="composer-subject"]').first().focus();
  await page.keyboard.press('Control+Enter');
  await page.locator('[data-testid="email-composer"]').first().waitFor({ state: 'hidden', timeout: 20000 });
}

test.describe('Sent copy of a group identity lands in the group’s Sent (#1090)', () => {
  let jc: JmapClient;
  let teamId: string;

  test.beforeEach(async () => {
    jc = await JmapClient.connect(carol.email, carol.password);
    teamId = jc.accountIdByName(team.email);
    await jc.reset();
    await jc.reset(teamId);
  });

  /** Subjects of every message in the Sent folder of `accountId`. */
  async function sentSubjects(accountId: string): Promise<string[]> {
    return roleSubjects('sent', accountId);
  }

  /** Subjects of every message in the `role` folder of `accountId`. */
  async function roleSubjects(role: string, accountId: string): Promise<string[]> {
    const sent = (await jc.mailboxByRole(role, accountId))!.id;
    const r = await jc.request([
      ['Email/query', { accountId, filter: { inMailbox: sent } }, '0'],
      ['Email/get', { accountId, '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' }, properties: ['subject'] }, '1'],
    ]);
    return (r.methodResponses[1][1].list as Array<{ subject: string }>).map((m) => m.subject);
  }

  /**
   * Poll until a message whose subject contains `subject` ("Re: …", "Fwd: …"
   * included - Stalwart's subject filter only strips "Re:") is in the group's
   * Sent, and assert carol's own Sent has none.
   */
  async function expectInGroupSent(subject: string): Promise<void> {
    await expect
      .poll(async () => (await sentSubjects(teamId)).some((x) => x.includes(subject)), { timeout: 20000, message: 'copy in team Sent' })
      .toBe(true);
    expect((await sentSubjects(jc.accountId)).filter((x) => x.includes(subject)), 'no copy in carol’s own Sent').toEqual([]);
  }

  /** Create a received message directly in the group's Inbox (carol has write access). */
  async function placeInGroupInbox(inboxId: string, subject: string): Promise<void> {
    const r = await jc.request([['Email/set', {
      accountId: teamId,
      create: { m: {
        mailboxIds: { [inboxId]: true },
        from: [{ email: 'someone@external.test' }],
        to: [{ email: team.email }],
        subject,
        receivedAt: new Date().toISOString(),
        bodyValues: { b: { value: 'x' } },
        textBody: [{ partId: 'b', type: 'text/plain' }],
      } },
    }, '0']]);
    if (!r.methodResponses[0][1].created?.m) throw new Error(`seed failed: ${JSON.stringify(r.methodResponses[0][1])}`);
  }

  async function composeAsTeam(page: Page, subject: string): Promise<void> {
    await login(page, carol);
    await forceSync(page);
    await openComposer(page);
    await expect.poll(() => page.locator('[data-testid="composer-from"] option').allTextContents().then(t => t.join('|')), { timeout: 15000 })
      .toContain(team.email);
    await selectComposerFrom(page, team.email);
    await expect.poll(() => selectedComposerFrom(page)).toContain(team.email);
    await addRecipient(page, bob.email);
    await setSubject(page, subject);
    // An empty body keeps Send disabled.
    await page.locator('[data-testid="email-composer"] [contenteditable="true"]').first().click();
    await page.keyboard.type('Hello from the team');
  }

  test('compose as the group', async ({ page }) => {
    const s = subj('grp-compose');
    await composeAsTeam(page, s);
    await send(page);
    await expectInGroupSent(s);
  });

  test('compose as the group with a sub-addressed From', async ({ page }) => {
    const s = subj('grp-subaddr');
    await composeAsTeam(page, s);
    await page.getByTitle('Use sub-address').first().click();
    const tag = page.getByPlaceholder('Enter tag (e.g., shopping)');
    await tag.fill('news');
    await tag.press('Enter');
    await send(page);
    await expectInGroupSent(s);
  });

  for (const [mode, key] of [['reply', 'r'], ['forward', 'f']] as const) {
    test(`${mode} from the group mailbox`, async ({ page }) => {
      const original = subj(`grp-${mode}-in`);
      const inbox = (await jc.mailboxByRole('inbox', teamId))!.id;
      await placeInGroupInbox(inbox, original);

      await login(page, carol);
      await expandSharedFolders(page, team.email);
      await openFolder(page, { role: 'inbox', shared: true });
      await forceSync(page);
      await expectEmailVisible(page, original);
      await emailItem(page, original).first().click();
      await expect(emailItem(page, original).first()).toHaveAttribute('data-unread', 'false', { timeout: 15000 });
      await page.keyboard.press(key);
      await expect.poll(() => selectedComposerFrom(page), { timeout: 15000 }).toContain(team.email);
      if (mode === 'forward') await addRecipient(page, bob.email);
      await send(page);
      // The subject filter matches the base subject (no "Re:"/"Fwd:"); the
      // original sits in the group Inbox, so look in Sent only.
      await expectInGroupSent(original);
    });
  }

  test.describe('drafts of a group identity live in the group’s Drafts', () => {
    const draftsHave = async (accountId: string, subject: string) =>
      (await roleSubjects('drafts', accountId)).some((x) => x.includes(subject));

    test('autosaved draft lands in the group’s Drafts and leaves it on send', async ({ page }) => {
      const s = subj('grp-draft-send');
      await composeAsTeam(page, s);
      await waitDraftSaved(page);
      await expect.poll(() => draftsHave(teamId, s), { timeout: 20000, message: 'draft in team Drafts' }).toBe(true);
      expect(await draftsHave(jc.accountId, s), 'no draft in carol’s Drafts').toBe(false);

      await send(page);
      await expectInGroupSent(s);
      await expect.poll(() => draftsHave(teamId, s), { timeout: 20000, message: 'draft removed after send' }).toBe(false);
      expect(await draftsHave(jc.accountId, s)).toBe(false);
    });

    test('discarding removes the draft from the group’s Drafts', async ({ page }) => {
      const s = subj('grp-draft-discard');
      await composeAsTeam(page, s);
      await waitDraftSaved(page);
      await expect.poll(() => draftsHave(teamId, s), { timeout: 20000, message: 'draft in team Drafts' }).toBe(true);

      // "Discard" opens the close dialog (dirty composer); its own "Discard"
      // button discards the draft.
      const discard = page.getByRole('button', { name: 'Discard', exact: true });
      await discard.first().click();
      await expect(discard).toHaveCount(2, { timeout: 5000 });
      await discard.last().click();
      await expect.poll(() => draftsHave(teamId, s), { timeout: 20000, message: 'draft discarded' }).toBe(false);
    });
  });
});
