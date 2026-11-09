// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

// The admin page says clearing the collector URL stops heartbeats. The route
// used to store the project's collector again instead, and the sender fell
// back to it for an empty URL too.

vi.mock('@/lib/admin/session', () => ({
  requireAdminAuth: vi.fn(async () => ({ session: { sub: 'admin' } })),
  getClientIP: () => '127.0.0.1',
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: vi.fn(async () => {}) }));

const sent = vi.fn(async (_url: string, _init?: unknown) => new Response('ok'));
vi.mock('@/lib/telemetry/endpoint-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/telemetry/endpoint-guard')>();
  return {
    ...actual,
    resolveEndpointAllowed: vi.fn(async () => ({ ok: true })),
    fetchTelemetryTarget: (url: string, init?: unknown) => sent(url, init),
  };
});

import { GET, POST } from '@/app/api/admin/telemetry/route';
import { DEFAULT_ENDPOINT, loadState, saveState, sendOnce, stopScheduler } from '@/lib/telemetry';

let dir: string;

function post(body: Record<string, unknown>) {
  return POST(new NextRequest('http://localhost/api/admin/telemetry', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bulwark-telemetry-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', dir);
  vi.stubEnv('TELEMETRY_DATA_DIR', path.join(dir, 'telemetry'));
  vi.stubEnv('BULWARK_TELEMETRY', '');
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  sent.mockClear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
  await saveState({ ...(await loadState()), consent: 'on', endpoint: DEFAULT_ENDPOINT });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await stopScheduler();
});

describe('clearing the telemetry collector URL', () => {
  it('stores the empty URL and sends nothing', async () => {
    const res = await post({ action: 'set-endpoint', endpoint: '  ' });
    expect(await res.json()).toEqual({ ok: true, endpoint: '' });
    expect((await loadState()).endpoint).toBe('');

    const status = await (await GET(new NextRequest('http://localhost/api/admin/telemetry'))).json();
    expect(status.endpoint).toBe('');

    expect(await sendOnce({ reason: 'test' })).toMatchObject({ ok: false, error: 'endpoint blank' });
    expect(sent).not.toHaveBeenCalled();
  });

  it('sends again once a collector URL is set', async () => {
    await post({ action: 'set-endpoint', endpoint: '' });
    await post({ action: 'set-endpoint', endpoint: 'https://collector.example.org/v1/heartbeat' });

    expect((await sendOnce({ reason: 'test' })).ok).toBe(true);
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls[0][0]).toBe('https://collector.example.org/v1/heartbeat');
  });

  it('still uses the project collector for a state file without the field', async () => {
    const { endpoint: _drop, ...withoutEndpoint } = await loadState();
    await saveState(withoutEndpoint as Awaited<ReturnType<typeof loadState>>);

    expect((await sendOnce({ reason: 'test' })).ok).toBe(true);
    expect(sent.mock.calls[0][0]).toBe(DEFAULT_ENDPOINT);
  });

  it('keeps BULWARK_TELEMETRY=off as an off switch', async () => {
    vi.stubEnv('BULWARK_TELEMETRY', 'off');
    try {
      expect((await sendOnce({ reason: 'test' })).ok).toBe(false);
      expect(sent).not.toHaveBeenCalled();
    } finally {
      vi.stubEnv('BULWARK_TELEMETRY', '');
    }
  });
});
