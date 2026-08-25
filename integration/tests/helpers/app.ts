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
 * Seed the persisted settings store before the app boots. Merges over the
 * store defaults on rehydrate. Must be called before {@link login} so the init
 * script is registered before the first navigation.
 */
export async function seedSettings(page: Page, settings: Record<string, unknown>): Promise<void> {
  await page.addInitScript((s) => {
    localStorage.setItem('settings-storage', JSON.stringify({ state: s, version: 7 }));
  }, settings);
}

/**
 * Enable the cross-account Unified Mailbox. Requires the
 * `unifiedCrossAccountEnabled` admin feature gate (provided by
 * integration/webmail-config/policy.json).
 */
export async function seedUnifiedSettings(page: Page): Promise<void> {
  await seedSettings(page, {
    enableUnifiedMailbox: true,
    unifiedCrossAccount: true,
    includeGroupInUnified: true,
  });
}

/**
 * Enable the "All Mail" view. `crossAccount` spans every logged-in account
 * (requires the `unifiedCrossAccountEnabled` gate); otherwise it is account-
 * bounded (spans the active account's own + shared folders). The "All mail"
 * entry itself is gated by `crossAllViewEnabled` (also in policy.json).
 */
export async function seedAllMailSettings(page: Page, opts: { crossAccount?: boolean } = {}): Promise<void> {
  await seedSettings(page, {
    enableUnifiedMailbox: true,
    enableCrossAllView: true,
    includeGroupInUnified: true,
    unifiedCrossAccount: !!opts.crossAccount,
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

// ─── Files (drive) ─────────────────────────────────────────────────────────

/** The primary navigation rail (there are two - mobile + desktop chrome). */
function navRail(page: Page): Locator {
  return page.locator('nav[aria-label="Navigation"]').first();
}

/**
 * Open the Files drive via the navigation rail. A deep `page.goto('/files')`
 * bounces to login in this SPA, so navigate in-app through the rail link
 * (rendered for every route once files support is detected). Waits until the
 * file browser toolbar is present.
 */
export async function openFiles(page: Page): Promise<void> {
  await navRail(page).getByRole('link', { name: 'Files', exact: true }).click();
  await page.locator('[role="toolbar"]').first().waitFor({ state: 'visible', timeout: 30000 });
}

/**
 * Return to the mail view via the navigation rail's Mail link and wait until it
 * has settled. Settling matters before touching the account switcher: while the
 * mailbox is still loading the sidebar reflows, which leaves the switcher's
 * popover items shifting/detaching under a click. Waiting for the Inbox row
 * (and the switcher) pins the layout first.
 */
export async function openMailView(page: Page): Promise<void> {
  await navRail(page).getByRole('link', { name: 'Mail', exact: true }).click();
  await accountSwitcher(page).waitFor({ state: 'visible', timeout: 30000 });
  await folderRow(page, { role: 'inbox' }).first().waitFor({ state: 'visible', timeout: 30000 });
}

/** A drive entry (folder/file) row, selected by its name via `data-resource`. */
export function driveEntry(page: Page, name: string): Locator {
  return page.locator(`[data-resource="${name}"]`);
}

// ─── Composer / drafts ────────────────────────────────────────────────────

/** Open the composer via the keyboard shortcut and wait for it to render. */
export async function openComposer(page: Page): Promise<void> {
  await page.keyboard.press('c');
  await page.locator('[data-testid="email-composer"]').waitFor({ state: 'visible', timeout: 15000 });
}

/** Add a recipient to the To field (commits it as a chip with Enter). */
export async function addRecipient(page: Page, email: string): Promise<void> {
  const input = page.locator('[data-testid="composer-to"] input').first();
  await input.click();
  await input.fill(email);
  await input.press('Enter');
}

/** Select a sending identity in the From dropdown by its identity id. */
export async function setFrom(page: Page, identityId: string): Promise<void> {
  await page.locator('[data-testid="composer-from"]').selectOption({ value: identityId });
}

/** Fill the subject field. */
export async function setSubject(page: Page, subject: string): Promise<void> {
  await page.locator('[data-testid="composer-subject"]').fill(subject);
}

/** Wait until the composer reports the draft as saved. */
export async function waitDraftSaved(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="composer-save-status"]')).toHaveAttribute('data-status', 'saved', {
    timeout: 20000,
  });
}

/** Close the composer (draft is auto-saved). */
export async function closeComposer(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.locator('[data-testid="email-composer"]').waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
}

/** Recipient chips currently shown in the composer's To field. */
export async function composerRecipients(page: Page): Promise<string[]> {
  const to = page.locator('[data-testid="composer-to"]');
  const text = (await to.innerText()).toLowerCase();
  return text.split(/\s+/).filter((t) => t.includes('@'));
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

export interface FolderSelector {
  role?: string;
  name?: string;
  mailboxId?: string;
  /** true = only shared-account folders, false = only own folders. */
  shared?: boolean;
}

/** Locator for a sidebar folder row. */
export function folderRow(page: Page, sel: FolderSelector): Locator {
  let s = '[data-testid="folder-row"]';
  if (sel.role) s += `[data-folder-role="${sel.role}"]`;
  if (sel.name) s += `[data-folder-name="${sel.name}"]`;
  if (sel.mailboxId) s += `[data-mailbox-id="${sel.mailboxId}"]`;
  if (sel.shared === true) s += '[data-shared="true"]';
  if (sel.shared === false) s += ':not([data-shared="true"])';
  return page.locator(s);
}

/**
 * Expand the sidebar "Shared" section and the given sharer's shared-account
 * group so its folders (data-shared="true") render. Idempotent.
 */
export async function expandSharedFolders(page: Page, sharerEmail: string): Promise<void> {
  const section = page.locator('[data-testid="section-shared"]');
  await section.waitFor({ state: 'visible', timeout: 30000 });
  if ((await section.getAttribute('data-expanded')) !== 'true') await section.click();
  const account = page.locator(`[data-testid="section-shared-account"][data-section-name="${sharerEmail}"]`);
  await account.waitFor({ state: 'visible', timeout: 30000 });
  if ((await account.getAttribute('data-expanded')) !== 'true') await account.click();
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

/** The JMAP (UI) mailbox id backing a folder row — namespaced for shared folders. */
export async function folderMailboxId(page: Page, sel: FolderSelector): Promise<string> {
  const id = await folderRow(page, sel).first().getAttribute('data-mailbox-id');
  if (!id) throw new Error(`folder ${JSON.stringify(sel)} has no data-mailbox-id`);
  return id;
}

/**
 * Move an email to `destMailboxId` (a UI mailbox id, e.g. from
 * {@link folderMailboxId}) via the list context menu's "Move to" submenu.
 */
export async function moveEmailTo(page: Page, subject: string, destMailboxId: string): Promise<void> {
  const row = emailItem(page, subject).first();
  await row.waitFor({ state: 'visible' });
  const submenu = page.locator('[data-testid="ctx-move-to"]');
  await expect(async () => {
    await row.click({ button: 'right' });
    await submenu.waitFor({ state: 'visible', timeout: 2000 });
  }).toPass({ timeout: 15000 });
  await submenu.hover();
  const target = page.locator(`[data-testid="move-to:${destMailboxId}"]`);
  await target.waitFor({ state: 'visible', timeout: 5000 });
  await target.click();
}

/** Poll until a folder's total count reaches `expected`. */
export async function expectFolderTotal(page: Page, sel: FolderSelector, expected: number, timeout = 30000): Promise<void> {
  await expect
    .poll(async () => (await folderCounts(page, sel)).total, { timeout })
    .toBe(expected);
}

/**
 * Assert a folder's counts, nudging a reconcile (visibilitychange ->
 * checkForStateChanges) before *every* poll. Use for counters that update via
 * reconcile rather than live SSE push — after a server-side move/delete, a
 * mark-as-spam, or a shared-account change — where a single missed reconcile
 * would otherwise flake. Only the provided fields are compared.
 */
export async function expectFolderCountsSynced(
  page: Page,
  sel: FolderSelector,
  expected: { unread?: number; total?: number },
  timeout = 45000,
): Promise<void> {
  await expect
    .poll(
      async () => {
        await forceSync(page);
        const c = await folderCounts(page, sel);
        return {
          ...(expected.unread !== undefined ? { unread: c.unread } : {}),
          ...(expected.total !== undefined ? { total: c.total } : {}),
        };
      },
      { timeout, intervals: [500, 1000, 1500, 2000, 2000, 3000] },
    )
    .toEqual(expected);
}

/** Click a folder row to select it. */
export async function openFolder(page: Page, sel: FolderSelector): Promise<void> {
  await folderRow(page, sel).first().click();
}

/**
 * Select the composer's From sender whose option text contains `emailNeedle`
 * (e.g. a shared/group address). Requires the multi-identity <select> to be
 * rendered. Scrolls it into view first so the change is captured on video.
 */
export async function selectComposerFrom(page: Page, emailNeedle: string): Promise<void> {
  const from = page.locator('[data-testid="composer-from"]').first();
  await from.scrollIntoViewIfNeeded();
  const value = await from.locator('option', { hasText: emailNeedle }).first().getAttribute('value');
  if (!value) throw new Error(`No composer From option matching "${emailNeedle}"`);
  await from.selectOption(value);
}

/** The display text of the currently selected From sender. */
export async function selectedComposerFrom(page: Page): Promise<string> {
  const from = page.locator('[data-testid="composer-from"]').first();
  return (await from.locator('option:checked').first().textContent())?.trim() ?? '';
}
/** Locator for an email row by (exact) subject. */
export function emailItem(page: Page, subject: string): Locator {
  return page.locator(`[data-testid="email-list-item"][data-subject="${subject}"]`);
}

/** Poll until an email with `subject` is present in the list. */
export async function expectEmailVisible(page: Page, subject: string, timeout = 20000): Promise<void> {
  await expect(emailItem(page, subject).first()).toBeVisible({ timeout });
}

/** Assert an email row's unread state (from its `data-unread` attribute). */
export async function expectEmailUnread(page: Page, subject: string, unread: boolean, timeout = 20000): Promise<void> {
  await expect(emailItem(page, subject).first()).toHaveAttribute('data-unread', String(unread), { timeout });
}

/** Assert an email row's starred state (from its `data-starred` attribute). */
export async function expectEmailStarred(page: Page, subject: string, starred: boolean, timeout = 20000): Promise<void> {
  await expect(emailItem(page, subject).first()).toHaveAttribute('data-starred', String(starred), { timeout });
}

/**
 * Open an email's right-click context menu and click one of its actions.
 * `testId` is one of: `ctx-delete`, `ctx-spam`, `ctx-not-spam`,
 * `ctx-mark-read`, `ctx-mark-unread`.
 */
export async function emailContextAction(page: Page, subject: string, testId: string): Promise<void> {
  const row = emailItem(page, subject).first();
  await row.waitFor({ state: 'visible' });
  await row.scrollIntoViewIfNeeded();
  const item = page.locator(`[data-testid="${testId}"]`);
  // Right-click can occasionally land before the list row is interactive;
  // retry opening the menu until the action item is actually present.
  await expect(async () => {
    await row.click({ button: 'right' });
    await item.waitFor({ state: 'visible', timeout: 2000 });
  }).toPass({ timeout: 15000 });
  await item.click();
}

// --- Calendar (multi-account) ---------------------------------------------

/**
 * Navigate to the calendar via the in-app nav (client-side routing) and wait
 * for the sidebar calendar list. A hard `page.goto('/calendar')` redirects to
 * login because the deep-link SSR path runs before client auth hydrates.
 */
export async function openCalendar(page: Page): Promise<void> {
  await page.locator('a[href$="/calendar"]').first().click();
  await page
    .locator('[data-testid="calendar-item"]')
    .first()
    .waitFor({ state: 'visible', timeout: 30000 });
}

/** A sidebar calendar row by its (exact) name. */
export function calendarItem(page: Page, name: string): Locator {
  return page.locator(`[data-testid="calendar-item"][data-calendar-name="${name}"]`).first();
}

/** All sidebar calendars as {name, account, visible}. */
export async function calendarRows(
  page: Page,
): Promise<Array<{ name: string; account: string; visible: boolean }>> {
  return page.locator('[data-testid="calendar-item"]').evaluateAll((els) =>
    els.map((e) => ({
      name: e.getAttribute('data-calendar-name') || '',
      account: e.getAttribute('data-account') || '',
      visible: e.getAttribute('data-visible') === 'true',
    })),
  );
}

/**
 * Turn on the Pro (multi-account) interface via the settings UI, so the
 * calendar/contacts aggregate across accounts. Done through the real toggle
 * (not a reload/seed) because the app doesn't survive a hard reload in tests
 * and seeding proInterface before login destabilises the add-account popover.
 */
export async function enableProInterface(page: Page): Promise<void> {
  await page.locator('a[href$="/settings"]').first().click();
  await page.locator('[data-testid="settings-tab-layout"]').first().click();
  const toggle = page.locator('[data-testid="setting-pro-interface"]').first();
  await toggle.waitFor({ state: 'visible', timeout: 30000 });
  if ((await toggle.getAttribute('aria-checked')) !== 'true') {
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
  }
}

// --- Contacts / address books (multi-account) ------------------------------

/** Navigate to contacts via in-app nav and wait for the address-book list. */
export async function openContacts(page: Page): Promise<void> {
  await page.locator('a[href$="/contacts"]').first().click();
  await page
    .locator('[data-testid="address-book-item"]')
    .first()
    .waitFor({ state: 'visible', timeout: 30000 });
}

/** All sidebar address books as {name, account}. */
export async function addressBookRows(
  page: Page,
): Promise<Array<{ name: string; account: string }>> {
  return page.locator('[data-testid="address-book-item"]').evaluateAll((els) =>
    els.map((e) => ({
      name: e.getAttribute('data-book-name') || '',
      account: e.getAttribute('data-account') || '',
    })),
  );
}
