import { test, expect, type Page } from '@playwright/test';
import { ACCOUNTS } from './helpers/config';
import {
  login,
  addAccount,
  enableProInterface,
  openCalendar,
  calendarItem,
  calendarRows,
} from './helpers/app';

/**
 * Multi-account calendar aggregation across an account switch.
 *
 * Regression for the cross-account id-namespacing bug: the Pro shell used to
 * leave the ACTIVE account's calendar ids raw while namespacing the others, so
 * switching accounts flipped the id form and reset the persisted calendar
 * visibility selection (and broke subscription/mutation routing). All accounts
 * are now namespaced consistently, so the selection survives a switch.
 *
 * Mail is unaffected (it keys per account + uses stable virtual ids), which is
 * why the user saw this only in Calendar and Address Book.
 */
const { alice, bob } = ACCOUNTS;

const switcher = (page: Page) => page.locator('[data-testid="account-switcher"]').first();

/** Read an account's id from the (stable, standard-shell) switcher popover. */
async function accountId(page: Page, email: string): Promise<string> {
  await switcher(page).click();
  const id = await page
    .locator(`[data-testid="account-option"][data-account-email="${email}"]`)
    .first()
    .getAttribute('data-account-id');
  await page.keyboard.press('Escape');
  if (!id) throw new Error(`no account id for ${email}`);
  return id;
}

/**
 * Switch active account robustly in the Pro shell. The switcher popover is a
 * portalled, repositioning element, so a normal click can race its layout;
 * force the click and verify via the switcher's data-active-account-id.
 */
async function switchTo(page: Page, id: string): Promise<void> {
  await switcher(page).click();
  await page.locator(`[data-testid="account-option"][data-account-id="${id}"]`).first().click({ force: true });
  await expect
    .poll(async () => switcher(page).getAttribute('data-active-account-id'), { timeout: 30000 })
    .toBe(id);
}

test.describe('Multi-account calendar', () => {
  test('an account switch preserves the calendar visibility selection', async ({ page }) => {
    // Both accounts in the standard shell (stable switcher), capture their ids,
    // then flip on the Pro interface so the calendar aggregates across accounts.
    await login(page, alice);
    await addAccount(page, bob);
    const bobId = await accountId(page, bob.email);
    await enableProInterface(page);

    await openCalendar(page);

    // Both accounts' (default) calendars aggregate into one list with distinct
    // names, and every row is initially visible.
    const rows = await calendarRows(page);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(new Set(rows.map((r) => r.name)).size).toBeGreaterThanOrEqual(2);

    // Deselect one calendar; remember it by name.
    const target = rows.find((r) => r.visible);
    expect(target, 'expected at least one visible calendar').toBeTruthy();
    const name = target!.name;
    await calendarItem(page, name).click();
    await expect(calendarItem(page, name)).toHaveAttribute('data-visible', 'false');

    // Switch the active account. This alone triggered the bug: the just-
    // deselected calendar belonged to the previously-active account, whose ids
    // flipped raw->namespaced on the switch, so the reconciler dropped the
    // selection and reset visibility to "all".
    await switchTo(page, bobId);
    await openCalendar(page);

    // The deselection survived the switch (the calendar is still aggregated in
    // and still hidden), and the list is still the cross-account set.
    await expect(calendarItem(page, name)).toHaveAttribute('data-visible', 'false');
    expect((await calendarRows(page)).length).toBeGreaterThanOrEqual(2);
  });
});
