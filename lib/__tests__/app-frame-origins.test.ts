import { describe, expect, it } from 'vitest';
import {
  MAX_APP_FRAME_ORIGINS,
  appUrlToFrameOrigin,
  inlineAppFrameOrigins,
  isValidAppFrameOrigin,
  parseAppFrameOrigins,
  serializeAppFrameOrigins,
} from '@/lib/security/app-frame-origins';

describe('isValidAppFrameOrigin', () => {
  it('accepts http and https origins', () => {
    expect(isValidAppFrameOrigin('https://www.google.com')).toBe(true);
    expect(isValidAppFrameOrigin('http://intranet.example.com')).toBe(true);
  });

  it('accepts self-hosted shapes the plugin validator rejects', () => {
    expect(isValidAppFrameOrigin('http://localhost:3000')).toBe(true);
    expect(isValidAppFrameOrigin('http://192.168.1.10:8080')).toBe(true);
    expect(isValidAppFrameOrigin('http://[fd00::1]:8080')).toBe(true);
  });

  it('rejects non-http(s) schemes', () => {
    expect(isValidAppFrameOrigin('ftp://example.com')).toBe(false);
    expect(isValidAppFrameOrigin('data:text/html,foo')).toBe(false);
    expect(isValidAppFrameOrigin('javascript:alert(1)')).toBe(false);
    expect(isValidAppFrameOrigin('blob:https://example.com/x')).toBe(false);
  });

  it('rejects paths, wildcards and bare hosts', () => {
    expect(isValidAppFrameOrigin('https://example.com/app')).toBe(false);
    expect(isValidAppFrameOrigin('https://example.com/')).toBe(false);
    expect(isValidAppFrameOrigin('https://*.example.com')).toBe(false);
    expect(isValidAppFrameOrigin('https://')).toBe(false);
    expect(isValidAppFrameOrigin('example.com')).toBe(false);
  });

  it('rejects values that could break out of the CSP directive', () => {
    expect(isValidAppFrameOrigin("https://example.com; script-src 'unsafe-inline'")).toBe(false);
    expect(isValidAppFrameOrigin('https://example.com foo')).toBe(false);
    expect(isValidAppFrameOrigin("https://example.com'")).toBe(false);
    expect(isValidAppFrameOrigin('https://ex\nample.com')).toBe(false);
    expect(isValidAppFrameOrigin('https://user:pass@example.com')).toBe(false);
    expect(isValidAppFrameOrigin(`https://${'a'.repeat(300)}.com`)).toBe(false);
    expect(isValidAppFrameOrigin(null)).toBe(false);
  });
});

describe('appUrlToFrameOrigin', () => {
  it('reduces a configured URL to its origin', () => {
    expect(appUrlToFrameOrigin('https://www.google.com')).toBe('https://www.google.com');
    expect(appUrlToFrameOrigin('https://example.com/apps/board?x=1#y')).toBe('https://example.com');
    expect(appUrlToFrameOrigin('http://nas:8080/ui')).toBe('http://nas:8080');
  });

  it('normalises case and default ports', () => {
    expect(appUrlToFrameOrigin('https://Example.COM:443/app')).toBe('https://example.com');
    expect(appUrlToFrameOrigin('http://Example.com:80')).toBe('http://example.com');
    expect(appUrlToFrameOrigin('https://example.com:8443')).toBe('https://example.com:8443');
  });

  it('rejects unusable URLs', () => {
    expect(appUrlToFrameOrigin('not a url')).toBeNull();
    expect(appUrlToFrameOrigin('javascript:alert(1)')).toBeNull();
    expect(appUrlToFrameOrigin('mailto:a@b.com')).toBeNull();
    expect(appUrlToFrameOrigin('')).toBeNull();
    expect(appUrlToFrameOrigin(undefined)).toBeNull();
  });
});

describe('inlineAppFrameOrigins', () => {
  it('collects only the apps that open inline', () => {
    const origins = inlineAppFrameOrigins([
      { url: 'https://www.google.com', openMode: 'inline' },
      { url: 'https://news.example.com', openMode: 'tab' },
      { url: 'https://board.example.com/x', openMode: 'inline' },
    ]);
    expect(origins).toEqual(['https://www.google.com', 'https://board.example.com']);
  });

  it('dedupes apps sharing an origin and drops invalid URLs', () => {
    const origins = inlineAppFrameOrigins([
      { url: 'https://example.com/a', openMode: 'inline' },
      { url: 'https://example.com/b', openMode: 'inline' },
      { url: 'notaurl', openMode: 'inline' },
    ]);
    expect(origins).toEqual(['https://example.com']);
  });

  it('caps the list and tolerates missing input', () => {
    const many = Array.from({ length: MAX_APP_FRAME_ORIGINS + 5 }, (_, i) => ({
      url: `https://app${i}.example.com`,
      openMode: 'inline',
    }));
    expect(inlineAppFrameOrigins(many)).toHaveLength(MAX_APP_FRAME_ORIGINS);
    expect(inlineAppFrameOrigins(undefined)).toEqual([]);
  });
});

describe('cookie round-trip', () => {
  it('survives serialize → parse', () => {
    const origins = ['https://www.google.com', 'http://localhost:3000'];
    expect(parseAppFrameOrigins(serializeAppFrameOrigins(origins))).toEqual(origins);
  });

  it('encodes the separator so the cookie value stays a single token', () => {
    const value = serializeAppFrameOrigins(['https://a.example.com', 'https://b.example.com']);
    expect(value).not.toContain(' ');
    expect(value).not.toContain(';');
  });

  it('drops invalid entries instead of the whole list', () => {
    const raw = encodeURIComponent("https://good.example.com bad;value https://also-good.example.com");
    expect(parseAppFrameOrigins(raw)).toEqual([
      'https://good.example.com',
      'https://also-good.example.com',
    ]);
  });

  it('returns nothing for empty, malformed or hostile values', () => {
    expect(parseAppFrameOrigins(undefined)).toEqual([]);
    expect(parseAppFrameOrigins('')).toEqual([]);
    expect(parseAppFrameOrigins('%E0%A4%A')).toEqual([]); // malformed percent-encoding
    expect(parseAppFrameOrigins(encodeURIComponent("'unsafe-inline'"))).toEqual([]);
    expect(parseAppFrameOrigins(encodeURIComponent('*'))).toEqual([]);
  });

  it('caps how many origins a cookie can contribute', () => {
    const many = Array.from({ length: MAX_APP_FRAME_ORIGINS + 5 }, (_, i) => `https://app${i}.example.com`);
    expect(parseAppFrameOrigins(many.join(' '))).toHaveLength(MAX_APP_FRAME_ORIGINS);
  });
});
