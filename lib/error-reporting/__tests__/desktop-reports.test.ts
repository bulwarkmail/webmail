import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureException, configureErrorReporting, reportFromError, resetErrorReportingForTests,
} from '../client';
import { appVersion } from '../envelope';
import { scrubFramePath, scrubText } from '../scrub';
import { parseStack, sanitizeFrames } from '../stack';

// The desktop app's errors. Main's frames are the shell's own files as /desktop/...: they
// have to survive the check that drops reports with no frame of ours, and nothing about the
// user's disk may get through with them.

const DSN = 'https://6f0b9c79ed3a4315b76595bc2536ac40@bugsink.example.org/3';
const SETTINGS = { dsn: DSN, sampleRate: 1, environment: 'production', collect: false };

const MAIN_STACK = [
  "TypeError: Cannot read properties of undefined (reading 'x')",
  '    at sendPing (/desktop/main.mjs:120:7)',
  '    at async /desktop/main.mjs:90:3',
  '    at processTicksAndRejections (node:internal/process/task_queues:105:5)',
].join('\n');

const EXTENSION_STACK = 'TypeError: nope\n    at x (chrome-extension://abc/content.js:1:2)\n    at y (moz-extension://def/inject.js:3:4)';

function withStack(stack: string): Error {
  const error = new TypeError('nope');
  error.stack = stack;
  return error;
}

function setBridge(bridge: unknown): void {
  (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop = bridge;
}

const forcedOff = { value: false, locked: true, source: 'machine' };

describe('main-process frames', () => {
  it('keeps a report whose frames are the shell\'s', () => {
    const report = reportFromError(withStack(MAIN_STACK), 'desktop-main', false);
    expect(report).not.toBeNull();
    expect(report!.frames[0]).toMatchObject({ path: '/desktop/main.mjs', line: 120, column: 7, fn: 'sendPing' });
    expect(report!.frames[1].path).toBe('/desktop/main.mjs');
    expect(report!.frames[2].path).toBe('node:internal/process/task_queues');
  });

  it('keeps one where every frame is the shell\'s', () => {
    const only = 'TypeError: nope\n    at a (/desktop/main.mjs:1:2)\n    at b (/desktop/main.mjs:3:4)';
    expect(reportFromError(withStack(only), 'desktop-main', false)?.frames).toHaveLength(2);
  });

  it('still drops a report from a browser extension', () => {
    expect(reportFromError(withStack(EXTENSION_STACK), 'onerror', false)).toBeNull();
  });

  it('survives being posted and scrubbed again', () => {
    const frames = parseStack(MAIN_STACK);
    expect(sanitizeFrames(frames).map((frame) => frame.path)).toEqual(frames.map((frame) => frame.path));
  });

  it.each([
    'C:\\Users\\linus\\AppData\\Local\\Programs\\Bulwark\\resources\\app.asar\\dist\\main.mjs',
    'file:///C:/Users/linus/AppData/Local/Programs/Bulwark/resources/app.asar/dist/main.mjs',
    '/home/linus/.local/bin/bulwark/resources/app.asar/dist/main.mjs',
    '/desktop/../../Users/linus/secret.js',
    '/desktop/C:\\Users\\linus\\x.js',
    '/desktop/linus smith/x.js',
    'https://evil.example/desktop/x.js',
  ])('gives nothing away for %s', (input) => {
    expect(scrubFramePath(input)).toBe('[other]');
  });
});

describe('what a report says', () => {
  it.each([
    ["ENOENT: no such file or directory, open 'C:\\Users\\linus\\AppData\\Roaming\\Bulwark\\crash.dmp'", ['linus', 'AppData', 'crash']],
    ['EPERM: operation not permitted, mkdir C:\\Users\\linus\\mail', ['linus']],
    ['failed to read /home/linus/.config/Bulwark/state', ['linus', '.config']],
    ['Subject Merger plans for Acme failed from ceo.private@acme-corp.example', ['Merger', 'Acme', 'ceo.private', 'acme-corp']],
    ['request failed Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdef sealed', ['eyJ', 'abcdef']],
    ['token 0123456789abcdef0123456789abcdef0123 refused', ['0123456789']],
  ])('%s', (input, gone) => {
    const out = scrubText(input);
    for (const word of gone) expect(out).not.toContain(word);
  });
});

describe('tagged as the desktop app', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  const eventOf = (init: RequestInit) => JSON.parse(String(init.body).trim().split('\n')[2]) as { tags: Record<string, string> };

  beforeEach(() => {
    resetErrorReportingForTests();
    sessionStorage.clear();
    fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    setBridge(undefined);
  });

  const bundleError = () => withStack('TypeError: nope\n    at a (https://mail.example.org/_next/static/chunks/1.js:2:30)');

  it('in the app, on the event that goes to a DSN', () => {
    setBridge({ version: 1, platform: 'win32' });
    configureErrorReporting(SETTINGS);
    captureException(bundleError());
    expect(eventOf(fetchSpy.mock.calls[0][1]).tags).toMatchObject({ runtime: 'browser', platform: 'desktop' });
  });

  it('not in a browser', () => {
    configureErrorReporting(SETTINGS);
    captureException(bundleError());
    expect(eventOf(fetchSpy.mock.calls[0][1]).tags.platform).toBeUndefined();
  });

  it('a page in the app sends nothing with crash reports forced off, even to an instance that asks', () => {
    setBridge({ version: 1, platform: 'win32', policy: { get: () => ({ CrashReportsAllowed: forcedOff }), onChange: () => () => {} } });
    configureErrorReporting({ ...SETTINGS, collect: true });
    captureException(bundleError());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a policy that only recommends leaves the instance\'s own settings in charge', () => {
    setBridge({ version: 1, platform: 'win32', policy: { get: () => ({ CrashReportsAllowed: { value: false, locked: false, source: 'recommended' } }), onChange: () => () => {} } });
    configureErrorReporting(SETTINGS);
    captureException(bundleError());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('in the version, in the desktop build only: the collector has no room for a tag', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_VERSION', '1.20.0');
    expect(appVersion()).toBe('1.20.0');
    vi.stubEnv('NEXT_PUBLIC_BULWARK_DESKTOP', '1');
    expect(appVersion()).toBe('1.20.0+desktop');
    expect(appVersion()).toMatch(/^\d+\.\d+\.\d+(?:[-+][\w.-]{1,40})?$/);
  });
});
