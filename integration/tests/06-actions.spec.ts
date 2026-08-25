import { test, expect } from '@playwright/test';
import { ACCOUNTS } from './helpers/config';
import { sendMail } from './helpers/smtp';
import { JmapClient } from './helpers/jmap';
import {
  login,
  expectFolderUnread,
  expectFolderTotal,
  expectFolderCountsSynced,
  expectEmailVisible,
  expectEmailUnread,
  emailContextAction,
  emailItem,
  openFolder,
} from './helpers/app';

/**
 * Message actions from the list context menu — mark read/unread, delete, spam —
 * performed in the Inbox, with the outcome checked on both the UI (counters,
 * row state) and the server (which mailbox the message ended up in).
 */
const alice = ACCOUNTS.alice;
let seq = 0;
const subj = (l: string) => `IT ${l} ${Date.now()}-${seq++}`;
const send = (subject: string) =>
  sendMail({ from: alice.email, authPass: alice.password, to: alice.email, subject, body: 'x' });

test.describe('Inbox message actions', () => {
  let jmap: JmapClient;

  test.beforeEach(async () => {
    jmap = await JmapClient.connect(alice.email, alice.password);
    await jmap.reset();
  });

  test('mark read then unread toggles the row state and Inbox unread counter', async ({ page }) => {
    const s = subj('act-read');
    await send(s);
    await jmap.waitForEmail(s);

    await login(page, alice);
    await expectFolderUnread(page, { role: 'inbox' }, 1);
    await expectEmailUnread(page, s, true);

    await emailContextAction(page, s, 'ctx-mark-read');
    await expectEmailUnread(page, s, false);
    await expectFolderUnread(page, { role: 'inbox' }, 0);

    await emailContextAction(page, s, 'ctx-mark-unread');
    await expectEmailUnread(page, s, true);
    await expectFolderUnread(page, { role: 'inbox' }, 1);
  });

  test('delete moves the message to Trash and updates both counters', async ({ page }) => {
    const s = subj('act-del');
    await send(s);
    await jmap.waitForEmail(s);

    await login(page, alice);
    await expectFolderTotal(page, { role: 'inbox' }, 1);

    await emailContextAction(page, s, 'ctx-delete');

    // Leaves the Inbox, lands in Trash — on the UI...
    await expectFolderTotal(page, { role: 'inbox' }, 0);
    await expectFolderTotal(page, { role: 'trash' }, 1);
    await expect(emailItem(page, s)).toHaveCount(0);

    // ...and on the server.
    const trash = await jmap.mailboxByRole('trash');
    const found = await jmap.findEmailBySubject(s, trash!.id);
    expect(found, 'deleted message is in Trash on the server').toBeTruthy();
  });

  test('mark as spam moves the message to Junk', async ({ page }) => {
    const s = subj('act-spam');
    await send(s);
    await jmap.waitForEmail(s);

    await login(page, alice);
    await expectFolderTotal(page, { role: 'inbox' }, 1);

    await emailContextAction(page, s, 'ctx-spam');

    // The destination (Junk) counter updates optimistically, but the source
    // (Inbox) counter isn't always decremented until the next reconcile when
    // the action fires moments after login — unlike delete, which decrements
    // the source immediately. The synced assertion nudges a reconcile per poll.
    await expectFolderCountsSynced(page, { role: 'junk' }, { total: 1 });
    await expectFolderCountsSynced(page, { role: 'inbox' }, { total: 0 });

    const junk = await jmap.mailboxByRole('junk');
    const found = await jmap.findEmailBySubject(s, junk!.id);
    expect(found, 'spammed message is in Junk on the server').toBeTruthy();
  });

  test('spam then not-spam round-trips the message back out of Junk', async ({ page }) => {
    const s = subj('act-notspam');
    await send(s);
    await jmap.waitForEmail(s);

    await login(page, alice);
    await emailContextAction(page, s, 'ctx-spam');
    await expectFolderCountsSynced(page, { role: 'junk' }, { total: 1 });

    // Open Junk, then mark not-spam.
    await openFolder(page, { role: 'junk' });
    await expectEmailVisible(page, s);
    await emailContextAction(page, s, 'ctx-not-spam');

    // The message leaves the open Junk list (optimistic) and round-trips on the
    // server: out of Junk, back in Inbox. (Asserted on the optimistic list +
    // authoritative server state rather than the Junk badge, whose reconcile
    // can stall under heavy concurrent load.)
    await expect(emailItem(page, s)).toHaveCount(0);
    const junk = await jmap.mailboxByRole('junk');
    const inbox = await jmap.mailboxByRole('inbox');
    expect(await jmap.findEmailBySubject(s, junk!.id), 'message no longer in Junk').toBeFalsy();
    expect(await jmap.findEmailBySubject(s, inbox!.id), 'message back in Inbox').toBeTruthy();
  });
});
