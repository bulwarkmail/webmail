import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { postJmap, rebaseApiUrl, fetchJmapSession, JmapRedirectError } from '@/lib/stalwart/jmap-api';
import { endlessResponse } from './helpers/endless-body';
import { resetStoredCredentialBudgetForTests } from '@/lib/stalwart/stored-credential-budget';

const realFetch = global.fetch;
const mockedFetch = vi.fn();

beforeEach(() => {
  // A 401 below would keep 'Basic abc' from reaching the mock in later tests.
  resetStoredCredentialBudgetForTests();
  mockedFetch.mockReset();
  global.fetch = mockedFetch as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = realFetch;
});

function response(status: number, body = '{}', headers: Record<string, string> = {}): Response {
  return new Response(status >= 300 && status < 400 ? null : body, { status, headers });
}

describe('postJmap', () => {
  it('POSTs the body with auth header and manual redirect mode', async () => {
    mockedFetch.mockResolvedValueOnce(response(200, '{"methodResponses":[]}'));

    const res = await postJmap('https://mail.example.com/jmap/', 'Basic abc', '{"using":[]}');

    expect(res.status).toBe(200);
    const [url, init] = mockedFetch.mock.calls[0];
    expect(url.toString()).toBe('https://mail.example.com/jmap/');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.body).toBe('{"using":[]}');
    expect(init.headers['Authorization']).toBe('Basic abc');
  });

  it('re-POSTs (not GETs) across an https upgrade redirect', async () => {
    mockedFetch
      .mockResolvedValueOnce(response(301, '', { location: 'https://mail.example.com/jmap/' }))
      .mockResolvedValueOnce(response(200));

    const res = await postJmap('http://mail.example.com/jmap/', 'Basic abc', '{}');

    expect(res.status).toBe(200);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    const [url, init] = mockedFetch.mock.calls[1];
    expect(url.toString()).toBe('https://mail.example.com/jmap/');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
  });

  it('follows same-host path redirects (trailing slash normalization)', async () => {
    mockedFetch
      .mockResolvedValueOnce(response(308, '', { location: '/jmap/' }))
      .mockResolvedValueOnce(response(200));

    const res = await postJmap('https://mail.example.com/jmap', 'Basic abc', '{}');

    expect(res.status).toBe(200);
    expect(mockedFetch.mock.calls[1][0].toString()).toBe('https://mail.example.com/jmap/');
  });

  it('refuses redirects to a different host', async () => {
    mockedFetch.mockResolvedValueOnce(
      response(302, '', { location: 'https://evil.example.net/jmap/' }),
    );

    await expect(postJmap('https://mail.example.com/jmap/', 'Basic abc', '{}'))
      .rejects.toBeInstanceOf(JmapRedirectError);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('gives up after too many redirects', async () => {
    mockedFetch.mockResolvedValue(
      response(302, '', { location: 'https://mail.example.com/jmap/' }),
    );

    await expect(postJmap('https://mail.example.com/jmap/', 'Basic abc', '{}'))
      .rejects.toThrow('Too many redirects');
  });

  it('returns non-redirect error responses as-is', async () => {
    mockedFetch.mockResolvedValueOnce(response(401));

    const res = await postJmap('https://mail.example.com/jmap/', 'Basic abc', '{}');
    expect(res.status).toBe(401);
  });
});

describe('rebaseApiUrl', () => {
  it('keeps the advertised path but swaps to the reachable origin', () => {
    const session = { apiUrl: 'https://public.example.org/prefix/jmap/', primaryAccounts: {} };
    expect(rebaseApiUrl(session, 'https://internal.example.com'))
      .toBe('https://internal.example.com/prefix/jmap/');
  });

  it('resolves relative apiUrl against serverUrl', () => {
    const session = { apiUrl: '/jmap/', primaryAccounts: {} };
    expect(rebaseApiUrl(session, 'https://mail.example.com'))
      .toBe('https://mail.example.com/jmap/');
  });

  it('returns null when the session has no apiUrl', () => {
    expect(rebaseApiUrl({ primaryAccounts: {} }, 'https://mail.example.com')).toBeNull();
    expect(rebaseApiUrl(null, 'https://mail.example.com')).toBeNull();
  });
});

describe('fetchJmapSession', () => {
  it('prefers the canonical /jmap/session endpoint', async () => {
    mockedFetch.mockResolvedValueOnce(
      response(200, JSON.stringify({ apiUrl: '/jmap/', primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a' } })),
    );

    const session = await fetchJmapSession('https://mail.example.com', 'Basic abc');

    expect(session?.apiUrl).toBe('/jmap/');
    expect(mockedFetch.mock.calls[0][0]).toBe('https://mail.example.com/jmap/session');
  });

  it('falls back to /.well-known/jmap when the canonical path 404s', async () => {
    mockedFetch
      .mockResolvedValueOnce(response(404))
      .mockResolvedValueOnce(
        response(200, JSON.stringify({ apiUrl: '/api/jmap/', primaryAccounts: {} })),
      );

    const session = await fetchJmapSession('https://mail.example.com', 'Basic abc');

    expect(session?.apiUrl).toBe('/api/jmap/');
    expect(mockedFetch.mock.calls[1][0]).toBe('https://mail.example.com/.well-known/jmap');
  });

  it('returns null when no candidate yields a session', async () => {
    mockedFetch.mockResolvedValue(response(404));
    expect(await fetchJmapSession('https://mail.example.com', 'Basic abc')).toBeNull();
  });
});

describe('fetchJmapSession (response size)', () => {
  it('stops reading a session document that never ends', async () => {
    const first = endlessResponse(500);
    const second = endlessResponse(500);
    mockedFetch.mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response);

    expect(await fetchJmapSession('https://mail.example.com', 'Basic abc')).toBeNull();
    expect(first.pulled() + second.pulled()).toBeLessThan(20);
  });
});
