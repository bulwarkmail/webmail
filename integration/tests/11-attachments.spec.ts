import { test, expect } from '@playwright/test';
import { ACCOUNTS } from './helpers/config';
import { sendMail } from './helpers/smtp';
import { JmapClient } from './helpers/jmap';
import {
  login,
  addAccount,
  switchAccount,
  seedSettings,
  folderRow,
  openFolder,
  emailItem,
  expectEmailVisible,
  forceSync,
} from './helpers/app';

/**
 * Attachments on a message that belongs to a *different* account, opened from
 * the cross-account All-Mail view. Blobs are account-scoped, so downloading one
 * must route to the owning account's client + accountId — otherwise it 404s
 * against the active account (the reported bug).
 */
const { alice, bob } = ACCOUNTS;
const ATT = { filename: 'report.bin', contentType: 'application/octet-stream', content: 'hello-attachment-content-12345' };

test.describe('Cross-account attachments', () => {
  test.beforeEach(async () => {
    for (const a of [alice, bob]) {
      const j = await JmapClient.connect(a.email, a.password);
      await j.reset();
    }
  });

  test('an attachment on another account\'s All-Mail message downloads correctly', async ({ page }) => {
    const subject = `IT attach ${Date.now()}`;
    // Deliver a message with an attachment to bob.
    await sendMail({ from: bob.email, authPass: bob.password, to: bob.email, subject, body: 'see attachment', attachment: ATT });

    // Cross-account All Mail + always download attachments (don't preview).
    await seedSettings(page, {
      enableUnifiedMailbox: true,
      enableCrossAllView: true,
      unifiedCrossAccount: true,
      includeGroupInUnified: true,
      mailAttachmentAction: 'download',
    });

    // Make alice the active account, with bob added, so bob's message is
    // genuinely cross-account when opened.
    await login(page, alice);
    await addAccount(page, bob);
    await switchAccount(page, alice.email);
    await forceSync(page);

    // Open the All-Mail view and bob's message.
    await expect(folderRow(page, { name: '__cross_all__' }).first()).toBeVisible();
    await openFolder(page, { name: '__cross_all__' });
    await forceSync(page);
    await expectEmailVisible(page, subject);
    await emailItem(page, subject).first().click();

    // The attachment chip is present; clicking it downloads the blob from bob's
    // account (pre-fix this 404s against alice and no download fires).
    const chip = page.locator(`[data-testid="attachment"][data-attachment-name="${ATT.filename}"]`).first();
    await chip.waitFor({ state: 'visible', timeout: 15000 });

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }),
      chip.click(),
    ]);

    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toContain(ATT.content);
  });

  test('an inline image on another account\'s All-Mail message renders', async ({ page }) => {
    const subject = `IT inline ${Date.now()}`;
    // 1x1 PNG referenced from the HTML body via cid.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    await sendMail({
      from: bob.email, authPass: bob.password, to: bob.email, subject, body: '',
      inlineImage: { cid: 'inlinepic', contentType: 'image/png', base64: png, html: '<p>see below</p><img src="cid:inlinepic" alt="pic" width="1" height="1" />' },
    });

    await seedSettings(page, {
      enableUnifiedMailbox: true,
      enableCrossAllView: true,
      unifiedCrossAccount: true,
      includeGroupInUnified: true,
    });

    await login(page, alice);
    await addAccount(page, bob);
    await switchAccount(page, alice.email);
    await forceSync(page);

    await openFolder(page, { name: '__cross_all__' });
    await forceSync(page);
    await expectEmailVisible(page, subject);
    await emailItem(page, subject).first().click();

    // The inline cid: image resolves to a blob URL fetched from bob's account.
    // Pre-fix the fetch 404s and it falls back to the data:image/gif placeholder.
    const img = page.frameLocator('iframe[title="Email content"]').locator('img').first();
    await expect
      .poll(async () => (await img.getAttribute('src').catch(() => '')) ?? '', { timeout: 15000 })
      .toMatch(/^blob:/);
  });
});
