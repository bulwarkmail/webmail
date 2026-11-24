/**
 * #1327 / plugins#27: api.storage keys a plugin stores with { sync: true }
 * follow the account to its other browsers through Settings Sync.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InstalledPlugin } from '@/lib/plugin-types';

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { dispatchApiCall } from '../plugin-sandbox/host-api';
import { pluginStoragePrefix } from '../plugin-sandbox/storage-scope';
import { generateAccountId } from '../account-utils';
import { useAccountStore } from '@/stores/account-store';
import { useSettingsStore } from '@/stores/settings-store';
import '@/stores/plugin-store';

const USER = 'alice@example.com';
const SERVER = 'https://mail.example.com';
const ACCOUNT = generateAccountId(USER, SERVER);
const KEY = pluginStoragePrefix('ai-assistant', ACCOUNT);

const plugin = {
  id: 'ai-assistant', name: 'AI Assistant', version: '1.0.0', author: 'x', description: '', type: 'hook',
  entrypoint: 'index.js', permissions: [], enabled: true, status: 'running', managed: true, settings: {},
} as unknown as InstalledPlugin;

const call = (method: string, args: unknown[]) => dispatchApiCall(plugin, method, args);

function pushed(): Record<string, { at: number; v?: unknown; gone?: true }> {
  return JSON.parse(useSettingsStore.getState().exportSettings({ forSync: true })).pluginSync ?? {};
}

beforeEach(() => {
  localStorage.clear();
  useAccountStore.setState({ activeAccountId: ACCOUNT });
  useSettingsStore.getState().enableSync(USER, SERVER);
});

describe('api.storage.set with { sync: true }', () => {
  it('sends the key up with the settings, and keeps it here', async () => {
    const prefs = { useOwn: true, own: { provider: 'openai', baseUrl: 'https://api.example.com/v1', model: 'm' } };
    await call('storage.set', ['prefs', prefs, { sync: true }]);
    expect(pushed()['ai-assistant|s:prefs'].v).toEqual(prefs);
    expect(await call('storage.get', ['prefs'])).toEqual(prefs);
  });

  it('keeps a key without the option in this browser', async () => {
    await call('storage.set', ['chat:1', { turns: [] }]);
    expect(pushed()['ai-assistant|s:chat:1']).toBeUndefined();
  });

  it('keeps syncing a key once synced, also for a set without the option', async () => {
    await call('storage.set', ['prefs', { a: 1 }, { sync: true }]);
    await call('storage.set', ['prefs', { a: 2 }]);
    expect(pushed()['ai-assistant|s:prefs'].v).toEqual({ a: 2 });
  });

  it('removes a synced key on every device', async () => {
    await call('storage.set', ['prefs', { a: 1 }, { sync: true }]);
    await call('storage.remove', ['prefs']);
    expect(pushed()['ai-assistant|s:prefs'].gone).toBe(true);
  });

  it('counts a value this browser already had as the oldest change, so the account copy wins', async () => {
    localStorage.setItem(`${KEY}prefs`, JSON.stringify({ model: 'old here' }));
    await call('storage.set', ['prefs', { model: 'old here' }, { sync: true }]);
    expect(pushed()['ai-assistant|s:prefs'].at).toBe(1);
  });

  it('refuses more than 16 KB per plugin, and stores nothing then', async () => {
    await expect(call('storage.set', ['big', 'x'.repeat(17 * 1024), { sync: true }])).rejects.toThrow(/Synced plugin storage is full/);
    expect(localStorage.getItem(`${KEY}big`)).toBeNull();
  });

  it('refuses an option that is not { sync: boolean }', async () => {
    await expect(call('storage.set', ['prefs', 1, { sync: 'yes' }])).rejects.toThrow(/sync must be true or false/);
    await expect(call('storage.set', ['prefs', 1, { share: true }])).rejects.toThrow(/unknown property "share"/);
  });
});

describe('a synced key from another browser', () => {
  const pull = (pluginSync: unknown) =>
    useSettingsStore.getState().importSettings(JSON.stringify({ pluginSync }), { serverAccountId: ACCOUNT });

  it('is there for the plugin here', async () => {
    pull({ 'ai-assistant|s:prefs': { at: 5, v: { useOwn: true } } });
    expect(await call('storage.get', ['prefs'])).toEqual({ useOwn: true });
  });

  it('removed there is removed here', async () => {
    await call('storage.set', ['prefs', { a: 1 }, { sync: true }]);
    pull({ 'ai-assistant|s:prefs': { at: Date.now() + 1000, gone: true } });
    expect(await call('storage.get', ['prefs'])).toBeNull();
  });

  it("doesn't replace a newer value set here", async () => {
    await call('storage.set', ['prefs', { a: 'here' }, { sync: true }]);
    pull({ 'ai-assistant|s:prefs': { at: 5, v: { a: 'there' } } });
    expect(await call('storage.get', ['prefs'])).toEqual({ a: 'here' });
  });
});
