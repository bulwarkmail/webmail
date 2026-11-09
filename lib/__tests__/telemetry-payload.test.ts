import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    getPolicy: () => ({ features: {} }),
    getAll: () => ({}),
    get: (key: string, fallback: unknown) => (key === 'jmapServerUrl' ? 'https://mail.example.org' : fallback),
  },
}));
vi.mock('@/lib/telemetry/state', () => ({
  getInstanceId: async () => 'instance-1',
  effectiveErrorsConsent: async () => ({ consent: 'off', source: 'file' }),
}));
vi.mock('@/lib/telemetry/login-tracker', () => ({ getLoginCounts: async () => ({ total: 3, active7d: 1 }) }));
vi.mock('@/lib/admin/plugin-registry', () => ({
  getPluginRegistry: async () => ({ plugins: [] }),
  getThemeRegistry: async () => ({ themes: [] }),
}));
// A probe, if one were made, would get past the SSRF guard.
vi.mock('@/lib/telemetry/endpoint-guard', () => ({ resolveEndpointAllowed: async () => ({ ok: true }) }));

import { buildPayload } from '@/lib/telemetry/payload';

// Stalwart (0.16.0 through 1.0) sends no Server header and publishes no
// version a client could read. The heartbeat used to read the Server header of
// /.well-known/jmap anyway: null against Stalwart itself, and the proxy's
// version (nginx/1.25.3 -> "1.25.3") behind a reverse proxy.
describe('telemetry stalwart_version', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.STALWART_VERSION;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 307, headers: { server: 'nginx/1.25.3', location: '/jmap/session' } }),
    );
  });

  afterEach(() => {
    delete process.env.STALWART_VERSION;
    vi.restoreAllMocks();
  });

  it('is empty without STALWART_VERSION, on 0.16 and 1.0 alike, and probes nothing', async () => {
    const payload = await buildPayload();

    expect(payload.stalwart_version).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports the version the admin set', async () => {
    process.env.STALWART_VERSION = ' 0.16.23 ';

    const payload = await buildPayload();

    expect(payload.stalwart_version).toBe('0.16.23');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('treats an empty STALWART_VERSION as unset', async () => {
    process.env.STALWART_VERSION = '';
    expect((await buildPayload()).stalwart_version).toBeNull();
  });
});
