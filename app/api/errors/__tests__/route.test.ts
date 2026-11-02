// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const config: Record<string, unknown> = {};
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback: unknown) => (key in config ? config[key] : fallback),
  },
}));

import { POST } from '../route';
import { flushErrors, readErrors, resetAggregateForTests, utcDay } from '@/lib/error-reporting/aggregate';
import { metrics, resetMetricsForTests } from '@/lib/metrics';

const DSN = 'https://6f0b9c79ed3a4315b76595bc2536ac40@bugsink.example.org/3';
const SUBJECT = 'Merger plans for Acme Q3';

let dir: string;
let ip = 0;

function post(body: unknown): NextRequest {
  ip += 1;
  return new NextRequest('http://localhost/api/errors', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${ip}` },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const report = {
  name: 'TypeError',
  message: `Cannot open "${SUBJECT}"`,
  frames: [{ path: `https://mail.example.org/_next/static/chunks/1.js?subject=${encodeURIComponent(SUBJECT)}`, line: 2, column: 30, fn: 'Ab' }],
  version: '1.20.0',
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bulwark-errors-route-'));
  process.env.TELEMETRY_DATA_DIR = dir;
  for (const key of Object.keys(config)) delete config[key];
  resetAggregateForTests();
});

afterEach(() => {
  resetAggregateForTests();
  delete process.env.TELEMETRY_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('POST /api/errors', () => {
  it('keeps nothing while error collection is off', async () => {
    const res = await POST(post(report));
    expect(res.status).toBe(204);
    await flushErrors();
    expect(await readErrors()).toEqual({});
  });

  it('counts a report, scrubbed again, without its message', async () => {
    config.errorReportingDsn = DSN;
    expect((await POST(post(report))).status).toBe(204);
    await flushErrors();
    const stored = JSON.stringify(await readErrors());
    expect(stored).not.toContain('Merger');
    expect(stored).not.toContain('subject=');
    const [entry] = Object.values((await readErrors())[utcDay()]);
    expect(entry).toMatchObject({ name: 'TypeError', runtime: 'browser', version: '1.20.0', count: 1 });
    expect(entry.frames).toEqual([{ path: '/_next/static/chunks/1.js', line: 2, column: 30, fn: 'Ab' }]);
  });

  it('counts while only the metrics endpoint is on, for the browser errors metric', async () => {
    process.env.METRICS_TOKEN = 'scrape-secret-0123456789';
    resetMetricsForTests();
    try {
      expect((await POST(post(report))).status).toBe(204);
      await flushErrors();
      expect(Object.keys((await readErrors())[utcDay()] ?? {})).toHaveLength(1);
      expect(await metrics().registry.metrics()).toContain('bulwark_browser_errors_total 1');
    } finally {
      delete process.env.METRICS_TOKEN;
      resetMetricsForTests();
    }
  });

  it('ignores a name or code that is not an identifier or fixed code', async () => {
    config.errorReportingDsn = DSN;
    await POST(post({ ...report, name: SUBJECT, code: SUBJECT }));
    await flushErrors();
    const [entry] = Object.values((await readErrors())[utcDay()]);
    expect(entry.name).toBe('Error');
    expect(entry.code).toBeUndefined();
  });

  it('refuses bodies that are too large or not JSON objects', async () => {
    config.errorReportingDsn = DSN;
    expect((await POST(post('x'.repeat(17 * 1024)))).status).toBe(413);
    expect((await POST(post('[1,2]'))).status).toBe(400);
    expect((await POST(post('not json'))).status).toBe(400);
  });
});
