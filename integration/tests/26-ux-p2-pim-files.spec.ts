import { test, expect, type Page } from '@playwright/test';
import { contextOptions } from './helpers/ent';
import { JmapClient } from './helpers/jmap';
import { accountSwitcher, neutralizeDevOverlay } from './helpers/app';

/**
 * Usability pass 2 in Files (pim-5, pim-p2-6, pim-p2-7, pim-p2-18) against a VM 106
 * Stalwart, 1.0 and 0.16. Every step that writes is read back with FileNode/get.
 *
 * - pim-p2-6: files dropped on the list go into the folder in view, files dropped on a
 *   folder's row into that folder, with no overlay and no question.
 * - pim-p2-7: a saved .eml opens like a mail with "Import to a mail folder…"; a .csv
 *   offers "Import into contacts…", which opens the contacts import.
 * - pim-5: at 1280×720 the ⋮ of the last row opens its menu beside the button, not over it.
 *
 * Account dso-ux-pim, password IT_DSO_PASSWORD. Every node made here is named
 * "UXP2-files <run> …" and removed afterwards. Nothing is imported.
 */

const PASSWORD = process.env.IT_DSO_PASSWORD ?? '';
const A = 'dso-ux-pim@example.org';
const CORE = 'urn:ietf:params:jmap:core';
const FILENODE = 'urn:ietf:params:jmap:filenode';
const RUN = Date.now().toString(36);
const PREFIX = `UXP2-files ${RUN}`;

test.skip(!PASSWORD, 'Set IT_DSO_PASSWORD (vault "Stalwart test – dso-* throwaway accounts")');

type Node = { id: string; name: string; parentId: string | null; blobId: string | null };

async function nodes(c: JmapClient): Promise<Node[]> {
  const r = await c.request([['FileNode/get', { accountId: c.filesAccountId, ids: null }, '0']], [CORE, FILENODE]);
  return r.methodResponses[0][1].list as Node[];
}

async function ours(c: JmapClient): Promise<Node[]> {
  return (await nodes(c)).filter((n) => n.name.startsWith(PREFIX));
}

async function cleanUp(c: JmapClient): Promise<void> {
  // Files first, then folders: a folder with children may be refused.
  for (let round = 0; round < 3; round++) {
    const all = await ours(c);
    if (all.length === 0) return;
    const parents = new Set(all.map((n) => n.parentId));
    const leaves = all.filter((n) => !parents.has(n.id)).map((n) => n.id);
    await c.request([['FileNode/set', { accountId: c.filesAccountId, destroy: leaves }, '0']], [CORE, FILENODE]);
  }
}

async function login(page: Page, email: string): Promise<void> {
  await neutralizeDevOverlay(page);
  await page.goto('/');
  await page.locator('#username').waitFor({ state: 'visible', timeout: 60000 });
  await page.fill('#username', email);
  await page.fill('#password', PASSWORD);
  await page.click('button[type="submit"]');
  await accountSwitcher(page).waitFor({ state: 'visible', timeout: 60000 });
}

async function openFilesRoot(page: Page): Promise<void> {
  await page.goto('/files');
  await expect(page.getByRole('grid', { name: 'Files and folders' }).first()).toBeVisible({ timeout: 60000 });
}

async function upload(page: Page, files: { name: string; text: string; mimeType?: string }[]): Promise<void> {
  await page.locator('input[type="file"][multiple]:not([webkitdirectory])').first().setInputFiles(
    files.map((f) => ({ name: f.name, mimeType: f.mimeType ?? 'text/plain', buffer: Buffer.from(f.text) })),
  );
}

const row = (page: Page, name: string) => page.locator(`[data-resource="${name}"]`).first();

/** A drag from outside, as the browser sends it, ending in a drop on `target`. */
async function dropFiles(page: Page, selector: string, files: { name: string; text: string }[]): Promise<void> {
  const transfer = await page.evaluateHandle((list) => {
    const dt = new DataTransfer();
    for (const f of list) dt.items.add(new File([f.text], f.name, { type: 'text/plain' }));
    return dt;
  }, files);
  const target = page.locator(selector).first();
  await target.dispatchEvent('dragenter', { dataTransfer: transfer });
  await target.dispatchEvent('dragover', { dataTransfer: transfer });
  // No choices on the Files screen.
  await expect(page.getByTestId('file-drop-overlay')).toHaveCount(0);
  await target.dispatchEvent('drop', { dataTransfer: transfer });
}

const EML = [
  'From: Ben <ben@example.org>',
  'To: dso-ux-pim@example.org',
  `Subject: ${PREFIX} saved mail`,
  'Date: Tue, 03 Nov 2026 10:00:00 +0100',
  'Message-ID: <uxp2-files@example.org>',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Hello from a saved message.',
  '',
].join('\r\n');

const CSV = 'First Name,Last Name,E-mail Address\r\nAnna,Example,anna.uxp2@example.org\r\n';

test.describe('Files, usability pass 2', () => {
  test.describe.configure({ mode: 'serial' });

  test.afterAll(async () => {
    const a = await JmapClient.connect(A, PASSWORD);
    await cleanUp(a);
  });

  test('a drop uploads where it lands, with no question (pim-p2-6)', async ({ browser }) => {
    test.setTimeout(240_000);
    const a = await JmapClient.connect(A, PASSWORD);
    const folderName = `${PREFIX} folder`;
    const folderId = await a.createFileDirectory(folderName);
    const context = await browser.newContext({ ...contextOptions(), viewport: { width: 1366, height: 768 } });
    const page = await context.newPage();
    await login(page, A);
    await openFilesRoot(page);
    await expect(row(page, folderName)).toBeVisible({ timeout: 30000 });

    // On the list: the folder in view (the top of Files).
    await dropFiles(page, '[role="grid"][aria-label="Files and folders"]', [{ name: `${PREFIX} on list.txt`, text: 'list' }]);
    // Where the folder made at the top sits: null on one server, the root node's id on another.
    const top = (await ours(a)).find((n) => n.id === folderId)?.parentId ?? null;
    await expect.poll(async () => {
      const node = (await ours(a)).find((n) => n.name === `${PREFIX} on list.txt`);
      return node ? node.parentId ?? null : 'missing';
    }, { timeout: 30000 }).toBe(top);

    // On the folder's row: into that folder.
    await dropFiles(page, `[data-resource="${folderName}"]`, [{ name: `${PREFIX} on row.txt`, text: 'row' }]);
    await expect.poll(async () => (await ours(a)).find((n) => n.name === `${PREFIX} on row.txt`)?.parentId ?? 'missing', { timeout: 30000 })
      .toBe(folderId);
    await context.close();
  });

  test('a saved mail opens as a mail, a .csv offers the contacts import (pim-p2-7)', async ({ browser }) => {
    test.setTimeout(240_000);
    const a = await JmapClient.connect(A, PASSWORD);
    const eml = `${PREFIX} saved.eml`;
    const csv = `${PREFIX} contacts.csv`;
    const context = await browser.newContext({ ...contextOptions(), viewport: { width: 1366, height: 768 } });
    const page = await context.newPage();
    await login(page, A);
    await openFilesRoot(page);
    await upload(page, [{ name: eml, text: EML, mimeType: 'message/rfc822' }, { name: csv, text: CSV, mimeType: 'text/csv' }]);
    await expect.poll(async () => (await ours(a)).map((n) => n.name).filter((n) => n === eml || n === csv).sort(), { timeout: 30000 })
      .toEqual([csv, eml].sort());

    await row(page, eml).dblclick();
    const preview = page.getByRole('dialog', { name: eml });
    await expect(preview).toBeVisible({ timeout: 30000 });
    await expect(preview.getByText(`${PREFIX} saved mail`).first()).toBeVisible({ timeout: 30000 });
    await expect(preview.getByRole('button', { name: 'Import to a mail folder…' })).toBeVisible();
    await expect(page.getByText('There is no preview for this type of file.')).toHaveCount(0);
    await preview.getByRole('button', { name: 'Import to a mail folder…' }).click();
    await expect(page.getByTestId('import-eml-dialog')).toBeVisible({ timeout: 30000 });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('import-eml-dialog')).toBeHidden();
    await page.keyboard.press('Escape');

    await row(page, csv).dblclick();
    const csvPreview = page.getByRole('dialog', { name: csv });
    await expect(csvPreview.getByRole('button', { name: 'Import into contacts…' })).toBeVisible({ timeout: 30000 });
    await csvPreview.getByRole('button', { name: 'Import into contacts…' }).click();
    await expect(page).toHaveURL(/\/contacts/, { timeout: 30000 });
    await expect(page.getByRole('dialog', { name: 'Import contacts' })).toBeVisible({ timeout: 30000 });
    await page.keyboard.press('Escape');
    await context.close();
  });

  test('the ⋮ of the last row opens beside its button at 1280×720 (pim-5)', async ({ browser }) => {
    test.setTimeout(240_000);
    const context = await browser.newContext({ ...contextOptions(), viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    await login(page, A);
    await openFilesRoot(page);
    const rows = page.locator('[role="grid"][aria-label="Files and folders"] [data-resource]');
    await expect(rows.first()).toBeVisible({ timeout: 30000 });
    const last = rows.last();
    await last.scrollIntoViewIfNeeded();
    await last.hover();
    const kebab = last.locator('[data-item-action][title]').last();
    const button = (await kebab.boundingBox())!;
    await kebab.click();
    const menu = page.getByRole('menu').first();
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    const overlaps = box.y < button.y + button.height && box.y + box.height > button.y
      && box.x < button.x + button.width && box.x + box.width > button.x;
    expect(overlaps).toBe(false);
    await page.keyboard.press('Escape');
    await context.close();
  });
});
