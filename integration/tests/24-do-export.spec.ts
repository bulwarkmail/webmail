/**
 * Export of the local store, through the real UI, as ent-dave, against a VM 106
 * Stalwart: a folder written with the browser offline is the bytes the server has,
 * the private files never hold readable mail, what has no original here is counted
 * and can be tried again online, and "No export" holds.
 *
 * Run with desktop-offline-rig/run-spec.sh. Works in its own folder and deletes it
 * with its mail at the end.
 */
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { ENT, ENT_PASSWORD, adminContext, jmapAs, requireEntEnv, shot, userPage, withPolicy } from './helpers/ent';
import { JMAP_URL } from './helpers/config';
import { listZipEntries, readZipEntry } from '../../lib/mail-import/zip-reader';
import { MboxSplitter } from '../../lib/mail-import/mbox';
import { withoutStateHeaders } from '../../lib/mail-import/mbox-status';

requireEntEnv();
test.describe.configure({ mode: 'serial' });
test.setTimeout(300_000);

const USER = ENT.dave;
const STAMP = `D10-${Date.now().toString(36)}`;
const FOLDER = `${STAMP}-folder`;
const SECRET = `Secret${STAMP.replace(/\W/g, '')}`;
const COUNT = 3;
const DEVICES_OFF = { noDownloads: false, noExport: false, noPrint: false, noInstallPrompt: false, pushWithoutContent: false, watermark: false, noOffline: false };

const auth = () => 'Basic ' + Buffer.from(`${USER}:${ENT_PASSWORD}`).toString('base64');

/** Bytes a rebuilt message wouldn't have: a Latin-1 byte, a bare LF, odd spacing, signature-like headers, mbox traps. */
function rawMessage(n: number): Buffer {
  return Buffer.concat([
    Buffer.from(`From: Seed <seed@example.org>\r\nTo: ${USER}\r\nSubject:   ${SECRET} subject ${n}  \r\nDate: Mon, 1 Jan 2018 08:00:0${n} +0000\r\nMessage-ID: <${STAMP}-${n}@example.org>\r\nDKIM-Signature: v=1; a=rsa-sha256; b=abc${n}\r\nContent-Type: text/plain; charset=iso-8859-1\r\n\r\n`),
    Buffer.from([0xe4, 0x0a]),
    Buffer.from(`From the start of a line ${n}\r\n>From quoted once\n${SECRET} body ${n}\r\n`),
  ]);
}

let mailbox = '';
const blobIds: string[] = [];
const originals: Buffer[] = [];

test.beforeAll(async () => {
  const client = await jmapAs(USER);
  mailbox = await client.createMailbox(FOLDER);
  for (let n = 1; n <= COUNT; n += 1) {
    const up = await fetch(`${JMAP_URL}/jmap/upload/${client.accountId}/`, { method: 'POST', headers: { Authorization: auth(), 'Content-Type': 'message/rfc822' }, body: rawMessage(n) });
    expect(up.ok).toBe(true);
    const { blobId } = await up.json();
    const res = await client.request([['Email/import', { accountId: client.accountId, emails: { e: { blobId, mailboxIds: { [mailbox]: true }, keywords: { $seen: true }, receivedAt: new Date(Date.now() + n * 1000).toISOString().replace(/\.\d+Z/, 'Z') } } }, '0']]);
    const created = res.methodResponses[0][1].created?.e;
    expect(created?.id, JSON.stringify(res.methodResponses[0][1])).toBeTruthy();
    blobIds.push(created.blobId);
    const download = await fetch(`${JMAP_URL}/jmap/download/${client.accountId}/${created.blobId}/m.eml?accept=message/rfc822`, { headers: { Authorization: auth() } });
    expect(download.ok).toBe(true);
    // What the server has is the reference, whatever it did with the upload.
    originals.push(Buffer.from(await download.arrayBuffer()));
  }
});

test.afterAll(async () => {
  const client = await jmapAs(USER);
  await client.request([['Mailbox/set', { accountId: client.accountId, destroy: [mailbox], onDestroyRemoveEmails: true }, '0']]).catch(() => {});
});

/** Every write to a private file is kept, and the export has no save picker, so it goes to the spool. */
const INIT = () => {
  const proto = FileSystemWritableFileStream.prototype as unknown as { write(data: unknown): Promise<void> };
  const write = proto.write;
  const seen: Uint8Array[] = [];
  (window as unknown as { __spoolWrites: Uint8Array[] }).__spoolWrites = seen;
  proto.write = function patched(data: unknown) {
    if (data instanceof Uint8Array) seen.push(data.slice());
    return write.call(this, data);
  };
  delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
};

let page: Page;
let context: BrowserContext;

async function settings(target: Page): Promise<void> {
  await target.goto('/settings/backup/offline');
  await expect(target.getByTestId('offline-switch')).toBeVisible({ timeout: 30_000 });
}

async function openDialog(): Promise<void> {
  await page.getByTestId('local-export-open').click();
  await expect(page.getByTestId('local-export-dialog')).toBeVisible();
  await expect(page.getByTestId('local-export-summary')).toBeVisible({ timeout: 30_000 });
  // The test's folder only.
  await page.getByTestId('local-export-all').click();
  await page.locator(`[data-folder="${FOLDER}"]`).click();
}

async function closeSetup(): Promise<void> {
  await page.getByTestId('local-export-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByTestId('local-export-dialog')).toBeHidden();
}

async function closeSummary(): Promise<void> {
  await page.getByTestId('local-export-dialog').getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(page.getByTestId('local-export-dialog')).toBeHidden();
}

async function waitForOriginals(wanted: string): Promise<void> {
  await expect.poll(async () => {
    await openDialog();
    const text = await page.getByTestId('local-export-kept').textContent();
    await closeSetup();
    return text;
  }, { timeout: 240_000, intervals: [5_000] }).toContain(wanted);
}

async function exported(format: 'mbox' | 'eml'): Promise<Buffer> {
  await page.getByTestId(`local-export-format-${format}`).check();
  const download = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByTestId('local-export-start').click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`${FOLDER}.${format === 'mbox' ? 'mbox' : 'zip'}`);
  await expect(page.getByTestId('mail-export-status')).toBeVisible();
  return readFileSync(await file.path());
}

function mboxMessages(bytes: Buffer): Buffer[] {
  const splitter = new MboxSplitter();
  return [...splitter.push(new Uint8Array(bytes)), ...splitter.end()].map((message) => Buffer.concat(withoutStateHeaders(message.parts)));
}

function expectOriginals(messages: Buffer[]): void {
  expect(messages.length).toBe(COUNT);
  for (let i = 0; i < COUNT; i += 1) expect(messages[i].equals(originals[i]), `message ${i + 1} differs`).toBe(true);
}

async function spoolReport(): Promise<{ left: string[]; bytes: number; readable: boolean }> {
  return page.evaluate(async (secret) => {
    const writes = (window as unknown as { __spoolWrites: Uint8Array[] }).__spoolWrites;
    const decoder = new TextDecoder('latin1');
    const root = await navigator.storage.getDirectory();
    const left: string[] = [];
    try {
      const dir = await root.getDirectoryHandle('bulwark-exports');
      for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) left.push(name);
    } catch { /* never made */ }
    return {
      left,
      bytes: writes.reduce((sum, write) => sum + write.length, 0),
      readable: writes.some((write) => decoder.decode(write).includes(secret)),
    };
  }, SECRET);
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  page = await userPage(browser, USER);
  context = page.context();
  await context.addInitScript(INIT);
  await settings(page);
  const toggle = page.getByTestId('offline-switch');
  if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('offline-status')).toContainText('updated', { timeout: 180_000 });
  await waitForOriginals(`${COUNT} of ${COUNT}`);
});

test.afterAll(async () => {
  await context?.close();
});

test('a folder exported offline as mbox is the bytes the server has, and the private files hold nothing readable', async () => {
  await context.setOffline(true);
  await openDialog();
  await expect(page.getByTestId('local-export-kept')).toContainText(`${COUNT} of ${COUNT}`);
  await expect(page.getByTestId('local-export-missing')).toHaveCount(0);
  await shot(page, 'd10-export-setup');
  const mbox = await exported('mbox');
  expectOriginals(mboxMessages(mbox));
  await expect(page.getByTestId('mail-export-status')).toContainText(`Messages exported: ${COUNT}`);
  await shot(page, 'd10-export-done');
  const report = await spoolReport();
  expect(report.bytes).toBeGreaterThan(0);
  expect(report.readable).toBe(false);
  // Gone the moment the export was done, with the download still free to read its Blob.
  expect(report.left).toEqual([]);
  await closeSummary();
});

test('the same folder as a ZIP of .eml files has the same bytes', async () => {
  await openDialog();
  const zip = new Blob([new Uint8Array(await exported('eml'))]);
  const entries = await listZipEntries(zip);
  expect(entries.map((entry) => entry.name).every((name) => name.startsWith(`${FOLDER}/`) && name.endsWith('.eml'))).toBe(true);
  expectOriginals(await Promise.all(entries.map(async (entry) => Buffer.from(await readZipEntry(zip, entry)))));
  const report = await spoolReport();
  expect(report.readable).toBe(false);
  expect(report.left).toEqual([]);
  await closeSummary();
});

test('with a save picker, it writes straight to the chosen file and no private file is used', async () => {
  const before = (await spoolReport()).bytes;
  await page.evaluate(() => {
    const parts: Uint8Array[] = [];
    (window as unknown as { __picked: Uint8Array[] }).__picked = parts;
    (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async () => ({
      createWritable: async () => ({
        write: async (data: Uint8Array) => { parts.push(data.slice()); },
        close: async () => {},
        abort: async () => {},
      }),
    });
  });
  await openDialog();
  await page.getByTestId('local-export-format-mbox').check();
  await page.getByTestId('local-export-start').click();
  await expect(page.getByTestId('mail-export-status')).toContainText(`Messages exported: ${COUNT}`);
  const picked = await page.evaluate(() => {
    const parts = (window as unknown as { __picked: Uint8Array[] }).__picked;
    return parts.flatMap((part) => Array.from(part));
  });
  expectOriginals(mboxMessages(Buffer.from(picked)));
  expect((await spoolReport()).bytes).toBe(before);
  await closeSummary();
  await page.evaluate(() => { delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker; });
});

test('with attachments off, offline counts every message and says why; the retry online writes them all', async () => {
  await context.setOffline(false);
  await page.getByTestId('offline-attachments').click();
  await expect(page.getByTestId('offline-attachments')).toHaveAttribute('aria-checked', 'false');
  // A choice reaches the store after a short wait, so a quick change of mind costs nothing.
  await waitForOriginals(`0 of ${COUNT}`);
  await context.setOffline(true);
  await openDialog();
  await expect(page.getByTestId('local-export-kept')).toContainText(`0 of ${COUNT}`);
  await expect(page.getByTestId('local-export-missing')).toContainText(`offline: ${COUNT}`);
  await expect(page.getByTestId('local-export-reason')).toContainText('Keep attachments');
  await shot(page, 'd10-export-offline-missing');
  await page.getByTestId('local-export-format-mbox').check();
  const download = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByTestId('local-export-start').click();
  await download;
  await expect(page.getByTestId('local-export-not-kept-attachments')).toContainText(`attachments aren't kept on this device: ${COUNT}`);
  await expect(page.getByTestId('local-export-retry')).toBeDisabled();
  await expect(page.getByTestId('local-export-retry-hint')).toHaveText("You can try again when you're online.");
  await shot(page, 'd10-export-not-kept');

  await context.setOffline(false);
  await expect(page.getByTestId('local-export-retry')).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId('local-export-retry').click();
  // The same folder is still the one chosen.
  await expect(page.getByTestId('local-export-kept')).toContainText(`0 of ${COUNT}`, { timeout: 30_000 });
  await expect(page.getByTestId('local-export-missing')).toContainText(`To download from the server: ${COUNT}`);
  const again = await exported('mbox');
  expectOriginals(mboxMessages(again));
  await closeSummary();

  await page.getByTestId('offline-attachments').click();
  await expect(page.getByTestId('offline-attachments')).toHaveAttribute('aria-checked', 'true');
});

test('at 390 px the dialog fits, and works by keyboard', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('local-export-open').scrollIntoViewIfNeeded();
  await page.getByTestId('local-export-open').focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByTestId('local-export-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('local-export-summary')).toBeVisible({ timeout: 30_000 });
  const widths = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="local-export-dialog"]') as HTMLElement;
    return { page: document.documentElement.scrollWidth, panel: panel.getBoundingClientRect().width, inner: panel.scrollWidth };
  });
  expect(widths.page).toBeLessThanOrEqual(390);
  expect(widths.panel).toBeLessThanOrEqual(390);
  expect(widths.inner).toBeLessThanOrEqual(390);
  await shot(page, 'd10-export-phone');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('"No export" locks it, also once offline', async ({ browser }) => {
  const admin = await adminContext(browser);
  try {
    await withPolicy(admin, { organisation: { devices: { ...DEVICES_OFF, noExport: true } } }, async () => {
      await settings(page);
      await expect(page.getByTestId('local-export-open')).toBeDisabled({ timeout: 30_000 });
      await expect(page.getByText('Set by your organisation').first()).toBeVisible();
      await context.setOffline(true);
      await expect(page.getByTestId('local-export-open')).toBeDisabled();
      await expect(page.getByTestId('local-export-dialog')).toHaveCount(0);
      await context.setOffline(false);
    });
  } finally {
    await admin.close();
  }
  await settings(page);
  await expect(page.getByTestId('local-export-open')).toBeEnabled({ timeout: 30_000 });
});
