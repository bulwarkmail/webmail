import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { accountSwitcher, neutralizeDevOverlay } from './helpers/app';
import { WEBMAIL_URL } from './helpers/config';
import { ENT, ENT_PASSWORD, adminContext, contextOptions, getPolicy, jmapAs, putPolicy, requireEntEnv, shot } from './helpers/ent';

/**
 * The installed app's launches through the real UI: shortcuts, files opened
 * from the OS, and shares. Chromium can't fire launchQueue from a test, so a
 * stand-in catches the consumer the app registers, and the spec calls that
 * consumer the way the browser would. Shares go through the real service
 * worker as a real form POST. Needs a production build, the only one that
 * registers the worker.
 *
 *   BUILD=1 bash desktop-offline-rig/start-prod.sh <worktree> 3230 <jmap-url> pwa-launch-1.0
 *   bash desktop-offline-rig/run-spec.sh <worktree> 3230 <jmap-url> 1.0 integration/tests/23-do-pwa-launch.spec.ts
 */

test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

const RUN = Date.now().toString(36);
const composer = (page: Page) => page.locator('[data-testid="email-composer"]').first();
const SHARE_CACHE = 'bulwark-launch-handoff-v1';

type LaunchFile = { name: string; type: string; body: string };

const EML: LaunchFile = {
  name: 'note.eml',
  type: 'message/rfc822',
  body: [
    'From: Bob <bob@example.org>',
    'To: Alice <alice@example.org>',
    `Subject: Launched message ${RUN}`,
    'Date: Tue, 03 Nov 2026 10:00:00 +0000',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Opened from the file system.',
    '',
  ].join('\r\n'),
};

const ICS: LaunchFile = {
  name: 'invite.ics',
  type: 'text/calendar',
  body: [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Bulwark//Test//EN',
    'BEGIN:VEVENT',
    `UID:launch-${RUN}@example.org`,
    'DTSTAMP:20261103T100000Z',
    'DTSTART:20261110T100000Z',
    'DTEND:20261110T110000Z',
    `SUMMARY:Launched event ${RUN}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n'),
};

const VCF: LaunchFile = {
  name: 'people.vcf',
  type: 'text/vcard',
  body: ['BEGIN:VCARD', 'VERSION:3.0', `FN:Launched Person ${RUN}`, `EMAIL:launched-${RUN}@example.org`, 'END:VCARD', ''].join('\r\n'),
};

/** Stands in for the browser's launchQueue, keeping the consumer the app sets. */
function catchLaunchConsumer() {
  Object.defineProperty(window, 'launchQueue', {
    configurable: true,
    value: {
      setConsumer(fn: unknown) {
        (window as unknown as { __launch: unknown }).__launch = fn;
      },
    },
  });
}

async function launch(page: Page, opts: { target?: string; files?: LaunchFile[] }): Promise<void> {
  await page.waitForFunction(() => typeof (window as unknown as { __launch?: unknown }).__launch === 'function');
  await page.evaluate(({ target, files }) => {
    const consumer = (window as unknown as { __launch: (params: unknown) => void }).__launch;
    consumer({
      targetURL: new URL(target, window.location.origin).href,
      ...(files.length > 0 ? {
        files: files.map((f) => ({ kind: 'file', getFile: async () => new File([f.body], f.name, { type: f.type }) })),
      } : {}),
    });
  }, { target: opts.target ?? '/', files: opts.files ?? [] });
}

async function signIn(page: Page, email: string): Promise<void> {
  await page.locator('#username').waitFor({ state: 'visible', timeout: 60_000 });
  await page.fill('#username', email);
  await page.fill('#password', ENT_PASSWORD);
  await page.click('button[type="submit"]');
  await accountSwitcher(page).waitFor({ state: 'visible', timeout: 60_000 });
}

/** A new window lands signed out or signed in, depending on what can be restored. */
async function signInIfAsked(page: Page, email: string): Promise<void> {
  const login = page.locator('#username');
  await expect(login.or(accountSwitcher(page))).toBeVisible({ timeout: 60_000 });
  if (await login.isVisible()) await signIn(page, email);
}

async function launchContext(browser: Browser, opts: Parameters<Browser['newContext']>[0] = {}): Promise<BrowserContext> {
  const context = await browser.newContext({ ...contextOptions(), ...opts });
  await context.addInitScript(catchLaunchConsumer);
  return context;
}

async function signedIn(browser: Browser, opts: Parameters<Browser['newContext']>[0] = {}): Promise<Page> {
  const page = await (await launchContext(browser, opts)).newPage();
  await neutralizeDevOverlay(page);
  await page.goto('/');
  await signIn(page, ENT.alice);
  return page;
}

/** A real form POST to the share target, as the OS's share sheet sends it. */
async function postShare(page: Page, fields: Record<string, string>, files: LaunchFile[]): Promise<void> {
  await page.evaluate(({ fields: values, files: list }) => {
    const form = document.createElement('form');
    form.method = 'POST';
    form.enctype = 'multipart/form-data';
    form.action = '/protocol/share';
    for (const [name, value] of Object.entries(values)) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value;
      form.append(input);
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.name = 'files';
    input.multiple = true;
    const data = new DataTransfer();
    for (const f of list) data.items.add(new File([f.body], f.name, { type: f.type }));
    input.files = data.files;
    form.append(input);
    document.body.append(form);
    form.submit();
  }, { fields, files });
}

async function workerReady(page: Page): Promise<void> {
  const active = await page.evaluate(() => navigator.serviceWorker.ready.then((r) => !!r.active));
  expect(active).toBe(true);
}

/** The question a share has to pass, wherever it came from. */
const startMessage = (page: Page) => page.getByRole('button', { name: 'Start message', exact: true });
const dontStart = (page: Page) => page.getByRole('button', { name: "Don't start", exact: true });

const HOSTILE = 'http://hostile.example';

/** A page on another origin that POSTs to the share target as soon as it loads. Nobody clicks. */
function hostilePage(opts: { subject: string; fileName?: string }): string {
  return `<!doctype html><title>hostile</title><body><script>
    const f = document.createElement('form');
    f.method = 'POST'; f.enctype = 'multipart/form-data'; f.action = ${JSON.stringify(`${WEBMAIL_URL}/protocol/share`)};
    const title = document.createElement('input'); title.type = 'hidden'; title.name = 'title'; title.value = ${JSON.stringify(opts.subject)}; f.append(title);
    const text = document.createElement('input'); text.type = 'hidden'; text.name = 'text'; text.value = 'body from another site'; f.append(text);
    const input = document.createElement('input'); input.type = 'file'; input.name = 'files'; input.multiple = true;
    ${opts.fileName ? `const d = new DataTransfer(); d.items.add(new File(['attacker bytes'], ${JSON.stringify(opts.fileName)})); input.files = d.files;` : ''}
    f.append(input); document.body.append(f); f.submit();
  </script>`;
}

async function hostileTab(context: BrowserContext, opts: Parameters<typeof hostilePage>[0]): Promise<Page> {
  await context.route(`${HOSTILE}/**`, (route) => route.fulfill({ contentType: 'text/html', body: hostilePage(opts) }));
  const tab = await context.newPage();
  await tab.goto(`${HOSTILE}/`);
  return tab;
}

/** Every message on the server with this subject. */
async function draftsWithSubject(subject: string): Promise<string[]> {
  const client = await jmapAs(ENT.alice);
  const res = await client.request([['Email/query', { accountId: client.accountId, filter: { subject } }, 'q']]);
  return res.methodResponses[0][1].ids as string[];
}

async function deleteDrafts(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const client = await jmapAs(ENT.alice);
  await client.request([['Email/set', { accountId: client.accountId, destroy: ids }, 'd']]);
}

const storedShareEntries = (page: Page) => page.evaluate(async (name) => {
  if (!(await caches.has(name))) return 0;
  return (await (await caches.open(name)).keys()).length;
}, SHARE_CACHE);

test.beforeAll(() => requireEntEnv());

test.describe('manifest', () => {
  test('offers shortcuts, file handlers and the share target, in the browser language', async ({ browser }) => {
    const context = await browser.newContext(contextOptions());
    const res = await context.request.get('/manifest.webmanifest', { headers: { 'Accept-Language': 'de-DE,de;q=0.9' } });
    expect(res.ok()).toBe(true);
    const manifest = await res.json();
    expect(manifest.shortcuts.map((s: { name: string; url: string }) => [s.name, s.url])).toEqual([
      ['Neue Nachricht', '/?compose=1'],
      ['Kalender', '/calendar'],
      ['Kontakte', '/contacts'],
    ]);
    expect(manifest.file_handlers.map((h: { action: string }) => h.action)).toEqual(['/mail', '/calendar', '/contacts']);
    expect(manifest.share_target).toMatchObject({ action: '/protocol/share', method: 'POST', enctype: 'multipart/form-data' });
    expect(manifest.protocol_handlers).toHaveLength(2);
    await context.close();
  });

  test('every address in it answers', async ({ browser }) => {
    const context = await browser.newContext(contextOptions());
    const manifest = await (await context.request.get('/manifest.webmanifest')).json();
    for (const shortcut of manifest.shortcuts) {
      expect((await context.request.get(shortcut.url)).ok(), shortcut.url).toBe(true);
      expect((await context.request.get(shortcut.icons[0].src)).ok(), shortcut.icons[0].src).toBe(true);
    }
    for (const handler of manifest.file_handlers) {
      expect((await context.request.get(handler.action)).ok(), handler.action).toBe(true);
    }
    await context.close();
  });
});

test.describe('share target', () => {
  test('files and a link go through the service worker into a new draft', async ({ browser }) => {
    const page = await signedIn(browser);
    await workerReady(page);

    const subject = `Shared ${RUN}`;
    await postShare(page, { title: subject, text: 'Have a look', url: 'https://example.org/page' }, [
      { name: `shared-${RUN}.txt`, type: 'text/plain', body: 'shared bytes' },
    ]);
    await page.waitForURL((url) => url.pathname.endsWith('/') || !url.pathname.includes('protocol'));
    await startMessage(page).click({ timeout: 60_000 });
    await signInIfAsked(page, ENT.alice);

    await expect(composer(page)).toBeVisible({ timeout: 30_000 });
    await expect(composer(page).getByPlaceholder(/subject/i)).toHaveValue(subject);
    await expect(composer(page).locator('[contenteditable="true"]').first()).toContainText('https://example.org/page');
    await expect(composer(page).getByText(`shared-${RUN}.txt`)).toBeVisible();
    // It reached the app through the worker's store, not the server's fallback.
    await expect(page.getByText("The shared files couldn't be kept")).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).hash).toBe('');
    await expect.poll(() => storedShareEntries(page)).toBe(0);
    await shot(page, 'pwa-launch-share');
    await page.context().close();
  });

  test('survives a sign-in that reloads the page', async ({ browser }) => {
    const page = await (await launchContext(browser)).newPage();
    await page.goto('/');
    await page.locator('#username').waitFor({ state: 'visible', timeout: 60_000 });
    await workerReady(page);

    await postShare(page, { url: 'https://example.org/waited' }, [{ name: `waited-${RUN}.txt`, type: 'text/plain', body: 'x' }]);
    await startMessage(page).click({ timeout: 60_000 });
    await page.locator('#username').waitFor({ state: 'visible', timeout: 60_000 });
    await expect.poll(() => storedShareEntries(page)).toBe(3);
    // What SSO does: away and back, in the same tab.
    await page.reload();
    await signIn(page, ENT.alice);

    await expect(composer(page)).toBeVisible({ timeout: 30_000 });
    await expect(composer(page).getByText(`waited-${RUN}.txt`)).toBeVisible();
    await expect.poll(() => storedShareEntries(page)).toBe(0);
    await page.context().close();
  });

  test('without a service worker the link still arrives and the app says the files did not', async ({ browser }) => {
    const page = await signedIn(browser, { serviceWorkers: 'block' });
    await postShare(page, { url: 'https://example.org/no-worker' }, [{ name: 'lost.txt', type: 'text/plain', body: 'x' }]);
    await page.waitForLoadState('domcontentloaded');
    await startMessage(page).click({ timeout: 60_000 });
    await signInIfAsked(page, ENT.alice);

    await expect(composer(page)).toBeVisible({ timeout: 30_000 });
    await expect(composer(page).locator('[contenteditable="true"]').first()).toContainText('https://example.org/no-worker');
    await expect(composer(page).getByText('lost.txt')).toHaveCount(0);
    await expect(page.getByText("The shared files couldn't be kept").first()).toBeVisible();
    await page.context().close();
  });

  test('the server takes the POST from outside the origin, which /api/ would refuse', async ({ browser }) => {
    const context = await browser.newContext(contextOptions());
    const res = await context.request.post('/protocol/share', {
      headers: { Origin: 'https://other.example', 'Sec-Fetch-Site': 'cross-site' },
      multipart: { url: 'https://example.org/direct' },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(303);
    const location = new URL(res.headers().location, 'http://x.invalid');
    // In the fragment: shared text stays out of access logs.
    expect(location.search).toBe('');
    const fragment = new URLSearchParams(location.hash.slice(1));
    expect(fragment.get('share')).toBe('unavailable');
    expect(fragment.get('share_url')).toBe('https://example.org/direct');
    await context.close();
  });

  test('long non-Latin text fits the address the fallback sends on', async ({ browser }) => {
    const context = await browser.newContext(contextOptions());
    const res = await context.request.post('/protocol/share', {
      multipart: { text: 'あ'.repeat(3000) },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(303);
    const location = res.headers().location;
    expect(location.length).toBeLessThan(4000);
    expect((await context.request.get(location)).ok()).toBe(true);
    await context.close();
  });
});

test.describe('a share nobody asked for', () => {
  test('a POST from another site leaves no draft on the server and asks first', async ({ browser }) => {
    const signedInPage = await signedIn(browser);
    await workerReady(signedInPage);
    const subject = `hostile-${RUN}-a`;
    const tab = await hostileTab(signedInPage.context(), { subject, fileName: `invoice-${RUN}.exe` });
    await tab.waitForURL((url) => url.href.startsWith(WEBMAIL_URL));

    // The question comes before anything else, also before a sign-in.
    await expect(startMessage(tab)).toBeVisible({ timeout: 30_000 }).catch(() => {});
    if (await startMessage(tab).isVisible()) {
      await expect(tab.getByTestId('share-confirm-details')).toContainText(`invoice-${RUN}.exe`);
    } else {
      await signInIfAsked(tab, ENT.alice);
    }
    await tab.waitForTimeout(6000);
    const drafts = await draftsWithSubject(subject);
    await deleteDrafts(drafts);
    expect(drafts).toEqual([]);
    await expect(composer(tab)).toHaveCount(0);
    await expect(startMessage(tab)).toBeVisible();
    await shot(tab, 'pwa-launch-share-confirm');

    // Refused: what it stored goes too.
    await dontStart(tab).click();
    await expect.poll(() => storedShareEntries(tab)).toBe(0);
    await expect(composer(tab)).toHaveCount(0);
    await signedInPage.context().close();
  });

  test('agreed, it is only the starting state: no draft until the first real edit', async ({ browser }) => {
    const signedInPage = await signedIn(browser);
    await workerReady(signedInPage);
    const subject = `hostile-${RUN}-b`;
    const tab = await hostileTab(signedInPage.context(), { subject, fileName: `kept-${RUN}.txt` });
    await tab.waitForURL((url) => url.href.startsWith(WEBMAIL_URL));
    await startMessage(tab).click({ timeout: 60_000 });
    await signInIfAsked(tab, ENT.alice);
    await expect(composer(tab).getByText(`kept-${RUN}.txt`)).toBeVisible({ timeout: 30_000 });
    await expect(composer(tab).getByPlaceholder(/subject/i)).toHaveValue(subject);

    await tab.waitForTimeout(6000);
    expect(await draftsWithSubject(subject)).toEqual([]);

    // Leaving doesn't save it either.
    await tab.evaluate(() => { window.dispatchEvent(new Event('beforeunload')); });
    await tab.waitForTimeout(3000);
    expect(await draftsWithSubject(subject)).toEqual([]);

    // The user's own edit: from here it is a draft like any other.
    await composer(tab).getByPlaceholder(/subject/i).fill(`${subject} edited`);
    await expect(composer(tab).getByPlaceholder(/subject/i)).toHaveValue(`${subject} edited`);
    await expect.poll(() => draftsWithSubject(subject), { timeout: 20_000 }).toHaveLength(1);
    await deleteDrafts(await draftsWithSubject(subject));
    await signedInPage.context().close();
  });

  test('a hidden frame stores nothing', async ({ browser }) => {
    const page = await (await launchContext(browser)).newPage();
    await page.goto('/');
    await page.locator('#username').waitFor({ state: 'visible', timeout: 60_000 });
    await workerReady(page);
    // From the app's own origin: another site's frame doesn't reach this worker
    // at all in Chromium (partitioned storage), so only this shows the check.
    await page.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.name = 'hidden-share';
      frame.style.display = 'none';
      document.body.append(frame);
      const form = document.createElement('form');
      form.method = 'POST';
      form.enctype = 'multipart/form-data';
      form.action = '/protocol/share';
      form.target = 'hidden-share';
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'title';
      input.value = 'frame';
      form.append(input);
      document.body.append(form);
      form.submit();
    });
    await page.waitForTimeout(3000);
    expect(await storedShareEntries(page)).toBe(0);
    await page.context().close();
  });

  test('text in an address anyone can link to asks first too', async ({ browser }) => {
    const page = await signedIn(browser);
    await page.goto(`/#share=unavailable&share_title=${encodeURIComponent(`linked-${RUN}`)}&share_text=hello`);
    await expect(startMessage(page)).toBeVisible({ timeout: 30_000 });
    await expect(composer(page)).toHaveCount(0);
    await dontStart(page).click();
    await expect(composer(page)).toHaveCount(0);
    await page.context().close();
  });
});

test.describe('a handoff while a composer is open', () => {
  test('one closed by reading a message is kept as a draft, and the next opens fresh', async ({ browser }) => {
    const page = await signedIn(browser);
    await page.locator('[data-testid="email-list-item"]').first().waitFor({ timeout: 30_000 });
    const subject = `setaside${RUN}`;
    await launch(page, { target: '/?compose=1' });
    await expect(composer(page)).toBeVisible({ timeout: 30_000 });
    await composer(page).getByPlaceholder(/subject/i).fill(subject);
    await expect(composer(page).getByPlaceholder(/subject/i)).toHaveValue(subject);
    // Reading a message runs the composer's own close, which saves before its
    // autosave would have: "Draft saved" (decisions: closing saves first; one
    // composer at a time). Nothing unsaved is left to wait for.
    await page.locator('[data-testid="email-list-item"]').first().click();
    await expect(composer(page)).toHaveCount(0);
    await expect(page.getByText('Draft saved').first()).toBeVisible({ timeout: 10_000 });
    await expect.poll(async () => (await draftsWithSubject(subject)).length, { timeout: 20_000 }).toBe(1);
    // Two new-message launches within 2 s count as one (a launch can arrive twice).
    await page.waitForTimeout(2100);
    await launch(page, { target: '/?compose=1' });
    await expect(composer(page)).toBeVisible({ timeout: 30_000 });
    await expect(composer(page).getByPlaceholder(/subject/i)).toHaveValue('');
    await expect(page.getByText('Close this message to start the next one.')).toHaveCount(0);
    // The new composer replaced nothing: the first one's draft is still there.
    expect(await draftsWithSubject(subject)).toHaveLength(1);
    await page.locator('[data-testid="composer-close"]').first().click();
    await deleteDrafts(await draftsWithSubject(subject));
    await page.context().close();
  });

  test('two at once: the second waits until the first composer closes', async ({ browser }) => {
    const page = await signedIn(browser);
    // Let the page settle after the sign-in: the composer shouldn't race the first mail load.
    await page.waitForTimeout(3000);
    await launch(page, { target: '/?compose=1' });
    await expect(composer(page)).toBeVisible({ timeout: 30_000 });
    const subject = `kept-open-${RUN}`;
    await composer(page).getByPlaceholder(/subject/i).fill(subject);
    await expect(composer(page).getByPlaceholder(/subject/i)).toHaveValue(subject);

    await page.waitForTimeout(2100);
    await launch(page, { target: '/?compose=1' });
    await expect(page.getByText('Close this message to start the next one.').first()).toBeVisible({ timeout: 10_000 });
    await expect(composer(page).getByPlaceholder(/subject/i)).toHaveValue(subject);

    await page.locator('[data-testid="composer-close"]').first().click();
    await expect(composer(page).getByPlaceholder(/subject/i)).toHaveValue('', { timeout: 15_000 });
    await deleteDrafts(await draftsWithSubject(subject));
    await page.context().close();
  });

  test('a .vcf launch saves what was just typed before leaving the composer', async ({ browser }) => {
    const page = await signedIn(browser);
    await launch(page, { target: '/?compose=1' });
    await expect(composer(page)).toBeVisible({ timeout: 30_000 });
    const subject = `typedfirst${RUN}`;
    await composer(page).getByPlaceholder(/subject/i).fill(subject);
    // Well inside the autosave's 2 seconds.
    await launch(page, { target: '/contacts', files: [VCF] });
    await page.waitForURL(/\/contacts/);
    await expect(page.getByText(`Launched Person ${RUN}`).first()).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => draftsWithSubject(subject), { timeout: 10_000 }).toHaveLength(1);
    await deleteDrafts(await draftsWithSubject(subject));
    await page.context().close();
  });
});

test.describe('file launches', () => {
  test('.eml opens in the viewer, over the page', async ({ browser }) => {
    const page = await signedIn(browser);
    const before = new URL(page.url()).pathname;
    await launch(page, { target: '/mail', files: [EML] });
    await expect(page.getByRole('heading', { name: `Launched message ${RUN}` })).toBeVisible({ timeout: 20_000 });
    expect(new URL(page.url()).pathname).toBe(before);
    await expect(page.getByRole('button', { name: 'Download', exact: true }).first()).toBeVisible();
    await shot(page, 'pwa-launch-eml');
    await page.context().close();
  });

  test('.eml opens before signing in', async ({ browser }) => {
    const page = await (await launchContext(browser)).newPage();
    await page.goto('/');
    await page.locator('#username').waitFor({ state: 'visible', timeout: 60_000 });
    await launch(page, { target: '/mail', files: [EML] });
    await expect(page.getByRole('heading', { name: `Launched message ${RUN}` })).toBeVisible({ timeout: 20_000 });
    await page.context().close();
  });

  test('.eml with downloads blocked: the viewer opens, with nothing to save', async ({ browser }) => {
    const admin = await adminContext(browser);
    const saved = await getPolicy(admin);
    const organisation = (saved.organisation ?? {}) as Record<string, unknown>;
    await putPolicy(admin, {
      ...saved,
      organisation: {
        ...organisation,
        devices: { ...((organisation.devices ?? {}) as object), noDownloads: true },
      },
    });
    try {
      const page = await signedIn(browser);
      await launch(page, { target: '/mail', files: [EML] });
      await expect(page.getByRole('heading', { name: `Launched message ${RUN}` })).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole('button', { name: 'Download', exact: true })).toHaveCount(0);
      await page.context().close();
    } finally {
      await putPolicy(admin, saved);
      await admin.close();
    }
  });

  test('.eml without a connection or the viewer chunk: a message, not the error page', async ({ browser }) => {
    const page = await signedIn(browser);
    await page.context().setOffline(true);
    await launch(page, { target: '/mail', files: [EML] });
    await expect(page.getByText("The file couldn't be opened").first()).toBeVisible({ timeout: 20_000 });
    await expect(accountSwitcher(page)).toBeVisible();

    await page.context().setOffline(false);
    await launch(page, { target: '/mail', files: [EML] });
    await expect(page.getByRole('heading', { name: `Launched message ${RUN}` })).toBeVisible({ timeout: 20_000 });
    await page.context().close();
  });

  test('.ics goes to the calendar import, which the server parses', async ({ browser }) => {
    const page = await signedIn(browser);
    await launch(page, { target: '/calendar', files: [ICS] });
    await page.waitForURL(/\/calendar/);
    await expect(page.getByText(`Launched event ${RUN}`).first()).toBeVisible({ timeout: 30_000 });
    await shot(page, 'pwa-launch-ics');
    await page.context().close();
  });

  test('.ics while offline says the server is needed, and carries on once back', async ({ browser }) => {
    const page = await signedIn(browser);
    // Into the calendar first: its code isn't on the device without offline mode.
    await launch(page, { target: '/calendar' });
    await page.waitForURL(/\/calendar/);
    await page.context().setOffline(true);
    await launch(page, { target: '/calendar', files: [ICS] });
    await expect(page.getByText('Importing a calendar file needs a connection to the server.')).toBeVisible({ timeout: 20_000 });
    await shot(page, 'pwa-launch-ics-offline');

    await page.context().setOffline(false);
    await expect(page.getByText(`Launched event ${RUN}`).first()).toBeVisible({ timeout: 30_000 });
    await page.context().close();
  });

  test('.vcf goes to the contacts import, parsed in the browser', async ({ browser }) => {
    const page = await signedIn(browser);
    await launch(page, { target: '/contacts', files: [VCF] });
    await page.waitForURL(/\/contacts/);
    await expect(page.getByText(`Launched Person ${RUN}`).first()).toBeVisible({ timeout: 30_000 });
    await shot(page, 'pwa-launch-vcf');
    await page.context().close();
  });

  test('a file launched before signing in waits for it', async ({ browser }) => {
    const page = await (await launchContext(browser)).newPage();
    await page.goto('/');
    await page.locator('#username').waitFor({ state: 'visible', timeout: 60_000 });
    await launch(page, { target: '/contacts', files: [VCF] });
    await expect(page.locator('#username')).toBeVisible();
    await signIn(page, ENT.alice);
    await page.waitForURL(/\/contacts/);
    await expect(page.getByText(`Launched Person ${RUN}`).first()).toBeVisible({ timeout: 30_000 });
    await page.context().close();
  });

  test('a file launched into a signed-in page with a reload on the way still arrives', async ({ browser }) => {
    const page = await (await launchContext(browser)).newPage();
    await page.goto('/');
    await page.locator('#username').waitFor({ state: 'visible', timeout: 60_000 });
    await launch(page, { target: '/calendar', files: [ICS] });
    await expect.poll(() => storedShareEntries(page)).toBe(3);
    await page.reload();
    await signIn(page, ENT.alice);
    await page.waitForURL(/\/calendar/);
    await expect(page.getByText(`Launched event ${RUN}`).first()).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => storedShareEntries(page)).toBe(0);
    await page.context().close();
  });
});

test.describe('shortcuts', () => {
  test('New message opens a composer from the address, once, and clears the address', async ({ browser }) => {
    const page = await (await launchContext(browser)).newPage();
    await page.goto('/?compose=1');
    await signIn(page, ENT.alice);
    await expect(composer(page)).toBeVisible({ timeout: 30_000 });
    expect(new URL(page.url()).search).toBe('');
    await page.context().close();
  });

  test('New message in an open window', async ({ browser }) => {
    const page = await signedIn(browser);
    await expect(composer(page)).toHaveCount(0);
    await launch(page, { target: '/?compose=1' });
    await expect(composer(page)).toBeVisible({ timeout: 30_000 });
    await page.context().close();
  });

  test('Calendar and Contacts in an open window', async ({ browser }) => {
    const page = await signedIn(browser);
    await launch(page, { target: '/calendar' });
    await page.waitForURL(/\/calendar/);
    await launch(page, { target: '/contacts' });
    await page.waitForURL(/\/contacts/);
    await page.context().close();
  });

  test('the plain app icon leaves an open window where it is', async ({ browser }) => {
    const page = await signedIn(browser);
    await launch(page, { target: '/calendar' });
    await page.waitForURL(/\/calendar/);
    await launch(page, { target: '/' });
    await page.waitForTimeout(1000);
    expect(new URL(page.url()).pathname).toMatch(/\/calendar(\/|$)/);
    await expect(composer(page)).toHaveCount(0);
    await page.context().close();
  });
});

test.describe('in the Pro shell', () => {
  const proOn = () => {
    const key = 'settings-storage';
    const parsed = JSON.parse(localStorage.getItem(key) ?? '{"state":{},"version":0}');
    parsed.state = { ...parsed.state, proInterface: true };
    localStorage.setItem(key, JSON.stringify(parsed));
  };

  test('a shared file reaches the composer tab, and a .ics the calendar tab', async ({ browser }) => {
    const context = await launchContext(browser);
    await context.addInitScript(proOn);
    const page = await context.newPage();
    await page.goto('/');
    await signIn(page, ENT.alice);
    // The Pro shell, by its tab bar: the address is the tab's own (/mail/…),
    // written over /pro, so a wait for /pro raced it.
    const proTabs = page.locator('[role="tablist"]', { has: page.getByRole('tab', { name: /Mail/ }) });
    await expect(proTabs.first()).toBeVisible({ timeout: 60_000 });
    await workerReady(page);

    await postShare(page, { url: 'https://example.org/pro' }, [{ name: `pro-${RUN}.txt`, type: 'text/plain', body: 'x' }]);
    await startMessage(page).click({ timeout: 60_000 });
    await signInIfAsked(page, ENT.alice);
    await expect(proTabs.first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(`pro-${RUN}.txt`).first()).toBeVisible({ timeout: 30_000 });

    await launch(page, { target: '/calendar', files: [ICS] });
    await expect(page.getByText(`Launched event ${RUN}`).first()).toBeVisible({ timeout: 30_000 });
    await shot(page, 'pwa-launch-pro');
    await context.close();
  });
});
