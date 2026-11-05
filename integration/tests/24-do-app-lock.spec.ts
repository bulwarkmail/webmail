import { test, expect, type Browser, type BrowserContext, type Page, type Route } from '@playwright/test';
import { ENT, ENT_PASSWORD, contextOptions, deliver, jmapAs, requireEntEnv, shot } from './helpers/ent';
import { accountSwitcher } from './helpers/app';

/**
 * App lock (D8), through the real UI on a production build, on both test Stalwarts with
 * the throwaway ent-* accounts:
 * - off by default; on with a PIN in Settings > General;
 * - "Lock now": a lock screen, no mail in the page, its memory gone, the store's worker
 *   and key gone, no plugin frames, no subjects in browser storage;
 * - a wrong PIN, the wait after too many that a reload doesn't reset;
 * - every tab locks and unlocks, one key: only the tab that unlocked holds it;
 * - an open composer's text is on the server as a draft, and not readable meanwhile;
 * - time without use across tabs;
 * - a new tab, a pop-out address and a fresh start stay locked;
 * - a passkey with PRF through a virtual authenticator, and one without, which keeps the PIN;
 * - forgetting the PIN removes the data and signs out, also offline and with a server that hangs;
 * - offline with a shell, a lock still goes through a reload, and memory with it;
 * - a device at the lock screen hears a remote wipe.
 */

test.describe.configure({ mode: 'serial' });
test.setTimeout(300_000);

const RUN = Date.now().toString(36);
const PIN = 'it-pin-4827';
const lockForm = (page: Page) => page.getByTestId('app-lock-form');
const SECRET_SUBJECT = `applock-secret-${RUN}`;

test.beforeAll(async () => {
  requireEntEnv();
  await deliver({ from: ENT.bob, to: [ENT.alice], subject: SECRET_SUBJECT, text: `Body of ${SECRET_SUBJECT}` });
});

type Go = (page: Page, path: string) => Promise<unknown>;

const hardGoto: Go = (page, path) => page.goto(path);
const softGoto: Go = (page, path) => page.evaluate((target) => (window as unknown as { next: { router: { push(path: string): void } } }).next.router.push(target), path);

async function enableOffline(page: Page, go = hardGoto): Promise<void> {
  await go(page, '/settings/backup/offline');
  const toggle = page.getByTestId('offline-switch');
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  // The store is open once its key record is there. A full first sync isn't what's tested.
  await expect.poll(async () => (await keyRecords(page).catch(() => [])).length, { timeout: 60_000 }).toBeGreaterThan(0);
}

async function enableLock(page: Page, pin = PIN, go = hardGoto): Promise<void> {
  await go(page, '/settings/privacy');
  const toggle = page.getByTestId('app-lock-switch');
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await page.getByTestId('app-lock-new-pin').fill(pin);
  await page.getByTestId('app-lock-repeat-pin').fill(pin);
  await page.getByTestId('app-lock-dialog-save').click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 });
}

async function lockNow(page: Page): Promise<void> {
  if (!page.url().includes('/settings/privacy')) await gotoUnlocked(page, '/settings/privacy');
  await page.getByTestId('app-lock-now').click();
  await expect(lockForm(page)).toBeVisible({ timeout: 30_000 });
}

async function unlock(page: Page, pin = PIN): Promise<void> {
  await page.getByTestId('app-lock-pin').fill(pin);
  await page.getByTestId('app-lock-unlock').click();
  await expect(lockForm(page)).toBeHidden({ timeout: 60_000 });
}

/**
 * A full page load in the tab that holds the key loses the key, so it asks again. That's
 * the design: the key isn't kept anywhere that a reload could find it.
 */
async function gotoUnlocked(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(lockForm(page)).toBeVisible({ timeout: 30_000 });
  await unlock(page);
}

async function toMail(page: Page): Promise<void> {
  await gotoUnlocked(page, '/mail');
  await expect(page.locator('[data-testid="email-list-item"]').first()).toBeVisible({ timeout: 60_000 });
}

async function heldLocks(page: Page): Promise<string[]> {
  return page.evaluate(async () => ((await navigator.locks.query()).held ?? []).map((lock) => lock.name ?? ''));
}

/** Everything a person or a script could read in plain browser storage. */
async function browserStorage(page: Page): Promise<string> {
  return page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
}

/** The account key records as they are on disk. */
async function keyRecords(page: Page): Promise<Array<{ account: string; layers: string[] }>> {
  return page.evaluate(async () => new Promise(async (resolve, reject) => {
    // Opening one that doesn't exist would create it, empty, and break the app's own open.
    if (!(await indexedDB.databases()).some((db) => db.name === 'bulwark-store')) {
      resolve([]);
      return;
    }
    const open = indexedDB.open('bulwark-store');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      if (!open.result.objectStoreNames.contains('accounts')) {
        open.result.close();
        resolve([]);
        return;
      }
      const all = open.result.transaction('accounts').objectStore('accounts').getAll();
      all.onsuccess = () => {
        open.result.close();
        resolve((all.result as Array<{ account: string; layers: string[] }>).map(({ account, layers }) => ({ account, layers })));
      };
      all.onerror = () => reject(all.error);
    };
  }));
}

async function serverDraftBodies(subject: string): Promise<string[]> {
  const client = await jmapAs(ENT.alice);
  const r = await client.request([
    ['Email/query', { accountId: client.accountId, filter: { subject }, limit: 10 }, '0'],
    ['Email/get', { accountId: client.accountId, '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' }, properties: ['subject', 'keywords', 'bodyValues', 'textBody'], fetchTextBodyValues: true }, '1'],
  ]);
  const list = r.methodResponses[1][1].list as Array<{ keywords: Record<string, boolean>; bodyValues: Record<string, { value: string }> }>;
  return list.filter((email) => email.keywords.$draft).map((email) => Object.values(email.bodyValues).map((part) => part.value).join('\n'));
}

/** On this rig the box isn't offered, and a login is remembered, so a reload finds the session again. */
async function signIn(page: Page): Promise<void> {
  await page.fill('#username', ENT.alice);
  await page.fill('#password', ENT_PASSWORD);
  await page.click('button[type="submit"]');
  await accountSwitcher(page).waitFor({ state: 'visible', timeout: 60_000 });
}

async function fresh(browser: Browser): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext(contextOptions());
  const page = await context.newPage();
  await page.goto('/');
  await signIn(page);
  return { page, context };
}

test('off by default: nothing changes and no record is wrapped', async ({ browser }) => {
  const { page, context } = await fresh(browser);
  await page.goto('/settings/privacy');
  await expect(page.getByTestId('app-lock-switch')).toHaveAttribute('aria-checked', 'false', { timeout: 30_000 });
  expect(await page.evaluate(() => document.documentElement.hasAttribute('data-app-locked'))).toBe(false);
  expect(await heldLocks(page)).not.toContain('bulwark-app-lock-holder');
  await context.close();
});

test('locked: no mail in the page, its memory gone, the store closed with no key, and the PIN opens it again', async ({ browser }) => {
  const { page, context } = await fresh(browser);
  await enableOffline(page);
  await enableLock(page);

  const records = await keyRecords(page);
  expect(records.length).toBeGreaterThan(0);
  for (const record of records) expect(record.layers).toEqual(['applock']);

  await toMail(page);
  await expect(page.getByText(SECRET_SUBJECT).first()).toBeVisible({ timeout: 60_000 });
  await page.getByText(SECRET_SUBJECT).first().click();
  await expect(page.getByRole('heading', { name: SECRET_SUBJECT }).first()).toBeVisible({ timeout: 20_000 });
  expect(await heldLocks(page)).toContain('bulwark-store-owner');
  expect(await heldLocks(page)).toContain('bulwark-app-lock-holder');

  await gotoUnlocked(page, '/settings/privacy');
  await page.evaluate(() => { (window as unknown as { __before: string }).__before = 'still here'; });
  await page.getByTestId('app-lock-now').click();
  await expect(lockForm(page)).toBeVisible({ timeout: 30_000 });

  expect(await page.evaluate(() => (window as unknown as { __before?: string }).__before)).toBeUndefined();
  await expect(page.locator('body')).not.toContainText(SECRET_SUBJECT);
  expect(await page.content()).not.toContain(SECRET_SUBJECT);
  expect(await browserStorage(page)).not.toContain(SECRET_SUBJECT);
  expect(await page.title()).not.toContain(SECRET_SUBJECT);
  expect(await page.locator('iframe').count(), 'no frames, plugin frames included').toBe(0);
  const held = await heldLocks(page);
  expect(held, 'no worker holds the store').not.toContain('bulwark-store-owner');
  expect(held, 'nobody holds the key').not.toContain('bulwark-app-lock-holder');
  // What the app below the gate would start: from the very start of a locked page, nothing asks for mail.
  const requests: string[] = [];
  page.on('request', (request) => { if (/\/jmap|\/api\/auth\/(session|token)/.test(request.url())) requests.push(request.url()); });
  await page.reload();
  await expect(lockForm(page)).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  expect(requests).toEqual([]);
  await shot(page, 'app-lock-screen');

  await unlock(page);
  await expect(accountSwitcher(page)).toBeVisible({ timeout: 60_000 });
  expect(await heldLocks(page)).toContain('bulwark-app-lock-holder');
  await expect.poll(() => heldLocks(page), { timeout: 30_000 }).toContain('bulwark-store-owner');
  await context.close();
});

test('a wrong PIN says so, and after too many the wait survives a reload', async ({ browser }) => {
  const { page, context } = await fresh(browser);
  await enableLock(page);
  await lockNow(page);
  const message = page.getByTestId('app-lock-message');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await expect(page.getByTestId('app-lock-pin')).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId('app-lock-pin').fill(`wrong-pin-${attempt}`);
    await page.getByTestId('app-lock-unlock').click();
    await expect(page.getByTestId('app-lock-pin')).toHaveValue('', { timeout: 30_000 });
  }
  await expect(message).toContainText('Too many tries', { timeout: 15_000 });
  await expect(page.getByTestId('app-lock-pin')).toBeDisabled();

  await page.reload();
  await expect(lockForm(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('app-lock-message')).toContainText('Too many tries', { timeout: 15_000 });
  await expect(page.getByTestId('app-lock-pin')).toBeDisabled();

  await expect(page.getByTestId('app-lock-pin')).toBeEnabled({ timeout: 40_000 });
  await unlock(page);
  await context.close();
});

test('all tabs lock together, and a new tab or pop-out address stays locked; the one that unlocks holds the key', async ({ browser }) => {
  const { page, context } = await fresh(browser);
  await enableOffline(page);
  await enableLock(page);
  const second = await context.newPage();
  await second.goto('/mail');
  await expect(second.locator('[data-testid="email-list-item"]').first()).toBeVisible({ timeout: 60_000 });

  // This tab holds the key: no new load here, or the others would lock for that.
  await page.getByTestId('app-lock-now').click();
  await expect(lockForm(page)).toBeVisible({ timeout: 30_000 });
  await expect(lockForm(second)).toBeVisible({ timeout: 30_000 });
  await expect(second.locator('body')).not.toContainText(SECRET_SUBJECT);

  const third = await context.newPage();
  await third.goto('/mail');
  await expect(lockForm(third)).toBeVisible({ timeout: 30_000 });

  // A pop-out address: the lock screen sends people to the main window.
  const popout = await context.newPage();
  await popout.goto('/popout/compose');
  await expect(popout.getByRole('dialog').first()).toBeVisible({ timeout: 30_000 });
  await expect(popout.locator('[data-testid="email-composer"]')).toHaveCount(0);
  await expect(popout.getByRole('button', { name: 'Go to the main window' })).toBeVisible({ timeout: 10_000 });
  await popout.close();

  await unlock(second);
  await expect(lockForm(page)).toBeHidden({ timeout: 30_000 });
  await expect(lockForm(third)).toBeHidden({ timeout: 30_000 });
  await expect(accountSwitcher(page)).toBeVisible({ timeout: 60_000 });
  await expect(third.locator('[data-testid="email-list-item"]').first()).toBeVisible({ timeout: 60_000 });

  // The key was never passed on: when the tab that has it goes, the others have to ask.
  // Up to a store call's wait for the owner that went, then the reload.
  await second.close();
  await expect(lockForm(page)).toBeVisible({ timeout: 90_000 });
  await expect(lockForm(third)).toBeVisible({ timeout: 90_000 });
  await unlock(page);
  await context.close();
});

test('an open composer\'s text is saved first, is unreadable while locked, and nothing prompts', async ({ browser }) => {
  const { page, context } = await fresh(browser);
  const subject = `applock-draft-${RUN}`;
  const words = `words only the draft has ${RUN}`;
  await enableLock(page);
  await toMail(page);
  const prompts: string[] = [];
  page.on('dialog', (dialog) => { prompts.push(dialog.type()); void dialog.accept(); });
  await page.keyboard.press('c');
  const composer = page.locator('[data-testid="email-composer"]');
  await composer.waitFor({ state: 'visible', timeout: 15_000 });
  await page.locator('[data-testid="composer-subject"]').first().fill(subject);
  await composer.locator('[contenteditable="true"]').first().click();
  await page.keyboard.type(words);

  // As the timer does it, with the composer open.
  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('bulwark-app-lock') ?? '{}');
    localStorage.setItem('bulwark-app-lock', JSON.stringify({ ...raw, locked: true }));
    new BroadcastChannel('bulwark:app-lock').postMessage({ type: 'lock' });
  });
  await expect(lockForm(page)).toBeVisible({ timeout: 60_000 });
  expect(prompts).toEqual([]);
  await expect(page.locator('body')).not.toContainText(words);
  expect(await browserStorage(page)).not.toContain(words);

  await expect.poll(async () => (await serverDraftBodies(subject)).join('\n'), { timeout: 60_000 }).toContain(words);

  await unlock(page);
  await expect(page.getByRole('status').filter({ hasText: 'saved to Drafts' }).or(page.getByText('saved to Drafts')).first()).toBeVisible({ timeout: 30_000 });
  await context.close();
});

test('time without use locks every tab, and use in another tab counts', async ({ browser }) => {
  const { page, context } = await fresh(browser);
  await enableLock(page);
  await page.getByTestId('app-lock-timeout').selectOption('1');
  const other = await context.newPage();
  await other.goto('/mail');
  await expect(other.locator('[data-testid="email-list-item"]').first()).toBeVisible({ timeout: 60_000 });

  // 40 s of use in the other tab, then nothing.
  for (let i = 0; i < 4; i += 1) {
    await other.mouse.move(100 + i * 5, 100);
    await other.waitForTimeout(10_000);
    await other.mouse.move(120 + i * 5, 120);
  }
  await page.waitForTimeout(25_000);
  await expect(lockForm(page), 'used 25 s ago in the other tab').toBeHidden();

  await expect(lockForm(page)).toBeVisible({ timeout: 90_000 });
  await expect(lockForm(other)).toBeVisible({ timeout: 30_000 });
  await context.close();
});

test('a browser closed while unlocked starts locked', async ({ browser }) => {
  const { page, context } = await fresh(browser);
  await enableLock(page);
  const state = await context.storageState();
  // Web Locks and memory don't survive this. IndexedDB doesn't come along either, so localStorage alone decides here.
  await context.close();
  const reopened = await browser.newContext({ ...contextOptions(), storageState: state });
  const again = await reopened.newPage();
  await again.goto('/mail');
  await expect(lockForm(again)).toBeVisible({ timeout: 30_000 });
  await expect(again.locator('[data-testid="email-list-item"]')).toHaveCount(0);
  await reopened.close();
});

async function virtualAuthenticator(page: Page, hasPrf: boolean): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf,
    },
  });
}

test('a passkey with PRF unlocks without the PIN, and the PIN keeps working', async ({ browser }) => {
  const { page, context } = await fresh(browser);
  await virtualAuthenticator(page, true);
  await enableOffline(page);
  await enableLock(page);
  await page.getByTestId('app-lock-add-passkey').click();
  await page.getByTestId('app-lock-current-pin').fill(PIN);
  await page.getByTestId('app-lock-dialog-save').click();
  await expect(page.getByTestId('app-lock-dialog')).toBeHidden({ timeout: 60_000 });

  await lockNow(page);
  await page.getByTestId('app-lock-passkey').click();
  await expect(lockForm(page)).toBeHidden({ timeout: 60_000 });
  await expect(accountSwitcher(page)).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => heldLocks(page), { timeout: 30_000 }).toContain('bulwark-store-owner');

  await lockNow(page);
  await unlock(page);
  await context.close();
});

test('a passkey with no PRF is refused when added, and the PIN stays', async ({ browser }) => {
  const { page, context } = await fresh(browser);
  await virtualAuthenticator(page, false);
  await enableLock(page);
  await page.getByTestId('app-lock-add-passkey').click();
  await page.getByTestId('app-lock-current-pin').fill(PIN);
  await page.getByTestId('app-lock-dialog-save').click();
  await expect(page.getByTestId('app-lock-dialog')).toContainText("can't protect the key", { timeout: 60_000 });
  await page.getByRole('button', { name: 'Cancel' }).click();

  await lockNow(page);
  await expect(page.getByTestId('app-lock-passkey')).toHaveCount(0);
  await unlock(page);
  await context.close();
});

test('a login without "Remember me" has to sign in again after a lock, and its local data waits', async ({ browser }) => {
  const context = await browser.newContext(contextOptions());
  const page = await context.newPage();
  // The server has the box switched off. This asks for it as a server with it on does: the rest is the real login.
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), loginShowRememberMe: true, rememberMeEnabled: true } });
  });
  await page.goto('/');
  await expect(page.getByText('Remember me', { exact: true })).toBeVisible({ timeout: 30_000 });
  await signIn(page);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('account-registry') ?? '{}').state.accounts[0].rememberMe)).toBe(false);
  // By the router: such a login doesn't survive a page load, with or without a lock.
  await enableOffline(page, softGoto);
  await enableLock(page, PIN, softGoto);
  const before = await keyRecords(page);
  expect(before.length).toBeGreaterThan(0);
  await page.getByTestId('app-lock-now').click();
  await expect(lockForm(page)).toBeVisible({ timeout: 30_000 });
  await unlock(page);
  // The way to the login page and back from it are full page loads, and each asks again.
  const pastLock = async (target: ReturnType<Page['locator']>) => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(target.or(lockForm(page)).first()).toBeVisible({ timeout: 60_000 });
      if (await target.first().isVisible()) return;
      await unlock(page);
    }
    throw new Error('still at the lock screen');
  };
  await pastLock(page.locator('#username'));
  // Not what a page reload does to such a login with the lock off: that one wipes.
  expect((await keyRecords(page)).map((record) => record.account)).toEqual(before.map((record) => record.account));
  await page.fill('#username', ENT.alice);
  await page.fill('#password', ENT_PASSWORD);
  await page.click('button[type="submit"]');
  await pastLock(accountSwitcher(page));
  await expect.poll(() => heldLocks(page), { timeout: 60_000 }).toContain('bulwark-store-owner');
  await context.close();
});

test('turning it off needs the PIN and takes the layer off', async ({ browser }) => {
  const { page, context } = await fresh(browser);
  await enableOffline(page);
  await enableLock(page);
  await page.getByTestId('app-lock-switch').click();
  await page.getByTestId('app-lock-current-pin').fill('wrong-pin-1');
  await page.getByTestId('app-lock-dialog-save').click();
  await expect(page.getByTestId('app-lock-dialog')).toContainText('not right', { timeout: 30_000 });
  await page.getByTestId('app-lock-current-pin').fill(PIN);
  await page.getByTestId('app-lock-dialog-save').click();
  await expect(page.getByTestId('app-lock-switch')).toHaveAttribute('aria-checked', 'false', { timeout: 30_000 });
  for (const record of await keyRecords(page)) expect(record.layers).toEqual([]);
  // Off: a reload asks for nothing.
  await page.reload();
  await expect(page.getByTestId('app-lock-switch')).toBeVisible({ timeout: 60_000 });
  await expect(lockForm(page)).toHaveCount(0);
  await context.close();
});

/** What must be gone once the PIN is forgotten, however the server behaved. */
async function expectNothingLeft(page: Page): Promise<void> {
  expect(await page.evaluate(() => localStorage.getItem('bulwark-app-lock'))).toBeNull();
  await expect.poll(async () => page.evaluate(async () => (await indexedDB.databases()).map((db) => db.name)), { timeout: 30_000 })
    .not.toEqual(expect.arrayContaining(['bulwark-app-lock']));
  await expect.poll(async () => page.evaluate(async () => (await indexedDB.databases()).map((db) => db.name)), { timeout: 30_000 })
    .not.toEqual(expect.arrayContaining(['bulwark-store']));
  // The encrypted files themselves, in the browser's private folder.
  await expect.poll(() => page.evaluate(async () => {
    const names: string[] = [];
    for await (const name of (await navigator.storage.getDirectory() as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
    return names;
  }), { timeout: 30_000 }).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('account-registry') ?? '')).not.toContain('@');
}

const SESSION_COOKIE = /^jmap_/;

async function forgetPin(page: Page): Promise<void> {
  await page.getByTestId('app-lock-forgot').click();
  await page.getByRole('button', { name: 'Remove and sign out' }).click();
}

test('a forgotten PIN: local data goes, everyone signs out, and the login page is next', async ({ browser }) => {
  const { page, context } = await fresh(browser);
  await enableOffline(page);
  await enableLock(page);
  await lockNow(page);
  await forgetPin(page);
  await expect(page.locator('#username')).toBeVisible({ timeout: 60_000 });
  await expectNothingLeft(page);
  await expect.poll(async () => (await context.cookies()).filter((cookie) => SESSION_COOKIE.test(cookie.name)).map((cookie) => cookie.name), { timeout: 30_000 }).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('bulwark-cookies-to-clear'))).toBeNull();
  await context.close();
});

test('a forgotten PIN with a server that hangs: nothing waits for it, and nobody is signed in', async ({ browser }) => {
  const { page, context } = await fresh(browser);
  await enableOffline(page);
  await enableLock(page);
  await lockNow(page);
  // Sign-out's calls never answer.
  await context.route(/\/api\/(auth|settings|devices)/, () => { /* no answer */ });
  const started = Date.now();
  await forgetPin(page);
  // Polled: the way out may replace one navigation with the next, and
  // waitForURL gives up on the aborted one (net::ERR_ABORTED).
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 60_000 }).not.toContain('/settings');
  await page.waitForLoadState('load');
  expect(Date.now() - started, 'bounded, whatever the server does').toBeLessThan(45_000);
  await expectNothingLeft(page);
  // The session cookie stays, as the server never heard. The mark keeps it from signing anyone in.
  expect(await page.evaluate(() => localStorage.getItem('bulwark-cookies-to-clear'))).toBe('1');
  await context.unroute(/\/api\/(auth|settings|devices)/);
  await page.goto('/');
  await expect(page.locator('#username')).toBeVisible({ timeout: 60_000 });
  await expect(accountSwitcher(page)).toHaveCount(0);
  await expect.poll(async () => (await context.cookies()).filter((cookie) => SESSION_COOKIE.test(cookie.name)).map((cookie) => cookie.name), { timeout: 30_000 }).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('bulwark-cookies-to-clear'))).toBeNull();
  await context.close();
});

test('a forgotten PIN offline: the cookie that stays signs nobody in, then or when the network is back', async ({ browser }) => {
  const { page, context } = await fresh(browser);
  await enableOffline(page);
  await enableLock(page);
  await lockNow(page);
  const sessionCookies = (await context.cookies()).filter((cookie) => SESSION_COOKIE.test(cookie.name));
  expect(sessionCookies.length).toBeGreaterThan(0);
  await context.setOffline(true);
  // Chromium's emulated outage lets a keepalive request through when the page leaves right
  // after it. Sometimes its answer reached the page in time, which then dropped its mark, and
  // the check below failed. A real outage answers nothing: these DELETEs fail here too.
  const CLEAR = /\/api\/auth\/(session|token)\?all=true/;
  const outage = (route: Route) => route.abort('internetdisconnected');
  await context.route(CLEAR, outage);
  await forgetPin(page);
  // No network, so no way to delete an HttpOnly cookie, and the shell went with the rest:
  // the way to the login page ends at the browser's own error until the network is back.
  await page.waitForURL((url) => !url.pathname.includes('/settings'), { timeout: 60_000 })
    .catch((error: Error) => expect(error.message).toContain('ERR_INTERNET_DISCONNECTED'));
  // The old page is gone only once the error page is up: until then it could still reach the network.
  await expect.poll(() => page.url(), { timeout: 30_000 }).toContain('chrome-error');
  // What a real outage leaves: the cookies too (held back above, so this changes nothing).
  await context.addCookies(sessionCookies);
  const stored = (await context.storageState()).origins.flatMap((origin) => origin.localStorage).map((entry) => entry.name);
  expect(stored).toContain('bulwark-cookies-to-clear');
  expect(stored).not.toContain('bulwark-app-lock');
  const asked: string[] = [];
  context.on('request', (request) => {
    if (/\/api\/auth\/session/.test(request.url())) asked.push(request.method());
  });
  await context.unroute(CLEAR, outage);
  await context.setOffline(false);
  await page.goto('/');
  await expect(page.locator('#username')).toBeVisible({ timeout: 60_000 });
  await expect(accountSwitcher(page)).toHaveCount(0);
  await expectNothingLeft(page);
  await expect.poll(async () => (await context.cookies()).filter((cookie) => SESSION_COOKIE.test(cookie.name)).map((cookie) => cookie.name), { timeout: 30_000 }).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('bulwark-cookies-to-clear'))).toBeNull();
  expect(asked[0], 'the DELETE goes before anything could adopt the cookie').toBe('DELETE');
  await context.close();
});

test('locked offline, with the shell kept: the page still reloads, so nothing stays in memory', async ({ browser }) => {
  const { page, context } = await fresh(browser);
  await enableOffline(page);
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration()) ? (await caches.keys()).filter((key) => key.startsWith('bulwark-shell-')).length : 0), { timeout: 60_000 }).toBeGreaterThan(0);
  await enableLock(page);
  await page.goto('/settings/privacy');
  await expect(lockForm(page)).toBeVisible({ timeout: 30_000 });
  await unlock(page);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 30_000 }).toBe(true);
  await page.evaluate(() => { (window as unknown as { __before: string }).__before = 'still here'; });
  await context.setOffline(true);
  await page.getByTestId('app-lock-now').click();
  await expect(lockForm(page)).toBeVisible({ timeout: 60_000 });
  expect(await page.evaluate(() => (window as unknown as { __before?: string }).__before), 'a new document').toBeUndefined();
  await context.close();
});

test('a server answering 5xx: the lock holds on the page, and the reload comes when it can', async ({ browser }) => {
  const { page, context } = await fresh(browser);
  await enableLock(page);
  await page.evaluate(() => { (window as unknown as { __before: string }).__before = 'still here'; });
  await context.route('**/settings/privacy*', (route) => route.fulfill({ status: 503, body: 'down' }));
  await page.getByTestId('app-lock-now').click();
  await expect(lockForm(page)).toBeVisible({ timeout: 60_000 });
  expect(await page.evaluate(() => (window as unknown as { __before?: string }).__before), 'stayed').toBe('still here');
  await expect(page.locator('body')).not.toContainText('Lock now');
  await context.unroute('**/settings/privacy*');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  // The reload can come in the middle of a look.
  await expect.poll(() => page.evaluate(() => (window as unknown as { __before?: string }).__before).catch(() => 'reloading'), { timeout: 30_000 }).toBeUndefined();
  await expect(lockForm(page)).toBeVisible({ timeout: 30_000 });
  await context.close();
});

test('a device at the lock screen hears a remote wipe, and what it hears takes the data', async ({ browser }) => {
  const { page, context } = await fresh(browser);
  let wipeWaits = false;
  let checkedInLocked = false;
  // The registry itself is the remote wipe spec's to test: here it says what it says for a wipe.
  await context.route('**/api/devices', async (route) => {
    const body = route.request().postDataJSON() as { id?: string } | null;
    if (wipeWaits && body?.id) {
      checkedInLocked = true;
      await route.fulfill({ json: { wipe: { requestedAt: '2026-11-03T00:00:00.000Z' } } });
      return;
    }
    await route.continue();
  });
  await enableOffline(page);
  await enableLock(page);
  await expect.poll(() => page.evaluate(() => new Promise<number>((resolve) => {
    const open = indexedDB.open('bulwark-store');
    open.onsuccess = () => {
      const all = open.result.transaction('keys').objectStore('keys').getAllKeys();
      all.onsuccess = () => {
        open.result.close();
        resolve(all.result.filter((key) => String(key).startsWith('device:')).length);
      };
    };
  })), { timeout: 60_000 }).toBeGreaterThan(0);

  wipeWaits = true;
  await page.getByTestId('app-lock-now').click();
  // The lock screen comes first, and nobody unlocks.
  await expect(page.locator('#username').or(lockForm(page)).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#username')).toBeVisible({ timeout: 90_000 });
  expect(checkedInLocked).toBe(true);
  await expectNothingLeft(page);
  await context.close();
});
