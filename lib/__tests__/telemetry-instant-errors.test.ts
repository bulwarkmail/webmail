// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

// Instant error counts: with the error-count consent set to "instant", the
// scheduler leader sends the current day's counts to the collector's
// /v1/errors once a minute, but only errors that are new or whose count
// bucket changed since the last send. Daily mode sends nothing extra.

const thirdParty = vi.hoisted(() => ({ on: false }));
vi.mock('@/lib/admin/third-party-mode', () => ({ isNoThirdPartyTrafficOn: async () => thirdParty.on }));
vi.mock('@/lib/admin/session', () => ({
  requireAdminAuth: vi.fn(async () => ({ session: { sub: 'admin' } })),
  getClientIP: () => '127.0.0.1',
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: vi.fn(async () => {}) }));
vi.mock('@/lib/admin/plugin-registry', () => ({
  getPluginRegistry: async () => ({ plugins: [] }),
  getThemeRegistry: async () => ({ themes: [] }),
}));

const sent = vi.fn(async (_url: string, _init?: { body?: string }) => new Response('{"ok":true}'));
vi.mock('@/lib/telemetry/endpoint-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/telemetry/endpoint-guard')>();
  return {
    ...actual,
    resolveEndpointAllowed: vi.fn(async () => ({ ok: true })),
    fetchTelemetryTarget: (url: string, init?: { body?: string }) => sent(url, init),
  };
});

import { POST } from '@/app/api/admin/telemetry/route';
import { DEFAULT_ENDPOINT, buildPayload, effectiveErrorsConsent, loadState, saveState } from '@/lib/telemetry';
import { resetInstantErrorsForTests, sendInstantErrors } from '@/lib/telemetry/instant-errors';
import { resetAggregateForTests, utcDay } from '@/lib/error-reporting/aggregate';

let dir: string;
const debugId = 'bc67f7db-7f3b-7be2-6f94-966cd7825cc2';

function entry(count: number, name = 'TypeError') {
  return {
    name,
    frames: [
      { path: '/_next/static/chunks/1.js', line: 2, column: 30, debugId },
      { path: 'node_modules/next/dist/x.js', line: 1, column: 1 },
    ],
    version: '1.20.0',
    runtime: 'browser' as const,
    count,
  };
}

function storeCounts(day: Record<string, ReturnType<typeof entry>>): void {
  writeFileSync(path.join(dir, 'telemetry', 'errors.json'), JSON.stringify({ [utcDay()]: day }));
}

function bodies(): Array<Record<string, unknown> & { errors: Array<Record<string, unknown>> }> {
  return sent.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
}

function post(body: Record<string, unknown>) {
  return POST(new NextRequest('http://localhost/api/admin/telemetry', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bulwark-telemetry-instant-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', dir);
  vi.stubEnv('TELEMETRY_DATA_DIR', path.join(dir, 'telemetry'));
  mkdirSync(path.join(dir, 'telemetry'), { recursive: true });
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  thirdParty.on = false;
  vi.stubEnv('BULWARK_TELEMETRY', '');
  vi.stubEnv('BULWARK_TELEMETRY_ERRORS', '');
  sent.mockClear();
  sent.mockImplementation(async () => new Response('{"ok":true}'));
  resetAggregateForTests();
  resetInstantErrorsForTests();
  await saveState({ ...(await loadState()), consent: 'on', endpoint: DEFAULT_ENDPOINT, errorsConsent: 'instant' });
  storeCounts({ aaaa000011112222: entry(1) });
});
afterEach(() => {
  resetAggregateForTests();
  resetInstantErrorsForTests();
});

describe('instant error counts', () => {
  it('sends today\'s counts to the collector\'s /v1/errors, nothing but the allowed fields', async () => {
    await sendInstantErrors();
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls[0][0]).toBe('https://telemetry.bulwarkmail.org/v1/errors');
    const [body] = bodies();
    expect(Object.keys(body).sort()).toEqual(['day', 'errors', 'instance_id', 'schema']);
    expect(body.schema).toBe('1');
    expect(body.day).toBe(utcDay());
    expect(body.instance_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.errors).toEqual([{
      name: 'TypeError',
      fingerprint: 'aaaa000011112222',
      frames: [{ path: '/_next/static/chunks/1.js', line: 2, col: 30, debug_id: debugId }],
      version: '1.20.0',
      count: '1',
      days: 1,
    }]);
  });

  it('sends an error again only when its count bucket changes', async () => {
    storeCounts({ aaaa000011112222: entry(1), bbbb000011112222: entry(1, 'RangeError') });
    await sendInstantErrors();
    expect(bodies()[0].errors).toHaveLength(2);

    await sendInstantErrors();
    expect(sent).toHaveBeenCalledTimes(1);

    // 1 -> 3 moves from '1' to '2-5'.
    storeCounts({ aaaa000011112222: entry(3), bbbb000011112222: entry(1, 'RangeError') });
    await sendInstantErrors();
    expect(sent).toHaveBeenCalledTimes(2);
    expect(bodies()[1].errors.map((e) => [e.fingerprint, e.count])).toEqual([['aaaa000011112222', '2-5']]);

    // 3 -> 4 is still '2-5': nothing new to say.
    storeCounts({ aaaa000011112222: entry(4), bbbb000011112222: entry(1, 'RangeError') });
    await sendInstantErrors();
    expect(sent).toHaveBeenCalledTimes(2);
  });

  it('tries a failed send again on the next tick', async () => {
    sent.mockImplementationOnce(async () => new Response('{}', { status: 503 }));
    await sendInstantErrors();
    await sendInstantErrors();
    expect(sent).toHaveBeenCalledTimes(2);
    expect(bodies()[1].errors).toHaveLength(1);
  });

  it('sends nothing in daily mode, with error counts off, with the heartbeat off or in no-third-party mode', async () => {
    await saveState({ ...(await loadState()), errorsConsent: 'on' });
    await sendInstantErrors();
    await saveState({ ...(await loadState()), errorsConsent: 'off' });
    await sendInstantErrors();
    await saveState({ ...(await loadState()), consent: 'off', errorsConsent: 'instant' });
    await sendInstantErrors();
    await saveState({ ...(await loadState()), consent: 'on' });
    thirdParty.on = true;
    await sendInstantErrors();
    expect(sent).not.toHaveBeenCalled();
  });

  it('sends nothing when the collector URL is empty, and follows a custom one', async () => {
    await saveState({ ...(await loadState()), endpoint: '' });
    await sendInstantErrors();
    expect(sent).not.toHaveBeenCalled();
    await saveState({ ...(await loadState()), endpoint: 'https://collector.example.org/v1/heartbeat' });
    await sendInstantErrors();
    expect(sent.mock.calls[0][0]).toBe('https://collector.example.org/v1/errors');
  });

  it('also sends the daily heartbeat with error counts (schema 2)', async () => {
    expect((await buildPayload()).schema).toBe('2');
  });
});

describe('instant consent', () => {
  it('can be chosen in the admin panel and needs the heartbeat', async () => {
    await saveState({ ...(await loadState()), errorsConsent: 'off' });
    expect((await post({ action: 'set-errors-consent', consent: 'instant' })).status).toBe(200);
    expect((await loadState()).errorsConsent).toBe('instant');
    expect((await effectiveErrorsConsent()).consent).toBe('instant');

    await saveState({ ...(await loadState()), consent: 'off', errorsConsent: 'off' });
    expect((await post({ action: 'set-errors-consent', consent: 'instant' })).status).toBe(409);
  });

  it('can be set with BULWARK_TELEMETRY_ERRORS=instant', async () => {
    await saveState({ ...(await loadState()), errorsConsent: 'off' });
    vi.stubEnv('BULWARK_TELEMETRY_ERRORS', 'instant');
    expect(await effectiveErrorsConsent()).toEqual({ consent: 'instant', source: 'env' });
  });
});
