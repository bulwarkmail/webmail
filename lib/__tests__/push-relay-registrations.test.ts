import { beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetRelayRegistration, keepRelayRegistration, relayRegistrationsKey } from '@/lib/pwa-notify/worker-state';

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal('caches', {
    open: async () => ({
      match: async (key: string) => (store.has(key) ? new Response(store.get(key)) : undefined),
      put: async (key: string, res: Response) => { store.set(key, await res.text()); },
    }),
  });
});

const stored = () => JSON.parse(store.get(relayRegistrationsKey(window.location.origin)) ?? 'null');

describe('what the worker keeps to re-register without a tab', () => {
  it('keeps one entry per account and the key', async () => {
    await keepRelayRegistration('a', { relay: 'https://r', subscriptionId: 'd1', accountLabel: 'a@x' }, 'KEY');
    await keepRelayRegistration('b', { relay: 'https://r', subscriptionId: 'd2' }, 'KEY');
    expect(stored()).toEqual({
      applicationServerKey: 'KEY',
      entries: { a: { relay: 'https://r', subscriptionId: 'd1', accountLabel: 'a@x' }, b: { relay: 'https://r', subscriptionId: 'd2' } },
    });
  });

  it('forgets an account, and leaves the others', async () => {
    await keepRelayRegistration('a', { relay: 'https://r', subscriptionId: 'd1' }, 'KEY');
    await keepRelayRegistration('b', { relay: 'https://r', subscriptionId: 'd2' }, 'KEY');
    await forgetRelayRegistration('a');
    expect(Object.keys(stored().entries)).toEqual(['b']);
  });

  it('stays out of the way without a Cache API', async () => {
    vi.stubGlobal('caches', undefined);
    await expect(keepRelayRegistration('a', { relay: 'https://r', subscriptionId: 'd1' }, 'KEY')).resolves.toBeUndefined();
    await expect(forgetRelayRegistration('a')).resolves.toBeUndefined();
  });
});
