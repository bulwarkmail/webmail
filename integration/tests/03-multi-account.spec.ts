import { test, expect } from '@playwright/test';
import { ACCOUNTS } from './helpers/config';
import { sendMail } from './helpers/smtp';
import { JmapClient } from './helpers/jmap';
import {
  login,
  addAccount,
  switchAccount,
  accountSwitcher,
  seedUnifiedSettings,
  folderRow,
  expectFolderUnread,
  expectFolderTotal,
  forceSync,
} from './helpers/app';

/**
 * Multi-account synchronisation — the account-scoped Unified Mailbox.
 *
 * Covers the two failure modes that dog multi-account webmail: counters
 * bleeding between accounts, and the cross-account unified view mis-aggregating
 * (or not updating when a background account receives mail).
 */
const { alice, bob } = ACCOUNTS;

let seq = 0;
const subj = (l: string) => `IT ${l} ${Date.now()}-${seq++}`;

async function send(to: typeof alice, subject: string) {
  await sendMail({ from: to.email, authPass: to.password, to: to.email, subject, body: 'x' });
}

test.describe('Multi-account sync', () => {
  test.beforeEach(async () => {
    for (const a of [alice, bob]) {
      const j = await JmapClient.connect(a.email, a.password);
      await j.reset();
    }
  });

  test('both accounts connect and their Inbox counters stay isolated', async ({ page }) => {
    // Pre-seed: two unread for alice, one for bob.
    await send(alice, subj('iso-a1'));
    await send(alice, subj('iso-a2'));
    await send(bob, subj('iso-b1'));

    await login(page, alice);
    // Active = alice: her own Inbox shows 2 unread.
    await expectFolderUnread(page, { role: 'inbox', name: 'Inbox' }, 2);

    await addAccount(page, bob);
    await forceSync(page);
    // Both accounts are now registered in the switcher.
    await accountSwitcher(page).click();
    await expect(page.locator('[data-testid="account-option"]')).toHaveCount(2);
    await page.keyboard.press('Escape');

    // Active = bob: his own Inbox shows 1 unread — alice's 2 don't leak in.
    await expectFolderUnread(page, { role: 'inbox', name: 'Inbox' }, 1);

    // Switch back to alice: her count is intact.
    await switchAccount(page, alice.email);
    await expectFolderUnread(page, { role: 'inbox', name: 'Inbox' }, 2);
  });

  test('the cross-account Unified Inbox aggregates unread across accounts', async ({ page }) => {
    await send(alice, subj('agg-a'));
    await send(bob, subj('agg-b'));

    await seedUnifiedSettings(page);
    await login(page, alice);
    await addAccount(page, bob);
    await forceSync(page);

    // Unified Inbox = alice(1) + bob(1) = 2. The active account's own Inbox
    // (bob) still reports just its own 1.
    await expect(folderRow(page, { name: 'unified-inbox' }).first()).toBeVisible();
    await expectFolderUnread(page, { name: 'unified-inbox' }, 2);
    await expectFolderTotal(page, { name: 'unified-inbox' }, 2);
    await expectFolderUnread(page, { role: 'inbox', name: 'Inbox' }, 1);
  });

  // fixme: the unified counter for a *background* (non-active) account is not
  // updated live on this branch — the background-push counter fix lives in the
  // unified-mailbox feature commits (single-source unified counters / keep
  // unified counters current for shared accounts), which sit on
  // feat/unified-mailbox-account-scope, not on this harness-only base branch.
  test.fixme('a delivery to a background account bumps the Unified Inbox counter', async ({ page }) => {
    await seedUnifiedSettings(page);
    await login(page, alice);
    await addAccount(page, bob); // bob is now the active account
    await forceSync(page);
    await expectFolderUnread(page, { name: 'unified-inbox' }, 0);

    // Mail lands in alice's inbox while bob is the active account.
    await send(alice, subj('bg'));
    await forceSync(page);

    // The unified counter reflects the background account's new mail.
    await expectFolderUnread(page, { name: 'unified-inbox' }, 1);
    // bob (active) own Inbox is unaffected.
    await expectFolderUnread(page, { role: 'inbox', name: 'Inbox' }, 0);
  });
});
