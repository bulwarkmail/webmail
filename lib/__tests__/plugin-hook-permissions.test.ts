import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { InstalledPlugin, Permission } from '../plugin-types';

// Hooks and slots used to be wired for whatever the sandbox reported, with
// no look at the manifest: a plugin declaring no permissions could add a
// Bcc to every outgoing mail through onTransformOutgoingEmail and read every
// opened message through onRenderEmailBody.

const mocks = vi.hoisted(() => ({
  background: { hooks: [] as string[], slots: [] as Array<{ name: string }> },
}));

const CODE = 'export default { activate() {} }';
const HASH = createHash('sha256').update(CODE, 'utf-8').digest('hex');

vi.mock('../plugin-storage', () => ({
  pluginStorage: { getCode: async () => CODE, saveCode: async () => {}, deleteCode: vi.fn() },
}));
vi.mock('../plugin-sandbox/bundle-fetch', () => ({ downloadManagedBundle: vi.fn() }));
vi.mock('../plugin-sandbox/host-bridge', () => ({
  createBackgroundInstance: () => ({
    initPromise: Promise.resolve({ hooks: mocks.background.hooks, slots: mocks.background.slots, shortcuts: [] }),
    invokeHook: vi.fn(async () => ({ to: ['a@example.org'], bcc: ['attacker@evil.example'] })),
    destroy: vi.fn(),
  }),
  SandboxInstance: class {},
}));
vi.mock('../plugin-sandbox/host-api', () => ({ cancelPluginDialogs: vi.fn() }));
vi.mock('../plugin-sandbox/shortcuts', () => ({ registerShortcuts: () => () => {} }));

import { loadSandboxedPlugin, unloadSandboxedPlugin, setSandboxStoreAccessor } from '../plugin-sandbox/loader';
import { get as getActive } from '../plugin-sandbox/registry';
import { emailHooks, renderHooks, appLifecycleHooks } from '../plugin-hooks';
import { hookPermission, mayOfferSlot, mayRegisterHook, pluginHasPermission } from '../plugin-sandbox/permissions';

function plugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    id: 'hook-plugin',
    name: 'Hook plugin',
    version: '1.0.0',
    author: 'someone',
    description: '',
    type: 'hook',
    permissions: [],
    entrypoint: 'index.js',
    enabled: true,
    status: 'enabled',
    settings: {},
    managed: true,
    adminApproved: true,
    bundleHash: HASH,
    ...overrides,
  };
}

beforeEach(() => {
  setSandboxStoreAccessor({ setPluginStatus: () => {} });
  mocks.background.hooks = ['onTransformOutgoingEmail', 'onRenderEmailBody', 'onAppReady'];
  mocks.background.slots = [{ name: 'email-banner' }, { name: 'plugin-dialog' }];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  unloadSandboxedPlugin('hook-plugin');
  vi.restoreAllMocks();
});

describe('sandboxed plugin hooks and slots', () => {
  it('a zero-permission plugin cannot rewrite outgoing mail or read opened messages', async () => {
    await loadSandboxedPlugin(plugin());

    expect(emailHooks.onTransformOutgoingEmail.size).toBe(0);
    expect(renderHooks.onRenderEmailBody.size).toBe(0);
    const outgoing = await emailHooks.onTransformOutgoingEmail.transform({ to: ['a@example.org'], bcc: [] });
    expect(outgoing).toEqual({ to: ['a@example.org'], bcc: [] });

    // Implicit permissions still work.
    expect(appLifecycleHooks.onAppReady.size).toBe(1);
    expect(getActive('hook-plugin')?.slotOffers.map((o) => o.name)).toEqual(['plugin-dialog']);
  });

  it('wires the hooks and slots a managed plugin declares', async () => {
    await loadSandboxedPlugin(plugin({ permissions: ['email:send', 'email:render-takeover', 'ui:email-banner'] }));

    expect(emailHooks.onTransformOutgoingEmail.size).toBe(1);
    expect(renderHooks.onRenderEmailBody.size).toBe(1);
    expect(getActive('hook-plugin')?.slotOffers.map((o) => o.name)).toEqual(['email-banner', 'plugin-dialog']);
  });

  it('holds back a declared permission the user has not granted', async () => {
    await loadSandboxedPlugin(plugin({
      managed: false,
      permissions: ['email:send', 'email:render-takeover'],
      grantedPermissions: ['email:render-takeover'],
    }));

    expect(emailHooks.onTransformOutgoingEmail.size).toBe(0);
    expect(renderHooks.onRenderEmailBody.size).toBe(1);
  });
});

describe('permission tables', () => {
  it('refuses a hook it does not know', () => {
    expect(hookPermission('onSomethingNew')).toBeNull();
    expect(mayRegisterHook(plugin({ permissions: ['email:read'] }), 'onSomethingNew')).toBe(false);
    expect(hookPermission('toString')).toBeNull();
  });

  it('refuses a slot it does not know', () => {
    expect(mayOfferSlot(plugin({ permissions: ['ui:toolbar'] }), 'made-up-slot')).toBe(false);
    expect(mayOfferSlot(plugin({ permissions: ['ui:toolbar'] }), 'constructor')).toBe(false);
  });

  it('accepts either permission for the admin page slot', () => {
    expect(mayOfferSlot(plugin({ permissions: ['admin:config'] }), 'admin-plugin-page')).toBe(true);
    expect(mayOfferSlot(plugin({ permissions: ['ui:admin-page'] }), 'admin-plugin-page')).toBe(true);
    expect(mayOfferSlot(plugin({ permissions: [] }), 'admin-plugin-page')).toBe(false);
  });

  it('treats implicit permissions as granted', () => {
    expect(pluginHasPermission(plugin({ managed: false }), 'app:lifecycle' as Permission)).toBe(true);
    expect(mayRegisterHook(plugin(), 'onAfterLogout')).toBe(true);
  });
});
