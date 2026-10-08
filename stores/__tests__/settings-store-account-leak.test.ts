import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());

vi.mock('@/lib/browser-navigation', () => ({ apiFetch }));

import { useSettingsStore } from '../settings-store';
import { useTemplateStore } from '../template-store';

// #1185: settings-storage is one store for the whole browser. After signing
// out of A, an account B without server settings showed A's tags, templates
// and preferences, and the next push wrote them into B's server file.

const A = { username: 'a@example.com', serverUrl: 'https://mail.example.com' };
const B = { username: 'b@example.com', serverUrl: 'https://mail.example.com' };
const SECRET_TAG = { id: 'customer-x', label: 'Customer X', color: 'red' };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Server files by username; a missing entry means "no settings yet". */
let serverFiles: Record<string, unknown> = {};
let failLoads = false;

function posted(): Array<{ username: string; settings: Record<string, unknown> }> {
  return apiFetch.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([, init]) => JSON.parse((init as RequestInit).body as string));
}

async function signIn(account: typeof A) {
  const settings = useSettingsStore.getState();
  await settings.loadFromServer(account.username, account.serverUrl).finally(() => {
    useSettingsStore.getState().enableSync(account.username, account.serverUrl);
  });
}

async function signOut() {
  await useSettingsStore.getState().flushSync();
  useSettingsStore.getState().disableSync();
  useSettingsStore.getState().forgetSyncedSettings();
}

/** Signed in as A, with a custom tag and a template that reached A's file. */
async function setUpAccountA() {
  serverFiles[A.username] = { emailKeywords: [SECRET_TAG], fontSize: 'large' };
  await signIn(A);
  useTemplateStore.getState().addTemplate({
    name: 'A only', subject: '', body: '', category: '', isFavorite: false,
  });
  await useSettingsStore.getState().flushSync();
  expect(useSettingsStore.getState().emailKeywords).toEqual([SECRET_TAG]);
}

beforeEach(async () => {
  localStorage.clear();
  serverFiles = {};
  failLoads = false;
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return json({ ok: true });
    if (failLoads) return json({ error: 'boom' }, 500);
    const username = (init?.headers as Record<string, string>)['x-settings-username'];
    return json({ settings: serverFiles[username] ?? null });
  });
  useSettingsStore.getState().disableSync();
  useSettingsStore.getState().resetToDefaults();
  useTemplateStore.setState({ templates: [], recentTemplateIds: [], deletedTemplateIds: {} });
});

describe('switching people in one browser (#1185)', () => {
  it('starts the next account from defaults after a sign-out', async () => {
    await setUpAccountA();
    await signOut();

    expect(useSettingsStore.getState().emailKeywords).not.toContainEqual(SECRET_TAG);
    expect(useTemplateStore.getState().templates).toEqual([]);

    apiFetch.mockClear();
    await signIn(B);
    useSettingsStore.getState().updateSetting('sendDelaySeconds', 10);
    await useSettingsStore.getState().flushSync();

    const pushes = posted();
    expect(pushes.map((p) => p.username)).toEqual([B.username]);
    expect(pushes[0].settings.emailKeywords).not.toContainEqual(SECRET_TAG);
    expect(pushes[0].settings.templates).toEqual([]);
    expect(pushes[0].settings.fontSize).toBe('medium');
  });

  it("drops A's state when B signs in without a sign-out in between", async () => {
    await setUpAccountA();
    useSettingsStore.getState().disableSync(); // e.g. the session expired

    apiFetch.mockClear();
    await signIn(B);
    useSettingsStore.getState().updateSetting('sendDelaySeconds', 10);
    await useSettingsStore.getState().flushSync();

    expect(useSettingsStore.getState().emailKeywords).not.toContainEqual(SECRET_TAG);
    const pushes = posted();
    expect(pushes.map((p) => p.username)).toEqual([B.username]);
    expect(pushes[0].settings.emailKeywords).not.toContainEqual(SECRET_TAG);
    expect(pushes[0].settings.templates).toEqual([]);
  });

  it("does not merge A's templates into B's server file", async () => {
    await setUpAccountA();
    useSettingsStore.getState().disableSync();
    serverFiles[B.username] = { fontSize: 'small', templates: [], deletedTemplateIds: {} };

    apiFetch.mockClear();
    await signIn(B);
    await useSettingsStore.getState().flushSync();

    expect(useTemplateStore.getState().templates).toEqual([]);
    expect(useSettingsStore.getState().emailKeywords).not.toContainEqual(SECRET_TAG);
    expect(useSettingsStore.getState().fontSize).toBe('small');
    expect(posted()).toEqual([]);
  });

  it("keeps sync off when B's settings cannot be loaded over A's", async () => {
    await setUpAccountA();
    useSettingsStore.getState().disableSync();
    failLoads = true;

    apiFetch.mockClear();
    await signIn(B);
    useSettingsStore.getState().updateSetting('sendDelaySeconds', 10);
    await useSettingsStore.getState().flushSync();

    expect(useSettingsStore.getState().emailKeywords).not.toContainEqual(SECRET_TAG);
    expect(posted()).toEqual([]);
  });

  it('lets the same account pick up where it left off', async () => {
    await setUpAccountA();
    useSettingsStore.getState().disableSync();
    failLoads = true;

    await signIn(A);
    useSettingsStore.getState().updateSetting('sendDelaySeconds', 10);
    await useSettingsStore.getState().flushSync();

    expect(useSettingsStore.getState().emailKeywords).toEqual([SECRET_TAG]);
    expect(posted().at(-1)?.username).toBe(A.username);
  });
});

describe('settings that never reached a server', () => {
  it('lets the first synced sign-in adopt the device settings', async () => {
    useSettingsStore.getState().addKeyword(SECRET_TAG);

    await signIn(A);
    expect(useSettingsStore.getState().emailKeywords).toContainEqual(SECRET_TAG);
    useSettingsStore.getState().updateSetting('sendDelaySeconds', 10);
    await useSettingsStore.getState().flushSync();
    expect(posted()[0].settings.emailKeywords).toContainEqual(SECRET_TAG);

    // From here on they live in A's file, so a sign-out may drop them.
    await signOut();
    expect(useSettingsStore.getState().emailKeywords).not.toContainEqual(SECRET_TAG);
  });

  it('keeps them on sign-out when sync was never used', () => {
    useSettingsStore.getState().addKeyword(SECRET_TAG);
    useSettingsStore.getState().forgetSyncedSettings();
    expect(useSettingsStore.getState().emailKeywords).toContainEqual(SECRET_TAG);
  });

  it('keeps them on sign-out when the user opted out of sync', async () => {
    await setUpAccountA();
    useSettingsStore.setState({ settingsSyncDisabled: true });
    await signOut();
    expect(useSettingsStore.getState().emailKeywords).toEqual([SECRET_TAG]);
  });

  it('keeps device-only settings through the reset', async () => {
    useSettingsStore.setState({ proInterface: true });
    await setUpAccountA();
    await signOut();
    expect(useSettingsStore.getState().proInterface).toBe(true);
  });
});
