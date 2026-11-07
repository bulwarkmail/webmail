import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The policy is read on every start. A production page asks for it as soon as
// the store's module runs, and the config load joins that request instead of
// sending a second one. A deliberate refetch still goes to the server.

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/browser-navigation', () => ({ apiFetch: fetchMock }));

const policyCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/admin/policy'));

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ features: {}, restrictions: {} })));
  localStorage.clear();
  vi.stubEnv('NEXT_PUBLIC_BULWARK_LITE', '0');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the policy request at start', () => {
  it('goes out when the module runs in a production build, and the start-up callers share it', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { usePolicyStore } = await import('../policy-store');
    expect(policyCalls()).toHaveLength(1);

    // What fetchConfig does once the config is in.
    await usePolicyStore.getState().fetchStartupPolicy();
    await usePolicyStore.getState().fetchStartupPolicy();
    expect(policyCalls()).toHaveLength(1);
    expect(usePolicyStore.getState().loaded).toBe(true);

    // A refetch (after a sign-in, on a change) is a new request.
    await usePolicyStore.getState().fetchPolicy();
    expect(policyCalls()).toHaveLength(2);
  });

  it('waits for a caller outside production builds, and still sends one request for the start', async () => {
    const { usePolicyStore } = await import('../policy-store');
    expect(policyCalls()).toHaveLength(0);
    await Promise.all([usePolicyStore.getState().fetchStartupPolicy(), usePolicyStore.getState().fetchStartupPolicy()]);
    expect(policyCalls()).toHaveLength(1);
  });

  it('lets fetchConfig join the request the store started', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await import('../policy-store');
    fetchMock.mockImplementation(async (url: string) => (String(url) === '/api/config'
      ? new Response(JSON.stringify((await import('@/lib/__tests__/fixtures/config')).createConfig()))
      : new Response(JSON.stringify({ features: {}, restrictions: {} }))));
    const { fetchConfig } = await import('@/hooks/use-config');
    await fetchConfig();
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === '/api/config')).toBe(true));
    expect(policyCalls()).toHaveLength(1);
  });
});
