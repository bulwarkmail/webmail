import { beforeEach, describe, expect, it, vi } from 'vitest';

// A failed policy fetch must not lift the organisation's locks: a refetch
// keeps what the server sent, and a fresh start without the server uses the
// last policy this browser saw instead of the defaults.

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/browser-navigation', () => ({ apiFetch: fetchMock }));

import { POLICY_CACHE_KEY, usePolicyStore, whenPolicySettled } from '@/stores/policy-store';
import { DEFAULT_POLICY } from '@/lib/admin/types';

const LOCKED = {
  ...DEFAULT_POLICY,
  restrictions: { externalContentPolicy: { locked: true, value: 'block' } },
};

const ok = (policy: object) => new Response(JSON.stringify(policy));
const locked = () => usePolicyStore.getState().isSettingLocked('externalContentPolicy');

beforeEach(() => {
  fetchMock.mockReset();
  localStorage.clear();
  usePolicyStore.setState({ policy: { ...DEFAULT_POLICY }, rawPolicy: { ...DEFAULT_POLICY }, loaded: false, fetching: false, source: 'none', partial: false });
});

describe('policy fetch failures', () => {
  it('keeps the server policy when a later fetch fails', async () => {
    fetchMock.mockResolvedValueOnce(ok(LOCKED));
    await usePolicyStore.getState().fetchPolicy();
    expect(locked()).toBe(true);

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await usePolicyStore.getState().fetchPolicy();
    expect(locked()).toBe(true);

    fetchMock.mockResolvedValueOnce(new Response('oops', { status: 502 }));
    await usePolicyStore.getState().fetchPolicy();
    expect(locked()).toBe(true);
    expect(usePolicyStore.getState().source).toBe('server');
  });

  it('starts from the last policy this browser saw when the server is out of reach', async () => {
    fetchMock.mockResolvedValueOnce(ok(LOCKED));
    await usePolicyStore.getState().fetchPolicy();
    expect(localStorage.getItem(POLICY_CACHE_KEY)).toContain('externalContentPolicy');

    // A new page load: nothing in memory, no network.
    usePolicyStore.setState({ policy: { ...DEFAULT_POLICY }, rawPolicy: { ...DEFAULT_POLICY }, loaded: false, source: 'none' });
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await usePolicyStore.getState().fetchPolicy();
    expect(usePolicyStore.getState().source).toBe('cache');
    expect(locked()).toBe(true);
  });

  it('uses the defaults only when no policy was ever fetched', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await usePolicyStore.getState().fetchPolicy();
    expect(usePolicyStore.getState().source).toBe('fallback');
    expect(usePolicyStore.getState().loaded).toBe(true);
    expect(locked()).toBe(false);
  });

  it("doesn't keep the public part a signed-out page gets", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(DEFAULT_POLICY), { headers: { 'X-Bulwark-Policy-Scope': 'public' } }));
    await usePolicyStore.getState().fetchPolicy();
    expect(localStorage.getItem(POLICY_CACHE_KEY)).toBeNull();
  });
});

describe('whenPolicySettled', () => {
  it('waits for the first fetch, then resolves', async () => {
    let release!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { release = resolve; }));
    const fetching = usePolicyStore.getState().fetchPolicy();
    let settled = false;
    const wait = whenPolicySettled(5000).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release(ok(LOCKED));
    await fetching;
    await wait;
    expect(settled).toBe(true);
  });

  it('gives up after its timeout', async () => {
    fetchMock.mockReturnValueOnce(new Promise<Response>(() => {}));
    void usePolicyStore.getState().fetchPolicy();
    const started = Date.now();
    await whenPolicySettled(50);
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  });
});
