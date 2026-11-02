import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureException, configureErrorReporting, resetErrorReportingForTests } from '../client';

const DSN = 'https://6f0b9c79ed3a4315b76595bc2536ac40@bugsink.example.org/3';
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_BULWARK_LITE', '1');
  resetErrorReportingForTests();
  sessionStorage.clear();
  fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// Bulwark Lite has no server, so it never posts to /api/errors, whatever
// the settings say; reports go to the DSN only.
describe('error reporting in Lite', () => {
  it('sends to the DSN and never to /api/errors', () => {
    configureErrorReporting({ dsn: DSN, sampleRate: 1, environment: 'lite', collect: true });
    const error = new TypeError('boom');
    error.stack = 'TypeError: boom\n    at a (https://lite.example.org/_next/static/chunks/1.js:2:30)';
    captureException(error);
    const urls = fetchSpy.mock.calls.map(([url]) => String(url));
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/api/3/envelope/');
    expect(urls.some((url) => url.includes('/api/errors'))).toBe(false);
  });
});
