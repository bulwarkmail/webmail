// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Main's errors on their way through the embedded server: handleServerReport counts them
// them. The webmail scrubs them, so a message off the disk or
// out of a mail can't get through.

const flag = vi.hoisted(() => ({ IS_DESKTOP_BUILD: true, dsn: '' }));
vi.mock('@/lib/desktop/flag', () => ({
  get IS_DESKTOP_BUILD() {
    return flag.IS_DESKTOP_BUILD;
  },
}));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback: unknown) => (key === 'errorReportingDsn' ? flag.dsn : fallback),
  },
}));
vi.mock('@/lib/metrics', () => ({ metricsEnabled: () => false }));
const consent = vi.hoisted(() => ({ value: 'instant' as 'instant' | 'off' }));
vi.mock('@/lib/telemetry/state', () => ({
  effectiveErrorsConsent: async () => ({ consent: consent.value, source: 'env' }),
  telemetryDocs: () => ({ update: async () => {}, get: async () => null }),
}));

import { readErrors, resetAggregateForTests, utcDay } from '../aggregate';
import { captureDesktopMainError } from '../server';

const MAIN = {
  name: 'TypeError',
  message: "ENOENT: open 'C:\\Users\\linus\\AppData\\Roaming\\Bulwark\\inbox.json' for ceo.private@acme-corp.example",
  stack: 'TypeError: secret\n    at sendPing (/desktop/main.mjs:120:7)\n    at file:///C:/Users/linus/elsewhere/other.js:1:1',
  mechanism: 'uncaughtexception',
};

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetAggregateForTests();
  // The server's limiter sends one per fingerprint per hour.
  delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for('bulwark.error-reporting.server')];
  consent.value = 'instant';
  flag.IS_DESKTOP_BUILD = true;
  // The frames' rule is compiled into this build only.
  vi.stubEnv('NEXT_PUBLIC_BULWARK_DESKTOP', '1');
  flag.dsn = '';
  fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function counted() {
  const day = (await readErrors())[utcDay()] ?? {};
  return Object.values(day);
}

describe('an error from the main process', () => {
  it('is counted with its frames kept and the disk gone', async () => {
    await captureDesktopMainError(MAIN);
    const [entry] = await counted();
    expect(entry.name).toBe('TypeError');
    expect(entry.frames[0]).toMatchObject({ path: '/desktop/main.mjs', line: 120, fn: 'sendPing' });
    expect(entry.frames[1].path).toBe('[other]');
    expect(JSON.stringify(entry)).not.toContain('linus');
    expect(JSON.stringify(entry)).not.toContain('acme-corp');
  });

  it('goes nowhere without consent', async () => {
    consent.value = 'off';
    flag.dsn = 'https://6f0b9c79ed3a4315b76595bc2536ac40@bugsink.example.org/3';
    await captureDesktopMainError(MAIN);
    expect(await counted()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never throws, whatever it is given', async () => {
    await expect(captureDesktopMainError({ name: 5, message: {}, stack: 7 })).resolves.toBeUndefined();
    const [entry] = await counted();
    expect(entry.name).toBe('Error');
  });
});
