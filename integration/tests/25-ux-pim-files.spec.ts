import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { contextOptions } from './helpers/ent';
import { JmapClient } from './helpers/jmap';
import { accountSwitcher, neutralizeDevOverlay } from './helpers/app';

/**
 * Usability fixes in Files (pim-3, pim-10, pim-16, pim-26) against a VM 106
 * Stalwart, 1.0 and 0.16. FileNode differs between them (1.0: draft 18 with
 * nodeType and `@type`; 0.16: blobId == null marks a folder), so the server
 * state is read back over JMAP after every step.
 *
 * - pim-10: uploading a name that exists asks Replace / Keep both / Skip.
 *   Replace keeps the node id and gives it a new blob, Keep both makes the
 *   "(1)" copy, Skip changes nothing; "Do this for all" answers the rest.
 * - pim-3: a double-click opens the preview and it stays open.
 * - pim-16: a file with no preview opens a pane with Download.
 * - pim-26: delete has Undo, and sharing offers "Send a message" with a link.
 *
 * Account dso-ux-pim (and dso-ux-pim-b to share with), password
 * IT_DSO_PASSWORD. Every node made here is named "UXFIX-files …" and removed.
 */

const PASSWORD = process.env.IT_DSO_PASSWORD ?? '';
const A = 'dso-ux-pim@example.org';
const B = 'dso-ux-pim-b@example.org';
const CORE = 'urn:ietf:params:jmap:core';
const FILENODE = 'urn:ietf:params:jmap:filenode';
const RUN = Date.now().toString(36);
const PREFIX = `UXFIX-files ${RUN}`;
const SHOTS = process.env.IT_UXPIM_SHOTS;

test.skip(!PASSWORD, 'Set IT_DSO_PASSWORD (vault "Stalwart test – dso-* throwaway accounts")');

type Node = { id: string; name: string; parentId: string | null; blobId: string | null; shareWith?: Record<string, unknown> | null };

async function nodes(c: JmapClient): Promise<Node[]> {
  const r = await c.request([['FileNode/get', { accountId: c.filesAccountId, ids: null }, '0']], [CORE, FILENODE]);
  return r.methodResponses[0][1].list as Node[];
}

async function ours(c: JmapClient): Promise<Node[]> {
  return (await nodes(c)).filter((n) => n.name.startsWith(PREFIX));
}

async function cleanUp(c: JmapClient): Promise<void> {
  // Our nodes wherever they are, the trash's batch folders included.
  const all = await nodes(c);
  const ids = all.filter((n) => n.name.startsWith(PREFIX)).map((n) => n.id);
  if (ids.length) await c.request([['FileNode/set', { accountId: c.filesAccountId, destroy: ids }, '0']], [CORE, FILENODE]);
  // The draft "Send a message" started.
  const q = await c.request([['Email/query', { accountId: c.accountId, filter: { subject: PREFIX } }, '0']]);
  const drafts = q.methodResponses[0][1].ids as string[];
  if (drafts?.length) await c.request([['Email/set', { accountId: c.accountId, destroy: drafts }, '0']]);
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

async function upload(page: Page, files: { name: string; text: string }[]): Promise<void> {
  await page.locator('input[type="file"][multiple]:not([webkitdirectory])').first().setInputFiles(
    files.map((f) => ({ name: f.name, mimeType: 'text/plain', buffer: Buffer.from(f.text) })),
  );
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name) });
}

const row = (page: Page, name: string) => page.locator(`[data-resource="${name}"]`).first();

test.describe('Files (pim-3, pim-10, pim-16, pim-26)', () => {
  test.describe.configure({ mode: 'serial' });

  test.afterAll(async () => {
    const a = await JmapClient.connect(A, PASSWORD);
    await cleanUp(a);
  });

  test('an upload over an existing name asks, and each answer shows on the server', async ({ browser }) => {
    test.setTimeout(240_000);
    const a = await JmapClient.connect(A, PASSWORD);
    const name = `${PREFIX}.txt`;
    const copy = `${PREFIX} (1).txt`;
    const context = await browser.newContext({ ...contextOptions(), viewport: { width: 1366, height: 768 } });
    const page = await context.newPage();
    await login(page, A);
    await openFilesRoot(page);

    await upload(page, [{ name, text: 'one' }]);
    await expect.poll(async () => (await ours(a)).map((n) => n.name), { timeout: 30000 }).toEqual([name]);
    const [first] = await ours(a);
    await expect(row(page, name)).toBeVisible({ timeout: 30000 });

    // Replace: the same node, a new blob, no copy.
    await upload(page, [{ name, text: 'two, longer' }]);
    const dialog = page.getByRole('alertdialog', { name: `${name} already exists.` });
    await expect(dialog).toBeVisible({ timeout: 30000 });
    await expect(dialog.getByRole('checkbox')).toHaveCount(0);
    await shot(page, 'pim-fix-10-after.png');
    await dialog.getByRole('button', { name: 'Replace', exact: true }).click();
    await expect.poll(async () => {
      const list = await ours(a);
      return list.map((n) => ({ id: n.id, name: n.name, newBlob: n.blobId !== first.blobId }));
    }, { timeout: 30000 }).toEqual([{ id: first.id, name, newBlob: true }]);
    const replaced = (await ours(a))[0];

    // Keep both: the "(1)" copy, the original untouched.
    await upload(page, [{ name, text: 'three' }]);
    await dialog.getByRole('button', { name: 'Keep both' }).click();
    await expect.poll(async () => (await ours(a)).map((n) => n.name).sort(), { timeout: 30000 }).toEqual([copy, name].sort());
    expect((await ours(a)).find((n) => n.name === name)).toMatchObject({ id: first.id, blobId: replaced.blobId });
    const before = JSON.stringify((await ours(a)).map((n) => [n.id, n.name, n.blobId]).sort());

    // Skip: nothing changes.
    await expect(row(page, copy)).toBeVisible({ timeout: 30000 });
    await upload(page, [{ name, text: 'four' }]);
    await dialog.getByRole('button', { name: 'Skip' }).click();
    await expect(dialog).toBeHidden();
    // Two conflicts: "Do this for all 2 conflicts", and Skip answers both.
    await upload(page, [{ name, text: 'five' }, { name: copy, text: 'six' }]);
    await expect(dialog).toBeVisible();
    await dialog.getByRole('checkbox', { name: 'Do this for all 2 conflicts' }).check();
    await dialog.getByRole('button', { name: 'Skip' }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await page.waitForTimeout(3000);
    expect(JSON.stringify((await ours(a)).map((n) => [n.id, n.name, n.blobId]).sort())).toBe(before);
    await context.close();
  });

  test('double-click opens a preview that stays, a file with no preview gets a pane, delete has Undo', async ({ browser }) => {
    test.setTimeout(240_000);
    const a = await JmapClient.connect(A, PASSWORD);
    const name = `${PREFIX}.txt`;
    const zip = `${PREFIX}.bin`;
    const context = await browser.newContext({ ...contextOptions(), viewport: { width: 1366, height: 768 } });
    const page = await context.newPage();
    await login(page, A);
    await openFilesRoot(page);
    await upload(page, [{ name: zip, text: 'binary-ish' }]);
    await expect(row(page, zip)).toBeVisible({ timeout: 30000 });

    // pim-3: one click selects, a double-click opens, and it stays open.
    await row(page, name).getByTitle(name).click();
    await expect(row(page, name)).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('dialog', { name })).toHaveCount(0);
    await row(page, name).getByTitle(name).dblclick();
    await page.waitForTimeout(1000);
    await expect(page.getByRole('dialog', { name })).toBeVisible();
    await shot(page, 'pim-fix-3-after.png');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name })).toHaveCount(0);

    // pim-16: no preview, no editor: the pane, not a download.
    let downloaded = false;
    page.on('download', () => { downloaded = true; });
    await row(page, zip).getByTitle(zip).dblclick();
    const pane = page.getByTestId('file-no-preview');
    await expect(pane).toBeVisible();
    await expect(pane).toContainText('There is no preview for this type of file.');
    await expect(pane.getByRole('button', { name: 'Download' })).toBeVisible();
    await shot(page, 'pim-fix-16-after.png');
    expect(downloaded).toBe(false);
    await page.keyboard.press('Escape');

    // pim-26: delete goes to the trash with Undo, and Undo puts it back.
    await row(page, zip).click();
    await page.keyboard.press('Delete');
    const undo = page.getByRole('button', { name: 'Undo' }).last();
    await expect(undo).toBeVisible({ timeout: 30000 });
    await shot(page, 'pim-fix-26-undo-after.png');
    const zipId = (await ours(a)).find((n) => n.name === zip)!.id;
    await expect.poll(async () => (await nodes(a)).find((n) => n.id === zipId)?.parentId ?? null, { timeout: 30000 }).not.toBeNull();
    await undo.click();
    await expect.poll(async () => (await nodes(a)).find((n) => n.id === zipId)?.parentId ?? null, { timeout: 30000 }).toBeNull();
    await expect(row(page, zip)).toBeVisible({ timeout: 30000 });
    await context.close();
  });

  test('sharing with someone offers a message with a link to the file', async ({ browser }) => {
    test.setTimeout(240_000);
    const a = await JmapClient.connect(A, PASSWORD);
    const b = await JmapClient.connect(B, PASSWORD);
    const name = `${PREFIX}.txt`;
    const context = await browser.newContext({ ...contextOptions(), viewport: { width: 1366, height: 768 } });
    const page = await context.newPage();
    await login(page, A);
    await openFilesRoot(page);
    // Run on its own (-g), it makes the file the first test made.
    if (!(await ours(a)).some((n) => n.name === name)) await upload(page, [{ name, text: 'one' }]);
    await expect.poll(async () => (await ours(a)).some((n) => n.name === name), { timeout: 30000 }).toBe(true);
    const node = (await ours(a)).find((n) => n.name === name)!;
    await expect(row(page, name)).toBeVisible({ timeout: 30000 });

    await row(page, name).getByTitle(name).click({ button: 'right' });
    await page.getByRole('menuitem', { name: /^Share/ }).click();
    const shareDialog = page.getByRole('dialog').last();
    await shareDialog.getByRole('button', { name: 'Add person or group' }).click();
    await shareDialog.getByRole('textbox', { name: 'Search by name or email…' }).fill('dso-ux-pim-b');
    await shareDialog.getByRole('button', { name: /dso-ux-pim-b/ }).first().click();
    const send = page.getByRole('button', { name: 'Send a message' });
    await expect(send).toBeVisible({ timeout: 30000 });
    await expect.poll(async () => Object.keys((await nodes(a)).find((n) => n.id === node.id)?.shareWith ?? {}).length, { timeout: 30000 }).toBe(1);
    await shot(page, 'pim-fix-26-share-after.png');
    await send.click();

    // The composer, to b, with a link the person opens it by.
    const link = `?shared=${encodeURIComponent(`${a.filesAccountId}:${node.id}`)}`;
    await expect(page.getByText(B).first()).toBeVisible({ timeout: 60000 });
    await expect(page.locator('[contenteditable="true"], textarea').filter({ hasText: link }).first()).toBeVisible({ timeout: 30000 });
    await shot(page, 'pim-fix-26-compose-after.png');

    // b sees the node under that id.
    const shared = await b.request([['FileNode/get', { accountId: a.filesAccountId, ids: [node.id], properties: ['id', 'name'] }, '0']], [CORE, FILENODE]);
    expect(shared.methodResponses[0][1].list?.[0]?.name).toBe(name);
    await context.close();
  });
});
