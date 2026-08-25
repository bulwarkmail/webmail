import { test, expect } from '@playwright/test';
import { ACCOUNTS } from './helpers/config';
import { sendMail } from './helpers/smtp';
import { JmapClient } from './helpers/jmap';
import {
  login,
  seedSettings,
  openFolder,
  forceSync,
  expectEmailVisible,
  expectEmailUnread,
  expectEmailStarred,
  emailItem,
  emailContextAction,
  expectFolderCountsSynced,
} from './helpers/app';

/**
 * The Unread and Starred cross views filter on the very keyword the read/star
 * actions flip. Acting on a mail from within the view (reading it in Unread,
 * un-starring it in Starred) must NOT make the row vanish on the next push /
 * focus refresh - only its status + the counters update; the row stays until
 * the view is re-opened. See the unit coverage in
 * stores/__tests__/email-store-retained-in-view.test.ts.
 */
const alice = ACCOUNTS.alice;
const UNREAD = '__cross_unread__';
const STARRED = '__cross_starred__';

let seq = 0;
const subj = (l: string) => `IT ${l} ${Date.now()}-${seq++}`;
const send = (s: string) => sendMail({ from: alice.email, authPass: alice.password, to: alice.email, subject: s, body: 'x' });

test.describe('Cross unread/starred views keep the acted-on row', () => {
  let jmap: JmapClient;

  test.beforeEach(async () => {
    jmap = await JmapClient.connect(alice.email, alice.password);
    await jmap.reset();
  });

  test('reading a mail in the Unread view keeps it visible (status + counter only)', async ({ page }) => {
    const a = subj('cr-unread-a');
    const b = subj('cr-unread-b');
    await send(a);
    await send(b);
    await jmap.waitForEmail(a);
    await jmap.waitForEmail(b);

    await seedSettings(page, { enableUnifiedMailbox: true, enableCrossUnreadView: true });
    await login(page, alice);

    await openFolder(page, { name: UNREAD });
    await forceSync(page);
    await expectEmailVisible(page, a);
    await expectEmailVisible(page, b);
    await expectFolderCountsSynced(page, { name: UNREAD }, { unread: 2 });

    // Read one from the list's context menu.
    await emailContextAction(page, a, 'ctx-mark-read');
    await expectEmailUnread(page, a, false); // status updated in place
    await expectEmailVisible(page, a); // and still shown

    // Force the focus/push refresh that previously dropped the read row.
    await forceSync(page);
    await page.waitForTimeout(1500);

    await expect(emailItem(page, a)).toHaveCount(1); // retained, not removed
    await expectEmailUnread(page, a, false);
    await expectEmailVisible(page, b);
    // The unread counter still dropped to 1 (status + counter update happened).
    await expectFolderCountsSynced(page, { name: UNREAD }, { unread: 1 });
  });

  test('un-starring a mail in the Starred view keeps it visible', async ({ page }) => {
    const a = subj('cr-star-a');
    const b = subj('cr-star-b');
    await send(a);
    await send(b);
    const ea = await jmap.waitForEmail(a);
    const eb = await jmap.waitForEmail(b);
    await jmap.setFlagged(ea.id, true);
    await jmap.setFlagged(eb.id, true);

    await seedSettings(page, { enableUnifiedMailbox: true, enableCrossStarredView: true });
    await login(page, alice);

    await openFolder(page, { name: STARRED });
    await forceSync(page);
    await expectEmailVisible(page, a);
    await expectEmailVisible(page, b);

    // Remove the star from one via the context menu.
    await emailContextAction(page, a, 'ctx-unstar');
    await expectEmailStarred(page, a, false); // status updated in place
    await expectEmailVisible(page, a); // and still shown

    await forceSync(page);
    await page.waitForTimeout(1500);

    await expect(emailItem(page, a)).toHaveCount(1); // retained, not removed
    await expectEmailStarred(page, a, false);
    await expectEmailVisible(page, b);
  });
});
