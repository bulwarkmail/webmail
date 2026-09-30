import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The telemetry sender checked the endpoint with its own DNS lookup, then
// fetched with a plain fetch that resolved again (a rebinding window), and
// the check passed outright when that first lookup failed.

const guardedFetch = vi.fn();
vi.mock('@/lib/security/url-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/security/url-guard')>();
  return { ...actual, fetchPublicUrl: (...args: unknown[]) => guardedFetch(...args) };
});

const plainFetch = vi.fn();

beforeEach(() => {
  guardedFetch.mockReset().mockResolvedValue(new Response('ok'));
  plainFetch.mockReset().mockResolvedValue(new Response('ok'));
  vi.stubGlobal('fetch', plainFetch);
  delete process.env.BULWARK_TELEMETRY_ALLOW_PRIVATE;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('fetchTelemetryTarget', () => {
  it('connects through the rebinding-safe fetch', async () => {
    const { fetchTelemetryTarget } = await import('@/lib/telemetry/endpoint-guard');
    await fetchTelemetryTarget('https://telemetry.example.org/', { method: 'POST', body: '{}' });
    expect(guardedFetch).toHaveBeenCalledWith('https://telemetry.example.org/', { method: 'POST', body: '{}' });
    expect(plainFetch).not.toHaveBeenCalled();
  });

  it('uses the plain fetch only with the dev bypass, still without redirects', async () => {
    process.env.BULWARK_TELEMETRY_ALLOW_PRIVATE = '1';
    const { fetchTelemetryTarget } = await import('@/lib/telemetry/endpoint-guard');
    await fetchTelemetryTarget('http://localhost:4000/', { method: 'GET' });
    expect(plainFetch).toHaveBeenCalledWith('http://localhost:4000/', { method: 'GET', redirect: 'manual' });
    expect(guardedFetch).not.toHaveBeenCalled();
  });
});
