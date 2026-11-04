import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { BulwarkDesktopBridge } from '../types';
import { EMPTY_POLICY_LAYERS, resolvePolicies, type PolicyLayer, type PolicySnapshot } from '../policy-schema';
import { customServerAllowedByDesktopPolicy, desktopOfflinePolicy, desktopPolicyValue, jmapServerAllowedByDesktopPolicy, pluginAllowedByDesktopPolicy, pluginMayRunByDesktopPolicy, pluginUploadsAllowedByDesktopPolicy, useDesktopPolicy } from '../policy';
import { accountRefusedByDesktopPolicy, planForRefusedAccounts } from '../refused-accounts';

function snapshotOf(forcedMachine: PolicyLayer, recommendedMachine: PolicyLayer = {}): PolicySnapshot {
  return resolvePolicies({ ...EMPTY_POLICY_LAYERS, forcedMachine, recommendedMachine });
}

let current: PolicySnapshot;
let listeners: ((snapshot: PolicySnapshot) => void)[];

function setBridgePolicy(snapshot: PolicySnapshot) {
  current = snapshot;
  listeners = [];
  window.bulwarkDesktop = {
    version: 1,
    platform: 'win32',
    mode: 'instance',
    policy: {
      get: () => current,
      onChange: (listener) => {
        listeners.push(listener);
        return () => { listeners = listeners.filter((l) => l !== listener); };
      },
    },
  } as BulwarkDesktopBridge;
}

afterEach(() => {
  window.bulwarkDesktop = undefined;
});

describe('in a browser', () => {
  it('nothing is refused and nothing is locked', () => {
    expect(pluginAllowedByDesktopPolicy('anything')).toBe(true);
    expect(jmapServerAllowedByDesktopPolicy('https://anything.example')).toBe(true);
    expect(customServerAllowedByDesktopPolicy()).toBe(true);
    expect(desktopOfflinePolicy()).toEqual({ forced: null, fallback: null });
  });

  it('a shell that predates the policy member counts as no policy', () => {
    window.bulwarkDesktop = { version: 1, platform: 'win32' } as BulwarkDesktopBridge;
    expect(pluginAllowedByDesktopPolicy('anything')).toBe(true);
  });
});

describe('in the app', () => {
  it('follows what the bridge says', () => {
    setBridgePolicy(snapshotOf({ PluginsMode: 'allowlist', PluginAllowlist: ['good'], AllowedJmapServers: ['https://mail.example.com'] }));
    expect(pluginAllowedByDesktopPolicy('good')).toBe(true);
    expect(pluginAllowedByDesktopPolicy('bad')).toBe(false);
    expect(jmapServerAllowedByDesktopPolicy('https://mail.example.com/x')).toBe(true);
    expect(jmapServerAllowedByDesktopPolicy('https://other.example')).toBe(false);
  });

  it('with a list, a package of the user\'s own can\'t pass by naming a listed id, and nobody can add one', () => {
    setBridgePolicy(snapshotOf({ PluginsMode: 'allowlist', PluginAllowlist: ['good'] }));
    expect(pluginMayRunByDesktopPolicy({ id: 'good', managed: true })).toBe(true);
    expect(pluginMayRunByDesktopPolicy({ id: 'good' })).toBe(false);
    expect(pluginMayRunByDesktopPolicy({ id: 'bad', managed: true })).toBe(false);
    expect(pluginUploadsAllowedByDesktopPolicy()).toBe(false);
    setBridgePolicy(snapshotOf({ PluginsMode: 'off' }));
    expect(pluginUploadsAllowedByDesktopPolicy()).toBe(false);
    setBridgePolicy(snapshotOf({}));
    expect(pluginMayRunByDesktopPolicy({ id: 'anything' })).toBe(true);
    expect(pluginUploadsAllowedByDesktopPolicy()).toBe(true);
  });

  it('plans what happens to accounts on a server taken off the list', () => {
    const accounts = [
      { id: 'a', serverUrl: 'https://off.example', isConnected: true },
      { id: 'b', serverUrl: 'https://on.example', isConnected: false },
      { id: 'c', serverUrl: 'https://on.example', isConnected: true },
    ];
    const list = snapshotOf({ AllowedJmapServers: ['https://on.example'] });
    expect(accountRefusedByDesktopPolicy(accounts[0], list)).toBe(true);
    expect(accountRefusedByDesktopPolicy(accounts[1], list)).toBe(false);
    expect(planForRefusedAccounts(accounts, 'a', list)).toEqual({ refused: ['a'], stop: ['a'], activeRefused: true, next: 'c' });
    expect(planForRefusedAccounts(accounts, 'b', list)).toEqual({ refused: ['a'], stop: ['a'], activeRefused: false, next: null });
    expect(planForRefusedAccounts([accounts[0]], 'a', list)).toEqual({ refused: ['a'], stop: ['a'], activeRefused: true, next: null });
    expect(planForRefusedAccounts(accounts, 'a', snapshotOf({})).refused).toEqual([]);
  });

  it('a forced server hides the field for one of your own, unless direct connections are left on', () => {
    setBridgePolicy(snapshotOf({ InstanceUrl: 'https://mail.example.com' }));
    expect(customServerAllowedByDesktopPolicy()).toBe(false);
    setBridgePolicy(snapshotOf({ InstanceUrl: 'https://mail.example.com', AllowStandalone: 1 }));
    expect(customServerAllowedByDesktopPolicy()).toBe(true);
    setBridgePolicy(snapshotOf({ AllowStandalone: 0 }));
    expect(customServerAllowedByDesktopPolicy()).toBe(false);
    setBridgePolicy(snapshotOf({}, { InstanceUrl: 'https://mail.example.com' }));
    expect(customServerAllowedByDesktopPolicy()).toBe(true);
    // A recommendation can't open what a forced server closed.
    setBridgePolicy(snapshotOf({ InstanceUrl: 'https://mail.example.com' }, { AllowStandalone: 1 }));
    expect(customServerAllowedByDesktopPolicy()).toBe(false);
  });

  it('forced offline goes over the user, recommended under', () => {
    setBridgePolicy(snapshotOf({ OfflineEnabled: 0 }));
    expect(desktopOfflinePolicy()).toEqual({ forced: false, fallback: null });
    expect(desktopPolicyValue('OfflineEnabled', true)).toBe(false);
    setBridgePolicy(snapshotOf({}, { OfflineEnabled: 0 }));
    expect(desktopOfflinePolicy()).toEqual({ forced: null, fallback: false });
    expect(desktopPolicyValue('OfflineEnabled', true)).toBe(true);
    expect(desktopPolicyValue('OfflineEnabled')).toBe(false);
  });

  it('forced off is the same as the organisation forbidding it, for every account', async () => {
    setBridgePolicy(snapshotOf({ OfflineEnabled: 0 }));
    const { devicesForAccount } = await import('@/lib/device-policy');
    expect(devicesForAccount('some-account').noOffline).toBe(true);
    setBridgePolicy(snapshotOf({}));
    expect(devicesForAccount('some-account').noOffline).toBe(false);
  }, 60_000);

  it('a forced value that makes no sense keeps offline off without forbidding it, which would wipe', async () => {
    setBridgePolicy(snapshotOf({ OfflineEnabled: 'yes' }));
    expect(desktopOfflinePolicy()).toEqual({ forced: false, fallback: null, invalid: true });
    const { devicesForAccount } = await import('@/lib/device-policy');
    expect(devicesForAccount('some-account').noOffline).toBe(false);
  }, 60_000);

  it('the hook settles on a bridge that copies what it returns, as contextBridge does', async () => {
    setBridgePolicy(snapshotOf({ PluginsMode: 'off' }));
    window.bulwarkDesktop!.policy!.get = () => JSON.parse(JSON.stringify(current));
    let renders = 0;
    function Probe() {
      renders += 1;
      return <span>{useDesktopPolicy().PluginsMode.value}</span>;
    }
    render(<Probe />);
    expect(screen.getByText('off')).toBeInTheDocument();
    expect(renders).toBeLessThan(4);
  });

  it('the hook shows a change at once', async () => {
    setBridgePolicy(snapshotOf({}));
    function Probe() {
      return <span>{useDesktopPolicy().PluginsMode.value}</span>;
    }
    render(<Probe />);
    expect(screen.getByText('allowed')).toBeInTheDocument();
    const { act } = await import('@testing-library/react');
    act(() => {
      current = snapshotOf({ PluginsMode: 'off' });
      for (const listener of listeners) listener(current);
    });
    expect(screen.getByText('off')).toBeInTheDocument();
  });
});
