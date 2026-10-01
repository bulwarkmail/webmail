import { render, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';

// While a browser restores its logins they connect one after another; the
// identities of every other account used to be read again on each
// connection - 1 + 2 + … + N reads. Each account must be read once per mount.

const env = vi.hoisted(() => ({
  accounts: [] as { id: string; email: string; username: string; isConnected: boolean }[],
  reads: {} as Record<string, number>,
}));

vi.mock('@/stores/account-store', () => ({
  useAccountStore: (sel: (s: { accounts: typeof env.accounts }) => unknown) => sel({ accounts: env.accounts }),
}));

vi.mock('@/stores/auth-store', () => {
  const clients = new Map<string, { getIdentities: () => Promise<unknown[]> }>();
  const state = {
    activeAccountId: 'a',
    getClientForAccount: (id: string) => {
      if (!clients.has(id)) {
        clients.set(id, {
          getIdentities: async () => {
            env.reads[id] = (env.reads[id] ?? 0) + 1;
            return [{ id: `id-${id}`, email: `${id}@example.org`, name: id }];
          },
        });
      }
      return clients.get(id);
    },
  };
  const hook = (sel: (s: typeof state) => unknown) => sel(state);
  hook.getState = () => state;
  return { useAuthStore: hook };
});

vi.mock('@/stores/identity-store', () => {
  const state = { identities: [{ id: 'id-a', email: 'a@example.org', name: 'a' }] };
  return { useIdentityStore: (sel: (s: typeof state) => unknown) => sel(state) };
});

import { useProMultiAccountIdentities } from '../use-pro-multi-account-identities';

type Result = ReturnType<typeof useProMultiAccountIdentities>;
function Harness({ sink }: { sink: Result[] }) {
  sink.push(useProMultiAccountIdentities());
  return null;
}
const account = (id: string) => ({ id, email: `${id}@example.org`, username: `${id}@example.org`, isConnected: true });

afterEach(() => {
  cleanup();
  env.reads = {};
});

describe('useProMultiAccountIdentities while logins connect', () => {
  it('reads each other account once, however many connections follow', async () => {
    const sink: Result[] = [];
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    env.accounts = ids.slice(0, 2).map(account);
    const { rerender } = render(<Harness sink={sink} />);
    for (let n = 3; n <= ids.length; n++) {
      env.accounts = ids.slice(0, n).map(account);
      rerender(<Harness sink={sink} />);
    }
    await waitFor(() => expect(sink.at(-1)?.groups).toHaveLength(6));
    expect(env.reads).toEqual({ b: 1, c: 1, d: 1, e: 1, f: 1 });
  });
});
