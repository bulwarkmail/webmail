import { describe, expect, it } from 'vitest';
import {
  isValidFrameOrigin,
  sanitizeFrameOrigins,
} from '@/lib/admin/csp-frame-origins';

describe('isValidFrameOrigin', () => {
  it('accepts plain https origins', () => {
    expect(isValidFrameOrigin('https://www.youtube-nocookie.com')).toBe(true);
    expect(isValidFrameOrigin('https://meet.example.com')).toBe(true);
    expect(isValidFrameOrigin('https://a.b.c.example.com')).toBe(true);
  });

  it('accepts a wildcard subdomain', () => {
    expect(isValidFrameOrigin('https://*.example.com')).toBe(true);
    expect(isValidFrameOrigin('https://*.youtube.com')).toBe(true);
  });

  it('accepts an explicit port', () => {
    expect(isValidFrameOrigin('https://meet.example.com:8443')).toBe(true);
    expect(isValidFrameOrigin('https://*.example.com:443')).toBe(true);
  });

  it('rejects non-https schemes', () => {
    expect(isValidFrameOrigin('http://example.com')).toBe(false);
    expect(isValidFrameOrigin('ftp://example.com')).toBe(false);
    expect(isValidFrameOrigin('data:text/html,foo')).toBe(false);
    expect(isValidFrameOrigin('javascript:alert(1)')).toBe(false);
  });

  it('rejects bare schemes and wildcard hosts', () => {
    expect(isValidFrameOrigin('https://')).toBe(false);
    expect(isValidFrameOrigin('https://*')).toBe(false);
    expect(isValidFrameOrigin('https://*.com')).toBe(false);
    expect(isValidFrameOrigin('https://localhost')).toBe(false);
  });

  it('rejects paths, queries, and fragments', () => {
    expect(isValidFrameOrigin('https://example.com/embed')).toBe(false);
    expect(isValidFrameOrigin('https://example.com/')).toBe(false);
    expect(isValidFrameOrigin('https://example.com?x=1')).toBe(false);
    expect(isValidFrameOrigin('https://example.com#x')).toBe(false);
  });

  it('rejects userinfo, IPs, and IPv6', () => {
    expect(isValidFrameOrigin('https://user:pass@example.com')).toBe(false);
    expect(isValidFrameOrigin('https://1.2.3.4')).toBe(false);
    expect(isValidFrameOrigin('https://[::1]')).toBe(false);
  });

  it('rejects values that try to break out of the directive', () => {
    expect(isValidFrameOrigin("https://example.com'; script-src 'unsafe-eval")).toBe(false);
    expect(isValidFrameOrigin('https://example.com" data:')).toBe(false);
    expect(isValidFrameOrigin('https://example.com data:')).toBe(false);
    expect(isValidFrameOrigin('https://example.com\nhttps://evil.com')).toBe(false);
    expect(isValidFrameOrigin('https://example.com;https://evil.com')).toBe(false);
    expect(isValidFrameOrigin('https://exa,mple.com')).toBe(false);
  });

  it('rejects non-strings and obvious garbage', () => {
    expect(isValidFrameOrigin(undefined)).toBe(false);
    expect(isValidFrameOrigin(null)).toBe(false);
    expect(isValidFrameOrigin(42)).toBe(false);
    expect(isValidFrameOrigin('')).toBe(false);
    expect(isValidFrameOrigin('not-a-url')).toBe(false);
    expect(isValidFrameOrigin('a'.repeat(300))).toBe(false);
  });
});

describe('sanitizeFrameOrigins', () => {
  it('returns empty for non-array input', () => {
    expect(sanitizeFrameOrigins(undefined)).toEqual([]);
    expect(sanitizeFrameOrigins(null)).toEqual([]);
    expect(sanitizeFrameOrigins('https://example.com')).toEqual([]);
    expect(sanitizeFrameOrigins({})).toEqual([]);
  });

  it('keeps valid entries and drops invalid ones silently', () => {
    expect(
      sanitizeFrameOrigins([
        'https://www.youtube-nocookie.com',
        'http://insecure.com',
        'https://meet.example.com:8443',
        'https://example.com/path',
        42,
        'https://*.vimeo.com',
      ]),
    ).toEqual([
      'https://www.youtube-nocookie.com',
      'https://meet.example.com:8443',
      'https://*.vimeo.com',
    ]);
  });

  it('dedupes case-insensitively', () => {
    expect(
      sanitizeFrameOrigins([
        'https://Example.com',
        'https://example.com',
        'https://EXAMPLE.com',
      ]),
    ).toEqual(['https://Example.com']);
  });
});
