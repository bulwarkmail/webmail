import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * #1073: when the webmail server could not verify a sign-in with the mail
 * server, or the browser dropped the Secure context cookie, every
 * cookie-gated route answered "Not authenticated" and nothing was logged.
 */

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

vi.mock('@/lib/admin/config-manager', () => ({
  configManager: { get: (_key: string, fallback: unknown) => fallback },
}));

import { JmapAuthVerificationError, networkErrorCode, upstreamFailureHint } from '@/lib/auth/verify-jmap-auth';
import { insecureCookieHint, verificationFailureBody } from '@/lib/auth/verification-failure';
import { explainServerAuthError, setServerAuthIssue } from '@/lib/server-auth-status';

function requestFrom(origin: string | null): Request {
  const headers = new Headers();
  if (origin) headers.set('origin', origin);
  return new Request('https://webmail.example/api/auth/stalwart-context', { method: 'POST', headers });
}

afterEach(() => {
  vi.unstubAllEnvs();
  setServerAuthIssue(null);
});

describe('networkErrorCode', () => {
  it('reads the code undici puts on the cause', () => {
    const cause = Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    expect(networkErrorCode(Object.assign(new TypeError('fetch failed'), { cause }))).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
  });

  it('reads a code set directly on the error', () => {
    expect(networkErrorCode(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))).toBe('ECONNREFUSED');
  });

  it('returns undefined when there is no code', () => {
    expect(networkErrorCode(new TypeError('fetch failed'))).toBeUndefined();
    expect(networkErrorCode('nope')).toBeUndefined();
  });
});

describe('upstreamFailureHint', () => {
  it.each([
    ['SELF_SIGNED_CERT_IN_CHAIN', /NODE_EXTRA_CA_CERTS/],
    ['ERR_TLS_CERT_ALTNAME_INVALID', /host name/],
    ['CERT_HAS_EXPIRED', /expired/],
    ['EAI_AGAIN', /resolve/],
    ['ECONNREFUSED', /cannot connect/],
  ])('explains %s', (code, pattern) => {
    expect(upstreamFailureHint(code)).toMatch(pattern);
  });

  it('has nothing to say about unknown codes', () => {
    expect(upstreamFailureHint('EWHATEVER')).toBeUndefined();
    expect(upstreamFailureHint(undefined)).toBeUndefined();
  });
});

describe('verificationFailureBody', () => {
  const tlsError = () => new JmapAuthVerificationError('Failed to verify JMAP session', 502, undefined, 'DEPTH_ZERO_SELF_SIGNED_CERT');

  it('passes the cause to the browser for an admin-configured server', () => {
    const body = verificationFailureBody('stalwart-context', tlsError(), 'https://mail.example', true);
    expect(body.code).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
    expect(body.hint).toMatch(/NODE_EXTRA_CA_CERTS/);
  });

  it('keeps the cause server-side for a user-supplied server', () => {
    const body = verificationFailureBody('stalwart-context', tlsError(), 'https://custom.example', false);
    expect(body).toEqual({ error: 'Failed to verify JMAP session' });
  });
});

describe('insecureCookieHint', () => {
  it('warns when Secure cookies are set for a plain-http page', () => {
    vi.stubEnv('COOKIE_SECURE', 'true');
    expect(insecureCookieHint(requestFrom('http://192.168.1.20:3000'))).toMatch(/COOKIE_SECURE=false/);
  });

  it('stays quiet over https, on loopback, without Origin, or with COOKIE_SECURE=false', () => {
    vi.stubEnv('COOKIE_SECURE', 'true');
    expect(insecureCookieHint(requestFrom('https://webmail.example'))).toBeUndefined();
    expect(insecureCookieHint(requestFrom('http://localhost:3000'))).toBeUndefined();
    expect(insecureCookieHint(requestFrom('http://127.0.0.1:3000'))).toBeUndefined();
    expect(insecureCookieHint(requestFrom(null))).toBeUndefined();
    vi.stubEnv('COOKIE_SECURE', 'false');
    expect(insecureCookieHint(requestFrom('http://192.168.1.20:3000'))).toBeUndefined();
  });
});

describe('explainServerAuthError', () => {
  it('appends the recorded reason to a 401', () => {
    setServerAuthIssue('The webmail server does not trust the mail server\'s TLS certificate.');
    expect(explainServerAuthError(401, 'Not authenticated', 'Failed')).toBe(
      'Not authenticated: The webmail server does not trust the mail server\'s TLS certificate.',
    );
  });

  it('leaves other errors and unexplained 401s alone', () => {
    expect(explainServerAuthError(401, 'Not authenticated', 'Failed')).toBe('Not authenticated');
    setServerAuthIssue('reason');
    expect(explainServerAuthError(502, 'Remote server returned 404', 'Failed')).toBe('Remote server returned 404');
    expect(explainServerAuthError(500, undefined, 'Failed')).toBe('Failed');
  });
});
