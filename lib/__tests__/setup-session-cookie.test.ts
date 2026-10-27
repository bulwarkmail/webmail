import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { buildSessionCookieAttributes } from '@/lib/setup/session';

// The wizard cookie carries the setup token. Like the admin cookie, its Secure
// flag follows the request unless COOKIE_SECURE says otherwise: behind a TLS
// proxy that sends no X-Forwarded-Proto the request looks like plain HTTP.
describe('setup wizard cookie Secure flag', () => {
  afterEach(() => vi.unstubAllEnvs());

  const secureFor = (url: string, headers: Record<string, string> = {}) =>
    buildSessionCookieAttributes(new NextRequest(url, { headers })).secure;

  it('follows the request', () => {
    expect(secureFor('http://app:3000/api/setup/token', { 'x-forwarded-proto': 'https' })).toBe(true);
    expect(secureFor('http://app:3000/api/setup/token')).toBe(false);
  });

  it('lets COOKIE_SECURE win over the request', () => {
    vi.stubEnv('COOKIE_SECURE', 'true');
    expect(secureFor('http://app:3000/api/setup/token')).toBe(true);
    vi.stubEnv('COOKIE_SECURE', 'false');
    expect(secureFor('http://app:3000/api/setup/token', { 'x-forwarded-proto': 'https' })).toBe(false);
  });
});
