/**
 * The Files drive is account-scoped: switching the active account must swap the
 * drive to the new account's FileNodes and never leave the previous account's
 * folders on screen.
 *
 * Regression for the stale-drive bug: the Files store is a global that outlives
 * the FilesApp component, and it was the one account-scoped store not reset on a
 * switch (account-state-manager cleared email/contacts/calendar/… but not
 * files). So after switching accounts the old account's folders lingered until a
 * manual navigation - both when the switch happened on the Files view and, more
 * commonly, when it happened on the mail view before the drive was reopened.
 *
 * Two paths are exercised:
 *   1. switch while the Files view is NOT mounted (mail view → switch → open
 *      Files) - the reported normal-shell case, guarded by clearing the store
 *      centrally on every switch.
 *   2. switch while the Files view IS mounted (rail account switcher) - guarded
 *      by FilesApp re-initialising on the active-account change.
 */
import { test, expect } from '@playwright/test';
import { ACCOUNTS } from './helpers/config';
import { JmapClient } from './helpers/jmap';
import { login, addAccount, switchAccount, openFiles, openMailView, driveEntry } from './helpers/app';

// Distinct top-level folder in each account's drive; presence/absence of these
// names is how we tell which account's drive is on screen.
const ALICE_DIR = 'alice-only-folder';
const BOB_DIR = 'bob-only-folder';

test.describe('Files drive is account-scoped across an account switch', () => {
  test.beforeAll(async () => {
    const alice = await JmapClient.connect(ACCOUNTS.alice.email, ACCOUNTS.alice.password);
    const bob = await JmapClient.connect(ACCOUNTS.bob.email, ACCOUNTS.bob.password);
    // Start each drive from a known-empty root so the only entries are ours.
    await alice.resetFiles();
    await bob.resetFiles();
    await alice.createFileDirectory(ALICE_DIR);
    await bob.createFileDirectory(BOB_DIR);
  });

  test('switching accounts swaps the drive with no stale folders', async ({ page }) => {
    await login(page, ACCOUNTS.alice);
    await addAccount(page, ACCOUNTS.bob); // active account becomes bob

    // Bob's drive loads into the (global) Files store.
    await openFiles(page);
    await expect(driveEntry(page, BOB_DIR)).toBeVisible();
    await expect(driveEntry(page, ALICE_DIR)).toHaveCount(0);

    // Path 1 - switch happens OFF the Files view: go to mail, switch to alice
    // there (FilesApp unmounted), then reopen Files. Without the central reset
    // bob's folder would still be sitting in the store here.
    await openMailView(page);
    await switchAccount(page, ACCOUNTS.alice.email);
    await openFiles(page);
    await expect(driveEntry(page, ALICE_DIR)).toBeVisible();
    await expect(driveEntry(page, BOB_DIR)).toHaveCount(0);

    // Path 2 - switch happens ON the Files view via the rail account switcher.
    await switchAccount(page, ACCOUNTS.bob.email);
    await expect(driveEntry(page, BOB_DIR)).toBeVisible();
    await expect(driveEntry(page, ALICE_DIR)).toHaveCount(0);

    // And back again, to be sure the swap is symmetric and repeatable.
    await switchAccount(page, ACCOUNTS.alice.email);
    await expect(driveEntry(page, ALICE_DIR)).toBeVisible();
    await expect(driveEntry(page, BOB_DIR)).toHaveCount(0);
  });
});
