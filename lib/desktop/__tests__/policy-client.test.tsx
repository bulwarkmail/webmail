import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { BulwarkDesktopBridge } from '../types';
import { EMPTY_POLICY_LAYERS, resolvePolicies, type PolicyLayer, type PolicySnapshot } from '../policy-schema';
import { customServerAllowedByDesktopPolicy, desktopOfflinePolicy, desktopPolicyValue, jmapServerAllowedByDesktopPolicy, pluginAllowedByDesktopPolicy, useDesktopPolicy } from '../policy';

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
      onWipeOfflineData: () => () => {},
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

  it('a forced server hides the field for one of your own, unless direct connections are left on', () => {
    setBridgePolicy(snapshotOf({ InstanceUrl: 'https://mail.example.com' }));
    expect(customServerAllowedByDesktopPolicy()).toBe(false);
    setBridgePolicy(snapshotOf({ InstanceUrl: 'https://mail.example.com', AllowStandalone: 1 }));
    expect(customServerAllowedByDesktopPolicy()).toBe(true);
    setBridgePolicy(snapshotOf({ AllowStandalone: 0 }));
    expect(customServerAllowedByDesktopPolicy()).toBe(false);
    setBridgePolicy(snapshotOf({}, { InstanceUrl: 'https://mail.example.com' }));
    expect(customServerAllowedByDesktopPolicy()).toBe(true);
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
