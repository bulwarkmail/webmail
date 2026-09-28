import { render, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { useProMultiAccountIdentities } from '../use-pro-multi-account-identities';

// The standard shell opens other accounts' messages too (Unified Inbox, a
// non-active account's folders), so a reply can only default to the receiving
// account's identity if the cross-account list is built there as well - it
// used to be Pro/embedded only (#1104).

const env = vi.hoisted(() => ({
  accounts: [] as { id: string; email: string; username: string; label?: string; isConnected: boolean }[],
  getIdentities: vi.fn(async () => [{ id: 'id-b', email: 'b@elsewhere.net', name: 'B' }]),
}));

vi.mock('@/stores/account-store', () => ({
  useAccountStore: (sel: (s: { accounts: typeof env.accounts }) => unknown) => sel({ accounts: env.accounts }),
}));

vi.mock('@/stores/auth-store', () => {
  const state = {
    activeAccountId: 'acc-a',
    getClientForAccount: (id: string) => (id === 'acc-b' ? { getIdentities: env.getIdentities } : undefined),
  };
  const hook = (sel: (s: typeof state) => unknown) => sel(state);
  hook.getState = () => state;
  return { useAuthStore: hook };
});

vi.mock('@/stores/identity-store', () => {
  const state = { identities: [{ id: 'id-a', email: 'a@example.com', name: 'A' }] };
  return { useIdentityStore: (sel: (s: typeof state) => unknown) => sel(state) };
});

type Result = ReturnType<typeof useProMultiAccountIdentities>;

function Harness({ sink }: { sink: Result[] }) {
  sink.push(useProMultiAccountIdentities());
  return null;
}

const A = { id: 'acc-a', email: 'a@example.com', username: 'a@example.com', isConnected: true };
const B = { id: 'acc-b', email: 'b@elsewhere.net', username: 'b@elsewhere.net', isConnected: true };

afterEach(() => {
  cleanup();
  env.getIdentities.mockClear();
});

describe('useProMultiAccountIdentities', () => {
  it('stays off with a single connected account', () => {
    env.accounts = [A];
    const sink: Result[] = [];
    render(<Harness sink={sink} />);
    expect(sink.at(-1)?.enabled).toBe(false);
    expect(env.getIdentities).not.toHaveBeenCalled();
  });

  it('lists every connected account\'s identities, namespaced by account', async () => {
    env.accounts = [A, B];
    const sink: Result[] = [];
    render(<Harness sink={sink} />);
    await waitFor(() => expect(sink.at(-1)?.allIdentities.map((i) => i.id))
      .toEqual(['acc-a::id-a', 'acc-b::id-b']));
    expect(sink.at(-1)?.enabled).toBe(true);
  });

  // mail-app keeps an instance mounted; a composer opened later must know the
  // other accounts' addresses on its first render, when reply-all drops them.
  it('starts a later instance with the identities an earlier one loaded', async () => {
    env.accounts = [A, B];
    const first: Result[] = [];
    render(<Harness sink={first} />);
    await waitFor(() => expect(first.at(-1)?.allIdentities).toHaveLength(2));

    const second: Result[] = [];
    render(<Harness sink={second} />);
    expect(second[0].allIdentities.map((i) => i.id)).toEqual(['acc-a::id-a', 'acc-b::id-b']);
  });
});
