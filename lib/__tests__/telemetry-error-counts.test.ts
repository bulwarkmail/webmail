// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

// Error counts in the heartbeat (schema 2) have their own consent, off by
// default and off whenever telemetry is off. Without it the heartbeat is
// exactly schema 1.

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

import { GET, POST } from '@/app/api/admin/telemetry/route';
import { buildPayload, effectiveErrorsConsent, errorsForPayload, loadState, saveState } from '@/lib/telemetry';
import { resetAggregateForTests, utcDay, type Aggregate } from '@/lib/error-reporting/aggregate';

let dir: string;
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-10T12:00:00Z');
const debugId = 'bc67f7db-7f3b-7be2-6f94-966cd7825cc2';

function post(body: Record<string, unknown>) {
  return POST(new NextRequest('http://localhost/api/admin/telemetry', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

function entry(count: number, extra: Partial<Aggregate[string][string]> = {}) {
  return {
    name: 'TypeError',
    frames: [
      { path: '/_next/static/chunks/1.js', line: 2, column: 30, debugId },
      { path: 'node_modules/next/dist/x.js', line: 1, column: 1 },
      { path: '[other]' },
    ],
    version: '1.20.0',
    runtime: 'browser' as const,
    count,
    ...extra,
  };
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bulwark-telemetry-errors-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', dir);
  vi.stubEnv('TELEMETRY_DATA_DIR', path.join(dir, 'telemetry'));
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  thirdParty.on = false;
  vi.stubEnv('BULWARK_TELEMETRY', '');
  vi.stubEnv('BULWARK_TELEMETRY_ERRORS', '');
  resetAggregateForTests();
  await saveState({ ...(await loadState()), consent: 'on', errorsConsent: 'off' });
  const yesterday = utcDay(Date.now() - DAY);
  mkdirSync(path.join(dir, 'telemetry'), { recursive: true });
  writeFileSync(path.join(dir, 'telemetry', 'errors.json'), JSON.stringify({ [yesterday]: { aaaa000011112222: entry(7) } }));
});
afterEach(() => {
  resetAggregateForTests();
});

describe('error counts consent', () => {
  it('is off by default and the heartbeat stays schema 1, without errors', async () => {
    expect((await effectiveErrorsConsent()).consent).toBe('off');
    const payload = await buildPayload();
    expect(payload.schema).toBe('1');
    expect('errors' in payload).toBe(false);
  });

  it('turns the heartbeat into schema 2 with the counts when on', async () => {
    expect((await post({ action: 'set-errors-consent', consent: 'on' })).status).toBe(200);
    const payload = await buildPayload();
    expect(payload.schema).toBe('2');
    expect(payload.schema === '2' && payload.errors).toEqual([{
      name: 'TypeError',
      fingerprint: 'aaaa000011112222',
      frames: [{ path: '/_next/static/chunks/1.js', line: 2, col: 30, debug_id: debugId }],
      version: '1.20.0',
      count: '6-10',
      days: 1,
    }]);
  });

  it('can\'t be turned on while telemetry is off, and goes off with it', async () => {
    await saveState({ ...(await loadState()), consent: 'off' });
    expect((await post({ action: 'set-errors-consent', consent: 'on' })).status).toBe(409);

    await saveState({ ...(await loadState()), consent: 'on', errorsConsent: 'on' });
    expect((await effectiveErrorsConsent()).consent).toBe('on');
    await post({ action: 'set-consent', consent: 'off' });
    expect((await loadState()).errorsConsent).toBe('off');
    await post({ action: 'set-consent', consent: 'on' });
    expect((await effectiveErrorsConsent()).consent).toBe('off');
  });

  it('is off in no-third-party mode, whatever is stored or set in the env', async () => {
    await saveState({ ...(await loadState()), errorsConsent: 'on' });
    vi.stubEnv('BULWARK_TELEMETRY_ERRORS', 'on');
    thirdParty.on = true;
    expect(await effectiveErrorsConsent()).toEqual({ consent: 'off', source: 'no-third-party' });
  });

  it('follows BULWARK_TELEMETRY_ERRORS and refuses changes from the panel then', async () => {
    vi.stubEnv('BULWARK_TELEMETRY_ERRORS', 'on');
    expect(await effectiveErrorsConsent()).toEqual({ consent: 'on', source: 'env' });
    expect((await post({ action: 'set-errors-consent', consent: 'off' })).status).toBe(409);
  });

  it('shows the v2 errors in the admin preview before anything is turned on', async () => {
    const body = await (await GET(new NextRequest('http://localhost/api/admin/telemetry'))).json();
    expect(body.payloadPreview.schema).toBe('1');
    expect(body.errorsConsent).toBe('off');
    expect(body.errorsPreview).toHaveLength(1);
  });
});

describe('errors in the payload', () => {
  const yesterday = utcDay(NOW - DAY);

  it('come from the last complete day, most frequent first, at most 50', () => {
    const day: Aggregate[string] = {};
    for (let i = 0; i < 60; i++) day[`f${String(i).padStart(15, '0')}`] = entry(i + 1);
    const errors = errorsForPayload({ [yesterday]: day, [utcDay(NOW)]: { today: entry(999) } }, NOW);
    expect(errors).toHaveLength(50);
    expect(errors[0].fingerprint).toBe('f000000000000059');
    expect(errors.some((e) => e.fingerprint === 'today')).toBe(false);
  });

  it('count the days of the last week a fingerprint occurred on', () => {
    const agg: Aggregate = {
      [yesterday]: { f: entry(1) },
      [utcDay(NOW - 3 * DAY)]: { f: entry(1) },
      [utcDay(NOW - 9 * DAY)]: { f: entry(1) },
    };
    expect(errorsForPayload(agg, NOW)[0].days).toBe(2);
  });

  it('carry a message only when it is a fixed error code', () => {
    const agg: Aggregate = {
      [yesterday]: {
        a: entry(1, { name: 'JmapMethodError', code: 'Email/set: overQuota' }),
        b: entry(1, { code: 'Merger plans for Acme' as string }),
      },
    };
    const [withCode, without] = errorsForPayload(agg, NOW);
    expect(withCode.message).toBe('Email/set: overQuota');
    expect(without.message).toBeUndefined();
  });
});
