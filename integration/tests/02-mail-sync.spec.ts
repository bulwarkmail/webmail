import { test, expect } from '@playwright/test';
import { ACCOUNTS } from './helpers/config';
import { sendMail } from './helpers/smtp';
import { JmapClient } from './helpers/jmap';
import {
  login,
  folderRow,
  folderCounts,
  expectFolderUnread,
  expectFolderTotal,
  emailItem,
  expectEmailVisible,
  forceSync,
} from './helpers/app';

/**
 * Single-account mail & folder synchronisation.
 *
 * These exercise the webmail's ability to reflect *external* changes to the
 * mailbox — new deliveries, server-side reads/moves/deletes, and folder
 * creation — which is where "my counts are wrong / my folder didn't show up"
 * sync bugs live. Mutations are made over SMTP/JMAP and the assertions are on
 * the rendered UI.
 */
const alice = ACCOUNTS.alice;

// Unique subject per test run avoids cross-test contamination if a reset lags.
let seq = 0;
const subj = (label: string) => `IT ${label} ${Date.now()}-${seq++}`;

test.describe('Single-account sync', () => {
  let jmap: JmapClient;

  test.beforeEach(async () => {
    jmap = await JmapClient.connect(alice.email, alice.password);
    await jmap.reset();
  });

  test('incoming mail appears and bumps the Inbox unread counter', async ({ page }) => {
    await login(page, alice);
    await expectFolderUnread(page, { role: 'inbox' }, 0);

    const subject = subj('incoming');
    await sendMail({ from: alice.email, authPass: alice.password, to: alice.email, subject, body: 'hi' });

    await expectFolderUnread(page, { role: 'inbox' }, 1);
    await expectEmailVisible(page, subject);
  });

  test('opening a message clears its unread state (UI -> server -> counter)', async ({ page }) => {
    const subject = subj('read');
    await sendMail({ from: alice.email, authPass: alice.password, to: alice.email, subject, body: 'read me' });
    await jmap.waitForEmail(subject);

    await login(page, alice);
    await expectFolderUnread(page, { role: 'inbox' }, 1);

    await emailItem(page, subject).first().click();
    await expectFolderUnread(page, { role: 'inbox' }, 0);
  });

  test('a folder created on the server shows up in the sidebar', async ({ page }) => {
    await login(page, alice);
    await expect(folderRow(page, { name: 'SyncFolder' })).toHaveCount(0);

    await jmap.createMailbox('SyncFolder');

    await expect(folderRow(page, { name: 'SyncFolder' }).first()).toBeVisible({ timeout: 20000 });
  });

  test('a server-side move updates both source and destination counters', async ({ page }) => {
    const subject = subj('move');
    await sendMail({ from: alice.email, authPass: alice.password, to: alice.email, subject, body: 'move me' });
    const email = await jmap.waitForEmail(subject);

    await login(page, alice);
    await expectFolderUnread(page, { role: 'inbox' }, 1);

    // Create destination + move the message there (server-side).
    const destId = await jmap.createMailbox('Archive2');
    const inbox = await jmap.mailboxByRole('inbox');
    await jmap.request([
      ['Email/set', { accountId: jmap.accountId, update: { [email.id]: { mailboxIds: { [destId]: true } } } }, '0'],
    ]);
    await forceSync(page);

    // Source Inbox drains, destination gains the message.
    await expectFolderUnread(page, { role: 'inbox' }, 0);
    await expectFolderTotal(page, { name: 'Archive2' }, 1);
    expect(inbox).toBeTruthy();
  });

  test('a server-side delete drains the Inbox total', async ({ page }) => {
    const subject = subj('delete');
    await sendMail({ from: alice.email, authPass: alice.password, to: alice.email, subject, body: 'delete me' });
    const email = await jmap.waitForEmail(subject);

    await login(page, alice);
    await expectFolderTotal(page, { role: 'inbox' }, 1);

    await jmap.request([['Email/set', { accountId: jmap.accountId, destroy: [email.id] }, '0']]);
    await forceSync(page);

    // The folder counter is the sync-critical signal and drains to zero. (The
    // already-rendered list view is not re-queried on a background delete, so
    // we don't assert on the row disappearing here.)
    await expectFolderTotal(page, { role: 'inbox' }, 0);
    await expectFolderUnread(page, { role: 'inbox' }, 0);
  });

  test('counts are consistent between server and UI after a burst of deliveries', async ({ page }) => {
    await login(page, alice);
    await expectFolderUnread(page, { role: 'inbox' }, 0);

    const subjects = Array.from({ length: 3 }, (_, i) => subj(`burst-${i}`));
    for (const s of subjects) {
      await sendMail({ from: alice.email, authPass: alice.password, to: alice.email, subject: s, body: 'burst' });
    }

    await expectFolderUnread(page, { role: 'inbox' }, 3);
    const counts = await folderCounts(page, { role: 'inbox' });
    expect(counts.total).toBe(3);
    for (const s of subjects) await expectEmailVisible(page, s);
  });
});
