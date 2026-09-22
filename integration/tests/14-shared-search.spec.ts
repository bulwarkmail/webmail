import { test, expect } from '@playwright/test';
import { ACCOUNTS } from './helpers/config';
import { sendMail } from './helpers/smtp';
import { JmapClient } from './helpers/jmap';
import {
  login,
  expandSharedFolders,
  openFolder,
  expectEmailVisible,
  emailItem,
  searchMail,
  clearMailSearch,
  toggleAttachmentFilter,
  listedSubjects,
} from './helpers/app';

/**
 * Search and filters inside a shared (delegated) folder. (#923)
 *
 * The search panel's folder selector defaults to "All folders" and does not
 * follow the open folder, so resolving the JMAP account from it alone sent
 * every unscoped search to the PRIMARY account: searching from a shared folder
 * silently returned the grantee's own mail, and field filters looked broken
 * because they matched there rather than in the shared mailbox.
 *
 * Each case seeds a distinctive term into BOTH accounts so a query that hits
 * the wrong one still returns something — a test that only asserts "a result
 * appears" would pass against the bug.
 */
const { alice, carol } = ACCOUNTS;
const SHARED = 'SearchShared';

let seq = 0;
const subj = (l: string) => `IT ${l} ${Date.now()}-${seq++}`;

test.describe('Shared folder search', () => {
  let ja: JmapClient; // owner (alice)
  let jc: JmapClient; // grantee (carol)
  let sharedId: string;

  test.beforeEach(async () => {
    ja = await JmapClient.connect(alice.email, alice.password);
    jc = await JmapClient.connect(carol.email, carol.password);
    await ja.reset();
    await jc.reset();
    sharedId = await ja.createSharedFolder(SHARED, carol.email);
  });

  /** Deliver to alice and move it into the folder she shares with carol. */
  async function seedIntoShared(
    subject: string,
    opts: { attachment?: { filename: string; contentType: string; content: string } } = {},
  ): Promise<void> {
    await sendMail({
      from: alice.email, authPass: alice.password, to: alice.email,
      subject, body: 'shared body', ...opts,
    });
    const m = await ja.waitForEmail(subject);
    await ja.moveEmail(m.id, sharedId);
  }

  /** Deliver straight to carol's own Inbox (the account the bug leaked to). */
  async function seedIntoOwn(
    subject: string,
    opts: { attachment?: { filename: string; contentType: string; content: string } } = {},
  ): Promise<void> {
    await sendMail({
      from: alice.email, authPass: alice.password, to: carol.email,
      subject, body: 'own body', ...opts,
    });
    await jc.waitForEmail(subject);
  }

  test('a word search in a shared folder returns the shared mail, not the searcher own', async ({ page }) => {
    const term = `zeta${Date.now()}`;
    const inShared = subj(`${term}-shared`);
    const inOwn = subj(`${term}-own`);
    await seedIntoShared(inShared);
    await seedIntoOwn(inOwn);

    await login(page, carol);
    await expandSharedFolders(page, alice.email);
    await openFolder(page, { name: SHARED, shared: true });
    await expectEmailVisible(page, inShared);

    await searchMail(page, term);

    // The hit from the shared folder, and NOT the identically-matching one
    // sitting in carol's own Inbox.
    await expect(emailItem(page, inShared).first()).toBeVisible({ timeout: 20000 });
    await expect(emailItem(page, inOwn)).toHaveCount(0);
  });

  test('the attachment filter in a shared folder filters the shared mail', async ({ page }) => {
    const withAtt = subj('att-yes');
    const withoutAtt = subj('att-no');
    const ownWithAtt = subj('att-own');
    await seedIntoShared(withAtt, {
      attachment: { filename: 'report.txt', contentType: 'text/plain', content: 'hello' },
    });
    await seedIntoShared(withoutAtt);
    await seedIntoOwn(ownWithAtt, {
      attachment: { filename: 'own.txt', contentType: 'text/plain', content: 'hello' },
    });

    await login(page, carol);
    await expandSharedFolders(page, alice.email);
    await openFolder(page, { name: SHARED, shared: true });
    await expectEmailVisible(page, withAtt);
    await expectEmailVisible(page, withoutAtt);

    await toggleAttachmentFilter(page);

    // Only the shared message that has an attachment survives: the shared one
    // without is filtered out, and carol's own attachment mail never appears.
    await expect(emailItem(page, withAtt).first()).toBeVisible({ timeout: 20000 });
    await expect(emailItem(page, withoutAtt)).toHaveCount(0);
    await expect(emailItem(page, ownWithAtt)).toHaveCount(0);
  });

  test('search in an own folder is unaffected', async ({ page }) => {
    const term = `theta${Date.now()}`;
    const inOwn = subj(`${term}-own`);
    const inShared = subj(`${term}-shared`);
    await seedIntoOwn(inOwn);
    await seedIntoShared(inShared);

    await login(page, carol);
    await searchMail(page, term);

    // Searching from her own Inbox still searches her own account only.
    await expect(emailItem(page, inOwn).first()).toBeVisible({ timeout: 20000 });
    await expect(emailItem(page, inShared)).toHaveCount(0);

    await clearMailSearch(page);
    expect(await listedSubjects(page)).toContain(inOwn);
  });
});
