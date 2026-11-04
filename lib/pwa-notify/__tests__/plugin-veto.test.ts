import { afterEach, describe, expect, it } from 'vitest';
import { hookSpec } from '@/lib/plugin-hook-catalog';
import { emailHooks } from '@/lib/plugin-hooks';
import { pluginsMayVeto, vetoHooksRegistered } from '../plugin-veto';

describe('pluginsMayVeto', () => {
  it('reads the permission off the catalogue, which is email:write for all three today', () => {
    for (const name of ['onBeforeEmailMove', 'onBeforeEmailArchive', 'onBeforeEmailReadStateChange']) {
      expect(hookSpec(name)?.permission).toBe('email:write');
    }
  });

  it('is true for an enabled plugin with that permission', () => {
    expect(pluginsMayVeto([{ enabled: true, permissions: ['email:read', 'email:write'] }])).toBe(true);
  });

  it('is false for a disabled one, for other permissions and for none', () => {
    expect(pluginsMayVeto([{ enabled: false, permissions: ['email:write'] }])).toBe(false);
    expect(pluginsMayVeto([{ enabled: true, permissions: ['email:read'] }])).toBe(false);
    expect(pluginsMayVeto([{ enabled: true }])).toBe(false);
    expect(pluginsMayVeto([])).toBe(false);
  });
});

describe('vetoHooksRegistered', () => {
  const stops: Array<() => void> = [];
  afterEach(() => { stops.splice(0).forEach((stop) => stop()); });

  it.each(['onBeforeEmailMove', 'onBeforeEmailArchive', 'onBeforeEmailReadStateChange'] as const)('sees a listener on %s', (name) => {
    expect(vetoHooksRegistered()).toBe(false);
    const bus = emailHooks[name] as unknown as { register(id: string, fn: () => boolean): { dispose(): void } };
    const handle = bus.register('test-plugin', () => true);
    stops.push(() => handle.dispose());
    expect(vetoHooksRegistered()).toBe(true);
  });
});
