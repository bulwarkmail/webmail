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

  it('uses settings:write for updating and removing definitions', async () => {
    expect(await gateError(plugin(), 'keywords.update', [[]]))
      .toMatch(/lacks permission "settings:write"/);
    expect(await gateError(plugin(), 'keywords.remove', [[]]))
      .toMatch(/lacks permission "settings:write"/);
  });

  it.each([
    ['keywords.add', [[{ id: 'fairs', label: 'Fairs', color: 'blue' }]]],
    ['keywords.update', [[{ id: 'mine', label: 'Mine too' }]]],
    ['keywords.remove', [['mine']]],
    ['keywords.reorder', [['work', 'mine']]],
  ])('makes the tag list the user\'s own with %s, so no admin default wipes it (#1612)', async (method, args) => {
    useSettingsStore.setState({
      emailKeywords: [
        { id: 'mine', label: 'Mine', color: 'green', addedBy: 'p1' },
        { id: 'work', label: 'Work', color: 'blue' },
      ],
      explicitSettings: ['density'],
    });
    const writer = plugin({ permissions: ['settings:write'], grantedPermissions: ['settings:write'] });

    await dispatchApiCall(writer, method, args);

    expect(useSettingsStore.getState().explicitSettings).toEqual(['density', 'emailKeywords']);
    useSettingsStore.setState({ explicitSettings: [] });
  });

  it('records the plugin that added a definition, whatever the input says', async () => {
    useSettingsStore.setState({ emailKeywords: [] });
    const writer = plugin({ permissions: ['settings:write'], grantedPermissions: ['settings:write'] });

    const result = await dispatchApiCall(writer, 'keywords.add', [[
      { id: 'fairs', label: 'Fairs', color: 'blue', addedBy: 'someone-else' },
    ]]) as { added: Array<{ addedBy?: string }> };

    expect(result.added[0].addedBy).toBe('p1');
    expect(useSettingsStore.getState().emailKeywords).toEqual([
      { id: 'fairs', label: 'Fairs', color: 'blue', addedBy: 'p1' },
    ]);
  });

  it('updates only the definitions the plugin added, never their id', async () => {
    useSettingsStore.setState({
      emailKeywords: [
        { id: 'fairs/vison-2026', label: 'Vison 2026', color: 'blue', visibility: 'show', addedBy: 'p1' },
        { id: 'work', label: 'My Work', color: 'purple' },
        { id: 'other', label: 'Other', color: 'green', addedBy: 'p2' },
      ],
    });
    const writer = plugin({ permissions: ['settings:write'], grantedPermissions: ['settings:write'] });

    const result = await dispatchApiCall(writer, 'keywords.update', [[
      { id: 'FAIRS/VISON-2026', label: ' Vision 2026 ', visibility: 'unread' },
      { id: 'work', label: 'Plugin Work' },
      { id: 'other', color: 'red' },
      { id: 'missing', label: 'Missing' },
    ]]);

    expect(result).toEqual({
      updated: [
        { id: 'fairs/vison-2026', label: 'Vision 2026', color: 'blue', visibility: 'unread', addedBy: 'p1' },
      ],
      skipped: ['work', 'other', 'missing'],
    });
    expect(useSettingsStore.getState().emailKeywords).toEqual([
      { id: 'fairs/vison-2026', label: 'Vision 2026', color: 'blue', visibility: 'unread', addedBy: 'p1' },
      { id: 'work', label: 'My Work', color: 'purple' },
      { id: 'other', label: 'Other', color: 'green', addedBy: 'p2' },
    ]);
  });

  it('rejects invalid updates without partially updating settings', async () => {
    const original = [
      { id: 'a', label: 'A', color: 'blue', addedBy: 'p1' },
      { id: 'b', label: 'B', color: 'green', addedBy: 'p1' },
    ];
    useSettingsStore.setState({ emailKeywords: original });
    const writer = plugin({ permissions: ['settings:write'], grantedPermissions: ['settings:write'] });

    for (const [patches, error] of [
      ['a', /must be an array/],
      [[{ id: 'a', label: 'A2' }, { id: 'b', color: 'not-a-color' }], /not in the keyword palette/],
      [[{ id: 'a', label: '  ' }], /label must be/],
      [[{ id: 'a', visibility: 'sometimes' }], /visibility is invalid/],
      [[{ id: 'a' }], /changes nothing/],
      [[{ id: 'not valid', label: 'X' }], /not a valid JMAP label id/],
    ] as const) {
      await expect(dispatchApiCall(writer, 'keywords.update', [patches])).rejects.toThrow(error);
      expect(useSettingsStore.getState().emailKeywords).toEqual(original);
    }
  });

  it('removes only the definitions the plugin added', async () => {
    useSettingsStore.setState({
      emailKeywords: [
        { id: 'fairs/laser-2025', label: 'Laser 2025', color: 'blue', addedBy: 'p1' },
        { id: 'work', label: 'My Work', color: 'purple' },
        { id: 'other', label: 'Other', color: 'green', addedBy: 'p2' },
        { id: 'fairs/vision-2026', label: 'Vision 2026', color: 'red', addedBy: 'p1' },
      ],
    });
    const writer = plugin({ permissions: ['settings:write'], grantedPermissions: ['settings:write'] });

    const result = await dispatchApiCall(writer, 'keywords.remove', [[
      'FAIRS/LASER-2025', 'work', 'other', 'missing',
    ]]);

    expect(result).toEqual({ removed: ['fairs/laser-2025'], skipped: ['work', 'other', 'missing'] });
    expect(useSettingsStore.getState().emailKeywords).toEqual([
      { id: 'work', label: 'My Work', color: 'purple' },
      { id: 'other', label: 'Other', color: 'green', addedBy: 'p2' },
      { id: 'fairs/vision-2026', label: 'Vision 2026', color: 'red', addedBy: 'p1' },
    ]);
  });

  it('rejects invalid remove ids without changing settings', async () => {
    const original = [{ id: 'a', label: 'A', color: 'blue', addedBy: 'p1' }];
    useSettingsStore.setState({ emailKeywords: original });
    const writer = plugin({ permissions: ['settings:write'], grantedPermissions: ['settings:write'] });

    for (const ids of ['a', ['a', 1], Array.from({ length: 501 }, (_, i) => `t${i}`)]) {
      await expect(dispatchApiCall(writer, 'keywords.remove', [ids])).rejects.toThrow(/ids must be an array/);
      expect(useSettingsStore.getState().emailKeywords).toEqual(original);
    }
  });

  it('leaves the settings untouched when nothing matches', async () => {
    const original = [{ id: 'work', label: 'My Work', color: 'purple' }];
    useSettingsStore.setState({ emailKeywords: original });
    const writer = plugin({ permissions: ['settings:write'], grantedPermissions: ['settings:write'] });

    await dispatchApiCall(writer, 'keywords.update', [[{ id: 'work', label: 'X' }]]);
    await dispatchApiCall(writer, 'keywords.remove', [['work']]);

    expect(useSettingsStore.getState().emailKeywords).toBe(original);
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

  // Stalwart 1.0 derives hasAttachment from these, so a plugin adding or
  // removing one would misreport the message.
  it('keeps plugins off the attachment keywords Stalwart 1.0 sets itself', async () => {
    const setKeyword = vi.fn();
    const removeKeyword = vi.fn();
    const updateEmailKeywords = vi.fn();
    useAuthStore.setState({ client: { setKeyword, removeKeyword, updateEmailKeywords } as never });
    const writer = plugin({ permissions: ['email:write'], grantedPermissions: ['email:write'] });

    for (const method of ['jmap.setKeyword', 'jmap.removeKeyword', 'email.setKeyword', 'email.removeKeyword']) {
      for (const keyword of ['$hasattachment', '$hasnoattachment', '$HasAttachment']) {
        expect(await gateError(writer, method, ['email-1', keyword])).toMatch(/is set by the server/);
      }
    }
    expect(await gateError(writer, 'jmap.setKeywords', ['email-1', { '$seen': true, '$hasattachment': true }]))
      .toMatch(/"\$hasattachment" is set by the server/);

    expect(setKeyword).not.toHaveBeenCalled();
    expect(removeKeyword).not.toHaveBeenCalled();
    expect(updateEmailKeywords).not.toHaveBeenCalled();

    // Other keywords still go through.
    await dispatchApiCall(writer, 'jmap.setKeyword', ['email-1', '$label:work']);
    expect(setKeyword).toHaveBeenCalledWith('email-1', '$label:work', undefined);
  });

  it('leaves the attachment keywords out of a plugin import', async () => {
    // Stalwart 1.0 adds the right one itself and keeps whatever else the
    // import names, so a stray `$hasattachment` would stick.
    const importRawEmail = vi.fn().mockResolvedValue('email-9');
    const getMailboxes = vi.fn().mockResolvedValue([{ id: 'mb-inbox', role: 'inbox' }]);
    useAuthStore.setState({ client: { importRawEmail, getMailboxes } as never });
    const importer = plugin({ permissions: ['email:raw-send'], grantedPermissions: ['email:raw-send'] });

    await dispatchApiCall(
      importer,
      'jmap.importRaw',
      [new Uint8Array([1, 2, 3]), ['inbox'], { keywords: { $seen: true, $hasattachment: true, $HasNoAttachment: true } }],
      { privileged: true },
    );

    expect(importRawEmail).toHaveBeenCalledWith(expect.any(Blob), { 'mb-inbox': true }, { $seen: true }, undefined);
  });

  it('hides the attachment keywords Stalwart 1.0 puts on every message from keywords.discover', async () => {
    const discoverKeywords = vi.fn().mockResolvedValue({
      keywords: { $seen: 5, $hasattachment: 2, $hasnoattachment: 3, '$label:work': 1 },
      scanned: 5,
      total: 5,
      complete: true,
    });
    useAuthStore.setState({ client: { discoverKeywords } as never });
    const reader = plugin({ permissions: ['email:read'], grantedPermissions: ['email:read'] });

    await expect(dispatchApiCall(reader, 'keywords.discover', [])).resolves.toEqual({
      keywords: { $seen: 5, '$label:work': 1 },
      scanned: 5,
      total: 5,
      complete: true,
    });
  });
});

describe('jmap.uploadBlob', () => {
  it('is open to an untrusted plugin with email:blob-write, for composer attachment sources', async () => {
    const p = plugin({ permissions: ['email:blob-write'], grantedPermissions: ['email:blob-write'] });
    expect(await gateError(p, 'jmap.uploadBlob', [new Uint8Array(1), 'a.bin', 'application/octet-stream']))
      .not.toMatch(GATE_FAILURE);
  });

  it('still needs email:blob-write', async () => {
    expect(await gateError(plugin(), 'jmap.uploadBlob', [new Uint8Array(1), 'a.bin', 'x/y']))
      .toMatch(/lacks permission "email:blob-write"/);
  });

  describe('checks what it uploads', () => {
    const uploader = () => plugin({ permissions: ['email:blob-write'], grantedPermissions: ['email:blob-write'] });
    const uploadBlob = vi.fn(async (file: File) => ({ blobId: 'b1', size: file.size, type: file.type, name: file.name }));
    let maxSizeUpload = 0;
    const session = () => useAuthStore.setState({ client: { uploadBlob, getMaxSizeUpload: () => maxSizeUpload } as never });

    afterEach(() => {
      uploadBlob.mockClear();
      maxSizeUpload = 0;
      useAuthStore.setState({ client: null });
    });

    it('refuses a missing or blank name, a bad media type and content that is not bytes', async () => {
      session();
      expect(await gateError(uploader(), 'jmap.uploadBlob', [new Uint8Array(1), '', 'text/plain'])).toMatch(/name must be 1-255 characters/);
      expect(await gateError(uploader(), 'jmap.uploadBlob', [new Uint8Array(1), '\u0000\u0001', 'text/plain'])).toMatch(/name must be 1-255 characters/);
      expect(await gateError(uploader(), 'jmap.uploadBlob', [new Uint8Array(1), 'x'.repeat(256), 'text/plain'])).toMatch(/name must be 1-255 characters/);
      expect(await gateError(uploader(), 'jmap.uploadBlob', [new Uint8Array(1), 'a.txt', 'text/plain; charset=utf-8'])).toMatch(/type is not a media type/);
      expect(await gateError(uploader(), 'jmap.uploadBlob', [new Uint8Array(1), 'a.txt', 42])).toMatch(/type must be a string/);
      expect(await gateError(uploader(), 'jmap.uploadBlob', ['hello', 'a.txt', 'text/plain'])).toMatch(/content must be a Uint8Array/);
      expect(uploadBlob).not.toHaveBeenCalled();
    });

    it('caps the size at the server limit, or 50 MB when the server names none', async () => {
      session();
      maxSizeUpload = 10;
      expect(await gateError(uploader(), 'jmap.uploadBlob', [new Uint8Array(11), 'a.bin', 'application/octet-stream'])).toMatch(/more than the 10 bytes allowed/);
      expect(await gateError(uploader(), 'jmap.uploadBlob', [new Uint8Array(10), 'a.bin', 'application/octet-stream'])).toBe('');

      maxSizeUpload = 0;
      expect(await gateError(uploader(), 'jmap.uploadBlob', [new Uint8Array(50 * 1024 * 1024 + 1), 'a.bin', 'application/octet-stream']))
        .toMatch(/more than the 52428800 bytes allowed/);
      expect(uploadBlob).toHaveBeenCalledTimes(1);
    });

    it('uploads a clean file under its name and type', async () => {
      session();
      await dispatchApiCall(uploader(), 'jmap.uploadBlob', [new Uint8Array([1, 2, 3]), 'scan\u0007.pdf', 'application/pdf']);
      const file = uploadBlob.mock.calls[0][0];
      expect(file.name).toBe('scan.pdf');
      expect(file.type).toBe('application/pdf');
      expect(file.size).toBe(3);
    });
  });
});

describe('email.setKeyword and email.removeKeyword', () => {
  const setKeyword = vi.fn(async () => {});
  const removeKeyword = vi.fn(async () => {});
  afterEach(() => {
    setKeyword.mockClear();
    removeKeyword.mockClear();
    useAuthStore.setState({ client: null });
  });

  it('check the email id and account id like jmap.setKeyword does', async () => {
    useAuthStore.setState({ client: { setKeyword, removeKeyword } as never });
    const writer = plugin({ permissions: ['email:write'], grantedPermissions: ['email:write'] });
    for (const method of ['email.setKeyword', 'email.removeKeyword']) {
      expect(await gateError(writer, method, [undefined, '$label:work'])).toMatch(/emailId is required/);
      expect(await gateError(writer, method, ['', '$label:work'])).toMatch(/emailId is required/);
      expect(await gateError(writer, method, [{ id: 'e1' }, '$label:work'])).toMatch(/emailId is required/);
      expect(await gateError(writer, method, ['e1', '$label:work', 7])).toMatch(/accountId must be a non-empty string/);
    }
    expect(setKeyword).not.toHaveBeenCalled();
    expect(removeKeyword).not.toHaveBeenCalled();

    await dispatchApiCall(writer, 'email.setKeyword', ['e1', '$label:work', 'acc-2']);
    expect(setKeyword).toHaveBeenCalledWith('e1', '$label:work', 'acc-2');
    await dispatchApiCall(writer, 'email.removeKeyword', ['e1', '$label:work']);
    expect(removeKeyword).toHaveBeenCalledWith('e1', '$label:work', undefined);
  });
});

describe('WebAuthn PRF salt', () => {
  it("uses the calling plugin's id, not the one in the arguments", async () => {
    const get = vi.fn(async () => { throw new Error('stop'); });
    Object.defineProperty(navigator, 'credentials', { value: { get }, configurable: true });
    const p = plugin({ id: 'mine', permissions: ['crypto:full'], managed: true, tier: 'privileged' });

    await dispatchApiCall(p, 'crypto.getWebAuthn', [[1, 2, 3], 'someone-else'], { privileged: true }).catch(() => {});

    const salt = (get.mock.calls[0] as unknown as [{ publicKey: { extensions: { prf: { eval: { first: Uint8Array } } } } }])[0]
      .publicKey.extensions.prf.eval.first;
    expect(new TextDecoder().decode(salt)).toBe('bulwark-plugins-v1mine');
  });
});
