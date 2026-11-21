import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfig } from '@/lib/__tests__/fixtures/config';

// The trusted mail servers from /api/config reach the header checks
// (lib/trusted-authserv.ts) as soon as the config is fetched.

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
}));
vi.mock('@/lib/browser-navigation', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/stores/policy-store', () => ({
  usePolicyStore: { getState: () => ({ fetchPolicy: vi.fn() }) },
}));

beforeEach(() => {
  vi.resetModules();
  mocks.apiFetch.mockReset();
  vi.stubEnv('NEXT_PUBLIC_BULWARK_LITE', '0');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('fetching the config', () => {
  it('hands the trusted mail servers to the header checks', async () => {
    mocks.apiFetch.mockResolvedValueOnce(Response.json(createConfig({ trustedAuthservIds: ['mx.google.com'] })));
    const { fetchConfig } = await import('../use-config');
    const trusted = await import('@/lib/trusted-authserv');
    expect(trusted.trustedAuthservIds()).toEqual([]);
    await fetchConfig();
    expect(trusted.trustedAuthservIds()).toEqual(['mx.google.com']);
  });

  it('trusts none from a server that sends no list', async () => {
    const config = createConfig();
    delete config.trustedAuthservIds;
    mocks.apiFetch.mockResolvedValueOnce(Response.json(config));
    const { fetchConfig } = await import('../use-config');
    const trusted = await import('@/lib/trusted-authserv');
    await fetchConfig();
    expect(trusted.trustedAuthservIds()).toEqual([]);
  });
});
