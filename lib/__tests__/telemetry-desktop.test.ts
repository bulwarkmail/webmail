// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The desktop app's heartbeat and error counts, on a real socket: what counts is what
// reaches the collector, so these listen on a port rather than stubbing fetch. Consent
// comes from the shell, not from a file or the environment. The bodies go through the
// collector's real validator.

const flag = vi.hoisted(() => ({ IS_DESKTOP_BUILD: true }));
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
    getPolicy: () => ({ features: { calendarEnabled: true } }),
    getAll: () => ({}),
    get: (_key: string, fallback: unknown) => fallback,
  },
}));

import { buildPayload, loadState, saveState, sendOnce, startScheduler, stopScheduler } from '@/lib/telemetry';
import { resetInstantErrorsForTests, sendInstantErrors } from '@/lib/telemetry/instant-errors';
import { flushErrors, recordError, resetAggregateForTests } from '@/lib/error-reporting/aggregate';
import { shouldCollectErrors } from '@/lib/error-reporting/settings';
import { fetchTelemetryTarget } from '@/lib/telemetry/endpoint-guard';
import { OUTGOING_HOSTS } from '@/lib/admin/outgoing-hosts-registry';
import { DESKTOP_CATCH_UP_MAX_MS, DESKTOP_CATCH_UP_MIN_MS } from '@/lib/desktop/desktop-telemetry';
import { loadCollectorValidator } from './collector-validator';

const collector = await loadCollectorValidator();

interface Received {
  path: string;
  body: Record<string, unknown>;
}

let server: Server;
let received: Received[] = [];
let answer = 200;
let base = '';
let dir = '';

const PRIVACY = Symbol.for('bulwark.desktop.privacy');
const TRUSTED = Symbol.for('bulwark.desktop.trustedJmapOrigins');
const holder = globalThis as unknown as Record<symbol, unknown>;

function shellSays(privacy: { telemetry: boolean; crashReports: boolean } | null): void {
  holder[PRIVACY] = privacy ? { ...privacy, appVersion: '0.3.0', build: 'desktop.standalone.beta', endpoint: `${base}/v1/heartbeat` } : undefined;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      received.push({ path: req.url ?? '', body: JSON.parse(raw) });
      res.writeHead(answer, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  flag.IS_DESKTOP_BUILD = true;
  received = [];
  answer = 200;
  dir = mkdtempSync(path.join(tmpdir(), 'bw-telemetry-desktop-'));
  vi.stubEnv('TELEMETRY_DATA_DIR', dir);
  vi.stubEnv('BULWARK_TELEMETRY_ALLOW_PRIVATE', '1');
  vi.stubEnv('BULWARK_TELEMETRY', '');
  vi.stubEnv('BULWARK_TELEMETRY_DISABLED', '');
  vi.stubEnv('BULWARK_TELEMETRY_ERRORS', '');
  shellSays(null);
  resetAggregateForTests();
  resetInstantErrorsForTests();
  // Never used on the desktop build. Reaching it would show up as a failed send.
  await saveState({ consent: 'off', endpoint: 'http://127.0.0.1:1/ignored', consentedAt: null, lastSentAt: null, nextScheduledAt: null });
});

afterEach(async () => {
  await stopScheduler();
  delete holder[PRIVACY];
  delete holder[TRUSTED];
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('nothing leaves before consent', () => {
  it('sends no heartbeat when the shell has said nothing', async () => {
    expect((await sendOnce()).ok).toBe(false);
    expect(received).toEqual([]);
  });

  it('sends no heartbeat on a no from the shell, whatever the file or the environment say', async () => {
    shellSays({ telemetry: false, crashReports: false });
    vi.stubEnv('BULWARK_TELEMETRY', 'on');
    await saveState({ ...(await loadState()), consent: 'on' });
    expect((await sendOnce()).ok).toBe(false);
    expect(received).toEqual([]);
  });

  it('sends no error counts when the shell has said nothing', async () => {
    recordError({ name: 'TypeError', frames: [] }, 'server', '1.0.0');
    await flushErrors();
    await sendInstantErrors();
    expect(received).toEqual([]);
    expect(await shouldCollectErrors()).toBe(false);
  });
});

describe('the heartbeat with consent', () => {
  it('goes out, and stops the moment consent goes', async () => {
    shellSays({ telemetry: true, crashReports: false });
    expect((await sendOnce()).ok).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].path).toBe('/v1/heartbeat');
    shellSays({ telemetry: false, crashReports: false });
    expect((await sendOnce()).ok).toBe(false);
    expect(received).toHaveLength(1);
  });

  it('says desktop, the app version, mode and channel, in schema 1', async () => {
    shellSays({ telemetry: true, crashReports: false });
    await sendOnce();
    expect(received[0].body).toMatchObject({ schema: '1', platform: 'desktop', version: '0.3.0', build: 'desktop.standalone.beta' });
    expect(received[0].body).not.toHaveProperty('errors');
    expect(received[0].body).not.toHaveProperty('mode');
    expect(received[0].body).not.toHaveProperty('channel');
  });

  it.skipIf(!collector)('is what the real collector accepts, and it keeps the build', async () => {
    shellSays({ telemetry: true, crashReports: false });
    await sendOnce();
    const clean = collector!.validate(received[0].body)!;
    expect(clean).not.toBeNull();
    expect(clean.schema).toBe('1');
    expect(clean.build).toBe('desktop.standalone.beta');
    expect(clean.version).toBe('0.3.0');
    expect(clean.platform).toBe('desktop');
    // Schema 2 refuses any extra key, so this proves there is none.
    expect(collector!.validate({ ...received[0].body, schema: '2', errors: [] })).not.toBeNull();
  });

  it('stays schema 1 with crash reports on too', async () => {
    shellSays({ telemetry: true, crashReports: true });
    expect((await buildPayload()).schema).toBe('1');
  });
});

describe('quit within an hour of each start', () => {
  const nextIn = async () => new Date((await loadState()).nextScheduledAt!).getTime() - Date.now();

  it.each([
    [0, DESKTOP_CATCH_UP_MIN_MS],
    [0.5, (DESKTOP_CATCH_UP_MIN_MS + DESKTOP_CATCH_UP_MAX_MS) / 2],
    [0.999999, DESKTOP_CATCH_UP_MAX_MS],
  ])('after a restart with a slot in the past, at random %s it goes after about %s ms, not an hour', async (random, expected) => {
    shellSays({ telemetry: true, crashReports: false });
    vi.spyOn(Math, 'random').mockReturnValue(random);
    await saveState({ ...(await loadState()), nextScheduledAt: new Date(Date.now() - 3 * 86_400_000).toISOString() });
    await startScheduler();
    const wait = await nextIn();
    vi.restoreAllMocks();
    expect(wait).toBeGreaterThan(expected - 5_000);
    expect(wait).toBeLessThanOrEqual(expected);
  });

  it('the wait is between 30 s and 10 min, and differs from start to start', () => {
    expect(DESKTOP_CATCH_UP_MIN_MS).toBe(30_000);
    expect(DESKTOP_CATCH_UP_MAX_MS).toBe(600_000);
  });

  it('the first run with consent does not wait an hour either', async () => {
    shellSays({ telemetry: true, crashReports: false });
    await startScheduler();
    expect(await nextIn()).toBeLessThanOrEqual(DESKTOP_CATCH_UP_MAX_MS);
  });

  it('a slot still ahead stays where it is', async () => {
    shellSays({ telemetry: true, crashReports: false });
    const slot = new Date(Date.now() + 5 * 3_600_000).toISOString();
    await saveState({ ...(await loadState()), nextScheduledAt: slot });
    await startScheduler();
    expect(await nextIn()).toBeGreaterThan(4 * 3_600_000);
  });

  it('a server build still waits the hour', async () => {
    flag.IS_DESKTOP_BUILD = false;
    vi.stubEnv('BULWARK_TELEMETRY', 'on');
    await saveState({ ...(await loadState()), endpoint: `${base}/v1/heartbeat`, nextScheduledAt: new Date(Date.now() - 86_400_000).toISOString() });
    await startScheduler();
    const wait = await nextIn();
    expect(wait).toBeGreaterThan(59 * 60_000);
    expect(wait).toBeLessThanOrEqual(3_600_000);
  });
});

describe('BULWARK_TELEMETRY=off', () => {
  beforeEach(() => {
    vi.stubEnv('BULWARK_TELEMETRY', 'off');
    shellSays({ telemetry: true, crashReports: true });
  });

  it('beats the user\'s yes for the heartbeat', async () => {
    expect((await sendOnce()).ok).toBe(false);
    expect(received).toEqual([]);
  });

  it('beats it for error counts too, and nothing is collected', async () => {
    expect(await shouldCollectErrors()).toBe(false);
    recordError({ name: 'TypeError', frames: [] }, 'server', '1.20.0+desktop');
    await flushErrors();
    await sendInstantErrors();
    expect(received).toEqual([]);
  });

  it('the legacy variable does the same', async () => {
    vi.stubEnv('BULWARK_TELEMETRY', '');
    vi.stubEnv('BULWARK_TELEMETRY_DISABLED', '1');
    expect((await sendOnce()).ok).toBe(false);
    expect(await shouldCollectErrors()).toBe(false);
    expect(received).toEqual([]);
  });

  it('=on is no yes by itself', async () => {
    vi.stubEnv('BULWARK_TELEMETRY', 'on');
    shellSays({ telemetry: false, crashReports: false });
    expect((await sendOnce()).ok).toBe(false);
    expect(received).toEqual([]);
  });

  it('the list of outgoing hosts says how the desktop app differs', () => {
    const entry = OUTGOING_HOSTS.find((host) => host.id === 'telemetry')!;
    expect(entry.usedBy).toMatch(/crash report consent alone/i);
    expect(entry.off).toMatch(/desktop app/i);
    expect(entry.off).toMatch(/no admin page/i);
  });
});

describe('a refusal from the collector', () => {
  it('isn\'t retried on every tick', async () => {
    answer = 400;
    shellSays({ telemetry: false, crashReports: true });
    recordError({ name: 'TypeError', frames: [] }, 'server', '0.3.0-beta.1+desktop');
    await flushErrors();
    await sendInstantErrors();
    await sendInstantErrors();
    await sendInstantErrors();
    expect(received).toHaveLength(1);
  });

  it('a passing failure is tried again', async () => {
    answer = 503;
    shellSays({ telemetry: false, crashReports: true });
    recordError({ name: 'TypeError', frames: [] }, 'server', '1.20.0+desktop');
    await flushErrors();
    await sendInstantErrors();
    await sendInstantErrors();
    expect(received).toHaveLength(2);
  });

  it('rate limiting is tried again', async () => {
    answer = 429;
    shellSays({ telemetry: false, crashReports: true });
    recordError({ name: 'TypeError', frames: [] }, 'server', '1.20.0+desktop');
    await flushErrors();
    await sendInstantErrors();
    await sendInstantErrors();
    expect(received).toHaveLength(2);
  });

  it.skipIf(!collector)('a beta version with the tag is what the patched collector takes', async () => {
    shellSays({ telemetry: false, crashReports: true });
    recordError({ name: 'TypeError', frames: [] }, 'server', '0.3.0-beta.1+desktop');
    await flushErrors();
    await sendInstantErrors();
    expect(collector!.validateErrorBatch(received[0].body)!.errors[0].version).toBe('0.3.0-beta.1+desktop');
  });

  it('a server build still retries as before', async () => {
    flag.IS_DESKTOP_BUILD = false;
    vi.stubEnv('BULWARK_TELEMETRY', 'on');
    vi.stubEnv('BULWARK_TELEMETRY_ERRORS', 'instant');
    answer = 400;
    await saveState({ ...(await loadState()), endpoint: `${base}/v1/heartbeat` });
    recordError({ name: 'TypeError', frames: [] }, 'server', '1.20.0');
    await flushErrors();
    await sendInstantErrors();
    await sendInstantErrors();
    expect(received).toHaveLength(2);
  });
});

describe('crash reports have their own consent', () => {
  const mainFrame = { path: '/desktop/main.mjs', line: 4, column: 2 };
  const bundleFrame = { path: '/.next/server/chunks/1.js', line: 9, column: 1 };

  it('collects and sends error counts with telemetry off, and no heartbeat', async () => {
    shellSays({ telemetry: false, crashReports: true });
    expect(await shouldCollectErrors()).toBe(true);
    recordError({ name: 'TypeError', frames: [bundleFrame] }, 'server', '1.20.0+desktop');
    await flushErrors();
    await sendInstantErrors();
    expect(received.map((r) => r.path)).toEqual(['/v1/errors']);
    expect((await sendOnce()).ok).toBe(false);
    expect(received).toHaveLength(1);
  });

  it('telemetry alone collects no errors', async () => {
    shellSays({ telemetry: true, crashReports: false });
    expect(await shouldCollectErrors()).toBe(false);
    recordError({ name: 'TypeError', frames: [] }, 'server', '1.20.0+desktop');
    await flushErrors();
    await sendInstantErrors();
    expect(received).toEqual([]);
  });

  it.skipIf(!collector)('a batch with a main-process error is what the real collector accepts', async () => {
    shellSays({ telemetry: false, crashReports: true });
    recordError({ name: 'TypeError', frames: [mainFrame, bundleFrame] }, 'server', '1.20.0+desktop');
    await flushErrors();
    await sendInstantErrors();
    const clean = collector!.validateErrorBatch(received[0].body)!;
    expect(clean).not.toBeNull();
    expect(clean.errors[0].version).toBe('1.20.0+desktop');
    // The unpatched collector refuses a whole batch over a frame outside the bundles.
    expect(clean.errors[0].frames).toEqual([expect.objectContaining({ path: '/.next/server/chunks/1.js' })]);
  });

  it('keeps main-process frames in what stays on this computer', async () => {
    shellSays({ telemetry: false, crashReports: true });
    recordError({ name: 'TypeError', frames: [mainFrame] }, 'server', '1.20.0+desktop');
    await flushErrors();
    const stored = JSON.parse(readFileSync(path.join(dir, 'errors.json'), 'utf8')) as Record<string, Record<string, { frames: { path: string }[] }>>;
    const entry = Object.values(Object.values(stored)[0])[0];
    expect(entry.frames[0].path).toBe('/desktop/main.mjs');
  });
});

describe('the endpoint guard', () => {
  it('still refuses a private address when the shell trusts it as a mail server', async () => {
    vi.stubEnv('BULWARK_TELEMETRY_ALLOW_PRIVATE', '');
    holder[TRUSTED] = new Set([base, 'http://192.168.1.5']);
    await expect(fetchTelemetryTarget(`${base}/v1/heartbeat`, { method: 'POST', body: '{}' })).rejects.toThrow();
    await expect(fetchTelemetryTarget('http://192.168.1.5/v1/heartbeat', { method: 'POST', body: '{}' })).rejects.toThrow();
    expect(received).toEqual([]);
  });

  it('a stored endpoint on a private address goes nowhere with consent', async () => {
    vi.stubEnv('BULWARK_TELEMETRY_ALLOW_PRIVATE', '');
    shellSays({ telemetry: true, crashReports: false });
    holder[TRUSTED] = new Set([base]);
    const result = await sendOnce();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('endpoint blocked');
    expect(received).toEqual([]);
  });
});

describe('a server build', () => {
  it('ignores what a shell would have said, so the admin\'s consent stands', async () => {
    flag.IS_DESKTOP_BUILD = false;
    shellSays({ telemetry: true, crashReports: true });
    vi.stubEnv('BULWARK_TELEMETRY', '');
    expect((await sendOnce()).ok).toBe(false);
    expect(received).toEqual([]);
    expect(await shouldCollectErrors()).toBe(false);
    await saveState({ ...(await loadState()), consent: 'on', endpoint: `${base}/v1/heartbeat` });
    expect((await sendOnce()).ok).toBe(true);
    expect(received[0].body.platform).not.toBe('desktop');
    expect(received[0].body.build).not.toBe('desktop.standalone.beta');
  });
});

// So a typo in the path can't quietly turn the checks above off on a machine with the repo.
it.skipIf(process.env.CI)('finds the collector on this machine', () => {
  expect(collector).not.toBeNull();
});
