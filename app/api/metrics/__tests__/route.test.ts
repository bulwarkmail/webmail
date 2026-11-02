// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '../route';
import { resetMetricsForTests } from '@/lib/metrics';

function scrape(authorization?: string): NextRequest {
  return new NextRequest('http://localhost/api/metrics', { headers: authorization ? { authorization } : {} });
}

afterEach(() => {
  delete process.env.METRICS_TOKEN;
  delete process.env.METRICS_TOKEN_FILE;
  resetMetricsForTests();
});

describe('GET /api/metrics', () => {
  it('does not exist without a token configured', async () => {
    const res = await GET(scrape('Bearer anything'));
    expect(res.status).toBe(404);
  });

  it('wants the bearer token', async () => {
    process.env.METRICS_TOKEN = 'scrape-secret-0123456789';
    expect((await GET(scrape())).status).toBe(401);
    expect((await GET(scrape('Bearer wrong'))).status).toBe(401);
    expect((await GET(scrape('Basic scrape-secret-0123456789'))).status).toBe(401);
  });

  it('answers Prometheus text with the right token', async () => {
    process.env.METRICS_TOKEN = 'scrape-secret-0123456789';
    const res = await GET(scrape('Bearer scrape-secret-0123456789'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();
    expect(body).toContain('# TYPE bulwark_http_requests_total counter');
    expect(body).toContain('bulwark_build_info');
    expect(body).toContain('bulwark_nodejs_eventloop_lag_seconds');
    expect(body).toContain('bulwark_signins_total{outcome="rate_limited"} 0');
  });

  it('reads the token from METRICS_TOKEN_FILE', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bulwark-metrics-'));
    try {
      writeFileSync(path.join(dir, 'token'), 'from-a-file-0123456789\n');
      process.env.METRICS_TOKEN_FILE = path.join(dir, 'token');
      expect((await GET(scrape('Bearer from-a-file-0123456789'))).status).toBe(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
