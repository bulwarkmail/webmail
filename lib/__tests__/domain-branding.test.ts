import { describe, it, expect } from 'vitest';
import {
  matchDomainBranding,
  parseDomainBranding,
  pickRequestHost,
  type DomainBrandingEntry,
} from '@/lib/admin/domain-branding';

function mockHeaders(map: Record<string, string>): Headers {
  const lc: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) lc[k.toLowerCase()] = v;
  return {
    get(name: string) {
      return lc[name.toLowerCase()] ?? null;
    },
  } as unknown as Headers;
}

describe('parseDomainBranding', () => {
  it('returns [] for null/undefined/empty', () => {
    expect(parseDomainBranding(null)).toEqual([]);
    expect(parseDomainBranding(undefined)).toEqual([]);
    expect(parseDomainBranding('')).toEqual([]);
    expect(parseDomainBranding([])).toEqual([]);
  });

  it('parses a stringified JSON array', () => {
    const raw = JSON.stringify([{ host: 'mail.example.com', loginCompanyName: 'Acme' }]);
    expect(parseDomainBranding(raw)).toEqual([
      { host: 'mail.example.com', loginCompanyName: 'Acme' },
    ]);
  });

  it('lower-cases hosts and strips trailing dots', () => {
    expect(parseDomainBranding([{ host: 'Mail.Example.COM.' }])).toEqual([
      { host: 'mail.example.com' },
    ]);
  });

  it('accepts wildcard hosts', () => {
    expect(parseDomainBranding([{ host: '*.example.com', loginCompanyName: 'Wild' }])).toEqual([
      { host: '*.example.com', loginCompanyName: 'Wild' },
    ]);
  });

  it('drops entries with invalid hosts', () => {
    const out = parseDomainBranding([
      { host: '' },
      { host: 'has space.com' },
      { host: 'foo..bar' },
      { host: '*.*.example.com' }, // embedded wildcard not allowed
      { host: 'good.example.com' },
    ]);
    expect(out.map(e => e.host)).toEqual(['good.example.com']);
  });

  it('drops duplicate hosts, keeping the first', () => {
    const out = parseDomainBranding([
      { host: 'foo.com', loginCompanyName: 'First' },
      { host: 'FOO.com', loginCompanyName: 'Second' },
    ]);
    expect(out).toEqual([{ host: 'foo.com', loginCompanyName: 'First' }]);
  });

  it('ignores non-string and empty-string override fields', () => {
    const out = parseDomainBranding([
      {
        host: 'foo.com',
        loginCompanyName: '',
        loginImprintUrl: 42,
        loginWebsiteUrl: 'https://foo.com',
      },
    ]);
    expect(out).toEqual([{ host: 'foo.com', loginWebsiteUrl: 'https://foo.com' }]);
  });

  it('ignores unknown fields', () => {
    const out = parseDomainBranding([
      { host: 'foo.com', notARealField: 'x', loginCompanyName: 'OK' },
    ]);
    expect(out).toEqual([{ host: 'foo.com', loginCompanyName: 'OK' }]);
  });
});

describe('pickRequestHost', () => {
  it('returns null when no host headers are set', () => {
    expect(pickRequestHost(mockHeaders({}))).toBeNull();
  });

  it('prefers X-Forwarded-Host over Host', () => {
    expect(pickRequestHost(mockHeaders({
      'x-forwarded-host': 'forwarded.example.com',
      host: 'origin.example.com',
    }))).toBe('forwarded.example.com');
  });

  it('falls back to Host when X-Forwarded-Host is absent', () => {
    expect(pickRequestHost(mockHeaders({ host: 'origin.example.com' }))).toBe('origin.example.com');
  });

  it('strips the port', () => {
    expect(pickRequestHost(mockHeaders({ host: 'example.com:8080' }))).toBe('example.com');
  });

  it('takes the first entry of a comma-separated X-Forwarded-Host', () => {
    expect(pickRequestHost(mockHeaders({
      'x-forwarded-host': 'first.example.com, second.example.com',
    }))).toBe('first.example.com');
  });

  it('lower-cases the result', () => {
    expect(pickRequestHost(mockHeaders({ host: 'EXAMPLE.com' }))).toBe('example.com');
  });

  it('handles a ReadonlyHeaders-shaped object with an internal `headers` field', () => {
    // `await headers()` returns Next's ReadonlyHeaders, which exposes `.get`
    // directly but also carries an internal `headers` property. Ensure we use
    // its own `.get` rather than descending into `.headers` (#585).
    const readonlyLike = Object.assign(mockHeaders({ host: 'ro.example.com' }), {
      headers: { notCallable: true },
    });
    expect(pickRequestHost(readonlyLike as unknown as Headers)).toBe('ro.example.com');
  });
});

describe('matchDomainBranding', () => {
  const entries: DomainBrandingEntry[] = [
    { host: 'mail.example.com', loginCompanyName: 'Exact' },
    { host: '*.example.com', loginCompanyName: 'Wildcard' },
    { host: '*.dev.example.com', loginCompanyName: 'Specific Wildcard' },
    { host: 'other.com', loginCompanyName: 'Other' },
  ];

  it('returns {} when host is null', () => {
    expect(matchDomainBranding(null, entries)).toEqual({});
  });

  it('returns {} when no entries match', () => {
    expect(matchDomainBranding('unknown.org', entries)).toEqual({});
  });

  it('prefers exact match over wildcard', () => {
    expect(matchDomainBranding('mail.example.com', entries).loginCompanyName).toBe('Exact');
  });

  it('matches wildcards on subdomains', () => {
    expect(matchDomainBranding('foo.example.com', entries).loginCompanyName).toBe('Wildcard');
  });

  it('prefers the longest wildcard suffix', () => {
    expect(matchDomainBranding('app.dev.example.com', entries).loginCompanyName).toBe('Specific Wildcard');
  });

  it('does not match the wildcard host against the apex domain', () => {
    expect(matchDomainBranding('example.com', entries)).toEqual({});
  });

  it('is case-insensitive on the request host', () => {
    expect(matchDomainBranding('Mail.Example.COM', entries).loginCompanyName).toBe('Exact');
  });
});
