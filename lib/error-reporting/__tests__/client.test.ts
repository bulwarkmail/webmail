import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureException, configureErrorReporting, recordJmapCall, recordNavigation, reportFromError, reportJmapFailure,
  resetErrorReportingForTests,
} from '../client';

const DSN = 'https://6f0b9c79ed3a4315b76595bc2536ac40@bugsink.example.org/3';
const SUBJECT = 'Merger plans for Acme Q3';
const ADDRESS = 'ceo.private@acme-corp.example';
const FOLDER = 'Acquisition Talks';

function errorWithStack(message: string): Error {
  const error = new TypeError(message);
  error.stack = `TypeError: ${message}\n    at Ab (https://mail.example.org/_next/static/chunks/1.js:2:30)\n    at https://mail.example.org/_next/static/chunks/2.js:4:5`;
  return error;
}

let fetchSpy: ReturnType<typeof vi.fn>;

function calls(): Array<{ url: string; init: RequestInit }> {
  return fetchSpy.mock.calls.map(([url, init]) => ({ url: String(url), init: init as RequestInit }));
}

beforeEach(() => {
  resetErrorReportingForTests();
  sessionStorage.clear();
  fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('browser error reporting', () => {
  it('sends nothing while reporting is off', () => {
    configureErrorReporting(null);
    captureException(errorWithStack('boom'));
    configureErrorReporting({ dsn: '', sampleRate: 1, environment: 'production', collect: false });
    captureException(errorWithStack('boom again'));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('holds reports until the config arrives, then sends them', () => {
    captureException(errorWithStack('early'));
    expect(fetchSpy).not.toHaveBeenCalled();
    configureErrorReporting({ dsn: DSN, sampleRate: 1, environment: 'production', collect: false });
    expect(calls().map((c) => c.url)).toEqual(['https://bugsink.example.org/api/3/envelope/?sentry_key=6f0b9c79ed3a4315b76595bc2536ac40&sentry_version=7']);
  });

  it('sends to the DSN without cookies or referrer, and with no mail content anywhere', () => {
    configureErrorReporting({ dsn: DSN, sampleRate: 1, environment: 'staging', collect: true });
    window.history.pushState({}, '', `/en/mail/folder/${encodeURIComponent(FOLDER)}/Mabc`);
    recordNavigation(window.location.pathname);
    recordJmapCall(['Email/query', 'Email/get']);
    captureException(errorWithStack(`Failed to open "${SUBJECT}" from ${ADDRESS} at https://mail.example.org/download?name=${encodeURIComponent(SUBJECT)}`));

    const [dsnCall, ownCall] = calls();
    expect(dsnCall.init.credentials).toBe('omit');
    expect(dsnCall.init.referrerPolicy).toBe('no-referrer');
    expect(ownCall.url).toBe('/api/errors');
    for (const { init } of [dsnCall, ownCall]) {
      const body = String(init.body);
      for (const planted of [SUBJECT, ADDRESS, FOLDER, encodeURIComponent(FOLDER), 'Merger', 'acme-corp', 'download?name']) {
        expect(body).not.toContain(planted);
      }
    }
    const event = JSON.parse(String(dsnCall.init.body).trim().split('\n')[2]);
    expect(event.exception.values[0].value).toBe('Failed to open "…" from [email] at [url]');
    expect(event.environment).toBe('staging');
    expect(event.breadcrumbs.values.map((b: { message: string }) => b.message)).toEqual(['/mail/…', 'Email/query, Email/get']);
    expect(event.tags.route).toBe('/mail/…');
  });

  it('sends each fingerprint once per session', () => {
    configureErrorReporting({ dsn: DSN, sampleRate: 1, environment: 'production', collect: false });
    captureException(errorWithStack('same'));
    captureException(errorWithStack('same'));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('stops at ten reports a minute', () => {
    configureErrorReporting({ dsn: DSN, sampleRate: 1, environment: 'production', collect: false });
    for (let i = 0; i < 15; i++) {
      const error = new Error(`e${i}`);
      error.stack = `Error\n    at https://m.example/_next/static/chunks/${i}.js:1:1`;
      captureException(error);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(10);
  });

  it('applies the sample rate to the DSN only', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    configureErrorReporting({ dsn: DSN, sampleRate: 0.1, environment: 'production', collect: true });
    captureException(errorWithStack('sampled out'));
    expect(calls().map((c) => c.url)).toEqual(['/api/errors']);
  });

  it('ignores errors that come only from extensions or other scripts', () => {
    configureErrorReporting({ dsn: DSN, sampleRate: 1, environment: 'production', collect: false });
    const error = new Error('from an extension');
    error.stack = 'Error\n    at chrome-extension://abc/content.js:1:1';
    captureException(error);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports a failed JMAP request by status or method and type, never the answer', () => {
    configureErrorReporting({ dsn: DSN, sampleRate: 1, environment: 'production', collect: true });
    reportJmapFailure({ status: 503 });
    reportJmapFailure({ method: 'Email/set', type: 'overQuota' });
    reportJmapFailure({ method: SUBJECT, type: ADDRESS });
    const own = calls().filter((c) => c.url === '/api/errors').map((c) => JSON.parse(String(c.init.body)));
    expect(own.map((r) => [r.name, r.code])).toEqual([
      ['JmapRequestError', 'http:503'],
      ['JmapMethodError', 'Email/set: overQuota'],
      ['JmapMethodError', 'Unknown/method: unknown'],
    ]);
  });
});

describe('offline mode (#523)', () => {
  it('doesn’t report what an offline session expects', () => {
    const refused = Object.assign(errorWithStack('Not available offline'), { name: 'OfflineUnavailableError' });
    expect(reportFromError(refused, 'unhandledrejection', false)).toBeNull();
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => false });
    try {
      expect(reportFromError(errorWithStack('Failed to fetch'), 'unhandledrejection', false)).toBeNull();
    } finally {
      Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true });
    }
    expect(reportFromError(errorWithStack('Failed to fetch'), 'unhandledrejection', false)).not.toBeNull();
  });
});
