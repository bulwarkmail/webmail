import { test, expect } from '@playwright/test';
import { ACCOUNTS } from './helpers/config';
import { sendMail } from './helpers/smtp';
import { JmapClient } from './helpers/jmap';
import {
  login,
  expandSharedFolders,
  openFolder,
  folderMailboxId,
  moveEmailTo,
  forceSync,
} from './helpers/app';

/**
 * Moving mail across the own-account / shared-folder boundary, in both
 * directions, and between two shared folders (same owner and across owners).
 * The move is driven from the list context menu's "Move to" submenu; the
 * authoritative check is the server-side mailbox the message ends up in.
 *
 * Each cross-account case asserts delivery *and* that the read state survives
 * (Email/copy drops keywords unless carried). Removing the source, however, is
 * currently blocked by a Stalwart bug — onSuccessDestroyOriginal destroys the
 * copy's create-id instead of the source id, so the original is left behind
 * (support.stalw.art #1150). Those source-removal checks are pinned test.fail
 * until Stalwart ships the fix; same-account moves (Email/set) are unaffected.
 */
const { alice, bob, carol } = ACCOUNTS;
const subj = (l: string) => `IT ${l} ${Date.now()}`;
type FolderSel = Parameters<typeof folderMailboxId>[1];

test.describe('Shared-folder moves', () => {
  let ja: JmapClient; // owner A
  let jb: JmapClient; // owner B (cross-owner shared → shared)
  let jc: JmapClient; // grantee
  let teamA: string;
  let teamB: string;
  let teamC: string; // owned by bob

  test.beforeEach(async () => {
    ja = await JmapClient.connect(alice.email, alice.password);
    jb = await JmapClient.connect(bob.email, bob.password);
    jc = await JmapClient.connect(carol.email, carol.password);
    await ja.reset();
    await jb.reset();
    await jc.reset();
    teamA = await ja.createSharedFolder('TeamA', carol.email);
    teamB = await ja.createSharedFolder('TeamB', carol.email);
    teamC = await jb.createSharedFolder('TeamC', carol.email);
  });

  // Seed a message into a mailbox and mark it read, so a lost $seen after the
  // move is observable as the moved copy coming back unread.
  async function seedRead(mailboxId: string, subject: string, owner = ja): Promise<void> {
    const acct = owner === ja ? alice : owner === jb ? bob : carol;
    await sendMail({ from: acct.email, authPass: acct.password, to: acct.email, subject, body: 'x' });
    const m = await owner.waitForEmail(subject);
    await owner.moveEmail(m.id, mailboxId);
    await owner.setSeen(m.id, true);
  }

  const seenOf = (m: any) => Boolean(m?.keywords?.$seen);

  // Log in as carol, reveal the relevant shared owners, and move `subject` from
  // `source` to `dest` via the context menu.
  async function uiMove(
    page: import('@playwright/test').Page,
    opts: { subject: string; owners: string[]; source: FolderSel; dest: FolderSel },
  ): Promise<void> {
    await login(page, carol);
    for (const o of opts.owners) await expandSharedFolders(page, o);
    const destId = await folderMailboxId(page, opts.dest);
    await openFolder(page, opts.source);
    await forceSync(page);
    await moveEmailTo(page, opts.subject, destId);
    await page.waitForTimeout(2000);
  }

  const inbox: FolderSel = { role: 'inbox', shared: false };
  const shared = (name: string): FolderSel => ({ name, shared: true });

  test('shared folder A -> shared folder B (same owner)', async ({ page }) => {
    const s = subj('mv-a2b');
    await seedRead(teamA, s);
    await uiMove(page, { subject: s, owners: [alice.email], source: shared('TeamA'), dest: shared('TeamB') });

    const inB = await ja.findEmailBySubject(s, teamB);
    expect(inB, 'message in TeamB').toBeTruthy();
    expect(await ja.findEmailBySubject(s, teamA), 'message left TeamA').toBeFalsy();
    expect(seenOf(inB), 'read state kept').toBe(true);
  });

  test('shared folder B -> shared folder A (same owner)', async ({ page }) => {
    const s = subj('mv-b2a');
    await seedRead(teamB, s);
    await uiMove(page, { subject: s, owners: [alice.email], source: shared('TeamB'), dest: shared('TeamA') });

    const inA = await ja.findEmailBySubject(s, teamA);
    expect(inA, 'message in TeamA').toBeTruthy();
    expect(await ja.findEmailBySubject(s, teamB), 'message left TeamB').toBeFalsy();
    expect(seenOf(inA), 'read state kept').toBe(true);
  });

  // Cross-account cases: delivery + read state must hold (our fix); removing the
  // source is pinned test.fail below (Stalwart #1150).
  test('cross-owner shared -> shared: delivers and keeps read state', async ({ page }) => {
    const s = subj('mv-a2c');
    await seedRead(teamA, s);
    await uiMove(page, { subject: s, owners: [alice.email, bob.email], source: shared('TeamA'), dest: shared('TeamC') });

    const inC = await jb.findEmailBySubject(s, teamC);
    expect(inC, 'message in bob TeamC').toBeTruthy();
    expect(seenOf(inC), 'read state kept').toBe(true);
  });

  test('own account -> shared folder: delivers and keeps read state', async ({ page }) => {
    const s = subj('mv-own2sh');
    await sendMail({ from: carol.email, authPass: carol.password, to: carol.email, subject: s, body: 'x' });
    const own = await jc.waitForEmail(s);
    await jc.setSeen(own.id, true);
    await uiMove(page, { subject: s, owners: [alice.email], source: inbox, dest: shared('TeamA') });

    const inTeam = await ja.findEmailBySubject(s, teamA);
    expect(inTeam, 'message in shared TeamA').toBeTruthy();
    expect(seenOf(inTeam), 'read state kept').toBe(true);
  });

  test('shared folder -> own account: delivers and keeps read state', async ({ page }) => {
    const s = subj('mv-sh2own');
    await seedRead(teamA, s);
    await uiMove(page, { subject: s, owners: [alice.email], source: shared('TeamA'), dest: inbox });

    const inOwn = await jc.findEmailBySubject(s);
    expect(inOwn, 'message in own account').toBeTruthy();
    expect(seenOf(inOwn), 'read state kept').toBe(true);
  });

  // Pinned failing: Stalwart's onSuccessDestroyOriginal leaves the original in
  // place on a cross-account copy (support.stalw.art #1150). Un-pin once fixed
  // upstream (our copyEmailAcrossAccounts already requests the destroy).
  test.describe('source is removed after a cross-account move', () => {
    test.fail(true, 'blocked by Stalwart #1150 (onSuccessDestroyOriginal destroys wrong id)');

    test('cross-owner shared -> shared', async ({ page }) => {
      const s = subj('rm-a2c');
      await seedRead(teamA, s);
      await uiMove(page, { subject: s, owners: [alice.email, bob.email], source: shared('TeamA'), dest: shared('TeamC') });
      expect(await ja.findEmailBySubject(s, teamA), 'original left alice TeamA').toBeFalsy();
    });

    test('own account -> shared folder', async ({ page }) => {
      const s = subj('rm-own2sh');
      await sendMail({ from: carol.email, authPass: carol.password, to: carol.email, subject: s, body: 'x' });
      const own = await jc.waitForEmail(s);
      await jc.setSeen(own.id, true);
      await uiMove(page, { subject: s, owners: [alice.email], source: inbox, dest: shared('TeamA') });
      expect(await jc.findEmailBySubject(s), 'original left own account').toBeFalsy();
    });

    test('shared folder -> own account', async ({ page }) => {
      const s = subj('rm-sh2own');
      await seedRead(teamA, s);
      await uiMove(page, { subject: s, owners: [alice.email], source: shared('TeamA'), dest: inbox });
      expect(await ja.findEmailBySubject(s, teamA), 'original left shared TeamA').toBeFalsy();
    });
  });
});
