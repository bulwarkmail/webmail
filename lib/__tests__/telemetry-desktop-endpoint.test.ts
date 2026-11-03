// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// What's on disk can't aim the desktop app's telemetry anywhere: a state file or a config
// file is something any program on the machine can write. Nothing here reaches a network.

const flag = vi.hoisted(() => ({ IS_DESKTOP_BUILD: true, dsn: '' }));
vi.mock('@/lib/desktop/flag', () => ({
  get IS_DESKTOP_BUILD() {
    return flag.IS_DESKTOP_BUILD;
  },
}));
vi.mock('@/lib/admin/third-party-mode', () => ({ isNoThirdPartyTrafficOn: async () => false }));
vi.mock('@/lib/admin/plugin-registry', () => ({
  getPluginRegistry: async () => ({ plugins: [] }),
  getThemeRegistry: async () => ({ themes: [] }),
}));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    getPolicy: () => ({ features: {} }),
    getAll: () => ({}),
    get: (key: string, fallback: unknown) => (key === 'errorReportingDsn' ? flag.dsn : fallback),
  },
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

import { DEFAULT_ENDPOINT, loadState, saveState, sendOnce } from '@/lib/telemetry';
import { resetInstantErrorsForTests, sendInstantErrors } from '@/lib/telemetry/instant-errors';
import { flushErrors, recordError, resetAggregateForTests } from '@/lib/error-reporting/aggregate';
import { browserErrorSettings, errorReportingSettings } from '@/lib/error-reporting/settings';
import { captureDesktopMainError } from '@/lib/error-reporting/server';

const PRIVACY = Symbol.for('bulwark.desktop.privacy');
const holder = globalThis as unknown as Record<symbol, unknown>;
const EVIL = 'https://collector.evil.example/v1/heartbeat';
const DSN = 'https://6f0b9c79ed3a4315b76595bc2536ac40@bugsink.evil.example/3';

let dir = '';

beforeEach(async () => {
  flag.IS_DESKTOP_BUILD = true;
  flag.dsn = '';
  sent.mockClear();
  dir = mkdtempSync(path.join(tmpdir(), 'bw-telemetry-endpoint-'));
  vi.stubEnv('TELEMETRY_DATA_DIR', dir);
  vi.stubEnv('BULWARK_TELEMETRY', '');
  resetAggregateForTests();
  resetInstantErrorsForTests();
  holder[PRIVACY] = { telemetry: true, crashReports: true, appVersion: '0.3.0', build: 'desktop.standalone.stable' };
  await saveState({ consent: 'off', endpoint: EVIL, consentedAt: null, lastSentAt: null, nextScheduledAt: null });
});

afterEach(() => {
  delete holder[PRIVACY];
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe('the desktop build', () => {
  it('sends a heartbeat to the project\'s collector, whatever the state file names', async () => {
    expect((await sendOnce()).ok).toBe(true);
    expect(sent.mock.calls.map(([url]) => url)).toEqual([DEFAULT_ENDPOINT]);
  });

  it('isn\'t switched off by a blank endpoint in the state file either: consent is the switch', async () => {
    await saveState({ ...(await loadState()), endpoint: '' });
    expect((await sendOnce()).ok).toBe(true);
    expect(sent.mock.calls.map(([url]) => url)).toEqual([DEFAULT_ENDPOINT]);
  });

  it('sends error counts there too', async () => {
    recordError({ name: 'TypeError', frames: [] }, 'server', '1.20.0+desktop');
    await flushErrors();
    await sendInstantErrors();
    expect(sent.mock.calls.map(([url]) => url)).toEqual([new URL('errors', DEFAULT_ENDPOINT).toString()]);
  });

  it('has no DSN, whatever a config file names', async () => {
    flag.dsn = DSN;
    expect(errorReportingSettings().dsn).toBe('');
    expect((await browserErrorSettings()).dsn).toBe('');
  });

  it('sends a main-process error to no config-file DSN, with consent on', async () => {
    flag.dsn = DSN;
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null));
    vi.stubGlobal('fetch', fetchSpy);
    await captureDesktopMainError({ name: 'TypeError', message: 'x', stack: 'TypeError: x\n    at f (/desktop/main.mjs:1:2)' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('a server build', () => {
  beforeEach(() => {
    flag.IS_DESKTOP_BUILD = false;
    vi.stubEnv('BULWARK_TELEMETRY', 'on');
  });

  it('still uses the endpoint its admin stored', async () => {
    await saveState({ ...(await loadState()), endpoint: 'https://collector.example.org/v1/heartbeat' });
    await sendOnce();
    expect(sent.mock.calls.map(([url]) => url)).toEqual(['https://collector.example.org/v1/heartbeat']);
  });

  it('still takes a blank endpoint as off', async () => {
    await saveState({ ...(await loadState()), endpoint: '' });
    expect(await sendOnce()).toMatchObject({ ok: false, error: 'endpoint blank' });
    expect(sent).not.toHaveBeenCalled();
  });

  it('still has its admin\'s DSN', async () => {
    flag.dsn = DSN;
    expect(errorReportingSettings().dsn).toBe(DSN);
    expect((await browserErrorSettings()).dsn).toBe(DSN);
  });
});
