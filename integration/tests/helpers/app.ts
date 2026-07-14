/**
 * Page-level helpers for driving the Bulwark webmail in integration tests.
 *
 * Selectors rely on the data-testid hooks added to the mail UI (sidebar folder
 * rows + counters, account switcher, composer). Folder counters are read from
 * the `data-unread` / `data-total` attributes on `[data-testid=folder-counts]`
 * rather than parsing rendered text, so assertions are locale-independent.
 */
import { expect, type Page, type Locator } from '@playwright/test';
import type { TestAccount } from './config';

/**
 * The account switcher renders twice (collapsed nav rail + expanded sidebar);
 * both carry the same data-testid and state, so always target the first.
 */
export function accountSwitcher(page: Page): Locator {
  return page.locator('[data-testid="account-switcher"]').first();
}

/**
 * The Next.js dev-mode overlay (`<nextjs-portal>`) sits in the bottom-left
 * corner and intercepts pointer events over the account switcher. Disable
 * pointer events on the portal host (light DOM) so it can't swallow clicks.
 * Registered as an init script so it survives navigations within the test.
 */
export async function neutralizeDevOverlay(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const inject = () => {
      const s = document.createElement('style');
      s.textContent = 'nextjs-portal{pointer-events:none!important}';
      document.documentElement.appendChild(s);
    };
    if (document.documentElement) inject();
    else document.addEventListener('DOMContentLoaded', inject);
  });
}

/**
 * Enable the cross-account Unified Mailbox before the app boots by seeding the
 * persisted settings store. Requires the `unifiedCrossAccountEnabled` admin
 * feature gate (provided by integration/webmail-config/policy.json). Must be
 * called before {@link login} so the init script is registered before the
 * first navigation.
 */
export async function seedUnifiedSettings(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem(
      'settings-storage',
      JSON.stringify({
        state: { enableUnifiedMailbox: true, unifiedCrossAccount: true, includeGroupInUnified: true },
        version: 7,
      }),
    );
  });
}

/** Fill and submit the login form (works for first login and add-account). */
async function submitCredentials(page: Page, account: TestAccount): Promise<void> {
  await page.locator('#username').waitFor({ state: 'visible', timeout: 30000 });
  await page.fill('#username', account.email);
  await page.fill('#password', account.password);
  await page.click('button[type="submit"]');
}

/** Log in as `account` from a clean context and wait for the mailbox to load. */
export async function login(page: Page, account: TestAccount): Promise<void> {
  await neutralizeDevOverlay(page);
  await page.goto('/');
  await submitCredentials(page, account);
  // Landed in the app once the account switcher (sidebar chrome) is present.
  await accountSwitcher(page).waitFor({ state: 'visible', timeout: 30000 });
}

/** Add a second (or later) account via the account switcher + login form. */
export async function addAccount(page: Page, account: TestAccount): Promise<void> {
  await accountSwitcher(page).click();
  await page.locator('[data-testid="add-account"]').click();
  await submitCredentials(page, account);
  // Wait until the switcher reports the newly added account as active.
  await expect
    .poll(async () => activeAccountEmail(page), { timeout: 30000 })
    .toBe(account.email);
}

/** Email of the currently active account, read from the switcher option list. */
export async function activeAccountEmail(page: Page): Promise<string | null> {
  const switcher = accountSwitcher(page);
  const id = await switcher.getAttribute('data-active-account-id');
  if (!id) return null;
  await switcher.click();
  const email = await page
    .locator(`[data-testid="account-option"][data-account-id="${id}"]`)
    .first()
    .getAttribute('data-account-email');
  // Close the popover again.
  await page.keyboard.press('Escape');
  return email;
}

/** Switch the active account to the one matching `email`. */
export async function switchAccount(page: Page, email: string): Promise<void> {
  await accountSwitcher(page).click();
  await page.locator(`[data-testid="account-option"][data-account-email="${email}"]`).first().click();
  await expect.poll(async () => activeAccountEmail(page), { timeout: 30000 }).toBe(email);
}

/**
 * Nudge the app to reconcile mailbox state immediately.
 *
 * The JMAP client refetches on `visibilitychange` (tab focus) via
 * checkForStateChanges(). Dispatching it makes reconciliation deterministic
 * after an *external* mutation, sidestepping the small window right after
 * login where a change can land before the SSE push channel has settled.
 * Mirrors what happens when a real user tabs back to the mailbox.
 */
export async function forceSync(page: Page): Promise<void> {
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
}

export interface FolderSelector {
  role?: string;
  name?: string;
  mailboxId?: string;
}

/** Locator for a sidebar folder row. */
export function folderRow(page: Page, sel: FolderSelector): Locator {
  let s = '[data-testid="folder-row"]';
  if (sel.role) s += `[data-folder-role="${sel.role}"]`;
  if (sel.name) s += `[data-folder-name="${sel.name}"]`;
  if (sel.mailboxId) s += `[data-mailbox-id="${sel.mailboxId}"]`;
  return page.locator(s);
}

export interface FolderCounts {
  unread: number;
  total: number;
}

/**
 * Read a folder's unread/total counts. When both are zero the counts element
 * is not rendered, so a missing element is reported as {0,0}.
 */
export async function folderCounts(page: Page, sel: FolderSelector): Promise<FolderCounts> {
  const row = folderRow(page, sel).first();
  const counts = row.locator('[data-testid="folder-counts"]');
  if ((await counts.count()) === 0) return { unread: 0, total: 0 };
  const unread = await counts.getAttribute('data-unread');
  const total = await counts.getAttribute('data-total');
  return { unread: Number(unread ?? 0), total: Number(total ?? 0) };
}

/** Poll until a folder's unread count reaches `expected`. */
export async function expectFolderUnread(page: Page, sel: FolderSelector, expected: number, timeout = 30000): Promise<void> {
  await expect
    .poll(async () => (await folderCounts(page, sel)).unread, { timeout })
    .toBe(expected);
}

/** Poll until a folder's total count reaches `expected`. */
export async function expectFolderTotal(page: Page, sel: FolderSelector, expected: number, timeout = 30000): Promise<void> {
  await expect
    .poll(async () => (await folderCounts(page, sel)).total, { timeout })
    .toBe(expected);
}

/** Click a folder row to select it. */
export async function openFolder(page: Page, sel: FolderSelector): Promise<void> {
  await folderRow(page, sel).first().click();
}

/** Open the "New message" composer and wait for it to render. */
export async function openComposer(page: Page): Promise<Locator> {
  await page.locator('[data-tour="compose-button"]').first().click();
  const composer = page.locator('[data-testid="email-composer"]');
  await composer.waitFor({ state: 'visible', timeout: 15000 });
  return composer;
}

/**
 * The sender addresses the composer's From control offers.
 *
 * With more than one identity the control is a <select> and each choice is an
 * <option>; with a single identity it collapses to a static <span> that shows
 * only that address. Returning the raw text of whichever is rendered lets a
 * test assert on the *set of senders* without caring which shape it took.
 */
export async function composerFromOptions(page: Page): Promise<string[]> {
  const from = page.locator('[data-testid="composer-from"]').first();
  await from.waitFor({ state: 'visible', timeout: 10000 });
  if ((await from.locator('option').count()) > 0) {
    return from.locator('option').allTextContents();
  }
  return [await from.innerText()];
}

/** Locator for an email row by (exact) subject. */
export function emailItem(page: Page, subject: string): Locator {
  return page.locator(`[data-testid="email-list-item"][data-subject="${subject}"]`);
}

/** Poll until an email with `subject` is present in the list. */
export async function expectEmailVisible(page: Page, subject: string, timeout = 20000): Promise<void> {
  await expect(emailItem(page, subject).first()).toBeVisible({ timeout });
}
