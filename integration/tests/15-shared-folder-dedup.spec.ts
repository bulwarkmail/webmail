import { test, expect, type Page } from '@playwright/test';
import { ACCOUNTS } from './helpers/config';
import { sendMail } from './helpers/smtp';
import { JmapClient } from './helpers/jmap';
import {
  login,
  addAccount,
  seedSettings,
  folderRow,
  openFolder,
  expectFolderCountsSynced,
  expectEmailVisible,
  emailItem,
  forceSync,
} from './helpers/app';

/**
 * A shared folder reachable through TWO logged-in accounts must show up only
 * once in the cross-account views (All mail / Unread) — both the list rows and
 * the unread badge.
 *
 * Scenarios:
 *  - owner + grantee: alice shares a folder with carol; alice and carol are both
 *    logged in, so the folder is reachable as alice's own folder AND as a
 *    shared folder via carol's session.
 *  - two grantees: alice shares a folder with bob and carol; bob and carol are
 *    logged in (alice is not), so the folder is reachable via both sessions.
 */
const { alice, bob, carol } = ACCOUNTS;
const SHARED = 'DupShared';
const ALL_MAIL = '__cross_all__';
const UNREAD = '__cross_unread__';

let seq = 0;
const subj = (l: string) => `IT ${l} ${Date.now()}-${seq++}`;

async function seedCrossViews(page: Page): Promise<void> {
  await seedSettings(page, {
    enableUnifiedMailbox: true,
    enableCrossAllView: true,
    enableCrossUnreadView: true,
    includeGroupInUnified: true,
    unifiedCrossAccount: true,
  });
}

async function expectSingleInView(page: Page, view: string, subject: string): Promise<void> {
  await openFolder(page, { name: view });
  await forceSync(page);
  await expectEmailVisible(page, subject);
  // Give a second (duplicate) row time to render before counting.
  await page.waitForTimeout(1500);
  expect.soft(await emailItem(page, subject).count(), `rows for "${subject}" in ${view}`).toBe(1);
}

test.describe('Shared folder reachable via two logged-in accounts', () => {
  let ja: JmapClient;
  let sharedId: string;

  test.beforeEach(async () => {
    ja = await JmapClient.connect(alice.email, alice.password);
    for (const a of [alice, bob, carol]) await (await JmapClient.connect(a.email, a.password)).reset();
  });

  test.afterEach(async () => {
    // Drop the shared folder so the grants don't leak into other specs.
    await ja.reset();
  });

  async function seedIntoShared(subject: string): Promise<void> {
    await sendMail({ from: alice.email, authPass: alice.password, to: alice.email, subject, body: 'x' });
    const m = await ja.waitForEmail(subject);
    await ja.moveEmail(m.id, sharedId);
  }

  test('owner + grantee logged in: shared message listed and counted once', async ({ page }) => {
    sharedId = await ja.createSharedFolder(SHARED, carol.email);
    const s = subj('dup-owner');
    await seedIntoShared(s);

    await seedCrossViews(page);
    await login(page, alice);
    await addAccount(page, carol);

    await expect(folderRow(page, { name: ALL_MAIL }).first()).toBeVisible();
    await expectSingleInView(page, ALL_MAIL, s);
    await expectSingleInView(page, UNREAD, s);

    await expectFolderCountsSynced(page, { name: UNREAD }, { unread: 1 }, 15000);
    await expectFolderCountsSynced(page, { name: ALL_MAIL }, { unread: 1 }, 15000);
  });

  test('two grantees logged in: shared message listed and counted once', async ({ page }) => {
    sharedId = await ja.createSharedFolder(SHARED, carol.email);
    await ja.shareMailbox(sharedId, bob.email);
    const s = subj('dup-grantees');
    await seedIntoShared(s);

    await seedCrossViews(page);
    await login(page, bob);
    await addAccount(page, carol);

    await expect(folderRow(page, { name: ALL_MAIL }).first()).toBeVisible();
    await expectSingleInView(page, ALL_MAIL, s);
    await expectSingleInView(page, UNREAD, s);

    await expectFolderCountsSynced(page, { name: UNREAD }, { unread: 1 }, 15000);
    await expectFolderCountsSynced(page, { name: ALL_MAIL }, { unread: 1 }, 15000);
  });
});
