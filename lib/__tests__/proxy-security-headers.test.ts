/**
 * @vitest-environment node
 *
 * The proxy used to treat every path whose last segment contains a dot as a
 * static asset and return before setting the CSP, X-Content-Type-Options and
 * the other security headers. This app routes [[...segments]] catch-alls
 * under /<locale>/mail, /calendar, /contacts and /files, so
 * /en/mail/folder/inbox/statement.pdf is a real, signed-in page - and it was
 * served without a CSP, which let a sender-typed blob: URL opened from that
 * document execute in the webmail origin (GHSA-xvjh-v9c6-qcvc). Only what
 * Next genuinely serves from public/ may skip the headers now.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: vi.fn(async () => {}),
    get: vi.fn((_key: string, fallback: unknown) => fallback),
    getPolicy: vi.fn(() => ({ features: { pluginsEnabled: false } })),
  },
}));
vi.mock('@/lib/setup/state', () => ({ detectSetupState: vi.fn(() => 'configured') }));
vi.mock('@/lib/admin/csp-frame-origins', () => ({ getEnabledPluginFrameOrigins: vi.fn(async () => []) }));
vi.mock('next-intl/middleware', async () => {
  const { NextResponse } = await import('next/server');
  return { default: () => () => NextResponse.next() };
});

import { proxy, isStaticAssetPath } from '@/proxy';

function load(path: string): Promise<Response> {
  return proxy(new NextRequest('http://localhost:3000' + path, {
    headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' },
  }));
}

const SECURITY_HEADERS = ['content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'permissions-policy'];

// Signed-in pages whose last segment happens to contain a dot.
const DOTTED_APP_PATHS = [
  '/en/mail/folder/inbox/statement.pdf',
  '/de/mail/folder/inbox/statement.pdf',
  '/en/calendar/2026/09/17.ics',
  '/en/contacts/jan.kahmen',
  '/en/files/reports/q3.xlsx',
  '/en/settings/account.json',
  '/mail/folder/inbox/statement.pdf',
  '/en/.well-known/security.txt',
];

// What public/ (and Next's own route handlers at the root) actually serve.
const STATIC_ASSETS = [
  '/sw.js',
  '/favicon.ico',
  '/manifest.webmanifest',
  '/icon-192x192.png',
  '/branding/logo.png',
  '/notification/cheerful-527.mp3',
  '/demo/prototype-v3.png',
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('security headers on dotted app paths (GHSA-xvjh-v9c6-qcvc)', () => {
  it.each(DOTTED_APP_PATHS)('serves %s with the full security header set', async (path) => {
    const response = await load(path);

    expect(response.status).toBe(200);
    for (const header of SECURITY_HEADERS) {
      expect(response.headers.get(header), header).not.toBeNull();
    }
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+'/);
    expect(csp).not.toContain("'unsafe-eval'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    // The nonce reaches the layout the same way it does on /en/mail/folder/inbox.
    expect(response.headers.get('x-middleware-request-x-nonce')).toBeTruthy();
    expect(response.headers.get('x-middleware-request-x-pathname')).toBe(path);
  });

  it('gives a dotted app path the same policy as its canonical sibling', async () => {
    const dotted = await load('/en/mail/folder/inbox/statement.pdf');
    const canonical = await load('/en/mail/folder/inbox');

    const strip = (csp: string | null) => (csp ?? '').replace(/'nonce-[^']+'/g, "'nonce-X'");
    expect(strip(dotted.headers.get('content-security-policy'))).toBe(strip(canonical.headers.get('content-security-policy')));
    for (const header of SECURITY_HEADERS.filter((h) => h !== 'content-security-policy')) {
      expect(dotted.headers.get(header)).toBe(canonical.headers.get(header));
    }
  });

  it.each(STATIC_ASSETS)('still passes %s straight through untouched', async (path) => {
    const response = await load(path);

    expect(response.status).toBe(200);
    // No page CSP (frame-ancestors alone restricts nothing a script or
    // image does) and no locale routing.
    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(response.headers.get('x-middleware-request-x-nonce')).toBeNull();
  });

  it.each(['/api/auth/session', '/_next/static/chunks/main.js', '/_next/image'])('still skips %s', async (path) => {
    const response = await load(path);

    expect(response.headers.get('content-security-policy') ?? '').not.toContain('script-src');
  });

  it.each(['/missing.html', '/branding/nothing-here', '/_next/static/x.js'])(
    'keeps %s from being framed or sniffed',
    async (path) => {
      const response = await load(path);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    },
  );

  it('leaves the CSP of API routes to the route', async () => {
    const response = await load('/api/unknown');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('content-security-policy')).toBeNull();
  });
});

describe('ALLOWED_FRAME_ANCESTORS', () => {
  const original = process.env.ALLOWED_FRAME_ANCESTORS;
  beforeEach(() => {
    process.env.ALLOWED_FRAME_ANCESTORS = 'https://portal.example';
  });
  afterEach(() => {
    if (original === undefined) delete process.env.ALLOWED_FRAME_ANCESTORS;
    else process.env.ALLOWED_FRAME_ANCESTORS = original;
  });

  it('lets a portal frame the mail UI', async () => {
    const res = await load('/en/mail');
    expect(res.headers.get('content-security-policy')).toContain('frame-ancestors https://portal.example');
  });

  it.each(['/admin', '/admin/login', '/admin/settings'])('never lets anyone frame %s', async (path) => {
    const res = await load(path);
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
});

describe('isStaticAssetPath', () => {
  it('matches only root-level files and the public/ asset folders', () => {
    for (const path of STATIC_ASSETS) expect(isStaticAssetPath(path), path).toBe(true);
    for (const path of DOTTED_APP_PATHS) expect(isStaticAssetPath(path), path).toBe(false);
    expect(isStaticAssetPath('/en')).toBe(false);
    expect(isStaticAssetPath('/en/mail')).toBe(false);
    expect(isStaticAssetPath('/brandingx/logo.png')).toBe(false);
  });
});
