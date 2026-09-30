/**
 * "Save to Files" attachment action (#901).
 *
 * Regression coverage for a bug where the folder picker always showed "No
 * subfolders", no matter what: the picker filtered candidate FileNode entries
 * by `type === "d"`, but real Stalwart never sets that on a directory - it
 * returns `type: null` for containers (confirmed against this same stack via
 * raw JMAP calls; `blobId === null` is the actual authoritative "this is a
 * folder" signal, matching stores/file-store.ts's `isFolder()`, #379). A
 * unit-test mock that (incorrectly) set both `type: 'd'` and `blobId: null`
 * on its fake folders masked the bug entirely - only a real server catches
 * this class of "the mock matched the wrong axis" mistake.
 */
import { test, expect } from '@playwright/test';
import { ACCOUNTS } from './helpers/config';
import { sendMail } from './helpers/smtp';
import { JmapClient } from './helpers/jmap';
import { login, emailItem, expectEmailVisible, openFiles, driveEntry } from './helpers/app';

const { alice } = ACCOUNTS;
const EXISTING_FOLDER = 'Existing-Folder';
const ATT = { filename: 'invoice.pdf', contentType: 'application/pdf', content: 'pdf-bytes-for-save-to-files-test' };

test.describe('Save attachment to Files (#901)', () => {
  test.beforeEach(async () => {
    const j = await JmapClient.connect(alice.email, alice.password);
    await j.reset();
    await j.resetFiles();
    await j.createFileDirectory(EXISTING_FOLDER);
  });

  test('the folder picker lists real folders, and saving reuses the attachment blob with no re-upload', async ({ page }) => {
    const subject = `IT save-to-files ${Date.now()}`;
    await sendMail({ from: alice.email, authPass: alice.password, to: alice.email, subject, body: 'see attached', attachment: ATT });

    await login(page, alice);
    await expectEmailVisible(page, subject);
    await emailItem(page, subject).first().click();

    const chip = page.locator(`[data-testid="attachment"][data-attachment-name="${ATT.filename}"]`).first();
    await chip.waitFor({ state: 'visible', timeout: 15000 });
    await chip.hover();

    const saveButton = chip.locator('[data-testid="attachment-save-to-files"]');
    await saveButton.waitFor({ state: 'visible', timeout: 5000 });
    await saveButton.click();

    const dialog = page.getByRole('dialog', { name: 'Save to Files' });
    await expect(dialog).toBeVisible();

    // The actual regression: pre-fix this list was always empty ("No
    // subfolders"), regardless of what folders existed on the server.
    await expect(dialog.getByText(EXISTING_FOLDER)).toBeVisible({ timeout: 10000 });
    await expect(dialog.getByText('No subfolders')).toHaveCount(0);

    await dialog.getByRole('button', { name: /^Save to / }).click();
    await expect(dialog).toHaveCount(0, { timeout: 10000 });

    // The file actually landed in Files, at the account root, with the right
    // name - confirms the zero-copy FileNode/set create (reusing the email
    // attachment's own blobId) round-tripped correctly against real Stalwart.
    await openFiles(page);
    await expect(driveEntry(page, ATT.filename)).toBeVisible({ timeout: 15000 });
  });
});
