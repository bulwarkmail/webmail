/**
 * Package C: mail import (mbox, PST) and export (folder as mbox or ZIP),
 * through the real UI, as ent-carol, against a VM 106 Stalwart.
 *
 * Run with enterprise-rig/run-spec.sh. Each run works in its own folders
 * (C-<stamp>-...) and deletes them with their mail at the end; the upload
 * quota (1000 messages or 50 MB an hour per user) easily holds a run.
 */
import { test, expect, type Page, type Download } from '@playwright/test';
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ENT, ENT_PASSWORD, jmapAs, requireEntEnv, shot, userPage } from './helpers/ent';
import { JMAP_URL } from './helpers/config';
import { expandSharedFolders, folderRow } from './helpers/app';
import { listZipEntries, streamZipEntry } from '../../lib/mail-import/zip-reader';
import { ZipWriter } from '../../lib/mail-export/zip-writer';

requireEntEnv();

const USER = ENT.carol;
const STAMP = `C-${Date.now().toString(36)}`;
const PST = readFileSync(path.join(__dirname, '..', '..', 'lib', 'mail-import', '__tests__', 'fixtures', 'Outlook.pst'));
const created: string[] = [];

const MBOX = [
  'From alice@example.org Tue May  5 10:11:12 2020',
  'Status: RO',
  'From: Alice <alice@example.org>',
  `Subject: ${STAMP} mbox read`,
  'Date: Tue, 5 May 2020 10:11:00 +0000',
  '',
  '>From the start of a line',
  'body one',
  '',
  'From bob@example.org Wed May  6 11:00:00 2020',
  'Status: O',
  'X-Status: F',
  'From: Bob <bob@example.org>',
  `Subject: ${STAMP} mbox flagged`,
  'Date: Wed, 6 May 2020 10:59:00 +0000',
  '',
  'body two',
  '',
  'From carol@example.org Thu May  7 12:00:00 2020',
  'X-Mozilla-Status: 0009',
  `Subject: ${STAMP} mbox deleted`,
  '',
  'deleted in Thunderbird',
  '',
  'From dave@example.org Fri May  8 13:30:00 2020',
  `Subject: ${STAMP} mbox plain`,
  '',
  'no state header',
  '',
  // Thunderbird writes when it copied the message into the folder; the Date header is when it was sent.
  'From - Sat Nov  1 09:00:00 2025',
  'X-Mozilla-Status: 0001',
  `Subject: ${STAMP} mbox copied`,
  'Date: Mon, 2 Jan 2017 08:30:00 +0100',
  '',
  'copied years later',
  '',
].join('\n');

const auth = () => 'Basic ' + Buffer.from(`${USER}:${ENT_PASSWORD}`).toString('base64');

async function createFolder(name: string, parentId: string | null = null): Promise<string> {
  const client = await jmapAs(USER);
  const id = await client.createMailbox(name, parentId);
  created.push(id);
  return id;
}

interface Stored { id: string; subject: string; receivedAt: string; keywords: Record<string, boolean>; blobId: string; hasAttachment: boolean; mailboxIds: Record<string, boolean> }

async function messagesIn(mailboxId: string): Promise<Stored[]> {
  const client = await jmapAs(USER);
  const res = await client.request([
    ['Email/query', { accountId: client.accountId, filter: { inMailbox: mailboxId }, sort: [{ property: 'receivedAt', isAscending: true }], limit: 500 }, '0'],
    ['Email/get', { accountId: client.accountId, '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' }, properties: ['subject', 'receivedAt', 'keywords', 'blobId', 'hasAttachment', 'mailboxIds'] }, '1'],
  ]);
  return res.methodResponses[1][1].list as Stored[];
}

async function children(parentId: string): Promise<Record<string, string>> {
  const client = await jmapAs(USER);
  const all = await client.mailboxes();
  return Object.fromEntries(all.filter((m) => m.parentId === parentId).map((m) => [m.name, m.id]));
}

/** Seeds a message with Email/import, as another client would have stored it. */
async function seed(mailboxId: string, subject: string, receivedAt: string, keywords: Record<string, boolean>): Promise<void> {
  const client = await jmapAs(USER);
  const raw = `From: Seed <seed@example.org>\r\nTo: ${USER}\r\nSubject: ${subject}\r\nDate: Mon, 1 Jan 2018 08:00:00 +0000\r\nMessage-ID: <${subject.replace(/\W/g, '')}@example.org>\r\n\r\nFrom the seed: ${subject}\r\n`;
  const up = await fetch(`${JMAP_URL}/jmap/upload/${client.accountId}/`, { method: 'POST', headers: { Authorization: auth(), 'Content-Type': 'message/rfc822' }, body: raw });
  expect(up.ok).toBe(true);
  const { blobId } = await up.json();
  const res = await client.request([['Email/import', { accountId: client.accountId, emails: { e: { blobId, mailboxIds: { [mailboxId]: true }, keywords, receivedAt } } }, '0']]);
  expect(res.methodResponses[0][1].created?.e?.id, JSON.stringify(res.methodResponses[0][1])).toBeTruthy();
}

async function openFolderMenu(page: Page, name: string): Promise<void> {
  const row = folderRow(page, { name }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click({ button: 'right' });
}

async function importFromFolderMenu(page: Page, folder: string, file: { name: string; buffer: Buffer; mimeType?: string } | string, opts: { keepFolders?: boolean } = {}) {
  await openFolderMenu(page, folder);
  await page.getByRole('menuitem', { name: 'Import mail…' }).click();
  const dialog = page.getByTestId('mail-import-dialog');
  await expect(dialog).toBeVisible();
  // A path keeps the file's date, which the resume checkpoint is keyed on, like a file on the user's disk.
  await page.getByTestId('mail-import-file').setInputFiles(typeof file === 'string' ? file : { name: file.name, mimeType: file.mimeType ?? 'application/octet-stream', buffer: file.buffer });
  await expect(dialog.getByText(typeof file === 'string' ? path.basename(file) : file.name)).toBeVisible();
  if (opts.keepFolders === false) await dialog.getByRole('checkbox', { name: /Recreate the folders/ }).uncheck();
  return dialog;
}

/** Hides the save picker so the export goes through the private file and a download Playwright can read. */
async function withoutSavePicker(page: Page): Promise<void> {
  await page.evaluate(() => { delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker; });
}

async function exportFolder(page: Page, folder: string, format: 'mbox' | 'eml'): Promise<Download> {
  await withoutSavePicker(page);
  await openFolderMenu(page, folder);
  await page.getByTestId('mailbox-export').click();
  const dialog = page.getByTestId('mail-export-dialog');
  await expect(dialog).toBeVisible();
  await page.getByTestId(`mail-export-format-${format}`).check();
  const download = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByTestId('mail-export-start').click();
  const file = await download;
  await expect(dialog.getByRole('heading', { name: 'Export finished' })).toBeVisible({ timeout: 60_000 });
  return file;
}

async function readDownload(download: Download): Promise<Buffer> {
  return readFileSync(await download.path());
}

async function openBackupSettings(page: Page): Promise<void> {
  await page.goto('/settings/backup');
  // On a phone a settings link opens the list of sections first.
  const button = page.getByTestId('settings-mail-import');
  if (!(await button.isVisible().catch(() => false))) {
    await page.getByText('Backup & reset', { exact: true }).first().click();
  }
  await expect(button).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  const client = await jmapAs(USER);
  // Children first: a folder with subfolders can't be destroyed.
  const all = await client.mailboxes();
  const ours = all.filter((m) => m.name.startsWith(STAMP) || created.includes(m.id));
  const withDescendants = new Set(ours.map((m) => m.id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const m of all) if (m.parentId && withDescendants.has(m.parentId) && !withDescendants.has(m.id)) { withDescendants.add(m.id); grew = true; }
  }
  const depth = (id: string): number => { const m = all.find((x) => x.id === id); return m?.parentId ? 1 + depth(m.parentId) : 0; };
  const ids = [...withDescendants].sort((a, b) => depth(b) - depth(a));
  for (const id of ids) {
    await client.request([['Mailbox/set', { accountId: client.accountId, destroy: [id], onDestroyRemoveEmails: true }, '0']]).catch(() => {});
  }
});

test('an mbox lands in the folder with its dates, read and flagged state, and the deleted message left out', async ({ browser }) => {
  const folderName = `${STAMP} mbox`;
  const folderId = await createFolder(folderName);
  const page = await userPage(browser, USER);
  const dialog = await importFromFolderMenu(page, folderName, { name: 'thunderbird.mbox', buffer: Buffer.from(MBOX) });
  await expect(dialog.getByText('mbox file')).toBeVisible();
  await shot(page, 'c-import-dialog');
  await page.getByTestId('mail-import-start').click();
  await expect(dialog.getByRole('heading', { name: 'Import finished' })).toBeVisible({ timeout: 60_000 });
  await expect(dialog.getByText('Messages imported: 4')).toBeVisible();
  await expect(dialog.getByText('Deleted in Thunderbird: 1')).toBeVisible();
  await shot(page, 'c-import-summary');

  const stored = await messagesIn(folderId);
  expect(stored.map((m) => m.subject)).toEqual([`${STAMP} mbox copied`, `${STAMP} mbox read`, `${STAMP} mbox flagged`, `${STAMP} mbox plain`]);
  // The Date header first; the envelope line only where there is none.
  expect(stored.map((m) => m.receivedAt)).toEqual(['2017-01-02T07:30:00Z', '2020-05-05T10:11:00Z', '2020-05-06T10:59:00Z', '2020-05-08T13:30:00Z']);
  expect(stored.map((m) => !!m.keywords.$seen)).toEqual([true, true, false, true]);
  expect(stored.map((m) => !!m.keywords.$flagged)).toEqual([false, false, true, false]);
  // The stored message starts with its own headers (no leftover "From " envelope line) and is unquoted.
  const res = await fetch(`${JMAP_URL}/jmap/download/${(await jmapAs(USER)).accountId}/${stored[1].blobId}/m.eml?accept=message/rfc822`, { headers: { Authorization: auth() } });
  const raw = await res.text();
  expect(raw.startsWith('From: Alice')).toBe(true);
  expect(raw).toContain('\nFrom the start of a line');
  expect(raw).not.toMatch(/^Status:/m);
  await page.context().close();
});

test('a PST lands in its own folders under the target with dates, read state and attachments', async ({ browser }) => {
  const parentName = `${STAMP} pst`;
  const parentId = await createFolder(parentName);
  const page = await userPage(browser, USER);
  const dialog = await importFromFolderMenu(page, parentName, { name: 'Outlook.pst', buffer: PST });
  await expect(dialog.getByText('Outlook data file')).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: /Recreate the folders/ })).toBeChecked();
  await page.getByTestId('mail-import-start').click();
  await expect(dialog.getByRole('heading', { name: 'Import finished' })).toBeVisible({ timeout: 90_000 });
  await expect(dialog.getByText('Messages imported: 14')).toBeVisible();
  await expect(dialog.getByText('Folders created: 2')).toBeVisible();
  await expect(dialog.getByText('Contacts: 1')).toBeVisible();
  await expect(dialog.getByText('Calendar items: 1')).toBeVisible();
  await expect(dialog.getByText('Messages attached to other messages: 4')).toBeVisible();

  const folders = await children(parentId);
  expect(Object.keys(folders).sort()).toEqual(['Inbox', 'Sent Items']);
  const inbox = await messagesIn(folders.Inbox);
  const sent = await messagesIn(folders['Sent Items']);
  expect(inbox).toHaveLength(8);
  expect(sent).toHaveLength(6);
  expect(inbox.filter((m) => !m.keywords.$seen).map((m) => m.subject).sort()).toEqual(['message 1', 'message 2']);
  expect(inbox.find((m) => m.subject === 'Multiple attachments')?.receivedAt).toBe('2011-06-21T23:51:07Z');
  expect(inbox.find((m) => m.subject === 'Multiple attachments')?.hasAttachment).toBe(true);
  // A message from the Sent folder, rebuilt without original headers.
  const client = await jmapAs(USER);
  const detail = await client.request([['Email/get', { accountId: client.accountId, ids: [sent.find((m) => m.subject === 'HTML body')!.id], properties: ['from', 'to', 'sentAt', 'attachments', 'htmlBody'] }, '0']]);
  const html = detail.methodResponses[0][1].list[0];
  expect(html.from[0].email).toBe('saqib.razzaq@xp.local');
  expect(html.attachments.length).toBeGreaterThanOrEqual(12);
  await page.context().close();
});

test('a folder exported as mbox from the UI imports back to the same messages, dates and read state', async ({ browser }) => {
  const sourceName = `${STAMP} export`;
  const sourceId = await createFolder(sourceName);
  await seed(sourceId, `${STAMP} exp read`, '2019-03-01T08:00:00Z', { $seen: true });
  await seed(sourceId, `${STAMP} exp flagged`, '2019-03-02T09:30:00Z', { $flagged: true });
  await seed(sourceId, `${STAMP} exp answered`, '2019-03-03T10:45:00Z', { $seen: true, $answered: true });
  const backName = `${STAMP} reimport`;
  const backId = await createFolder(backName);
  const page = await userPage(browser, USER);

  const download = await exportFolder(page, sourceName, 'mbox');
  expect(download.suggestedFilename()).toBe(`${sourceName}.mbox`);
  const mbox = await readDownload(download);
  expect(mbox.toString('latin1')).toMatch(/^From bulwark-export Fri Mar  1 08:00:00 2019\r?\n/);
  expect(mbox.toString('latin1')).toContain('>From the seed');
  await shot(page, 'c-export-done');
  await page.getByRole('button', { name: 'Close' }).last().click();

  const dialog = await importFromFolderMenu(page, backName, { name: download.suggestedFilename(), buffer: mbox });
  await page.getByTestId('mail-import-start').click();
  await expect(dialog.getByRole('heading', { name: 'Import finished' })).toBeVisible({ timeout: 60_000 });

  const original = await messagesIn(sourceId);
  const back = await messagesIn(backId);
  const view = (list: Stored[]) => list.map((m) => ({ subject: m.subject, receivedAt: m.receivedAt, seen: !!m.keywords.$seen, flagged: !!m.keywords.$flagged, answered: !!m.keywords.$answered }));
  expect(back).toHaveLength(3);
  expect(view(back)).toEqual(view(original));
  await page.context().close();
});

test('a folder exported as a ZIP of .eml files imports back to the same messages', async ({ browser }) => {
  const sourceName = `${STAMP} export`;
  const client = await jmapAs(USER);
  const sourceId = (await client.mailboxByName(sourceName))!.id;
  const backName = `${STAMP} reimport zip`;
  const backId = await createFolder(backName);
  const page = await userPage(browser, USER);
  const download = await exportFolder(page, sourceName, 'eml');
  expect(download.suggestedFilename()).toBe(`${sourceName}.zip`);
  const zip = await readDownload(download);
  expect(zip.subarray(0, 4).toString('latin1')).toBe('PK\u0003\u0004');
  await page.getByRole('button', { name: 'Close' }).last().click();

  const dialog = await importFromFolderMenu(page, backName, { name: download.suggestedFilename(), buffer: zip });
  await expect(dialog.getByText('ZIP archive')).toBeVisible();
  await page.getByTestId('mail-import-start').click();
  await expect(dialog.getByRole('heading', { name: 'Import finished' })).toBeVisible({ timeout: 60_000 });
  const original = await messagesIn(sourceId);
  const back = await messagesIn(backId);
  // Kept: every message, byte for byte. Lost: the state and arrival time,
  // which .eml files don't hold. They come back read and dated by their Date header.
  expect(back.map((m) => m.subject).sort()).toEqual(original.map((m) => m.subject).sort());
  expect(original.some((m) => !m.keywords.$seen)).toBe(true);
  expect(back.every((m) => m.keywords.$seen)).toBe(true);
  expect(back.every((m) => m.receivedAt === '2018-01-01T08:00:00Z')).toBe(true);
  await page.context().close();
});

test('the whole account exported from Settings holds a mbox file per folder', async ({ browser }) => {
  const page = await userPage(browser, USER);
  await openBackupSettings(page);
  await withoutSavePicker(page);
  await page.getByTestId('settings-mail-export').click();
  const dialog = page.getByTestId('mail-export-dialog');
  await expect(dialog.getByRole('heading', { name: 'Export all mail' })).toBeVisible();
  const download = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByTestId('mail-export-start').click();
  const file = await download;
  await expect(dialog.getByRole('heading', { name: 'Export finished' })).toBeVisible({ timeout: 120_000 });
  expect(file.suggestedFilename()).toMatch(/^ent-carol@example\.org-\d{4}-\d{2}-\d{2}\.zip$/);
  const zip = new Blob([await readDownload(file)]);
  const entries = await listZipEntries(zip);
  const exported = entries.find((e) => e.name === `${STAMP} export.mbox`);
  expect(exported, entries.map((e) => e.name).join(', ')).toBeTruthy();
  let text = '';
  for await (const chunk of streamZipEntry(zip, exported!)) text += Buffer.from(chunk).toString('latin1');
  expect(text.match(/^From bulwark-export /gm)).toHaveLength(3);
  expect(text).toContain(`Subject: ${STAMP} exp flagged`);
  // A folder inside another one is written under its path.
  expect(entries.some((e) => e.name === `${STAMP} pst/Sent Items.mbox`)).toBe(true);
  await page.context().close();
});

test('an import into a folder shared with the user lands in the sharer\'s account', async ({ browser }) => {
  const alice = await jmapAs(ENT.alice);
  const sharedName = `${STAMP} shared`;
  const sharedId = await alice.createSharedFolder(sharedName, USER);
  try {
    const page = await userPage(browser, USER);
    await expandSharedFolders(page, ENT.alice);
    const row = folderRow(page, { name: sharedName, shared: true }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Import mail…' }).click();
    const dialog = page.getByTestId('mail-import-dialog');
    await page.getByTestId('mail-import-file').setInputFiles({ name: 'shared.mbox', mimeType: 'application/mbox', buffer: Buffer.from(`From - Mon Jun  1 10:00:00 2020\nSubject: ${STAMP} into shared\nDate: Mon, 1 Jun 2020 09:00:00 +0000\n\nbody\n`) });
    await page.getByTestId('mail-import-start').click();
    await expect(dialog.getByRole('heading', { name: 'Import finished' })).toBeVisible({ timeout: 60_000 });
    const res = await alice.request([
      ['Email/query', { accountId: alice.accountId, filter: { inMailbox: sharedId } }, '0'],
      ['Email/get', { accountId: alice.accountId, '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' }, properties: ['subject'] }, '1'],
    ]);
    expect(res.methodResponses[1][1].list.map((m: { subject: string }) => m.subject)).toEqual([`${STAMP} into shared`]);
    await page.context().close();
  } finally {
    await alice.request([['Mailbox/set', { accountId: alice.accountId, destroy: [sharedId], onDestroyRemoveEmails: true }, '0']]).catch(() => {});
  }
});

test('a ZIP imported at the top level puts its Sent Items folder into the user\'s own Sent folder', async ({ browser }) => {
  const parts: Uint8Array[] = [];
  const z = new ZipWriter(async (c) => { parts.push(c.slice()); });
  await z.addFile('Sent Items/1.eml', new TextEncoder().encode(`From: ${USER}\r\nTo: x@example.org\r\nSubject: ${STAMP} into sent\r\nDate: Mon, 1 Jun 2020 09:00:00 +0000\r\n\r\nbody\r\n`));
  await z.finish();
  const client = await jmapAs(USER);
  const sent = (await client.mailboxByRole('sent'))!;
  const page = await userPage(browser, USER);
  await openBackupSettings(page);
  await page.getByTestId('settings-mail-import').click();
  const dialog = page.getByTestId('mail-import-dialog');
  await page.getByTestId('mail-import-file').setInputFiles({ name: 'tree.zip', mimeType: 'application/zip', buffer: Buffer.concat(parts) });
  await expect(dialog.getByRole('checkbox', { name: /Recreate the folders/ })).toBeChecked();
  await page.getByTestId('mail-import-target').selectOption({ label: 'Top level' });
  await expect(dialog.getByText(/At the top level, Inbox, Sent Items/)).toBeVisible();
  await page.getByTestId('mail-import-start').click();
  await expect(dialog.getByRole('heading', { name: 'Import finished' })).toBeVisible({ timeout: 60_000 });
  await expect(dialog.getByText(/Folders created/)).toHaveCount(0);
  const res = await client.request([
    ['Email/query', { accountId: client.accountId, filter: { inMailbox: sent.id, text: STAMP } }, '0'],
    ['Email/get', { accountId: client.accountId, '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' }, properties: ['subject'] }, '1'],
  ]);
  const found = (res.methodResponses[1][1].list as { id: string; subject: string }[]).filter((m) => m.subject === `${STAMP} into sent`);
  expect(found).toHaveLength(1);
  // Not left in the user's real Sent folder.
  await client.request([['Email/set', { accountId: client.accountId, destroy: found.map((m) => m.id) }, '0']]);
  await page.context().close();
});

test('the progress dialog cancels an import, keeps what came in, and continues later without duplicates', async ({ browser }) => {
  const folderName = `${STAMP} cancel`;
  const folderId = await createFolder(folderName);
  const count = 40;
  const big = Array.from({ length: count }, (_, i) =>
    `From x@example.org Mon Jun  1 10:${String(i).padStart(2, '0')}:00 2020\nSubject: ${STAMP} n${i}\n\nbody ${i}\n\n`).join('');
  const onDisk = path.join(mkdtempSync(path.join(tmpdir(), 'bulwark-c-')), 'many.mbox');
  writeFileSync(onDisk, big);
  utimesSync(onDisk, new Date('2024-01-01T00:00:00Z'), new Date('2024-01-01T00:00:00Z'));
  const page = await userPage(browser, USER);
  // Slow uploads down so Cancel lands in the middle.
  await page.route(/\/jmap\/upload\//, async (route) => {
    await new Promise((r) => setTimeout(r, 500));
    // Cancel aborts uploads that are still held here.
    await route.continue().catch(() => {});
  });
  const dialog = await importFromFolderMenu(page, folderName, onDisk);
  await page.getByTestId('mail-import-start').click();
  await expect(dialog.getByRole('heading', { name: 'Importing mail' })).toBeVisible();
  await expect(dialog.getByRole('progressbar', { name: 'Import progress' })).toBeVisible();
  await expect(dialog.getByTestId('mail-import-count')).toHaveText(/Messages imported: [1-9]/, { timeout: 30_000 });
  await shot(page, 'c-import-progress');
  await dialog.getByRole('button', { name: 'Cancel import' }).click();
  await expect(dialog.getByRole('heading', { name: 'Import cancelled' })).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByText('To go on later, import the same files into the same folder again.')).toBeVisible();
  const partial = (await messagesIn(folderId)).length;
  expect(partial).toBeGreaterThan(0);
  expect(partial).toBeLessThan(count);
  await page.getByRole('button', { name: 'Close' }).last().click();
  await page.unroute(/\/jmap\/upload\//);

  const again = await importFromFolderMenu(page, folderName, onDisk);
  const resume = again.getByRole('checkbox', { name: /Continue where the last import/ });
  await expect(resume).toBeChecked();
  await page.getByTestId('mail-import-start').click();
  await expect(again.getByRole('heading', { name: 'Import finished' })).toBeVisible({ timeout: 60_000 });
  const all = await messagesIn(folderId);
  expect(all).toHaveLength(count);
  expect(new Set(all.map((m) => m.subject)).size).toBe(count);
  await page.context().close();
});

test('import and export dialogs fill the screen at 390 px and import from Settings', async ({ browser }) => {
  const targetName = `${STAMP} phone`;
  const target = await createFolder(targetName);
  const page = await userPage(browser, USER, true);
  await openBackupSettings(page);
  await page.getByTestId('settings-mail-import').click();
  const dialog = page.getByTestId('mail-import-dialog');
  await expect(dialog).toBeVisible();
  // Full screen once the opening animation is over.
  await expect.poll(async () => (await dialog.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(389);
  await page.getByTestId('mail-import-file').setInputFiles({ name: 'phone.mbox', mimeType: 'application/mbox', buffer: Buffer.from(MBOX.replaceAll(`${STAMP} mbox`, `${STAMP} phone`)) });
  // From Settings there is no folder to start from: pick one.
  await page.getByTestId('mail-import-target').selectOption({ label: targetName });
  await page.waitForTimeout(300);
  await shot(page, 'c-import-phone');
  await page.getByTestId('mail-import-start').click();
  await expect(dialog.getByRole('heading', { name: 'Import finished' })).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => (await dialog.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(389);
  await shot(page, 'c-import-phone-summary');
  // Four messages; the one Thunderbird marked deleted stays out.
  expect(await messagesIn(target)).toHaveLength(4);
  await page.getByRole('button', { name: 'Close' }).last().click();

  await page.getByTestId('settings-mail-export').click();
  const exportDialog = page.getByTestId('mail-export-dialog');
  await expect(exportDialog.getByRole('heading', { name: 'Export all mail' })).toBeVisible();
  await expect.poll(async () => (await exportDialog.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(389);
  await shot(page, 'c-export-phone');
  // Escape closes it and the focus goes back to the button that opened it.
  await page.keyboard.press('Escape');
  await expect(exportDialog).toBeHidden();
  await expect(page.getByTestId('settings-mail-export')).toBeFocused();
  await page.context().close();
});
