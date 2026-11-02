// @vitest-environment node
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { metrics, observeRequest, resetMetricsForTests, signinOutcome } from '../index';
import { observeUpstream } from '../upstream';
import { installHttpMetrics } from '../http';

async function value(name: string, labels: Record<string, string> = {}): Promise<number | undefined> {
  const metric = (await metrics().registry.getMetricsAsJSON()).find((m) => m.name === name);
  const found = (metric?.values as Array<{ labels: Record<string, string | number>; value: number }> | undefined)
    ?.find((v) => Object.entries(labels).every(([k, want]) => v.labels[k] === want));
  return found?.value;
}

beforeEach(() => {
  process.env.METRICS_TOKEN = 'test-token-1234567890';
  resetMetricsForTests();
});

afterEach(() => {
  delete process.env.METRICS_TOKEN;
  resetMetricsForTests();
  vi.restoreAllMocks();
});

describe('request metrics', () => {
  it('label requests by route group and status class, never by the raw path', async () => {
    observeRequest('/de/mail/folder/Acquisition%20Talks/Mabc?q=secret', 'GET', 200, 0.05);
    observeRequest('/webmail/api/wopi/files/abc/contents', 'POST', 503, 1.2, '/webmail');
    observeRequest('/api/whatever-a-user-typed', 'BREW', 404, 0.01);
    expect(await value('bulwark_http_requests_total', { group: 'page:mail', method: 'GET', status: '2xx' })).toBe(1);
    expect(await value('bulwark_http_requests_total', { group: 'api:wopi', method: 'POST', status: '5xx' })).toBe(1);
    expect(await value('bulwark_http_requests_total', { group: 'api:other', method: 'other', status: '4xx' })).toBe(1);
    const text = await metrics().registry.metrics();
    expect(text).not.toContain('Acquisition');
    expect(text).not.toContain('whatever-a-user-typed');
    expect(text).not.toContain('secret');
  });

  it('count sign-ins by outcome from the auth routes', async () => {
    observeRequest('/api/auth/session', 'POST', 200, 0.1);
    observeRequest('/api/auth/session', 'POST', 401, 0.1);
    observeRequest('/api/auth/session', 'POST', 429, 0.1);
    observeRequest('/api/auth/token', 'PUT', 401, 0.1);
    observeRequest('/api/auth/token', 'PUT', 200, 0.1);
    observeRequest('/api/auth/session', 'GET', 200, 0.1);
    for (const [outcome, n] of [['success', 1], ['failure', 1], ['rate_limited', 1], ['refresh_failure', 1]] as const) {
      expect(await value('bulwark_signins_total', { outcome }), outcome).toBe(n);
    }
  });

  it('map outcomes only for sign-in and refresh calls', () => {
    expect(signinOutcome('api:auth', '/api/auth/totp-token-exchange', 'POST', 200)).toBe('success');
    expect(signinOutcome('api:auth', '/api/auth/session', 'DELETE', 200)).toBeNull();
    expect(signinOutcome('api:admin', '/api/admin/auth', 'POST', 401)).toBeNull();
  });

  it('do nothing while the endpoint is off', async () => {
    delete process.env.METRICS_TOKEN;
    observeRequest('/api/config', 'GET', 200, 0.01);
    process.env.METRICS_TOKEN = 'test-token-1234567890';
    expect(await value('bulwark_http_requests_total', { group: 'api:config' })).toBeUndefined();
  });

  it('come from Node\'s HTTP server itself once installed', async () => {
    expect(installHttpMetrics('')).toBe(true);
    const server = http.createServer((_req, res) => { res.statusCode = 204; res.end(); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      await fetch(`http://127.0.0.1:${port}/api/health/live`);
      await vi.waitFor(async () => expect(await value('bulwark_http_requests_total', { group: 'api:health', status: '2xx' })).toBe(1));
    } finally {
      server.close();
    }
  });
});

describe('upstream metrics', () => {
  it('count answers below 500 as ok and 5xx or errors as error', async () => {
    await observeUpstream('stalwart', async () => new Response(null, { status: 401 }));
    await observeUpstream('stalwart', async () => new Response(null, { status: 502 }));
    await expect(observeUpstream('wopi', async () => { throw new Error('down'); })).rejects.toThrow('down');
    expect(await value('bulwark_upstream_requests_total', { target: 'stalwart', outcome: 'ok' })).toBe(1);
    expect(await value('bulwark_upstream_requests_total', { target: 'stalwart', outcome: 'error' })).toBe(1);
    expect(await value('bulwark_upstream_requests_total', { target: 'wopi', outcome: 'error' })).toBe(1);
  });

  it('report build info', async () => {
    expect(await metrics().registry.metrics()).toMatch(/bulwark_build_info\{version="[^"]+",build="[^"]+"\} 1/);
  });
});
