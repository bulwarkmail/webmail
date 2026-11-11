import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY, type SettingsPolicy } from '@/lib/admin/types';
import type { InstalledPlugin } from '@/lib/plugin-types';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';
import { doUserFindPeople } from '../host-api-account';

// user.findPeople follows the admin policy's directory rules like the app's
// own lists (lib/directory-scope.ts).

const LISTING = [
  { id: 'me', type: 'individual', name: 'me@example.org', description: 'Me', email: 'me@example.org' },
  { id: 'ana', type: 'individual', name: 'ana@example.org', description: 'Ana', email: 'ana@example.org' },
  { id: 'bob', type: 'individual', name: 'bob@example.net', description: 'Bob', email: 'bob@example.net' },
  { id: 'zoe', type: 'individual', name: 'zoe@example.org', description: 'Zoe', email: null },
];

function makeClient(getUsername: () => string = () => 'me@example.org') {
  return {
    supportsPrincipals: () => true,
    getUsername,
    getAccountId: () => 'me',
    getIdentities: vi.fn(async () => [{ id: 'i', name: 'Me', email: 'me@example.org' }]),
    listPrincipals: vi.fn(async () => ({ principals: LISTING, status: 'ok' as const })),
    getPrincipals: vi.fn(async () => LISTING),
  };
}

let plugins = 0;
// A plugin of its own for each call, so the lookup limit never counts.
const plugin = () => ({ id: `people-test-${++plugins}` }) as unknown as InstalledPlugin;

const initialPolicy = usePolicyStore.getState();
const initialAuth = useAuthStore.getState();

function setRules(patch: Partial<SettingsPolicy>) {
  usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, ...patch }, loaded: true, partial: false });
}

afterEach(() => {
  usePolicyStore.setState(initialPolicy, true);
  useAuthStore.setState(initialAuth, true);
});

describe('user.findPeople under the directory rules', () => {
  it('finds everyone without rules', async () => {
    setRules({});
    useAuthStore.setState({ client: makeClient() } as never);
    expect((await doUserFindPeople(plugin(), { text: 'example' })).people).toHaveLength(LISTING.length);
  });

  it('finds only accounts in the own domains, by the address in the name when there is no email', async () => {
    setRules({ directorySameDomainOnly: true });
    useAuthStore.setState({ client: makeClient() } as never);
    const { people, complete } = await doUserFindPeople(plugin(), { text: 'example' });
    expect(people.map((p) => p.email)).toEqual(['me@example.org', 'ana@example.org', 'zoe@example.org']);
    expect(complete).toBe(true);
  });

  it('finds no one when the rules cannot be applied, and asks again on the next lookup', async () => {
    setRules({ directorySameDomainOnly: true });
    let broken = true;
    const client = makeClient(() => {
      if (broken) throw new Error('no session');
      return 'me@example.org';
    });
    useAuthStore.setState({ client } as never);
    expect(await doUserFindPeople(plugin(), { text: 'example' })).toEqual({ people: [], complete: false });
    broken = false;
    expect((await doUserFindPeople(plugin(), { text: 'example' })).people).toHaveLength(3);
    expect(client.listPrincipals).toHaveBeenCalledTimes(2);
  });
});
