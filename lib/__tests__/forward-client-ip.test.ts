import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

/**
 * JMAP_FORWARD_CLIENT_IP: Bulwark's server-side requests to the configured
 * JMAP server carry the end user's address, so a server that bans failed
 * logins per IP counts them per user instead of against Bulwark's own address.
 */

const requestHeaders = vi.fn();
vi.mock('next/headers', () => ({
  headers: () => requestHeaders(),
}));

const config: Record<string, unknown> = {};
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback: unknown) => (key in config ? config[key] : fallback),
  },
}));

const guardedFetch = vi.fn();
vi.mock('@/lib/security/url-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/security/url-guard')>();
  return { ...actual, fetchPublicUrl: (...args: unknown[]) => guardedFetch(...args) };
});

import { clientIpFromHeaders } from '@/lib/security/client-ip';
import { getClientIP } from '@/lib/admin/session';
import { CONFIG_ENV_MAP } from '@/lib/admin/types';
import { forwardedClientIpHeaders } from '@/lib/security/forward-client-ip';
import { fetchJmapServer } from '@/lib/stalwart/server-fetch';
import { verifyJmapAuth, verifyJmapIdentity } from '@/lib/auth/verify-jmap-auth';

let plainFetch: Mock;

function incoming(values: Record<string, string>) {
  requestHeaders.mockResolvedValue(new Headers(values));
}

function sentHeaders(call: unknown[]): Headers {
  return new Headers((call[1] as RequestInit | undefined)?.headers);
}

beforeEach(() => {
  for (const key of Object.keys(config)) delete config[key];
  requestHeaders.mockReset();
  guardedFetch.mockReset();
  plainFetch = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', plainFetch);
  delete process.env.TRUSTED_PROXY_DEPTH;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TRUSTED_PROXY_DEPTH;
});

describe('clientIpFromHeaders', () => {
  it('takes the entry our proxy appended, not what the client prepended', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '127.0.0.1, 203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('honours TRUSTED_PROXY_DEPTH', () => {
    process.env.TRUSTED_PROXY_DEPTH = '2';
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '198.51.100.1, 203.0.113.7, 10.0.0.2' }))).toBe('203.0.113.7');
  });

  it('falls back to X-Real-IP and accepts IPv6', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-real-ip': '2001:db8::1' }))).toBe('2001:db8::1');
  });

  it('strips a port and unwraps IPv4-mapped IPv6', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '203.0.113.7:4711' }))).toBe('203.0.113.7');
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '[2001:db8::1]:4711' }))).toBe('2001:db8::1');
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '::ffff:203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('returns null for anything that is not a usable client address', () => {
    for (const value of ['unknown', '0.0.0.0', '::', '127.0.0.1', '127.1.2.3:80', '::1', '0:0:0:0:0:0:0:1',
      '::ffff:127.0.0.1', 'fe80::1%eth0', '203.0.113.7, evil']) {
      expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': value })), value).toBeNull();
    }
    expect(clientIpFromHeaders(new Headers({}))).toBeNull();
  });

  it('leaves getClientIP (the admin rate limiter) as it was', () => {
    const req = (h: Record<string, string>) => new Request('https://webmail.example.org/', { headers: h });
    expect(getClientIP(req({ 'x-forwarded-for': '127.0.0.1, 203.0.113.7' }))).toBe('203.0.113.7');
    expect(getClientIP(req({ 'x-forwarded-for': 'not-an-ip' }))).toBe('not-an-ip');
    expect(getClientIP(req({ 'x-forwarded-for': ' , ' }))).toBe('0.0.0.0');
    expect(getClientIP(req({ 'x-real-ip': '198.51.100.4' }))).toBe('198.51.100.4');
    expect(getClientIP(req({}))).toBe('0.0.0.0');
  });
});

describe('forwardedClientIpHeaders', () => {
  it('is configured by JMAP_FORWARD_CLIENT_IP, off by default', () => {
    expect(CONFIG_ENV_MAP.jmapForwardClientIp).toMatchObject({
      envVar: 'JMAP_FORWARD_CLIENT_IP', type: 'boolean', defaultValue: false,
    });
  });

  it('is empty and never reads the request while the option is off', async () => {
    incoming({ 'x-forwarded-for': '203.0.113.7' });
    expect(await forwardedClientIpHeaders()).toEqual({});
    expect(requestHeaders).not.toHaveBeenCalled();
  });

  it('carries the client address when on', async () => {
    config.jmapForwardClientIp = true;
    incoming({ 'x-forwarded-for': '127.0.0.1, 203.0.113.7' });
    expect(await forwardedClientIpHeaders()).toEqual({ 'X-Forwarded-For': '203.0.113.7' });
  });

  it('is empty outside a request or without a usable address', async () => {
    config.jmapForwardClientIp = true;
    requestHeaders.mockRejectedValue(new Error('headers() called outside a request scope'));
    expect(await forwardedClientIpHeaders()).toEqual({});
    incoming({ 'x-forwarded-for': 'garbage' });
    expect(await forwardedClientIpHeaders()).toEqual({});
  });
});

describe('fetchJmapServer', () => {
  it('adds the client address for a trusted server, overriding any caller value', async () => {
    config.jmapForwardClientIp = true;
    incoming({ 'x-forwarded-for': '203.0.113.7' });
    await fetchJmapServer('https://mail.example.org/jmap/', {
      method: 'POST',
      headers: { Authorization: 'Basic eA==', 'X-Forwarded-For': '127.0.0.1' },
    }, true);
    const sent = sentHeaders(plainFetch.mock.calls[0]);
    expect(sent.get('x-forwarded-for')).toBe('203.0.113.7');
    expect(sent.get('authorization')).toBe('Basic eA==');
  });

  it('merges into a Headers object whatever the caller key case', async () => {
    config.jmapForwardClientIp = true;
    incoming({ 'x-forwarded-for': '203.0.113.7' });
    await fetchJmapServer('https://mail.example.org/jmap/', {
      headers: new Headers({ authorization: 'Basic eA==', 'x-forwarded-for': '10.0.0.9' }),
    }, true);
    const sent = sentHeaders(plainFetch.mock.calls[0]);
    expect(sent.get('x-forwarded-for')).toBe('203.0.113.7');
    expect(sent.get('authorization')).toBe('Basic eA==');
  });

  it('passes the request through unchanged while the option is off', async () => {
    incoming({ 'x-forwarded-for': '203.0.113.7' });
    const init = { headers: { Authorization: 'Basic eA==' } };
    await fetchJmapServer('https://mail.example.org/jmap/', init, true);
    expect(plainFetch).toHaveBeenCalledWith('https://mail.example.org/jmap/', init);
  });

  it('never sends it to a custom (untrusted) endpoint', async () => {
    config.jmapForwardClientIp = true;
    incoming({ 'x-forwarded-for': '203.0.113.7' });
    guardedFetch.mockResolvedValue(new Response('{}', { status: 200 }));
    await fetchJmapServer('https://custom.example.net/jmap/', { headers: { Authorization: 'Basic eA==' } }, false);
    expect(plainFetch).not.toHaveBeenCalled();
    const init = guardedFetch.mock.calls[0][1] as { headers: Record<string, string> };
    expect(Object.keys(init.headers).map(k => k.toLowerCase())).not.toContain('x-forwarded-for');
  });
});

describe('verifyJmapAuth', () => {
  it('sends the client address on every hop to a trusted server', async () => {
    config.jmapForwardClientIp = true;
    incoming({ 'x-forwarded-for': '203.0.113.7' });
    plainFetch
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: '/jmap/session' } }))
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));
    await expect(verifyJmapAuth('https://mail.example.org', 'Basic eDp5', { trusted: true }))
      .rejects.toMatchObject({ status: 401 });
    expect(plainFetch).toHaveBeenCalledTimes(2);
    for (const call of plainFetch.mock.calls) {
      expect(sentHeaders(call).get('x-forwarded-for')).toBe('203.0.113.7');
    }
  });

  it('sends it on the identity lookup a Bearer login needs too', async () => {
    config.jmapForwardClientIp = true;
    incoming({ 'x-forwarded-for': '203.0.113.7' });
    plainFetch
      .mockResolvedValueOnce(Response.json({
        apiUrl: 'https://mail.example.org/jmap/', username: 'someone-else', accounts: { a1: {} },
        primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a1' },
      }))
      .mockResolvedValueOnce(Response.json({
        methodResponses: [['Identity/get', { list: [{ email: 'user@example.org' }] }, '0']],
      }));
    await expect(verifyJmapIdentity('https://mail.example.org', 'Bearer t', 'user@example.org', { trusted: true }))
      .resolves.toBe('https://mail.example.org');
    expect(plainFetch).toHaveBeenCalledTimes(2);
    expect(plainFetch.mock.calls[1][0]).toBe('https://mail.example.org/jmap/');
    for (const call of plainFetch.mock.calls) {
      expect(sentHeaders(call).get('x-forwarded-for')).toBe('203.0.113.7');
    }
  });

  it('does not send it to an untrusted server', async () => {
    config.jmapForwardClientIp = true;
    incoming({ 'x-forwarded-for': '203.0.113.7' });
    guardedFetch.mockResolvedValue(new Response('unauthorized', { status: 401 }));
    await expect(verifyJmapAuth('https://93.184.216.34', 'Basic eDp5')).rejects.toMatchObject({ status: 401 });
    const init = guardedFetch.mock.calls[0][1] as { headers: Record<string, string> };
    expect(Object.keys(init.headers).map(k => k.toLowerCase())).not.toContain('x-forwarded-for');
  });
});

describe('TOTP login route', () => {
  it('sends the client address on its /api/auth call, keeping the content type', async () => {
    config.jmapForwardClientIp = true;
    config.jmapServerUrl = 'https://mail.example.org';
    incoming({ 'x-forwarded-for': '203.0.113.7' });
    plainFetch.mockResolvedValueOnce(Response.json({ type: 'failure' }));
    const { POST } = await import('@/app/api/auth/totp-token-exchange/route');
    const res = await POST(new Request('https://webmail.example.org/api/auth/totp-token-exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serverUrl: 'https://mail.example.org', username: 'u', password: 'wrong', totp: '123456' }),
    }) as never);
    expect(res.status).toBe(401);
    expect(plainFetch.mock.calls[0][0]).toBe('https://mail.example.org/api/auth');
    const sent = sentHeaders(plainFetch.mock.calls[0]);
    expect(sent.get('x-forwarded-for')).toBe('203.0.113.7');
    expect(sent.get('content-type')).toBe('application/json');
  });
});
