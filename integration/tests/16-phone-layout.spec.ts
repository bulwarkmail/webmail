import { test, expect, devices } from '@playwright/test';
import { ACCOUNTS } from './helpers/config';
import { sendMail } from './helpers/smtp';
import { JmapClient } from './helpers/jmap';
import { login, emailItem, expectEmailVisible } from './helpers/app';

/**
 * On a phone the message list is the whole screen. The selection toolbar
 * above it stays in the layout while collapsed, and its row of nowrap
 * buttons is wider than a phone. The list pane used to grow to that width
 * (a flex item with min-width:auto), which pushed the header's buttons,
 * every row's date and the subject's ellipsis off the right edge of the
 * screen, with nothing selected. The toolbar then measured itself as wide
 * and kept its labels too.
 */
const alice = ACCOUNTS.alice;
const subject = `IT phone-layout ${Date.now()}`;

test.use({ ...devices['Pixel 7'] });

/** Fails when `locator` has no box or any part of it is off the screen's sides. */
async function expectOnScreen(locator: import('@playwright/test').Locator, width: number): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width + 0.5);
}

test.describe('phone layout', () => {
  test.beforeEach(async () => {
    const jmap = await JmapClient.connect(alice.email, alice.password);
    await jmap.reset();
    await sendMail({ from: alice.email, authPass: alice.password, to: alice.email, subject, body: 'x' });
    await jmap.waitForEmail(subject);
  });

  test('the message list and search controls stay within the phone viewport', async ({ page }) => {
    await login(page, alice);
    await expectEmailVisible(page, subject);
    const { width } = page.viewportSize()!;

    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await expectOnScreen(page.locator('[data-mobile-mail-header]'), width);
    // The account button is the header's last control.
    await expectOnScreen(page.locator('[data-testid="account-switcher"]').first(), width);
    await expectOnScreen(emailItem(page, subject).first(), width);

    // The full-screen search panel is outside the app shell's safe-area
    // padding. Its Back button must still clear an installed phone's status bar.
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 62 } });
      await page.locator('[data-mobile-mail-search] button').first().click();
      const back = page.getByRole('button', { name: 'Go back', exact: true });
      await expect(back).toBeVisible();
      await expect.poll(async () => (await back.boundingBox())?.y ?? -1).toBeGreaterThanOrEqual(62);
      await back.click();
      await expect(page.locator('[data-mobile-mail-header]')).toBeVisible();
    } finally {
      await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
      await cdp.detach();
    }
  });

  test('the selection toolbar compacts so every button is on screen', async ({ page }) => {
    await login(page, alice);
    await expectEmailVisible(page, subject);
    const { width } = page.viewportSize()!;

    await emailItem(page, subject).first().getByRole('checkbox').click();
    // The toolbar only drops its labels when it measures narrower than a desktop list.
    const toolbar = page.locator('[data-batch-narrow]');
    await expect(toolbar).toBeVisible();
    await expectOnScreen(toolbar, width);
    for (const button of await toolbar.getByRole('button').all()) {
      await expectOnScreen(button, width);
    }
  });
});
