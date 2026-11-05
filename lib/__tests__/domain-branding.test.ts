import { describe, it, expect } from 'vitest';
import {
  brandPaletteCss,
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

describe('palette', () => {
  it('keeps hex colours for the known tokens, trimmed and lower-cased', () => {
    const [entry] = parseDomainBranding([{
      host: 'mail.example.com',
      palette: {
        light: { primary: ' #0B3D91 ', 'primary-foreground': '#fff' },
        dark: { primary: '#7cc4ff', accent: '#08506b80', 'accent-foreground': '#abcd' },
      },
    }]);
    expect(entry.palette).toEqual({
      light: { primary: '#0b3d91', 'primary-foreground': '#fff' },
      dark: { primary: '#7cc4ff', accent: '#08506b80', 'accent-foreground': '#abcd' },
    });
  });

  it('keeps a light-only or dark-only palette as it is', () => {
    const [light, dark] = parseDomainBranding([
      { host: 'light.example.com', palette: { light: { primary: '#0b3d91' } } },
      { host: 'dark.example.com', palette: { dark: { accent: '#123456' } } },
    ]);
    expect(light.palette).toEqual({ light: { primary: '#0b3d91' } });
    expect(dark.palette).toEqual({ dark: { accent: '#123456' } });
  });

  it('drops values that are not hex colours, unknown tokens and CSS break-out attempts', () => {
    const [entry] = parseDomainBranding([{
      host: 'mail.example.com',
      palette: {
        light: {
          primary: 'red',
          'primary-foreground': '#fff;}</style><script>alert(1)</script>',
          accent: 'url(https://example.com/x.png)',
          'accent-foreground': 'expression(alert(1))',
          background: '#ffffff',
          '--evil': '#000000',
        },
        dark: {
          primary: '#000;}body{display:none',
          'primary-foreground': 'rgb(0, 0, 0)',
          accent: '#12',
          'accent-foreground': 42,
        },
      },
    }]);
    expect(entry).toEqual({ host: 'mail.example.com' });
  });

  it('drops comments, CSS escapes and oversized values', () => {
    const [entry] = parseDomainBranding([{
      host: 'mail.example.com',
      palette: { light: { primary: '#fff/**/', accent: '\\23fff', 'accent-foreground': `#${'f'.repeat(100_000)}` } },
    }]);
    expect(entry).toEqual({ host: 'mail.example.com' });
  });

  it('keeps only the trimmed colour of a value with a trailing newline', () => {
    const [entry] = parseDomainBranding([{ host: 'mail.example.com', palette: { light: { primary: '#fff\n' } } }]);
    expect(entry.palette).toEqual({ light: { primary: '#fff' } });
  });

  it('keeps the valid colours next to dropped ones', () => {
    const [entry] = parseDomainBranding([{
      host: 'mail.example.com',
      palette: { light: { primary: 'url(x)', accent: '#abc' }, dark: { primary: '#gggggg' } },
    }]);
    expect(entry.palette).toEqual({ light: { accent: '#abc' } });
  });

  it('ignores a palette or colour mode that is not an object', () => {
    expect(parseDomainBranding([
      { host: 'a.example.com', palette: '#0b3d91' },
      { host: 'b.example.com', palette: ['#0b3d91'] },
      { host: 'c.example.com', palette: { light: '#0b3d91', dark: ['#0b3d91'] } },
      { host: 'd.example.com', palette: null },
    ])).toEqual([
      { host: 'a.example.com' },
      { host: 'b.example.com' },
      { host: 'c.example.com' },
      { host: 'd.example.com' },
    ]);
  });

  it('is matched per host with the rest of the entry', () => {
    const entries = parseDomainBranding([
      { host: 'one.example.com', palette: { light: { primary: '#0b3d91' } } },
      { host: 'two.example.com', palette: { light: { primary: '#7c2d12' } } },
      { host: 'plain.example.com', loginCompanyName: 'Plain' },
    ]);
    expect(matchDomainBranding('one.example.com', entries).palette).toEqual({ light: { primary: '#0b3d91' } });
    expect(matchDomainBranding('two.example.com', entries).palette).toEqual({ light: { primary: '#7c2d12' } });
    expect(matchDomainBranding('plain.example.com', entries).palette).toBeUndefined();
    expect(matchDomainBranding('other.example.com', entries).palette).toBeUndefined();
  });

  it('survives a round trip through JSON, as the admin config stores it', () => {
    const entries = parseDomainBranding([
      { host: 'mail.example.com', loginCompanyName: 'Acme', palette: { dark: { primary: '#7cc4ff' } } },
    ]);
    expect(parseDomainBranding(JSON.stringify(entries))).toEqual(entries);
  });
});

describe('brandPaletteCss', () => {
  it('renders light colours as --brand-* and dark ones as --brand-dark-*', () => {
    expect(brandPaletteCss({
      light: { primary: '#0b3d91', 'primary-foreground': '#ffffff' },
      dark: { primary: '#7cc4ff' },
    })).toBe(':root{--brand-primary:#0b3d91;--brand-primary-foreground:#ffffff;--brand-dark-primary:#7cc4ff}');
  });

  it('renders a light-only and a dark-only palette', () => {
    expect(brandPaletteCss({ light: { accent: '#abc' } })).toBe(':root{--brand-accent:#abc}');
    expect(brandPaletteCss({ dark: { 'accent-foreground': '#123456' } }))
      .toBe(':root{--brand-dark-accent-foreground:#123456}');
  });

  it('renders nothing without a palette', () => {
    expect(brandPaletteCss(undefined)).toBe('');
    expect(brandPaletteCss({})).toBe('');
    expect(brandPaletteCss({ light: {}, dark: {} })).toBe('');
  });

  it('never writes a value that is not a hex colour, even when handed one directly', () => {
    expect(brandPaletteCss({
      light: { primary: '#fff;}</style><script>alert(1)</script>', accent: 'url(x)', 'accent-foreground': '#fff\n' },
      dark: { primary: 'expression(alert(1))' },
    })).toBe('');
  });

  it('only declares --brand-* variables, never a --color-* token', () => {
    const css = brandPaletteCss({
      light: { primary: '#000001', 'primary-foreground': '#000002', accent: '#000003', 'accent-foreground': '#000004' },
      dark: { primary: '#000005', 'primary-foreground': '#000006', accent: '#000007', 'accent-foreground': '#000008' },
    });
    expect(css).toMatch(/^:root\{(--brand-(dark-)?[a-z-]+:#[0-9a-f]{6};?){8}\}$/);
    expect(css).not.toContain('--color-');
  });
});
