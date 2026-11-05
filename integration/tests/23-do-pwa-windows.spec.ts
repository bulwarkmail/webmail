import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { ENT, adminContext, contextOptions, deliver, jmapAs, requireEntEnv, shot, withPolicy, ENT_PASSWORD } from './helpers/ent';
import { accountSwitcher, neutralizeDevOverlay } from './helpers/app';

/**
 * Windows of an installed app (design B, step 2) through the real UI on a
 * VM 106 test Stalwart with the ent-* accounts:
 * - the title bar next to the native window controls;
 * - "Save all to a folder", with a stubbed showDirectoryPicker;
 * - pop-out message and composer windows: session, draft handover, send,
 *   close with unsaved text, a message deleted or moved, state across windows.
 *
 * Headless Chromium has no installed-app mode, so the display mode and the
 * overlay API are stubbed by an init script (which reaches popups too).
 * window.open, the second window and everything behind it are real. What this
 * can't show: a real install opening a popup inside the app rather than in
 * the browser. A person has to check that once in Chrome and Edge.
 *
 * Rig:
 *   BUILD=1 bash start-prod.sh <worktree> <port> <jmap-url> pw-1.0
 *   bash run-spec.sh <worktree> <port> <jmap-url> 1.0 integration/tests/23-do-pwa-windows.spec.ts
 */

test.setTimeout(180_000);

const RUN = Date.now().toString(36);
/** A server check every second: tighter polling gets a test account rate limited. */
const POLL = [1000];
const STANDALONE = `(() => {
  const real = window.matchMedia.bind(window);
  window.matchMedia = (query) => query.includes('display-mode: standalone')
    ? { matches: true, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }
    : real(query);
})();`;
const OVERLAY = `(() => {
  const overlay = new EventTarget();
  overlay.visible = true;
  overlay.getTitlebarAreaRect = () => ({ x: 0, y: 0, width: window.innerWidth - 140, height: 40 });
  Object.defineProperty(navigator, 'windowControlsOverlay', { value: overlay });
})();`;
const BRIDGE = `window.bulwarkDesktop = { windows: {} };`;

async function appPage(browser: Browser, ...initScripts: string[]): Promise<Page> {
  // Wide enough that "Open in new window" fits the reader's toolbar instead of
  // going into its More menu.
  const context = await browser.newContext({ ...contextOptions(), viewport: { width: 1920, height: 1000 } });
  for (const script of initScripts) await context.addInitScript(script);
  const page = await context.newPage();
  await neutralizeDevOverlay(page);
  await page.goto('/');
  await page.fill('#username', ENT.alice);
  await page.fill('#password', ENT_PASSWORD);
  await page.click('button[type="submit"]');
  await accountSwitcher(page).waitFor({ state: 'visible', timeout: 60_000 });
  return page;
}

/** A toast: the text is also in the live region for screen readers. */
function toast(page: Page, text: string | RegExp) {
  return page.getByRole('region', { name: 'Notifications' }).getByText(text).first();
}

function row(page: Page, subject: string) {
  return page.locator('[data-testid="email-list-item"]', { hasText: subject }).first();
}

async function openInMain(page: Page, subject: string): Promise<void> {
  await expect(row(page, subject)).toBeVisible({ timeout: 60_000 });
  await row(page, subject).click();
}

async function deliverToAlice(subject: string): Promise<string> {
  await deliver({ from: ENT.bob, to: [ENT.alice], subject, text: `Body of ${subject}` });
  const alice = await jmapAs(ENT.alice);
  const found = await alice.waitForEmail(subject, { timeoutMs: 30_000 });
  return found.id;
}

/** A message in Alice's inbox with two attachments of the same name and one other. */
async function messageWithAttachments(subject: string): Promise<void> {
  const alice = await jmapAs(ENT.alice);
  const inbox = await alice.mailboxByRole('inbox');
  const res = await alice.request([['Email/set', {
    accountId: alice.accountId,
    create: { m: {
      mailboxIds: { [inbox!.id]: true },
      from: [{ email: ENT.bob }],
      to: [{ email: ENT.alice }],
      subject,
      bodyValues: {
        t: { value: 'See the files.' },
        a: { value: 'first copy' },
        b: { value: 'second copy' },
        c: { value: 'notes' },
      },
      bodyStructure: {
        type: 'multipart/mixed',
        subParts: [
          { partId: 't', type: 'text/plain' },
          { partId: 'a', type: 'text/plain', name: 'same.txt', disposition: 'attachment' },
          { partId: 'b', type: 'text/plain', name: 'same.txt', disposition: 'attachment' },
          { partId: 'c', type: 'text/plain', name: 'notes.txt', disposition: 'attachment' },
        ],
      },
    } },
  }, '0']]);
  if (!res.methodResponses[0][1].created?.m) throw new Error(JSON.stringify(res.methodResponses[0][1]));
}

/** Stubs the picker on the page, with a folder that records what it is given. */
async function stubDirectoryPicker(page: Page, opts: { failOn?: string; cancel?: boolean } = {}): Promise<void> {
  await page.evaluate(({ failOn, cancel }) => {
    const files = new Map<string, string>();
    (window as unknown as { __folderFiles: Map<string, string> }).__folderFiles = files;
    (window as unknown as { __pickerCalls: number }).__pickerCalls = 0;
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => {
      (window as unknown as { __pickerCalls: number }).__pickerCalls += 1;
      if (cancel) throw new DOMException('closed', 'AbortError');
      return {
        name: 'Saved mail',
        async getFileHandle(name: string, options?: { create?: boolean }) {
          if (!files.has(name) && !options?.create) throw new DOMException('missing', 'NotFoundError');
          return {
            createWritable: async () => ({
              write: async (data: Blob) => {
                if (name === failOn) throw new DOMException('Disk full', 'QuotaExceededError');
                files.set(name, await data.text());
              },
              close: async () => {},
              abort: async () => {},
            }),
          };
        },
        async removeEntry(name: string) { files.delete(name); },
      };
    };
  }, opts);
}

const folderFiles = (page: Page) => page.evaluate(() => [...(window as unknown as { __folderFiles: Map<string, string> }).__folderFiles.entries()]);

function watchAuthCalls(context: BrowserContext): string[] {
  const calls: string[] = [];
  context.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() !== 'PUT') return;
    if (url.pathname === '/api/auth/token' || url.pathname === '/api/auth/session') {
      calls.push(`${request.frame().page().url()} ${url.pathname}${url.search}`);
    }
  });
  return calls;
}

async function openPopout(page: Page, trigger: () => Promise<void>): Promise<Page> {
  const [popup] = await Promise.all([page.context().waitForEvent('page'), trigger()]);
  await popup.waitForLoadState('domcontentloaded');
  return popup;
}

async function popOutMessage(page: Page, subject: string): Promise<Page> {
  await openInMain(page, subject);
  const button = page.locator('[data-testid="viewer-open-in-window"]').first();
  await expect(button).toBeVisible({ timeout: 30_000 });
  const popup = await openPopout(page, () => button.click());
  await expect(popup.locator('[data-popout-window="message"][data-popout-status="ready"]')).toBeVisible({ timeout: 60_000 });
  return popup;
}

async function draftsCalled(subject: string): Promise<Array<{ id: string; subject: string }>> {
  const alice = await jmapAs(ENT.alice);
  const drafts = await alice.mailboxByRole('drafts');
  const res = await alice.request([
    ['Email/query', { accountId: alice.accountId, filter: { inMailbox: drafts!.id, subject } }, '0'],
    ['Email/get', { accountId: alice.accountId, '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' }, properties: ['id', 'subject'] }, '1'],
  ]);
  return res.methodResponses[1][1].list;
}

test.beforeAll(() => requireEntEnv());

test.describe('the manifest and the window controls', () => {
  test('the manifest asks for the overlay and falls back to standalone', async ({ request, baseURL }) => {
    const res = await request.get(`${baseURL ?? process.env.IT_WEBMAIL_URL}/manifest.webmanifest`);
    const manifest = await res.json();
    expect(manifest.display).toBe('standalone');
    expect(manifest.display_override).toEqual(['window-controls-overlay', 'standalone']);
  });

  test('without an overlay nothing changes', async ({ browser }) => {
    const page = await appPage(browser);
    await expect(page.locator('html[data-window-controls]')).toHaveCount(0);
    await expect(page.locator('[data-window-row]')).toHaveCount(0);
    const padding = await page.evaluate(() => {
      const root = document.querySelector('[class*="--app-top-inset"]') as HTMLElement;
      return { padding: getComputedStyle(root).paddingTop, top: root.getBoundingClientRect().top };
    });
    expect(padding).toEqual({ padding: '0px', top: 0 });
    await page.context().close();
  });

  test('with one, the app runs to the top and its rightmost row leaves the controls free', async ({ browser }) => {
    const page = await appPage(browser, OVERLAY);
    await expect(page.locator('html[data-window-controls]')).toHaveCount(1);
    const root = await page.evaluate(() => {
      const el = document.querySelector('[class*="--app-top-inset"]') as HTMLElement;
      return { padding: getComputedStyle(el).paddingTop, top: el.getBoundingClientRect().top };
    });
    expect(root).toEqual({ padding: '0px', top: 0 });
    const row = page.locator('[data-window-row-right]').first();
    await expect(row).toBeVisible();
    const seen = await row.evaluate((el) => {
      const style = getComputedStyle(el) as CSSStyleDeclaration & { appRegion?: string; webkitAppRegion?: string };
      return { region: style.appRegion ?? style.webkitAppRegion, padding: parseFloat(style.paddingRight), right: el.getBoundingClientRect().right };
    });
    expect(seen.region).toBe('drag');
    expect(seen.right).toBe(page.viewportSize()!.width);
    expect(seen.padding).toBeGreaterThanOrEqual(140);
    await shot(page, 'pwa-windows-controls');
    await page.context().close();
  });
});

test.describe('save all attachments to a folder', () => {
  const SUBJECT = `Files ${RUN}`;

  test.beforeAll(() => messageWithAttachments(SUBJECT));

  test('writes every file, numbers the same name, and says how many', async ({ browser }) => {
    const page = await appPage(browser);
    await stubDirectoryPicker(page);
    await openInMain(page, SUBJECT);
    await page.locator('[data-testid="attachments-save-to-folder"]').first().click();
    await expect(toast(page, 'Saved 3 attachments to Saved mail.')).toBeVisible({ timeout: 30_000 });
    const files = new Map(await folderFiles(page));
    expect([...files.keys()].sort()).toEqual(['notes.txt', 'same (1).txt', 'same.txt']);
    expect(files.get('notes.txt')).toContain('notes');
    expect([files.get('same.txt'), files.get('same (1).txt')].map((text) => text!.trim()).sort()).toEqual(['first copy', 'second copy']);
    await page.context().close();
  });

  test('a write failing midway says how many were saved', async ({ browser }) => {
    const page = await appPage(browser);
    await stubDirectoryPicker(page, { failOn: 'notes.txt' });
    await openInMain(page, SUBJECT);
    await page.locator('[data-testid="attachments-save-to-folder"]').first().click();
    await expect(toast(page, 'Saved 2 of 3 attachments to Saved mail.')).toBeVisible({ timeout: 30_000 });
    await page.context().close();
  });

  test('closing the picker does nothing', async ({ browser }) => {
    const page = await appPage(browser);
    await stubDirectoryPicker(page, { cancel: true });
    await openInMain(page, SUBJECT);
    await page.locator('[data-testid="attachments-save-to-folder"]').first().click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __pickerCalls: number }).__pickerCalls)).toBe(1);
    await expect(toast(page, /Saved \d/)).toHaveCount(0);
    await page.context().close();
  });

  test('is gone when the organisation blocks downloads', async ({ browser }) => {
    const admin = await adminContext(browser);
    const page = await appPage(browser);
    await stubDirectoryPicker(page);
    await withPolicy(admin, { organisation: { devices: { noDownloads: true } } }, async () => {
      await page.reload();
      await stubDirectoryPicker(page);
      await accountSwitcher(page).waitFor({ state: 'visible', timeout: 60_000 });
      await openInMain(page, SUBJECT);
      await expect(page.getByTestId('attachments-downloads-off').first()).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('[data-testid="attachments-save-to-folder"]')).toHaveCount(0);
    });
    await admin.close();
    await page.context().close();
  });
});

test.describe('pop-out windows', () => {
  test('paints from the server HTML: its own frame, no spinner, no rail, the theme set before the first paint', async ({ browser }) => {
    const context = await browser.newContext(contextOptions());
    for (const path of ['/en/popout/compose', '/en/popout/message/x1']) {
      const res = await context.request.get(path);
      expect(res.status(), path).toBe(200);
      const html = await res.text();
      expect(html, path).toContain('data-popout-skeleton');
      expect(html, path).toContain('data-popout-status="loading"');
      expect(html, path).not.toContain('animate-spin');
      expect(html, path).not.toContain('data-sk-rail');
      expect(html, path).not.toContain('data-boot-skeleton=');
      expect(html.indexOf('theme-storage'), path).toBeLessThan(html.indexOf('data-popout-window'));
    }
    await context.close();
  });

  test('a browser tab offers a window for a composer only', async ({ browser }) => {
    const subject = `Tab ${RUN}`;
    await deliverToAlice(subject);
    const page = await appPage(browser);
    await openInMain(page, subject);
    await expect(page.getByText(`Body of ${subject}`).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="viewer-open-in-window"]')).toHaveCount(0);
    await page.keyboard.press('c');
    await page.locator('[data-testid="email-composer"]').waitFor({ state: 'visible' });
    // A composer moves to a window of its own from a tab too, as in Gmail (461a7daf4).
    await expect(page.locator('[data-testid="composer-open-in-window"]').first()).toBeVisible();
    await page.context().close();
  });

  test('the bridge counts too: display-mode is `browser` in Electron', async ({ browser }) => {
    const subject = `Bridge ${RUN}`;
    await deliverToAlice(subject);
    const page = await appPage(browser, BRIDGE);
    await openInMain(page, subject);
    await expect(page.locator('[data-testid="viewer-open-in-window"]').first()).toBeVisible({ timeout: 30_000 });
    await page.context().close();
  });

  test('a message opens alone, on the main window\'s session, with no rail and no token renewal', async ({ browser }) => {
    const subject = `Popout ${RUN}`;
    await deliverToAlice(subject);
    const page = await appPage(browser, STANDALONE);
    const calls = watchAuthCalls(page.context());
    const popup = await popOutMessage(page, subject);
    await expect(popup.getByText(`Body of ${subject}`).first()).toBeVisible({ timeout: 60_000 });
    await expect(popup.locator('nav')).toHaveCount(0);
    expect(popup.url()).toContain('/popout/message/');
    await expect(popup).toHaveTitle(new RegExp(subject));
    expect(calls.filter((call) => call.includes('/popout/'))).toEqual([]);
    await shot(popup, 'pwa-windows-popout-message');
    await page.context().close();
  });

  test('opening the same message again focuses its window', async ({ browser }) => {
    const subject = `Twice ${RUN}`;
    await deliverToAlice(subject);
    const page = await appPage(browser, STANDALONE);
    const popup = await popOutMessage(page, subject);
    const opened: Page[] = [];
    page.context().on('page', (p) => opened.push(p));
    const url = popup.url();
    let reloaded = false;
    popup.on('framenavigated', () => { reloaded = true; });
    await page.locator('[data-testid="viewer-open-in-window"]').first().click();
    await popup.waitForTimeout(1000);
    expect(opened).toEqual([]);
    expect(reloaded).toBe(false);
    expect(popup.url()).toBe(url);
    await page.context().close();
  });

  test('a session with nothing to restore still works, and survives in the list', async ({ browser }) => {
    const subject = `Forgotten ${RUN}`;
    await deliverToAlice(subject);
    const page = await appPage(browser, STANDALONE);
    await page.evaluate(() => {
      const registry = JSON.parse(localStorage.getItem('account-registry')!);
      for (const account of registry.state.accounts) account.rememberMe = false;
      localStorage.setItem('account-registry', JSON.stringify(registry));
    });
    await page.context().clearCookies({ name: 'jmap_session' });
    const popup = await popOutMessage(page, subject);
    await expect(popup.getByText(`Body of ${subject}`).first()).toBeVisible({ timeout: 60_000 });
    const accounts = await page.evaluate(() => JSON.parse(localStorage.getItem('account-registry')!).state.accounts.length);
    expect(accounts).toBeGreaterThan(0);
    await expect(accountSwitcher(page)).toBeVisible();
    await page.context().close();
  });

  test('a reload with the main window gone restores from the cookies, without evicting', async ({ browser }) => {
    const subject = `Alone ${RUN}`;
    await deliverToAlice(subject);
    const page = await appPage(browser, STANDALONE);
    const popup = await popOutMessage(page, subject);
    const before = await popup.evaluate(() => localStorage.getItem('account-registry'));
    await page.close();
    await popup.reload();
    await expect(popup.locator('[data-popout-window="message"][data-popout-status="ready"]')).toBeVisible({ timeout: 60_000 });
    await expect(popup.getByText(`Body of ${subject}`).first()).toBeVisible({ timeout: 60_000 });
    expect(await popup.evaluate(() => localStorage.getItem('account-registry'))).toBe(before);
    await popup.context().close();
  });

  test('a message deleted or moved while open says so', async ({ browser }) => {
    const subject = `Gone ${RUN}`;
    const emailId = await deliverToAlice(subject);
    const page = await appPage(browser, STANDALONE);
    const popup = await popOutMessage(page, subject);
    await expect(popup.getByText(`Body of ${subject}`).first()).toBeVisible({ timeout: 60_000 });

    const alice = await jmapAs(ENT.alice);
    const archive = await alice.mailboxByRole('archive');
    if (archive) {
      await alice.moveEmail(emailId, archive.id);
      await popup.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(popup.locator('[data-popout-moved]')).toContainText('moved to', { timeout: 30_000 });
      // A move keeps the id: the message stays readable.
      await expect(popup.getByText(`Body of ${subject}`).first()).toBeVisible();
    }

    await alice.request([['Email/set', { accountId: alice.accountId, destroy: [emailId] }, '0']]);
    await popup.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(popup.getByText('This message is gone')).toBeVisible({ timeout: 30_000 });
    await page.context().close();
  });

  test('deleting from the pop-out closes it', async ({ browser }) => {
    const subject = `Delete ${RUN}`;
    await deliverToAlice(subject);
    const page = await appPage(browser, STANDALONE);
    const popup = await popOutMessage(page, subject);
    await expect(popup.getByText(`Body of ${subject}`).first()).toBeVisible({ timeout: 60_000 });
    const closed = popup.waitForEvent('close');
    await popup.getByRole('button', { name: /^Delete$/ }).first().click();
    await closed;
    // The main window's list follows.
    await expect(row(page, subject)).toHaveCount(0, { timeout: 30_000 });
    const alice = await jmapAs(ENT.alice);
    const trash = await alice.mailboxByRole('trash');
    await expect.poll(async () => Object.keys((await alice.findEmailBySubject(subject))?.mailboxIds ?? {}), { intervals: POLL }).toEqual([trash!.id]);
  });

  test('state follows across windows without a reload', async ({ browser }) => {
    const subject = `Sync ${RUN}`;
    await deliverToAlice(subject);
    const page = await appPage(browser, STANDALONE);
    const popup = await popOutMessage(page, subject);
    await expect(popup.getByText(`Body of ${subject}`).first()).toBeVisible({ timeout: 60_000 });
    let navigated = 0;
    popup.on('framenavigated', () => { navigated += 1; });

    // Theme.
    await page.evaluate(() => {
      const stored = JSON.parse(localStorage.getItem('theme-storage') ?? '{"state":{"theme":"light"},"version":1}');
      stored.state.theme = 'dark';
      localStorage.setItem('theme-storage', JSON.stringify(stored));
    });
    await expect(popup.locator('html')).toHaveClass(/dark/, { timeout: 10_000 });

    // Language.
    await page.evaluate(() => localStorage.setItem('locale-storage', JSON.stringify({ state: { locale: 'de' }, version: 0 })));
    await expect(popup.locator('html')).toHaveAttribute('lang', 'de', { timeout: 15_000 });
    await page.evaluate(() => localStorage.setItem('locale-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 })));
    await expect(popup.locator('html')).toHaveAttribute('lang', 'en', { timeout: 15_000 });

    // Read state: from the pop-out to the main window's list. The main window
    // looks at another message: the one it has open it would mark read again.
    await expect(row(page, subject)).toHaveAttribute('data-unread', 'false', { timeout: 30_000 });
    const other = `Sync other ${RUN}`;
    await deliverToAlice(other);
    await openInMain(page, other);
    await popup.getByTitle('Mark as unread').first().click();
    await expect(row(page, subject)).toHaveAttribute('data-unread', 'true', { timeout: 30_000 });

    // And from the main window to the pop-out.
    await row(page, subject).click();
    await expect(row(page, subject)).toHaveAttribute('data-unread', 'false', { timeout: 30_000 });
    await expect(popup.getByTitle('Mark as unread').first()).toBeVisible({ timeout: 30_000 });
    expect(navigated).toBe(0);
    await page.context().close();
  });
});

test.describe('a composer in its own window', () => {
  async function popOutComposer(page: Page, subject: string): Promise<Page> {
    await page.keyboard.press('c');
    await page.locator('[data-testid="email-composer"]').waitFor({ state: 'visible', timeout: 15_000 });
    const input = page.locator('[data-testid="composer-to"] input').first();
    await input.click();
    await input.fill(ENT.bob);
    await input.press('Enter');
    await page.locator('[data-testid="composer-subject"]').first().fill(subject);
    await page.locator('[data-testid="email-composer"] [contenteditable="true"]').first().fill(`Body of ${subject}`);
    const popup = await openPopout(page, () => page.locator('[data-testid="composer-open-in-window"]').first().click());
    await expect(popup.locator('[data-popout-window="compose"][data-popout-status="ready"]')).toBeVisible({ timeout: 60_000 });
    await expect(popup.locator('[data-testid="composer-subject"]').first()).toHaveValue(subject, { timeout: 30_000 });
    return popup;
  }

  test('the draft moves over under one draft id, and the window closes after sending', async ({ browser }) => {
    const subject = `Moved ${RUN}`;
    const page = await appPage(browser, STANDALONE);
    const popup = await popOutComposer(page, subject);

    // Gone from the main window, with no "continue draft" left behind.
    await expect(page.locator('[data-testid="email-composer"]')).toHaveCount(0);
    await expect(popup.locator('[data-testid="composer-to"]')).toContainText(ENT.bob);
    await expect(popup.locator('[data-testid="email-composer"] [contenteditable="true"]').first()).toContainText(`Body of ${subject}`);
    await expect(popup.locator('nav')).toHaveCount(0);
    await expect.poll(async () => (await draftsCalled(subject)).length, { timeout: 15_000, intervals: POLL }).toBe(1);
    const [first] = await draftsCalled(subject);
    await shot(popup, 'pwa-windows-popout-composer');

    // Further edits replace that draft, they don't start another.
    await popup.locator('[data-testid="composer-subject"]').first().fill(`${subject} edited`);
    await expect.poll(async () => (await draftsCalled(`${subject} edited`)).length, { timeout: 15_000, intervals: POLL }).toBe(1);
    await expect.poll(async () => (await draftsCalled(subject)).map((draft) => draft.id).includes(first.id), { timeout: 15_000, intervals: POLL }).toBe(false);

    const closed = popup.waitForEvent('close');
    await popup.locator('[data-testid="composer-send"]').first().click();
    await closed;

    const bob = await jmapAs(ENT.bob);
    await bob.waitForEmail(`${subject} edited`, { timeoutMs: 60_000 });
    await expect.poll(async () => (await draftsCalled(`${subject} edited`)).length, { timeout: 20_000, intervals: POLL }).toBe(0);
    // The main window says it went, since the pop-out can't any more.
    await expect(toast(page, 'Email sent')).toBeVisible({ timeout: 30_000 });
    await page.context().close();
  });

  test('closing the window with unsaved text saves the draft', async ({ browser }) => {
    const subject = `Unsaved ${RUN}`;
    const page = await appPage(browser, STANDALONE);
    const popup = await popOutComposer(page, subject);
    await expect.poll(async () => (await draftsCalled(subject)).length, { timeout: 15_000, intervals: POLL }).toBe(1);
    const typed = `${subject} typed`;
    await popup.locator('[data-testid="composer-subject"]').first().fill(typed);
    // Inside the 2 s of the autosave, so only the close can save it. No prompt: the main window takes it.
    let prompted = false;
    popup.on('dialog', (dialog) => { prompted = true; void dialog.accept(); });
    const closed = popup.waitForEvent('close');
    await popup.close({ runBeforeUnload: true });
    await closed;
    expect(prompted).toBe(false);
    await expect.poll(async () => (await draftsCalled(typed)).length, { timeout: 20_000, intervals: POLL }).toBe(1);
    // It replaced the version the window started from.
    await expect.poll(async () => (await draftsCalled(subject)).filter((draft) => draft.subject === subject).length, { timeout: 20_000, intervals: POLL }).toBe(0);
    await page.context().close();
  });

  test('with no main window left it asks, and staying lets the save finish', async ({ browser }) => {
    const subject = `Asked ${RUN}`;
    const page = await appPage(browser, STANDALONE);
    const popup = await popOutComposer(page, subject);
    await expect.poll(async () => (await draftsCalled(subject)).length, { timeout: 15_000, intervals: POLL }).toBe(1);
    await page.close();
    const typed = `${subject} typed`;
    await popup.locator('[data-testid="composer-subject"]').first().fill(typed);
    const asked = new Promise<void>((resolve) => {
      popup.once('dialog', (dialog) => {
        expect(dialog.type()).toBe('beforeunload');
        void dialog.dismiss();
        resolve();
      });
    });
    await popup.close({ runBeforeUnload: true });
    await asked;
    expect(popup.isClosed()).toBe(false);
    await expect.poll(async () => (await draftsCalled(typed)).length, { timeout: 20_000, intervals: POLL }).toBe(1);
  });

  test('a blocked window leaves the composer where it is', async ({ browser }) => {
    const subject = `Blocked ${RUN}`;
    const page = await appPage(browser, STANDALONE);
    await page.evaluate(() => { window.open = () => null; });
    await page.keyboard.press('c');
    await page.locator('[data-testid="email-composer"]').waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator('[data-testid="composer-subject"]').first().fill(subject);
    await page.locator('[data-testid="composer-open-in-window"]').first().click();
    await expect(toast(page, /blocked the new window/)).toBeVisible();
    await expect(page.locator('[data-testid="composer-subject"]').first()).toHaveValue(subject);
    await page.context().close();
  });
});

test.describe('what a window must not lose', () => {
  test('text whose save fails in the main window lands in its "Continue draft" slot', async ({ browser }) => {
    const subject = `Refused ${RUN}`;
    const page = await appPage(browser, STANDALONE);
    await page.keyboard.press('c');
    await page.locator('[data-testid="email-composer"]').waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator('[data-testid="composer-subject"]').first().fill(subject);
    const popup = await openPopout(page, () => page.locator('[data-testid="composer-open-in-window"]').first().click());
    await expect(popup.locator('[data-testid="composer-subject"]').first()).toHaveValue(subject, { timeout: 60_000 });
    await expect.poll(async () => (await draftsCalled(subject)).length, { timeout: 15_000, intervals: POLL }).toBe(1);
    // Give the pop-out time to see the main window answer its ping.
    await popup.waitForTimeout(500);
    const typed = `${subject} typed`;
    await popup.locator('[data-testid="composer-subject"]').first().fill(typed);
    // The server stops taking saves, for the main window's rescue too.
    await page.context().route('**/jmap/**', async (route) => {
      if ((route.request().postData() ?? '').includes('Email/set')) await route.abort();
      else await route.continue();
    });
    let prompted = false;
    popup.on('dialog', (dialog) => { prompted = true; void dialog.accept(); });
    const closed = popup.waitForEvent('close');
    await popup.close({ runBeforeUnload: true });
    await closed;
    expect(prompted).toBe(false);
    await expect(toast(page, /save/i)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Continue draft').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(typed).first()).toBeVisible();
    await page.context().unroute('**/jmap/**');
    await page.context().close();
  });

  test('editing a draft from a message window opens a live composer, and only then closes', async ({ browser }) => {
    const subject = `Edit ${RUN}`;
    const alice = await jmapAs(ENT.alice);
    const draftId = await alice.createDraft(subject, ENT.bob);
    const page = await appPage(browser, STANDALONE);
    const drafts = await alice.mailboxByRole('drafts');
    await page.goto(`/mail/folder/${drafts!.id}`);
    await accountSwitcher(page).waitFor({ state: 'visible', timeout: 60_000 });
    await expect(row(page, subject)).toBeVisible({ timeout: 60_000 });
    const message = await openPopout(page, async () => {
      await row(page, subject).click({ button: 'right' });
      await page.getByTestId('ctx-open-window').click();
    });
    await expect(message.locator('[data-popout-window="message"][data-popout-status="ready"]')).toBeVisible({ timeout: 60_000 });
    const closed = message.waitForEvent('close');
    const composer = await openPopout(message, async () => {
      await message.getByRole('button', { name: /^Edit/ }).first().click();
    });
    await expect(composer.locator('[data-testid="composer-subject"]').first()).toHaveValue(subject, { timeout: 60_000 });
    await closed;
    // Live: it still saves over the same draft, with the window that opened it gone.
    await composer.locator('[data-testid="composer-subject"]').first().fill(`${subject} edited`);
    await expect.poll(async () => (await draftsCalled(`${subject} edited`)).length, { timeout: 20_000, intervals: POLL }).toBe(1);
    await expect.poll(async () => (await draftsCalled(subject)).filter((draft) => draft.id === draftId).length, { timeout: 20_000, intervals: POLL }).toBe(0);
    await page.context().close();
  });
});

test.describe('the attachment bar', () => {
  test('stays one row in a narrow pane, with both buttons in reach', async ({ browser }) => {
    const subject = `Narrow ${RUN}`;
    await messageWithAttachments(subject);
    const page = await appPage(browser);
    await stubDirectoryPicker(page);
    await openInMain(page, subject);
    const save = page.locator('[data-testid="attachments-save-to-folder"]').first();
    await expect(save).toBeVisible({ timeout: 30_000 });
    await page.setViewportSize({ width: 900, height: 900 });
    const pane = page.locator('[data-testid="reader-attachments"]').first();
    await expect(pane).toBeVisible();
    const row = save.locator('xpath=..');
    const rowBox = await row.boundingBox();
    const saveBox = await save.boundingBox();
    expect(rowBox!.height).toBeLessThan(48);
    expect(saveBox!.x + saveBox!.width).toBeLessThanOrEqual(rowBox!.x + rowBox!.width + 1);
    await expect(save).toHaveAttribute('aria-label', /folder/i);
    await page.context().close();
  });
});

test.describe('the desktop app\'s behaviour', () => {
  test('plain-text mail can be selected, list rows can\'t', async ({ browser }) => {
    const subject = `Selectable ${RUN}`;
    await deliverToAlice(subject);
    const page = await appPage(browser, BRIDGE);
    await openInMain(page, subject);
    const body = page.locator('[data-plugin-source="email-body"]').first();
    await expect(body).toBeVisible({ timeout: 30_000 });
    expect(await body.evaluate((el) => getComputedStyle(el).userSelect)).toBe('text');
    expect(await row(page, subject).evaluate((el) => getComputedStyle(el).userSelect)).toBe('none');
    // A real selection, the way a user would make one.
    await body.click({ clickCount: 3 });
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain(`Body of ${subject}`);
    await page.context().close();
  });

  test('hangs on the bridge: a browser gets none of it', async ({ browser }) => {
    const plain = await appPage(browser);
    expect(await plain.locator('html').getAttribute('data-desktop')).toBeNull();
    const button = plain.locator('button').first();
    expect(await button.evaluate((el) => getComputedStyle(el).userSelect)).not.toBe('none');
    await plain.context().close();

    const app = await appPage(browser, BRIDGE);
    expect(await app.locator('html').getAttribute('data-desktop')).toBe('');
    const chrome = app.locator('button').first();
    expect(await chrome.evaluate((el) => getComputedStyle(el).userSelect)).toBe('none');
    expect(await app.evaluate(() => getComputedStyle(document.documentElement).overscrollBehaviorY)).toBe('none');
    await app.context().close();
  });
});
