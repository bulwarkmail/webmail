import { test, expect } from '@playwright/test';
import { ACCOUNTS } from './helpers/config';
import { login, folderRow, accountSwitcher, activeAccountEmail } from './helpers/app';
import { JmapClient } from './helpers/jmap';

test.describe('Login & session', () => {
  test('logs in against Stalwart and loads the mailbox', async ({ page }) => {
    await login(page, ACCOUNTS.alice);

    // The Inbox folder row is a reliable "mailbox loaded" signal.
    await expect(folderRow(page, { role: 'inbox' }).first()).toBeVisible();

    // The active account in the switcher is alice. The account id is
    // `${email}@${serverHost}`, so assert on the email it reports instead.
    await expect(accountSwitcher(page)).toBeVisible();
    expect(await activeAccountEmail(page)).toBe(ACCOUNTS.alice.email);
  });

  test('rejects invalid credentials', async ({ page }) => {
    await page.goto('/');
    await page.fill('#username', ACCOUNTS.alice.email);
    await page.fill('#password', 'definitely-wrong');
    await page.click('button[type="submit"]');
    await expect(
      page.locator('[role="alert"], .text-red-600, .text-destructive').first(),
    ).toBeVisible({ timeout: 15000 });
  });

  test('JMAP helper can reach every provisioned account', async () => {
    for (const acct of Object.values(ACCOUNTS)) {
      const client = await JmapClient.connect(acct.email, acct.password);
      expect(client.accountId).toBeTruthy();
      const inbox = await client.mailboxByRole('inbox');
      expect(inbox, `${acct.email} has an inbox`).toBeTruthy();
    }
  });
});
