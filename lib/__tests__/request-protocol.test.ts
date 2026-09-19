import { describe, expect, it } from 'vitest';
import { isHttpsRequest } from '@/lib/security/request-protocol';

const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });

describe('isHttpsRequest', () => {
  it('trusts the proxy header over the scheme the app itself sees', () => {
    // The app always sees plain HTTP behind a TLS-terminating proxy.
    expect(isHttpsRequest(req('http://webmail.internal:3000/api/admin/auth', { 'x-forwarded-proto': 'https' }))).toBe(true);
    expect(isHttpsRequest(req('https://webmail.internal/api/admin/auth', { 'x-forwarded-proto': 'http' }))).toBe(false);
  });

  it('reads the first hop of a comma-separated forwarded list, case-insensitively', () => {
    expect(isHttpsRequest(req('http://x/', { 'x-forwarded-proto': 'HTTPS, http' }))).toBe(true);
    expect(isHttpsRequest(req('http://x/', { 'x-forwarded-proto': ' http ,https' }))).toBe(false);
  });

  it('falls back to the request URL without a proxy', () => {
    expect(isHttpsRequest(req('https://localhost:3000/'))).toBe(true);
    expect(isHttpsRequest(req('http://localhost:3000/'))).toBe(false);
  });
});
