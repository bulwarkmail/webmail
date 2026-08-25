import { afterEach, describe, it, expect, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { DEFAULT_KEYWORDS, useSettingsStore } from '@/stores/settings-store';

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

// host-api pulls in the whole store layer; nothing asserted here reaches a
// store, but the module graph has to resolve.
import { dispatchApiCall } from '../plugin-sandbox/host-api';

function plugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    id: 'p1',
    name: 'Test plugin',
    version: '1.0.0',
    author: 'test',
    description: '',
    type: 'hook',
    permissions: [],
    entrypoint: 'index.js',
    enabled: true,
    status: 'running',
    settings: {},
    ...overrides,
  };
}

/**
 * Message of the rejection, or '' when the call got through. The gates are
 * what's under test; what happens afterwards needs an IndexedDB and a JMAP
 * session, so "did not fail at a gate" is the useful assertion for the
 * allowed cases.
 */
async function gateError(...args: Parameters<typeof dispatchApiCall>): Promise<string> {
  try {
    await dispatchApiCall(...args);
    return '';
  } catch (err) {
    return (err as Error).message;
  }
}

const GATE_FAILURE = /lacks permission|requires the privileged plugin tier|Unknown API method/;

/**
 * The staged-attachment API is the one place an untrusted plugin can touch the
 * bytes of a file the user is sending, so the read/write asymmetry is worth
 * pinning down: reading back a file it was just handed the id of is a normal
 * permission, replacing that file is privileged-tier only.
 */
describe('upfiles tier + permission gates', () => {
  it('refuses upfiles.get without email:blob-read', async () => {
    expect(await gateError(plugin(), 'upfiles.get', ['some-id']))
      .toMatch(/lacks permission "email:blob-read"/);
  });

  it('refuses upfiles.get when the permission is declared but not granted', async () => {
    const p = plugin({ permissions: ['email:blob-read'], grantedPermissions: [] });
    expect(await gateError(p, 'upfiles.get', ['some-id']))
      .toMatch(/lacks permission "email:blob-read"/);
  });

  it('allows upfiles.get for an untrusted plugin granted email:blob-read', async () => {
    const p = plugin({ permissions: ['email:blob-read'], grantedPermissions: ['email:blob-read'] });
    expect(await gateError(p, 'upfiles.get', ['some-id'])).not.toMatch(GATE_FAILURE);
  });

  it('refuses upfiles.save from an untrusted plugin even with email:blob-write', async () => {
    const p = plugin({ permissions: ['email:blob-write'], grantedPermissions: ['email:blob-write'] });
    expect(await gateError(p, 'upfiles.save', ['old-id', new File(['x'], 'x.txt')]))
      .toMatch(/requires the privileged plugin tier/);
  });

  it('lets a privileged plugin call upfiles.save', async () => {
    const p = plugin({ permissions: ['email:blob-write'], grantedPermissions: ['email:blob-write'] });
    const err = await gateError(p, 'upfiles.save', ['old-id', new File(['x'], 'x.txt')], { privileged: true });
    expect(err).not.toMatch(GATE_FAILURE);
  });

  it('keeps stored message blobs privileged-only', async () => {
    const p = plugin({ permissions: ['email:blob-read'], grantedPermissions: ['email:blob-read'] });
    expect(await gateError(p, 'jmap.fetchBlob', ['blob-1']))
      .toMatch(/requires the privileged plugin tier/);
  });
});

describe('method-name typos', () => {
  // Guards the class of bug this suite was added for: an entry in the
  // privileged set naming a method the dispatcher never sees, which gates
  // nothing while looking like it does.
  it('rejects a method with no entry in the permission map', async () => {
    expect(await gateError(plugin(), 'upfiles.set', ['x'])).toMatch(/Unknown API method/);
  });
});

describe('native keyword extension API', () => {
  afterEach(() => {
    useAuthStore.setState({ client: null });
    useSettingsStore.setState({ emailKeywords: [...DEFAULT_KEYWORDS] });
    useEmailStore.setState({ tagCounts: {} });
  });

  it('uses the existing settings permissions for definition reads and writes', async () => {
    expect(await gateError(plugin(), 'keywords.list', []))
      .toMatch(/lacks permission "settings:read"/);
    expect(await gateError(plugin(), 'keywords.add', [[]]))
      .toMatch(/lacks permission "settings:write"/);
    expect(await gateError(plugin(), 'keywords.reorder', [[]]))
      .toMatch(/lacks permission "settings:write"/);

    const reader = plugin({ permissions: ['settings:read'], grantedPermissions: ['settings:read'] });
    expect(await dispatchApiCall(reader, 'keywords.list', []))
      .toEqual(useSettingsStore.getState().emailKeywords);
  });

  it('only appends missing definitions and preserves existing user metadata', async () => {
    useSettingsStore.setState({
      emailKeywords: [{ id: 'work', label: 'My Work', color: 'purple', visibility: 'hide' }],
    });
    const writer = plugin({ permissions: ['settings:write'], grantedPermissions: ['settings:write'] });

    const result = await dispatchApiCall(writer, 'keywords.add', [[
      { id: 'WORK', label: 'Plugin Work', color: 'red' },
      { id: 'gmail~shopping', label: 'Shopping', visibility: 'unread' },
    ]]) as { added: Array<{ id: string }>; skipped: string[] };

    expect(result.added.map((keyword) => keyword.id)).toEqual(['gmail~shopping']);
    expect(result.skipped).toEqual(['WORK']);
    expect(useSettingsStore.getState().emailKeywords).toEqual([
      { id: 'work', label: 'My Work', color: 'purple', visibility: 'hide' },
      expect.objectContaining({
        id: 'gmail~shopping',
        label: 'Shopping',
        visibility: 'unread',
        color: expect.any(String),
      }),
    ]);
  });

  it('rejects invalid definitions without partially updating settings', async () => {
    useSettingsStore.setState({ emailKeywords: [...DEFAULT_KEYWORDS] });
    const before = useSettingsStore.getState().emailKeywords;
    const writer = plugin({ permissions: ['settings:write'], grantedPermissions: ['settings:write'] });

    await expect(dispatchApiCall(writer, 'keywords.add', [[
      { id: 'valid', label: 'Valid', color: 'blue' },
      { id: 'invalid label', label: 'Invalid', color: 'blue' },
    ]])).rejects.toThrow(/not a valid JMAP label id/);

    expect(useSettingsStore.getState().emailKeywords).toEqual(before);
  });

  it('reorders complete label sets without changing user metadata', async () => {
    useSettingsStore.setState({
      emailKeywords: [
        { id: 'work', label: 'My Work', color: 'purple', visibility: 'hide' },
        { id: 'shopping', label: 'Shopping', color: 'green', visibility: 'unread' },
        { id: 'travel', label: 'Travel', color: 'blue' },
      ],
    });
    const writer = plugin({ permissions: ['settings:write'], grantedPermissions: ['settings:write'] });
    const setState = vi.spyOn(useSettingsStore, 'setState');

    const result = await dispatchApiCall(writer, 'keywords.reorder', [[
      'TRAVEL', 'work', 'shopping',
    ]]);

    expect(result).toEqual([
      { id: 'travel', label: 'Travel', color: 'blue' },
      { id: 'work', label: 'My Work', color: 'purple', visibility: 'hide' },
      { id: 'shopping', label: 'Shopping', color: 'green', visibility: 'unread' },
    ]);
    expect(useSettingsStore.getState().emailKeywords).toEqual(result);
    expect(setState).toHaveBeenCalledWith(expect.any(Function));
    setState.mockRestore();
  });

  it('supports optional case-sensitive label id matching', async () => {
    const original = [
      { id: 'Work', label: 'Work', color: 'purple' },
      { id: 'shopping', label: 'Shopping', color: 'green' },
    ];
    useSettingsStore.setState({ emailKeywords: original });
    const writer = plugin({ permissions: ['settings:write'], grantedPermissions: ['settings:write'] });

    await expect(dispatchApiCall(writer, 'keywords.reorder', [
      ['SHOPPING', 'work'],
      { caseSensitive: true },
    ])).rejects.toThrow(/unknown label id/);
    expect(useSettingsStore.getState().emailKeywords).toEqual(original);

    await expect(dispatchApiCall(writer, 'keywords.reorder', [
      ['shopping', 'Work'],
      { caseSensitive: true },
    ])).resolves.toEqual([original[1], original[0]]);
  });

  it('rejects invalid reorder options without changing settings', async () => {
    const original = [{ id: 'work', label: 'Work', color: 'purple' }];
    useSettingsStore.setState({ emailKeywords: original });
    const writer = plugin({ permissions: ['settings:write'], grantedPermissions: ['settings:write'] });

    for (const options of [true, { caseSensitive: 'yes' }, { unknown: true }]) {
      await expect(dispatchApiCall(writer, 'keywords.reorder', [
        ['work'], options,
      ])).rejects.toThrow(/options/);
      expect(useSettingsStore.getState().emailKeywords).toEqual(original);
    }
  });

  it('rejects incomplete, duplicate, and unknown reorder ids atomically', async () => {
    const original = [
      { id: 'work', label: 'Work', color: 'purple' },
      { id: 'shopping', label: 'Shopping', color: 'green' },
    ];
    useSettingsStore.setState({ emailKeywords: original });
    const writer = plugin({ permissions: ['settings:write'], grantedPermissions: ['settings:write'] });

    for (const ids of [
      ['work'],
      ['work', 'WORK'],
      ['work', 'missing'],
    ]) {
      await expect(dispatchApiCall(writer, 'keywords.reorder', [ids])).rejects.toThrow(
        /every existing label|duplicate label id|unknown label id/,
      );
      expect(useSettingsStore.getState().emailKeywords).toEqual(original);
    }
  });

  it('gates discovery and counts as email metadata', async () => {
    for (const method of ['jmap.getKeywords', 'keywords.discover', 'keywords.getCounts', 'keywords.refreshCounts']) {
      expect(await gateError(plugin(), method, [])).toMatch(/lacks permission "email:read"/);
    }

    useEmailStore.setState({ tagCounts: { shopping: { total: 9, unread: 2 } } });
    const reader = plugin({ permissions: ['email:read'], grantedPermissions: ['email:read'] });
    expect(await dispatchApiCall(reader, 'keywords.getCounts', [['shopping']]))
      .toEqual({ shopping: { total: 9, unread: 2 } });
  });

  it('keeps jmap.getKeywords available to untrusted plugins with email:read', async () => {
    const reader = plugin({ permissions: ['email:read'], grantedPermissions: ['email:read'] });
    const error = await gateError(reader, 'jmap.getKeywords', []);

    expect(error).not.toMatch(GATE_FAILURE);
    expect(error).toMatch(/No active session/);
  });

  it('routes jmap.getKeywords through the client implementation', async () => {
    const result = {
      keywords: { '$label:work': 2 },
      labels: [{
        id: '$label:work', name: 'Work', color: null, total: 2, unread: 1,
        isProviderLabel: true, source: 'provider' as const,
      }],
      scanned: 8,
      total: 8,
      complete: true,
    };
    const getKeywords = vi.fn().mockResolvedValue(result);
    const discoverKeywords = vi.fn();
    useAuthStore.setState({ client: { getKeywords, discoverKeywords } as never });
    const reader = plugin({ permissions: ['email:read'], grantedPermissions: ['email:read'] });

    await expect(dispatchApiCall(reader, 'jmap.getKeywords', [{ limit: 100 }])).resolves.toEqual(result);
    expect(getKeywords).toHaveBeenCalledWith({ limit: 100 });
    expect(discoverKeywords).not.toHaveBeenCalled();
  });

  it('gates jmap.setKeywords with email:write and validates complete maps', async () => {
    expect(await gateError(plugin(), 'jmap.setKeywords', ['email-1', { '$seen': true }]))
      .toMatch(/lacks permission "email:write"/);

    const writer = plugin({ permissions: ['email:write'], grantedPermissions: ['email:write'] });
    expect(await gateError(writer, 'jmap.setKeywords', ['email-1', { '$seen': false }]))
      .toMatch(/must be true; omit it to remove it/);
    expect(await gateError(writer, 'jmap.setKeywords', ['email-1', { 'invalid keyword': true }]))
      .toMatch(/Invalid JMAP keyword/);

    const error = await gateError(writer, 'jmap.setKeywords', ['email-1', { '$seen': true }]);
    expect(error).not.toMatch(GATE_FAILURE);
    expect(error).toMatch(/No active session/);
  });

  it('exposes incremental JMAP keyword aliases with email:write', async () => {
    for (const method of ['jmap.setKeyword', 'jmap.removeKeyword']) {
      expect(await gateError(plugin(), method, ['email-1', '$label:work']))
        .toMatch(/lacks permission "email:write"/);
    }

    const writer = plugin({ permissions: ['email:write'], grantedPermissions: ['email:write'] });
    for (const method of ['jmap.setKeyword', 'jmap.removeKeyword']) {
      expect(await gateError(writer, method, ['', '$label:work']))
        .toMatch(/emailId is required/);
      expect(await gateError(writer, method, ['email-1', 'invalid keyword']))
        .toMatch(/Invalid JMAP keyword/);
      const error = await gateError(writer, method, ['email-1', '$label:work']);
      expect(error).not.toMatch(GATE_FAILURE);
      expect(error).toMatch(/No active session/);
    }
  });
});
