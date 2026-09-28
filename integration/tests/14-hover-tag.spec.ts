import { test, expect } from '@playwright/test';
import { ACCOUNTS } from './helpers/config';
import { sendMail } from './helpers/smtp';
import { JmapClient } from './helpers/jmap';
import { login, seedSettings, emailItem, expectEmailVisible } from './helpers/app';

/**
 * The Labels quick-action on a list row (Settings -> Appearance & layout ->
 * Hover actions). It used to call `onSetTag(null)`, which clears every tag on
 * the message - a no-op on an untagged one, so clicking it appeared to do
 * nothing. It now opens the same tag picker the context menu and the reading
 * pane use.
 */
const alice = ACCOUNTS.alice;
let seq = 0;
const subj = (l: string) => `IT ${l} ${Date.now()}-${seq++}`;
const send = (subject: string) =>
  sendMail({ from: alice.email, authPass: alice.password, to: alice.email, subject, body: 'x' });

/** The row's tag button, made visible by hovering the row. */
async function openHoverTagPicker(page: import('@playwright/test').Page, subject: string) {
  const row = emailItem(page, subject).first();
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  const button = row.locator('[data-testid="hover-action-tag"]');
  await expect(button).toBeVisible();
  await button.click();
  return page.locator('[data-testid="hover-tag-picker"]');
}

test.describe('Labels hover quick-action', () => {
  let jmap: JmapClient;

  test.beforeEach(async ({ page }) => {
    jmap = await JmapClient.connect(alice.email, alice.password);
    await jmap.reset();
    // Only the tag quick-action, so the button position is unambiguous.
    await seedSettings(page, { hoverActions: ['tag'] });
  });

  test('opens the tag picker and applies the tag to the message', async ({ page }) => {
    const s = subj('hover-tag');
    await send(s);
    await jmap.waitForEmail(s);

    await login(page, alice);
    await expectEmailVisible(page, s);

    const picker = await openHoverTagPicker(page, s);
    await expect(picker).toBeVisible();

    const red = picker.getByRole('menuitemcheckbox', { name: 'Red' });
    await expect(red).toHaveAttribute('aria-checked', 'false');
    await red.click();

    // The tag reaches the server under the current $label: prefix.
    await expect(async () => {
      const mail = await jmap.findEmailBySubject(s);
      expect(mail?.keywords?.['$label:red']).toBe(true);
    }).toPass({ timeout: 15000 });

    // ...and the picker reflects it without being reopened.
    await expect(red).toHaveAttribute('aria-checked', 'true');
  });

  test('clicking the same tag again removes it', async ({ page }) => {
    const s = subj('hover-untag');
    await send(s);
    await jmap.waitForEmail(s);

    await login(page, alice);
    await expectEmailVisible(page, s);

    const picker = await openHoverTagPicker(page, s);
    const red = picker.getByRole('menuitemcheckbox', { name: 'Red' });

    await red.click();
    await expect(red).toHaveAttribute('aria-checked', 'true');

    await red.click();
    await expect(red).toHaveAttribute('aria-checked', 'false');

    await expect(async () => {
      const mail = await jmap.findEmailBySubject(s);
      expect(mail?.keywords?.['$label:red']).toBeFalsy();
    }).toPass({ timeout: 15000 });
  });

  test('stays open when the pointer leaves the row, and closes on Escape', async ({ page }) => {
    const s = subj('hover-tag-open');
    await send(s);
    await jmap.waitForEmail(s);

    await login(page, alice);
    await expectEmailVisible(page, s);

    const picker = await openHoverTagPicker(page, s);
    // Moving off the row un-hovers it; the toolbar (and so the picker's anchor)
    // must not disappear underneath the open picker.
    await page.mouse.move(5, 5);
    await expect(picker).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
  });

  test('clicking the tag button does not open the email', async ({ page }) => {
    const s = subj('hover-tag-noopen');
    await send(s);
    await jmap.waitForEmail(s);

    await login(page, alice);
    await expectEmailVisible(page, s);

    await openHoverTagPicker(page, s);
    // The reading pane stays closed - the click must not fall through to the row.
    await expect(page.locator('[data-tour="email-viewer"]')).toHaveCount(0);
  });
});
