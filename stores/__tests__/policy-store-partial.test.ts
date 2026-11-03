import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Before signing in the server answers with the public part of the policy;
// the store has to fetch the rest once a session exists.

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/browser-navigation', () => ({ apiFetch: fetchMock }));

import { usePolicyStore } from '@/stores/policy-store';
import { DEFAULT_POLICY } from '@/lib/admin/types';

function answer(policy: object, scope?: string) {
  return new Response(JSON.stringify(policy), {
    headers: scope ? { 'X-Bulwark-Policy-Scope': scope } : {},
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  usePolicyStore.setState({ policy: { ...DEFAULT_POLICY }, loaded: false, partial: false });
});

describe('a public answer to a page that is signed in', () => {
  const FULL = { ...DEFAULT_POLICY, organisation: { devices: { noOffline: true } } };

  afterEach(() => localStorage.removeItem('auth-storage'));

  it('doesn\'t replace the whole policy it has: the public part has no caps', async () => {
    localStorage.setItem('auth-storage', JSON.stringify({ state: { isAuthenticated: true } }));
    fetchMock.mockResolvedValueOnce(answer(FULL));
    await usePolicyStore.getState().fetchPolicy();
    expect(usePolicyStore.getState().policy.organisation?.devices.noOffline).toBe(true);

    fetchMock.mockResolvedValueOnce(answer({ ...DEFAULT_POLICY }, 'public'));
    await usePolicyStore.getState().fetchPolicy();
    expect(usePolicyStore.getState().partial).toBe(false);
    expect(usePolicyStore.getState().policy.organisation?.devices.noOffline).toBe(true);
  });

  it('does once nobody is signed in', async () => {
    fetchMock.mockResolvedValueOnce(answer(FULL));
    await usePolicyStore.getState().fetchPolicy();
    fetchMock.mockResolvedValueOnce(answer({ ...DEFAULT_POLICY }, 'public'));
    await usePolicyStore.getState().fetchPolicy();
    expect(usePolicyStore.getState().partial).toBe(true);
    expect(usePolicyStore.getState().policy.organisation?.devices.noOffline).toBeFalsy();
  });
});

describe('policy store', () => {
  it('fetches the full policy after signing in when only the public part was loaded', async () => {
    fetchMock.mockResolvedValueOnce(answer({ ...DEFAULT_POLICY }, 'public'));
    await usePolicyStore.getState().fetchPolicy();
    expect(usePolicyStore.getState().partial).toBe(true);

    const apps = [{ id: 'wiki', name: 'Wiki', url: 'https://wiki.example' }];
    fetchMock.mockResolvedValueOnce(answer({ ...DEFAULT_POLICY, defaultSidebarApps: apps }));
    await usePolicyStore.getState().refreshIfPartial();
    expect(usePolicyStore.getState().partial).toBe(false);
    expect(usePolicyStore.getState().policy.defaultSidebarApps).toEqual(apps);

    await usePolicyStore.getState().refreshIfPartial();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('lets the later fetch win when the public answer arrives last', async () => {
    let releasePublic!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { releasePublic = resolve; }));
    const early = usePolicyStore.getState().fetchPolicy();

    fetchMock.mockResolvedValueOnce(answer({ ...DEFAULT_POLICY, approvedPlugins: ['quick-notes'] }));
    await usePolicyStore.getState().refreshIfPartial();

    releasePublic(answer({ ...DEFAULT_POLICY }, 'public'));
    await early;
    expect(usePolicyStore.getState().partial).toBe(false);
    expect(usePolicyStore.getState().policy.approvedPlugins).toEqual(['quick-notes']);
  });
});
