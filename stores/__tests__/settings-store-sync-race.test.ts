import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeStoredSettingStamps } from '@/lib/settings-sync-stamps';

// A settings change is written to localStorage at once but pushed to the
// server two seconds later. A reload inside those two seconds lost the push,
// and the next load imported the older server copy over the local change.
// Each "page" below is a fresh module graph over the same localStorage, the
// way a reload is.

// A fresh module graph per page takes a few seconds the first time.
vi.setConfig({ testTimeout: 30_000 });

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/browser-navigation', () => ({ apiFetch }));

const USER = 'alice@example.org';
const SERVER = 'https://mail.example.org';

type Blob = Record<string, unknown>;
let serverBlob: Blob | null = null;
let offline = false;
let posts: { settings: Blob; keepalive?: boolean }[] = [];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The settings route, as far as these tests need it: same merge step. */
apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
  if (offline) throw new TypeError('Failed to fetch');
  if (!init?.method || init.method === 'GET') return json({ settings: serverBlob });
  const body = JSON.parse(init.body as string) as { settings: Blob };
  posts.push({ settings: body.settings, keepalive: init.keepalive });
  serverBlob = mergeStoredSettingStamps(serverBlob, body.settings);
  return json({ ok: true });
});

type Store = typeof import('../settings-store').useSettingsStore;
let page: Store | null = null;

/** Loads the app as a reload does: new modules, same localStorage. */
async function openPage(): Promise<Store> {
  // The old page is gone: its debounce timer never fires.
  page?.getState().disableSync();
  vi.resetModules();
  const { useSettingsStore } = await import('../settings-store');
  page = useSettingsStore;
  return useSettingsStore;
}

/** What the sign-in and boot paths do (auth-store resumeSettingsSync). */
async function signIn(store: Store) {
  await store.getState().loadFromServer(USER, SERVER);
  store.getState().enableSync(USER, SERVER);
  await store.getState().flushSync();
}

/** Another device pushing one setting at `at`. */
function otherDeviceWrites(key: string, value: unknown, at: number) {
  serverBlob = mergeStoredSettingStamps(serverBlob, {
    ...serverBlob,
    [key]: value,
    settingsModifiedAt: { ...(serverBlob?.settingsModifiedAt as Blob), [key]: at },
  });
}

beforeEach(() => {
  localStorage.clear();
  serverBlob = { sendDelaySeconds: 5, showPreview: true, explicitSettings: [] };
  offline = false;
  posts = [];
  apiFetch.mockClear();
  page = null;
});

afterEach(() => {
  page?.getState().disableSync();
  vi.useRealTimers();
});

describe('a settings change made just before a reload', () => {
  it('survives the reload and reaches the server', async () => {
    const first = await openPage();
    await signIn(first);
    first.getState().updateSetting('sendDelaySeconds', 30);
    // Reload before the debounced push went out.
    expect(posts).toHaveLength(0);

    const second = await openPage();
    await signIn(second);

    expect(second.getState().sendDelaySeconds).toBe(30);
    expect(second.getState().explicitSettings).toContain('sendDelaySeconds');
    expect(serverBlob?.sendDelaySeconds).toBe(30);
    expect(serverBlob?.explicitSettings).toContain('sendDelaySeconds');
  });

  it('is sent as the page goes away', async () => {
    const store = await openPage();
    await signIn(store);
    store.getState().updateSetting('sendDelaySeconds', 30);

    window.dispatchEvent(new Event('pagehide'));
    await vi.waitFor(() => expect(posts).toHaveLength(1));

    expect(posts[0].keepalive).toBe(true);
    expect(posts[0].settings.sendDelaySeconds).toBe(30);
    expect(serverBlob?.sendDelaySeconds).toBe(30);
  });

  it('is sent when the tab is hidden', async () => {
    const store = await openPage();
    await signIn(store);
    store.getState().updateSetting('showPreview', false);

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.waitFor(() => expect(posts).toHaveLength(1));
    } finally {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    }
    expect(serverBlob?.showPreview).toBe(false);
  });

  it('loses to a later change of the same setting on another device, and keeps the rest', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-05T10:00:00Z') });
    const first = await openPage();
    await signIn(first);
    first.getState().updateSetting('sendDelaySeconds', 30);
    first.getState().updateSetting('showPreview', false);

    // Before this device's reload, another device sets the delay too.
    otherDeviceWrites('sendDelaySeconds', 10, Date.now() + 60_000);

    const second = await openPage();
    await signIn(second);

    expect(second.getState().sendDelaySeconds).toBe(10);
    expect(second.getState().showPreview).toBe(false);
    expect(serverBlob?.sendDelaySeconds).toBe(10);
    expect(serverBlob?.showPreview).toBe(false);
  });

  it('wins over an older change of the same setting on another device', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-05T10:00:00Z') });
    const first = await openPage();
    await signIn(first);
    otherDeviceWrites('sendDelaySeconds', 10, Date.now() - 60_000);
    first.getState().updateSetting('sendDelaySeconds', 30);

    const second = await openPage();
    await signIn(second);

    expect(second.getState().sendDelaySeconds).toBe(30);
    expect(serverBlob?.sendDelaySeconds).toBe(30);
  });

  it('takes every setting it did not change from the server copy', async () => {
    const first = await openPage();
    await signIn(first);
    first.getState().updateSetting('sendDelaySeconds', 30);
    otherDeviceWrites('showPreview', false, Date.now() + 1);

    const second = await openPage();
    await signIn(second);

    expect(second.getState().showPreview).toBe(false);
    expect(second.getState().sendDelaySeconds).toBe(30);
  });
});

describe('a settings change made offline', () => {
  it('survives a reload and syncs when the connection is back', async () => {
    const first = await openPage();
    await signIn(first);

    offline = true;
    first.getState().updateSetting('sendDelaySeconds', 30);
    await first.getState().flushSync();
    expect(serverBlob?.sendDelaySeconds).toBe(5);

    const second = await openPage();
    await signIn(second);
    expect(second.getState().sendDelaySeconds).toBe(30);

    offline = false;
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(serverBlob?.sendDelaySeconds).toBe(30), { timeout: 4000 });

    // And the next load keeps it.
    const third = await openPage();
    await signIn(third);
    expect(third.getState().sendDelaySeconds).toBe(30);
  });
});

describe('a settings change in the desktop app', () => {
  afterEach(() => {
    delete (window as { bulwarkDesktop?: unknown }).bulwarkDesktop;
  });

  it('is sent before the window closes or the app quits', async () => {
    const handlers = new Set<() => Promise<unknown>>();
    (window as { bulwarkDesktop?: unknown }).bulwarkDesktop = {
      version: 1,
      lifecycle: {
        onFlushRequest: (handler: () => Promise<unknown>) => {
          handlers.add(handler);
          return () => handlers.delete(handler);
        },
      },
    };
    const store = await openPage();
    await signIn(store);
    expect(handlers.size).toBe(0);

    store.getState().updateSetting('sendDelaySeconds', 30);
    expect(handlers.size).toBe(1);

    await Promise.all([...handlers].map((handler) => handler()));
    expect(serverBlob?.sendDelaySeconds).toBe(30);
    // Nothing left to send: the next close doesn't wait.
    expect(handlers.size).toBe(0);
  });
});
