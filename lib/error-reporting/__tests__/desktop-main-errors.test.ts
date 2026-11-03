// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Main's errors on their way through the embedded server: handleServerReport counts them
// and, with a DSN, sends them tagged. The webmail scrubs them, so a message off the disk or
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
import { browserErrorSettings } from '../settings';

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
  flag.dsn = '';
  fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
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

  it('reaches a DSN tagged as desktop, in app, with nothing off the disk', async () => {
    flag.dsn = 'https://6f0b9c79ed3a4315b76595bc2536ac40@bugsink.example.org/3';
    await captureDesktopMainError(MAIN);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = String(fetchSpy.mock.calls[0][1].body);
    const event = JSON.parse(body.trim().split('\n')[2]) as {
      tags: Record<string, string>;
      exception: { values: { value: string; mechanism: { type: string }; stacktrace: { frames: { filename: string; in_app: boolean }[] } }[] };
    };
    expect(event.tags).toMatchObject({ runtime: 'server', platform: 'desktop' });
    const [value] = event.exception.values;
    expect(value.mechanism.type).toBe('desktop-main');
    const frame = value.stacktrace.frames.find((f) => f.filename === '/desktop/main.mjs')!;
    expect(frame.in_app).toBe(true);
    expect(body).not.toContain('linus');
    expect(body).not.toContain('acme-corp');
    expect(body).not.toContain('inbox.json');
  });

  it('never throws, whatever it is given', async () => {
    await expect(captureDesktopMainError({ name: 5, message: {}, stack: 7 })).resolves.toBeUndefined();
    const [entry] = await counted();
    expect(entry.name).toBe('Error');
  });
});

describe('a DSN in a config file', () => {
  const DSN = 'https://6f0b9c79ed3a4315b76595bc2536ac40@bugsink.example.org/3';

  it('never reaches a page of the desktop app before the user said yes', async () => {
    consent.value = 'off';
    flag.dsn = DSN;
    expect(await browserErrorSettings()).toMatchObject({ dsn: '', collect: false });
    consent.value = 'instant';
    expect(await browserErrorSettings()).toMatchObject({ dsn: DSN, collect: true });
  });

  it('stays an admin\'s to set on a server', async () => {
    flag.IS_DESKTOP_BUILD = false;
    consent.value = 'off';
    flag.dsn = DSN;
    expect(await browserErrorSettings()).toMatchObject({ dsn: DSN, collect: true });
  });
});

describe('a server\'s own report', () => {
  it('has no desktop tag outside the desktop build', async () => {
    flag.IS_DESKTOP_BUILD = false;
    flag.dsn = 'https://6f0b9c79ed3a4315b76595bc2536ac40@bugsink.example.org/3';
    await captureDesktopMainError(MAIN);
    const event = JSON.parse(String(fetchSpy.mock.calls[0][1].body).trim().split('\n')[2]) as { tags: Record<string, string> };
    expect(event.tags.platform).toBeUndefined();
  });
});
