import { test, expect } from '@playwright/test';
import { ACCOUNTS } from './helpers/config';
import { sendMail } from './helpers/smtp';
import { JmapClient } from './helpers/jmap';
import {
  login,
  addAccount,
  seedUnifiedSettings,
  seedAllMailSettings,
  expandSharedFolders,
  folderCounts,
  expectFolderUnread,
  forceSync,
} from './helpers/app';

/**
 * Live currency of the unified / All-Mail counters across every source folder.
 *
 * Stalwart's SSE only pushes StateChange for the *primary* account, so:
 *  - a background *login* account updates the badge live (each login has its
 *    own SSE) — asserted with no reconcile;
 *  - a *shared/delegated* account gets no push at all, so the client polls the
 *    session's secondary accounts too; the badge reconciles on focus/interval.
 *    (Regression test for the shared-account state-poll.)
 */
const { alice, bob, carol } = ACCOUNTS;
const subj = (l: string) => `IT ${l} ${Date.now()}`;

async function deliverIntoSharedFolder(owner: JmapClient, folderId: string, subject: string) {
  const acct = ACCOUNTS.alice;
  await sendMail({ from: acct.email, authPass: acct.password, to: acct.email, subject, body: 'x' });
  const m = await owner.waitForEmail(subject);
  await owner.moveEmail(m.id, folderId);
}

test.describe('Live unified/All-Mail counters', () => {
  test('a background login account updates the unified counter live (no reconcile)', async ({ page }) => {
    for (const a of [alice, bob]) {
      const j = await JmapClient.connect(a.email, a.password);
      await j.reset();
    }
    await seedUnifiedSettings(page);
    await login(page, alice);
    await addAccount(page, bob); // bob active, alice in the background
    await expectFolderUnread(page, { name: 'unified-inbox' }, 0);

    // Mail lands in alice's inbox while bob is active — no focus/forceSync here.
    await sendMail({ from: alice.email, authPass: alice.password, to: alice.email, subject: subj('bg-live'), body: 'x' });
    await expectFolderUnread(page, { name: 'unified-inbox' }, 1);
  });

  test('a shared-folder change reconciles the All-Mail counter on focus', async ({ page }) => {
    const ja = await JmapClient.connect(alice.email, alice.password);
    const jc = await JmapClient.connect(carol.email, carol.password);
    await ja.reset();
    await jc.reset();
    const shared = await ja.createSharedFolder('TeamShared', carol.email);

    await seedAllMailSettings(page, { crossAccount: false });
    await login(page, carol);
    await expandSharedFolders(page, alice.email);
    expect((await folderCounts(page, { name: '__cross_all__' })).unread).toBe(0);

    // A background change in the shared (delegated) account gets no SSE push.
    await deliverIntoSharedFolder(ja, shared, subj('sh-live'));

    // Focus reconcile now polls the shared account too, so the All-Mail badge
    // picks up the shared folder's new unread.
    await forceSync(page);
    await expect
      .poll(async () => (await folderCounts(page, { name: '__cross_all__' })).unread, { timeout: 15000 })
      .toBe(1);
  });
});
