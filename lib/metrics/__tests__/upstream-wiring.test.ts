// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/admin/config-manager', () => ({
  configManager: { ensureLoaded: async () => {}, get: (_key: string, fallback: unknown) => fallback },
}));

import { fetchJmapServer } from '@/lib/stalwart/server-fetch';
import { metrics, resetMetricsForTests } from '@/lib/metrics';

beforeEach(() => {
  process.env.METRICS_TOKEN = 'scrape-secret-0123456789';
  resetMetricsForTests();
});

afterEach(() => {
  delete process.env.METRICS_TOKEN;
  resetMetricsForTests();
  vi.unstubAllGlobals();
});

// The server's calls to Stalwart all go through fetchJmapServer.
describe('Stalwart calls', () => {
  it('are counted under the stalwart target', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    await fetchJmapServer('https://mail.example.org/jmap/session', {}, true);
    expect(await metrics().registry.metrics()).toContain('bulwark_upstream_requests_total{target="stalwart",outcome="ok"} 1');
  });
});
