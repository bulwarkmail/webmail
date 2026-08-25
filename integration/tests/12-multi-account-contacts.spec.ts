import { test, expect, type Page } from '@playwright/test';
import { ACCOUNTS } from './helpers/config';
import {
  login,
  addAccount,
  enableProInterface,
  openContacts,
  addressBookRows,
} from './helpers/app';

/**
 * Multi-account address-book aggregation across an account switch.
 *
 * Companion to the calendar spec for the cross-account id-namespacing fix.
 * Contacts keep no persisted id-selection (unlike calendars'
 * selectedCalendarIds), so there is no selection to reset; the observable here
 * is that the aggregated cross-account address-book list stays correct and
 * usable after switching the active account (the store now namespaces every
 * account consistently, so ids no longer flip form on a switch).
 */
const { alice, bob } = ACCOUNTS;

const switcher = (page: Page) => page.locator('[data-testid="account-switcher"]').first();

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

async function switchTo(page: Page, id: string): Promise<void> {
  await switcher(page).click();
  await page.locator(`[data-testid="account-option"][data-account-id="${id}"]`).first().click({ force: true });
  await expect
    .poll(async () => switcher(page).getAttribute('data-active-account-id'), { timeout: 30000 })
    .toBe(id);
}

test.describe('Multi-account contacts', () => {
  test('address books from both accounts stay aggregated across a switch', async ({ page }) => {
    await login(page, alice);
    await addAccount(page, bob);
    const bobId = await accountId(page, bob.email);
    await enableProInterface(page);

    await openContacts(page);

    // Both accounts' (default) address books aggregate into one list with
    // distinct names.
    const before = await addressBookRows(page);
    expect(before.length).toBeGreaterThanOrEqual(2);
    const namesBefore = new Set(before.map((b) => b.name));
    expect(namesBefore.size).toBeGreaterThanOrEqual(2);

    // Switch the active account: the previously-active account's ids flip
    // raw<->namespaced. The aggregated list must remain the same set (no loss,
    // no duplication, no corruption from the id-form change).
    await switchTo(page, bobId);
    await openContacts(page);

    const after = await addressBookRows(page);
    expect(after.length).toBe(before.length);
    expect(new Set(after.map((b) => b.name))).toEqual(namesBefore);
  });
});
