// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const config: Record<string, unknown> = {};
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback: unknown) => (key in config ? config[key] : fallback),
  },
}));

import { readiness, resetReadinessCache } from '../readiness';
import { GET as ready } from '@/app/api/health/ready/route';
import { GET as live } from '@/app/api/health/live/route';

let dir: string;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bulwark-ready-'));
  process.env.ADMIN_STATE_DIR = path.join(dir, 'state');
  process.env.TELEMETRY_DATA_DIR = path.join(dir, 'telemetry');
  for (const key of Object.keys(config)) delete config[key];
  config.jmapServerUrl = 'https://mail.example.org';
  resetReadinessCache();
  fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ADMIN_STATE_DIR;
  delete process.env.TELEMETRY_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('health endpoints', () => {
  it('live answers 200 whatever Stalwart does', async () => {
    fetchSpy.mockRejectedValue(new Error('down'));
    expect((await live()).status).toBe(200);
  });

  it('ready answers 200 when Stalwart answers, even with 401', async () => {
    const res = await ready();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ready: true, checks: { config: 'ok', store: 'ok', dataDirs: 'ok', stalwart: 'ok' } });
    expect(String(fetchSpy.mock.calls[0][0])).toBe('https://mail.example.org/.well-known/jmap');
  });

  it('ready answers 503 when Stalwart is unreachable or failing, and names no host', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED mail.example.org'));
    const res = await ready();
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text).checks.stalwart).toBe('fail');
    expect(text).not.toContain('example.org');

    resetReadinessCache();
    fetchSpy.mockResolvedValue(new Response(null, { status: 502 }));
    expect((await ready()).status).toBe(503);
  });

  it('skips Stalwart before a server is configured', async () => {
    delete config.jmapServerUrl;
    delete process.env.JMAP_SERVER_URL;
    expect((await readiness()).checks.stalwart).toBe('skipped');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails when a data dir is not writable', async () => {
    writeFileSync(path.join(dir, 'blocked'), '');
    process.env.TELEMETRY_DATA_DIR = path.join(dir, 'blocked', 'telemetry');
    const result = await readiness();
    expect(result.checks.dataDirs).toBe('fail');
    expect(result.ready).toBe(false);
  });

  it('reuses a result for a few seconds', async () => {
    await readiness(1000);
    await readiness(2000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
