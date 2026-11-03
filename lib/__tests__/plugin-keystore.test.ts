/**
 * api.keystore: the desktop app's OS certificate store, for a privileged plugin. The
 * refusals are what matters here: an untrusted plugin never reaches the bridge, the
 * flag only says yes when the call would work, and a call waiting on the OS's PIN
 * prompt is not a hung hook.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';
import { clearAllHooks, pluginErrorTracker, renderHooks, setHookDialogGate } from '../plugin-hooks';
import { checkPluginManifest } from '../extension-package';
import { dispatchApiCall, PERM_PER_METHOD } from '../plugin-sandbox/host-api';
import { hasDialogFor, holdForUser, whenNoDialogFor } from '../plugin-sandbox/host-dialog';
import { snapshotHostFeatures } from '../plugin-sandbox/host-features';
import { keystoreFeature } from '../plugin-sandbox/host-api-keystore';
import { HIGH_RISK_PERMISSIONS } from '../plugin-sandbox/permission-text';

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

function plugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    id: 'smime',
    name: 'S/MIME',
    version: '1.0.0',
    author: 'test',
    description: '',
    type: 'hook',
    tier: 'privileged',
    managed: true,
    permissions: ['crypto:full', 'keystore'],
    entrypoint: 'index.js',
    enabled: true,
    status: 'running',
    settings: {},
    ...overrides,
  };
}

const DIGEST = new Uint8Array(32).fill(7);
const SIGN = { scheme: 'rsa-pkcs1', hash: 'SHA-256' };

function fakeBridge() {
  return {
    list: vi.fn(async () => []),
    sign: vi.fn(async () => new Uint8Array([1, 2, 3])),
    decrypt: vi.fn(async () => new Uint8Array([4, 5, 6])),
    agree: vi.fn(async () => new Uint8Array([7, 8, 9])),
  };
}

function installBridge(bridge: ReturnType<typeof fakeBridge> | undefined): void {
  (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop = bridge ? { version: 1, platform: 'win32', keystore: bridge } : undefined;
}

afterEach(() => {
  delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
});

describe('who may call it', () => {
  let bridge: ReturnType<typeof fakeBridge>;
  beforeEach(() => {
    bridge = fakeBridge();
    installBridge(bridge);
  });

  const METHODS: Array<[string, unknown[]]> = [
    ['keystore.list', []],
    ['keystore.sign', ['id', DIGEST, SIGN]],
    ['keystore.decrypt', ['id', new Uint8Array(256), { scheme: 'rsa-pkcs1' }]],
    ['keystore.agree', ['id', new Uint8Array(91)]],
  ];

  it.each(METHODS)('%s is refused for the untrusted tier, even when declared and granted', async (method, args) => {
    const untrusted = plugin({ tier: 'untrusted', permissions: ['keystore'], grantedPermissions: ['keystore'], managed: true });
    await expect(dispatchApiCall(untrusted, method, args, { privileged: false })).rejects.toThrow(/requires the privileged plugin tier/);
    expect(bridge.list).not.toHaveBeenCalled();
    expect(bridge.sign).not.toHaveBeenCalled();
    expect(bridge.decrypt).not.toHaveBeenCalled();
    expect(bridge.agree).not.toHaveBeenCalled();
  });

  it.each(METHODS)('%s is refused without the permission, also in the privileged tier', async (method, args) => {
    const noPermission = plugin({ permissions: ['crypto:full'] });
    await expect(dispatchApiCall(noPermission, method, args, { privileged: true })).rejects.toThrow(/lacks permission "keystore"/);
    expect(bridge.sign).not.toHaveBeenCalled();
  });

  it('is refused when a manifest declares it but neither an admin nor the user gave it', async () => {
    const notGiven = plugin({ managed: false, grantedPermissions: [] });
    await expect(dispatchApiCall(notGiven, 'keystore.list', [], { privileged: true })).rejects.toThrow(/lacks permission "keystore"/);
  });

  it('passes for a privileged plugin holding it', async () => {
    await expect(dispatchApiCall(plugin(), 'keystore.sign', ['id', DIGEST, SIGN], { privileged: true })).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(bridge.sign).toHaveBeenCalledWith('id', DIGEST, SIGN);
    await expect(dispatchApiCall(plugin(), 'keystore.list', [], { privileged: true })).resolves.toEqual([]);
    await expect(dispatchApiCall(plugin(), 'keystore.decrypt', ['id', new Uint8Array(256), { scheme: 'rsa-pkcs1' }], { privileged: true })).resolves.toEqual(new Uint8Array([4, 5, 6]));
    await expect(dispatchApiCall(plugin(), 'keystore.agree', ['id', new Uint8Array(91)], { privileged: true })).resolves.toEqual(new Uint8Array([7, 8, 9]));
  });

  it('says it is unsupported in a browser or a shell without the helper', async () => {
    installBridge(undefined);
    await expect(dispatchApiCall(plugin(), 'keystore.list', [], { privileged: true })).rejects.toThrow('keystore:unsupported');
  });

  it('every keystore method is in the permission table', () => {
    for (const [method] of METHODS) expect(PERM_PER_METHOD[method]).toBe('keystore');
  });

  it('is shown as high risk in the consent dialog', () => {
    expect(HIGH_RISK_PERMISSIONS.has('keystore')).toBe(true);
  });
});

describe('what gets through to the shell', () => {
  let bridge: ReturnType<typeof fakeBridge>;
  beforeEach(() => {
    bridge = fakeBridge();
    installBridge(bridge);
  });
  const call = (method: string, ...args: unknown[]) => dispatchApiCall(plugin(), method, args, { privileged: true });

  it.each<[string, unknown[]]>([
    ['an id that is no string', [42, DIGEST, SIGN]],
    ['an empty id', ['', DIGEST, SIGN]],
    ['a long id', ['x'.repeat(65), DIGEST, SIGN]],
    ['a digest that is no bytes', ['id', 'not bytes', SIGN]],
    ['an empty digest', ['id', new Uint8Array(0), SIGN]],
    ['a digest longer than any hash', ['id', new Uint8Array(65), SIGN]],
    ['no scheme', ['id', DIGEST, null]],
    ['a list as scheme', ['id', DIGEST, []]],
    ['an unknown scheme', ['id', DIGEST, { scheme: 'raw', hash: 'SHA-256' }]],
    ['an unknown hash', ['id', DIGEST, { scheme: 'rsa-pkcs1', hash: 'MD5' }]],
    ['no hash', ['id', DIGEST, { scheme: 'rsa-pkcs1' }]],
  ])('sign refuses %s', async (_name, args) => {
    await expect(call('keystore.sign', ...args)).rejects.toThrow('keystore:invalid');
    expect(bridge.sign).not.toHaveBeenCalled();
  });

  it('decrypt refuses data past any modulus, and a label too long', async () => {
    await expect(call('keystore.decrypt', 'id', new Uint8Array(2049), { scheme: 'rsa-pkcs1' })).rejects.toThrow('keystore:invalid');
    await expect(call('keystore.decrypt', 'id', new Uint8Array(256), { scheme: 'rsa-oaep', hash: 'SHA-1', label: new Uint8Array(257) })).rejects.toThrow('keystore:invalid');
    await expect(call('keystore.decrypt', 'id', new Uint8Array(256), { scheme: 'rsa-oaep' })).rejects.toThrow('keystore:invalid');
    expect(bridge.decrypt).not.toHaveBeenCalled();
  });

  it('passes only the fields it knows', async () => {
    const data = new Uint8Array(256);
    await call('keystore.decrypt', 'id', data, { scheme: 'rsa-oaep', hash: 'SHA-1', extra: 'x', label: new Uint8Array(0) });
    expect(bridge.decrypt).toHaveBeenCalledWith('id', data, { scheme: 'rsa-oaep', hash: 'SHA-1' });
    await call('keystore.sign', 'id', DIGEST, { ...SIGN, extra: 'x' });
    expect(bridge.sign).toHaveBeenCalledWith('id', DIGEST, SIGN);
  });

  it('agree refuses an oversized peer key', async () => {
    await expect(call('keystore.agree', 'id', new Uint8Array(257))).rejects.toThrow('keystore:invalid');
    expect(bridge.agree).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'not-found', 'unsupported', 'locked', 'failed'])('hands keystore:%s to the frame as the message', async (code) => {
    bridge.sign.mockRejectedValueOnce(new Error(`Error invoking remote method: Error: keystore:${code}`));
    await expect(call('keystore.sign', 'id', DIGEST, SIGN)).rejects.toThrow(new RegExp(`^keystore:${code}$`));
  });

  it('turns anything else into keystore:failed, not a stack or a path', async () => {
    bridge.sign.mockRejectedValueOnce(new Error('C:\\secret\\path blew up'));
    await expect(call('keystore.sign', 'id', DIGEST, SIGN)).rejects.toThrow(/^keystore:failed$/);
  });
});

describe('api.host.features.keystore', () => {
  it('is true for a privileged plugin with the permission, in a shell that has it', () => {
    installBridge(fakeBridge());
    expect(keystoreFeature(plugin())).toEqual({ keystore: true });
    expect(snapshotHostFeatures(plugin()).keystore).toBe(true);
  });

  it('is absent in a browser', () => {
    expect(keystoreFeature(plugin())).toEqual({});
    expect(snapshotHostFeatures(plugin())).not.toHaveProperty('keystore');
  });

  it('is absent for the untrusted tier, without the permission, and for a privileged claim that fails its gates', () => {
    installBridge(fakeBridge());
    expect(keystoreFeature(plugin({ tier: 'untrusted' }))).toEqual({});
    expect(keystoreFeature(plugin({ permissions: ['crypto:full'] }))).toEqual({});
    // The tier resolver refuses these two: no admin install, no crypto:full.
    expect(keystoreFeature(plugin({ managed: false, grantedPermissions: ['keystore'] }))).toEqual({});
    expect(keystoreFeature(plugin({ permissions: ['keystore'] }))).toEqual({});
  });

  it('is absent when no plugin is named, so one plugin\'s flag is never everyone\'s', () => {
    installBridge(fakeBridge());
    expect(snapshotHostFeatures()).not.toHaveProperty('keystore');
  });
});

describe('the manifest', () => {
  const BASE = { id: 'keystore-test', name: 'P', version: '1.0.0', author: 'a', description: 'd', type: 'hook' };

  it('grants it to a privileged plugin as an optional permission', () => {
    const { manifest, errors } = checkPluginManifest({ ...BASE, tier: 'privileged', permissions: ['crypto:full'], optionalPermissions: ['keystore'] });
    expect(errors).toEqual([]);
    expect(manifest!.permissions).toContain('keystore');
  });

  it('leaves it out for an untrusted plugin, with a warning, as optional and as plain', () => {
    for (const declared of [{ optionalPermissions: ['keystore', 'email:read'] }, { permissions: ['keystore', 'email:read'] }]) {
      const { manifest, errors, warnings } = checkPluginManifest({ ...BASE, ...declared });
      expect(errors).toEqual([]);
      expect(manifest!.permissions).toEqual(['email:read']);
      expect(warnings.join()).toMatch(/"keystore" permission: it needs the privileged tier/);
    }
  });
});

describe('a keystore call and the hook timer', () => {
  const ID = 'smime';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    pluginErrorTracker.resetAll();
    setHookDialogGate({ hasOpenDialog: hasDialogFor, whenDialogsClosed: whenNoDialogFor });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setHookDialogGate(null);
    clearAllHooks();
    pluginErrorTracker.resetAll();
  });

  it('a hold counts as an open dialog until released, however many there are', () => {
    expect(hasDialogFor(ID)).toBe(false);
    const first = holdForUser(ID);
    const second = holdForUser(ID);
    expect(hasDialogFor(ID)).toBe(true);
    first();
    first(); // Releasing twice doesn't release the other's hold.
    expect(hasDialogFor(ID)).toBe(true);
    second();
    expect(hasDialogFor(ID)).toBe(false);
  });

  it('a PIN prompt longer than the hook budget neither times out nor counts as an error', async () => {
    const bridge = fakeBridge();
    let answerPin: () => void = () => {};
    bridge.decrypt.mockImplementation(() => new Promise<Uint8Array<ArrayBuffer>>((resolve) => { answerPin = () => resolve(new Uint8Array([1])); }));
    installBridge(bridge);

    // What an S/MIME plugin does: unwrap the content key inside its render hook.
    renderHooks.onRenderEmailBody.register(ID, async (body: object) => {
      await dispatchApiCall(plugin(), 'keystore.decrypt', ['id', new Uint8Array(256), { scheme: 'rsa-pkcs1' }], { privileged: true });
      return { ...body, html: 'decrypted', handledBy: ID };
    });

    const ran = renderHooks.onRenderEmailBody.transform({ html: '' });
    // Far past the 5 s budget: the user is looking for their card.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(console.error).not.toHaveBeenCalled();
    expect(hasDialogFor(ID)).toBe(true);

    answerPin();
    await expect(ran).resolves.toEqual({ html: 'decrypted', handledBy: ID });
    expect(console.error).not.toHaveBeenCalled();
    expect(hasDialogFor(ID)).toBe(false);
    expect(pluginErrorTracker.isDisabled(ID)).toBe(false);
  });

  it('the hold ends when the call fails too, so a later hang still times out', async () => {
    const bridge = fakeBridge();
    bridge.sign.mockRejectedValueOnce(new Error('keystore:cancelled'));
    installBridge(bridge);
    await expect(dispatchApiCall(plugin(), 'keystore.sign', ['id', DIGEST, SIGN], { privileged: true })).rejects.toThrow('keystore:cancelled');
    expect(hasDialogFor(ID)).toBe(false);

    await expect(dispatchApiCall(plugin(), 'keystore.sign', [42], { privileged: true })).rejects.toThrow('keystore:invalid');
    expect(hasDialogFor(ID)).toBe(false);
  });

  it('a hook that hangs with no keystore call still times out', async () => {
    renderHooks.onRenderEmailBody.register(ID, () => new Promise<object>(() => {}));
    const ran = renderHooks.onRenderEmailBody.transform({ html: 'as it was' });
    await vi.advanceTimersByTimeAsync(6000);
    await expect(ran).resolves.toEqual({ html: 'as it was' });
    expect(console.error).toHaveBeenCalled();
  });
});
