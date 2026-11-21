import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { metadataValueBytes } from '@/lib/jmap/bulwark-metadata';
import { mergeStoredSettingStamps } from '@/lib/settings-sync-stamps';
import { shardKey, shardOf } from '@/lib/settings-metadata-sync';

// The webmail and the mobile app keep the settings they share in the
// account's private Inbox metadata (lib/settings-metadata-sync). Here the
// account is a fake that follows Stalwart's rules: 8 KB a namespace, 16 KB
// in all, one member set only inside an entry that exists, all or nothing.

vi.setConfig({ testTimeout: 30_000 });

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/browser-navigation', () => ({ apiFetch }));

const USER = 'alice@example.org';
const SERVER = 'https://mail.example.org';
const ACCOUNT = 'a1';

/** The account's private Bulwark entries, by key without the `org.bulwarkmail.` prefix. */
let entries: Record<string, unknown>;
let mailboxState = 0;
let supportsPrivate = true;
let reads = 0;
let writes: Array<Record<string, unknown>> = [];
/** Entries the fake refuses as a server rule it doesn't model would. */
const refuseKeys = new Set<string>();

function applyChanges(changes: Array<{ key: string; member?: string; value: unknown }>) {
  const next = structuredClone(entries);
  for (const { key, member, value } of changes) {
    if (refuseKeys.has(key)) throw new m.errors.MetadataRefusedError('forbidden', 'Not today.');
    if (member === undefined) {
      if (value === null) delete next[key];
      else next[key] = structuredClone(value);
      continue;
    }
    const entry = next[key] as Record<string, unknown> | undefined;
    if (!entry) throw new m.errors.MetadataPatchError('invalidPatch');
    if (value === null) delete entry[member];
    else entry[member] = structuredClone(value);
  }
  for (const value of Object.values(next)) {
    if (metadataValueBytes(value) > 8192) throw new m.errors.MetadataTooLargeError('Value exceeds the maximum size');
  }
  if (metadataValueBytes(next) > 16384) throw new m.errors.MetadataTooLargeError('Metadata exceeds the maximum size');
  entries = next;
  mailboxState++;
}

const client = {
  getAccountId: () => ACCOUNT,
  advertisesPrivateBulwarkMetadata: () => supportsPrivate,
  getBulwarkMetadata: vi.fn(async (_id: string, options?: { private?: boolean }) => {
    expect(options?.private).toBe(true);
    reads++;
    return structuredClone(entries);
  }),
  updateBulwarkMetadata: vi.fn(async (_id: string, changes: Array<{ key: string; member?: string; value: unknown }>, options?: { private?: boolean }) => {
    expect(options?.private).toBe(true);
    writes.push(...changes.map((change) => ({ ...change })));
    applyChanges(changes);
    return { newState: `s${mailboxState}` };
  }),
};

vi.mock('../auth-store', async () => {
  const { create } = await import('zustand');
  return { useAuthStore: create(() => ({ client, username: USER, serverUrl: SERVER })) };
});
vi.mock('../account-store', async () => {
  const { create } = await import('zustand');
  return { useAccountStore: create(() => ({ accounts: [{ id: 'acc-1' }] })) };
});

type Blob = Record<string, unknown>;
let serverBlob: Blob | null;
let posts: Blob[] = [];
function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
  if (!init?.method || init.method === 'GET') return json({ settings: serverBlob });
  const body = JSON.parse(init.body as string) as { settings: Blob };
  posts.push(body.settings);
  serverBlob = mergeStoredSettingStamps(serverBlob, body.settings);
  return json({ ok: true });
});

type Modules = {
  settings: typeof import('../settings-store');
  sync: typeof import('../settings-metadata-sync');
  theme: typeof import('../theme-store');
  policy: typeof import('../policy-store');
  /** The error classes the sync module checks against: the same module graph. */
  errors: typeof import('@/lib/jmap/bulwark-metadata');
};

async function load(): Promise<Modules> {
  vi.resetModules();
  const settings = await import('../settings-store');
  const sync = await import('../settings-metadata-sync');
  const theme = await import('../theme-store');
  const policy = await import('../policy-store');
  const errors = await import('@/lib/jmap/bulwark-metadata');
  sync.startSettingsMetadataSync();
  policy.usePolicyStore.setState({ loaded: true });
  return { settings, sync, theme, policy, errors };
}

let m: Modules;

/** Sign-in as auth-store does it, then one metadata round. */
async function signIn() {
  await m.settings.useSettingsStore.getState().loadFromServer(USER, SERVER);
  m.settings.useSettingsStore.getState().enableSync(USER, SERVER);
  await round();
}

async function round() {
  await m.sync.runSettingsMetadataRoundForTests();
}

const shard = (name: string) => (entries[shardKey(shardOf(name))] ?? {}) as Record<string, { v?: unknown; at: number }>;
const stamps = () => JSON.parse(localStorage.getItem('settings-sync-stamps') ?? '{}') as { stamps?: Record<string, number>; dirty?: Record<string, number> };

beforeEach(async () => {
  localStorage.clear();
  entries = {};
  mailboxState = 0;
  supportsPrivate = true;
  reads = 0;
  writes = [];
  refuseKeys.clear();
  serverBlob = { explicitSettings: [] };
  posts = [];
  client.getBulwarkMetadata.mockClear();
  client.updateBulwarkMetadata.mockClear();
  m = await load();
});

afterEach(() => {
  m.settings.useSettingsStore.getState().disableSync();
  m.sync.resetSettingsMetadataSyncForTests();
  vi.useRealTimers();
});

describe('settings in the account metadata', () => {
  it('takes a newer setting from the app, as chosen, and sends it to /api/settings with its stamp', async () => {
    const at = Date.now() + 60_000;
    entries[shardKey(shardOf('showPreview'))] = { showPreview: { v: false, at } };
    await signIn();

    const state = m.settings.useSettingsStore.getState();
    expect(state.showPreview).toBe(false);
    expect(state.explicitSettings).toContain('showPreview');
    expect(stamps().stamps?.showPreview).toBe(at);

    await state.flushSync();
    expect(serverBlob?.showPreview).toBe(false);
    expect((serverBlob?.settingsModifiedAt as Record<string, number>).showPreview).toBe(at);
    // Taken, not changed here: nothing goes back to the account.
    expect(writes.filter((w) => w.member === 'showPreview' || (w.value as Blob)?.showPreview)).toEqual([]);
  });

  it('keeps a setting taken from the app over an older /api/settings copy after a reload', async () => {
    serverBlob = { showPreview: true, explicitSettings: ['showPreview'], settingsModifiedAt: { showPreview: 1000 } };
    entries[shardKey(shardOf('showPreview'))] = { showPreview: { v: false, at: 5000 } };
    await signIn();
    expect(m.settings.useSettingsStore.getState().showPreview).toBe(false);

    // The page goes away before its push to /api/settings.
    m.settings.useSettingsStore.getState().disableSync();
    m.sync.resetSettingsMetadataSyncForTests();
    m = await load();
    await m.settings.useSettingsStore.getState().loadFromServer(USER, SERVER);
    expect(m.settings.useSettingsStore.getState().showPreview).toBe(false);
  });

  it('sends a change made here as one member, leaving the app’s other members of the shard alone', async () => {
    // firstDayOfWeek and showPreview share shard 0.
    entries[shardKey(0)] = { firstDayOfWeek: { v: 0, at: 1000 } };
    await signIn();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    m.settings.useSettingsStore.getState().updateSetting('showPreview', false);
    await vi.advanceTimersByTimeAsync(2500);
    await round();

    const at = stamps().stamps?.showPreview;
    expect(at).toBeGreaterThan(0);
    expect(shard('showPreview')).toEqual({ firstDayOfWeek: { v: 0, at: 1000 }, showPreview: { v: false, at } });
    expect(writes).toContainEqual({ key: shardKey(0), member: 'showPreview', value: { v: false, at } });
  });

  it('keeps a change made here that is newer than the account’s', async () => {
    entries[shardKey(shardOf('showPreview'))] = { showPreview: { v: true, at: 1000 } };
    m.settings.useSettingsStore.getState().updateSetting('showPreview', false);
    await signIn();

    expect(m.settings.useSettingsStore.getState().showPreview).toBe(false);
    expect(shard('showPreview').showPreview.v).toBe(false);
  });

  it('puts a setting back to its default when the app did so later', async () => {
    m.settings.useSettingsStore.getState().updateSetting('confirmDelete', true);
    const at = Date.now() + 60_000;
    entries[shardKey(shardOf('confirmDelete'))] = { confirmDelete: { at } };
    await signIn();

    const state = m.settings.useSettingsStore.getState();
    expect(state.confirmDelete).toBe(false);
    expect(state.explicitSettings).not.toContain('confirmDelete');
  });

  it('sends a reset here without a value, also when the value was already the default', async () => {
    await signIn();
    const store = m.settings.useSettingsStore;
    store.getState().updateSetting('showPreview', true);
    await round();
    expect(shard('showPreview').showPreview).toHaveProperty('v', true);

    store.getState().resetSettings(['showPreview']);
    await round();
    expect(shard('showPreview').showPreview).not.toHaveProperty('v');
  });

  it('neither takes nor overwrites a value this build does not know', async () => {
    const at = Date.now() + 60_000;
    entries[shardKey(shardOf('sendDelaySeconds'))] = { sendDelaySeconds: { v: 7, at } };
    entries[shardKey(shardOf('dateFormat'))] = { dateFormat: { v: 'stardate', at } };
    await signIn();

    expect(m.settings.useSettingsStore.getState().sendDelaySeconds).not.toBe(7);
    expect(m.settings.useSettingsStore.getState().dateFormat).not.toBe('stardate');
    expect(shard('sendDelaySeconds').sendDelaySeconds.v).toBe(7);
    expect(shard('dateFormat').dateFormat.v).toBe('stardate');
  });

  it('leaves a setting the admin locks alone both ways', async () => {
    m.policy.usePolicyStore.setState((s) => ({ policy: { ...s.policy, restrictions: { showPreview: { locked: true } } } }));
    m.settings.useSettingsStore.getState().updateSetting('showPreview', false);
    entries[shardKey(shardOf('showPreview'))] = { showPreview: { v: true, at: 1000 } };
    await signIn();

    expect(shard('showPreview').showPreview).toEqual({ v: true, at: 1000 });
  });

  it('syncs the colour mode through the theme store', async () => {
    entries[shardKey(shardOf('theme'))] = { theme: { v: 'dark', at: Date.now() + 60_000 } };
    await signIn();
    expect(m.theme.useThemeStore.getState().theme).toBe('dark');
    expect(m.theme.useThemeStore.getState().themeChosen).toBe(true);
  });

  it('writes lists to an entry of their own', async () => {
    await signIn();
    m.settings.useSettingsStore.getState().updateSetting('attachmentReminderKeywords', ['invoice']);
    await round();
    expect(entries['settings.value.attachment-reminder-keywords']).toMatchObject({ k: 'attachmentReminderKeywords', v: ['invoice'] });
  });

  it('refuses sidebar apps whose link is not http(s)', async () => {
    entries['settings.value.sidebar-apps'] = {
      k: 'sidebarApps', at: Date.now() + 60_000,
      v: [{ id: 'x', name: 'X', url: 'javascript:alert(1)', icon: 'Globe', openMode: 'inline', showOnMobile: true }],
    };
    await signIn();
    expect(m.settings.useSettingsStore.getState().sidebarApps).toEqual([]);
  });

  it('offers back a value chosen here before stamps that the account replaced', async () => {
    m.settings.useSettingsStore.setState({ showPreview: false, explicitSettings: ['showPreview'] });
    localStorage.removeItem('settings-sync-stamps');
    entries[shardKey(shardOf('showPreview'))] = { showPreview: { v: true, at: 1000 } };
    await signIn();

    expect(m.settings.useSettingsStore.getState().showPreview).toBe(true);
    expect(m.sync.useSettingsMetadataSyncStore.getState().replaced).toEqual({ showPreview: false });

    m.sync.useSettingsMetadataSyncStore.getState().keepReplaced();
    await round();
    expect(m.settings.useSettingsStore.getState().showPreview).toBe(false);
    expect(shard('showPreview').showPreview.v).toBe(false);
  });

  it('asks nothing of a server without private metadata', async () => {
    supportsPrivate = false;
    await signIn();
    expect(reads).toBe(0);
    expect(m.sync.useSettingsMetadataSyncStore.getState().status).toBe('unsupported');
  });

  it('stays off while the user switched settings sync off', async () => {
    m.settings.useSettingsStore.setState({ settingsSyncDisabled: true });
    await signIn();
    expect(reads).toBe(0);
  });

  it('stays off without settings sync on the instance', async () => {
    await m.settings.useSettingsStore.getState().loadFromServer(USER, SERVER);
    await round();
    expect(reads).toBe(0);
  });

  it('stamps a change made here after an account value it saw but could not use', async () => {
    const ahead = Date.now() + 3_600_000;
    entries[shardKey(shardOf('dateFormat'))] = { dateFormat: { v: 'stardate', at: ahead } };
    await signIn();
    m.settings.useSettingsStore.getState().updateSetting('dateFormat', 'full');
    await round();
    const sent = shard('dateFormat').dateFormat;
    expect(sent.v).toBe('full');
    expect(sent.at).toBeGreaterThan(ahead);
  });

  it('does not stamp settings the admin pins when everything is reset', async () => {
    m.policy.usePolicyStore.setState((s) => ({ policy: { ...s.policy, restrictions: { showPreview: { locked: true, value: false } } } }));
    m.settings.useSettingsStore.setState({ showPreview: false });
    m.settings.useSettingsStore.getState().resetToDefaults();
    expect(stamps().stamps?.showPreview).toBeUndefined();
  });

  it('waits for the full admin policy before the first round', async () => {
    m.policy.usePolicyStore.setState({ partial: true });
    await signIn();
    expect(reads).toBe(0);
    m.policy.usePolicyStore.setState({ partial: false });
    await round();
    expect(reads).toBe(1);
  });

  it('keeps room for the plain settings: lists together take at most 12 KB', async () => {
    await signIn();
    const words = Array.from({ length: 140 }, (_, i) => `${'k'.repeat(30)}${i}`);
    m.settings.useSettingsStore.getState().updateSetting('attachmentReminderKeywords', words);
    const apps = Array.from({ length: 60 }, (_, i) => ({
      id: `app-${i}`, name: `App ${i}`, url: `https://app-${i}.example.org/start/page`, icon: 'Globe', openMode: 'tab' as const, showOnMobile: true,
    }));
    m.settings.useSettingsStore.getState().updateSetting('sidebarApps', apps);
    await round();
    // Both would fit the 16 KB, but not the 12 KB lists may take.
    expect(metadataValueBytes(apps)).toBeLessThan(8000);
    expect(metadataValueBytes(apps) + metadataValueBytes(words)).toBeLessThan(15_000);
    expect(metadataValueBytes(apps) + metadataValueBytes(words)).toBeGreaterThan(12_300);
    expect(entries['settings.value.attachment-reminder-keywords']).toBeDefined();
    expect(entries['settings.value.sidebar-apps']).toBeUndefined();
  });

  it('keeps a list the server refuses for another reason here and syncs the rest', async () => {
    await signIn();
    refuseKeys.add('settings.value.attachment-reminder-keywords');
    m.settings.useSettingsStore.getState().updateSetting('attachmentReminderKeywords', ['invoice']);
    m.settings.useSettingsStore.getState().updateSetting('showPreview', false);
    await round();
    expect(shard('showPreview').showPreview.v).toBe(false);
    expect(m.sync.useSettingsMetadataSyncStore.getState().status).toBe('synced');
  });

  it('keeps a list too long for the account here and sends the rest', async () => {
    await signIn();
    const words = Array.from({ length: 50 }, (_, i) => `${'w'.repeat(30)}${i}`);
    const many = Array.from({ length: 6 }, () => words).flat().map((w, i) => `${w}-${i}`);
    m.settings.useSettingsStore.getState().updateSetting('attachmentReminderKeywords', many);
    m.settings.useSettingsStore.getState().updateSetting('showPreview', false);
    await round();
    expect(entries['settings.value.attachment-reminder-keywords']).toBeUndefined();
    expect(shard('showPreview').showPreview.v).toBe(false);
    expect(m.sync.useSettingsMetadataSyncStore.getState().status).toBe('synced');
  });
});

describe('local stamps', () => {
  it('stamps a change later than a stamp from a clock that runs ahead', async () => {
    const ahead = Date.now() + 3_600_000;
    localStorage.setItem('settings-sync-stamps', JSON.stringify({ stamps: { showPreview: ahead }, dirty: {} }));
    m.settings.useSettingsStore.getState().updateSetting('showPreview', false);
    expect(stamps().stamps?.showPreview).toBeGreaterThan(ahead);
  });
});
