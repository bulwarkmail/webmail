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

// Saved in the admin dashboard (config.json); the environment comes next,
// as in the real config manager.
const adminConfig = vi.hoisted(() => ({} as Record<string, unknown>));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: vi.fn(async () => {}),
    get: vi.fn((key: string, fallback: unknown) => {
      if (key in adminConfig) return adminConfig[key];
      if (key === 'allowedFrameAncestors') return process.env.ALLOWED_FRAME_ANCESTORS ?? fallback;
      return fallback;
    }),
    getPolicy: vi.fn(() => ({ features: { pluginsEnabled: false } })),
  },
}));
vi.mock('@/lib/setup/state', () => ({ detectSetupState: vi.fn(() => 'configured') }));
vi.mock('@/lib/admin/csp-frame-origins', () => ({ getEnabledPluginFrameOrigins: vi.fn(async () => []) }));
vi.mock('next-intl/middleware', async () => {
  const { NextResponse } = await import('next/server');
  return { default: () => () => NextResponse.next() };
});

import { proxy, isStaticAssetPath, mailFrameAncestors } from '@/proxy';
import { configManager } from '@/lib/admin/config-manager';
import { getEnabledPluginFrameOrigins } from '@/lib/admin/csp-frame-origins';

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
  // The plugin sandbox document's script (scripts/build-plugin-sandbox.mjs).
  '/plugin-sandbox-assets/runtime-ABC123.js',
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

  it('sends HSTS only on a request that arrived over TLS', async () => {
    const plain = await load('/en/mail');
    expect(plain.headers.get('strict-transport-security')).toBeNull();
    const forwarded = await proxy(new NextRequest('http://localhost:3000/en/mail', {
      headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', 'x-forwarded-proto': 'https' },
    }));
    expect(forwarded.headers.get('strict-transport-security')).toBe('max-age=63072000');
    const direct = await proxy(new NextRequest('https://webmail.example/en/mail', {
      headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' },
    }));
    expect(direct.headers.get('strict-transport-security')).toBe('max-age=63072000');
  });

  it('lets a portal frame the mail UI', async () => {
    const res = await load('/en/mail');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'self' https://portal.example;");
    expect(res.headers.get('x-frame-options')).toBeNull();
  });

  it.each(['/admin', '/admin/login', '/admin/settings'])('never lets anyone frame %s', async (path) => {
    const res = await load(path);
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
});

// The PDF preview frames a blob: document, and Safari enforces the page's
// frame-ancestors on it, so the mail UI must always allow 'self' (#1301).
describe('frame-ancestors of the mail UI', () => {
  const original = process.env.ALLOWED_FRAME_ANCESTORS;
  afterEach(() => {
    if (original === undefined) delete process.env.ALLOWED_FRAME_ANCESTORS;
    else process.env.ALLOWED_FRAME_ANCESTORS = original;
  });

  it('allows only the app itself by default', async () => {
    delete process.env.ALLOWED_FRAME_ANCESTORS;
    const res = await load('/en/mail/folder/inbox');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'self';");
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  });

  it("reads 'none' as no other site", async () => {
    process.env.ALLOWED_FRAME_ANCESTORS = "'none'";
    const res = await load('/en/mail/folder/inbox');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'self';");
  });

  it('takes the allowed ancestors saved in the admin dashboard', async () => {
    delete process.env.ALLOWED_FRAME_ANCESTORS;
    adminConfig.allowedFrameAncestors = 'https://portal.example';
    try {
      const res = await load('/en/mail/folder/inbox');
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'self' https://portal.example;");
      expect(res.headers.get('x-frame-options')).toBeNull();
    } finally {
      delete adminConfig.allowedFrameAncestors;
    }
  });

  it("does not repeat 'self' the operator already listed", () => {
    expect(mailFrameAncestors(" https://a.example  'SELF' ")).toBe("https://a.example 'SELF'");
    expect(mailFrameAncestors('')).toBe("'self'");
    expect(mailFrameAncestors('https://a.example https://b.example;script-src https://c.example,x')).toBe("'self' https://a.example");
  });
});

// A same-site sibling host can plant the unprefixed Sidebar Apps cookie; only
// the __Host- one is trusted over HTTPS. Behind a TLS proxy that sends no
// X-Forwarded-Proto the request looks like plain HTTP, so COOKIE_SECURE=true
// has to count as HTTPS here too (GHSA-cjm9-m826-mh78).
describe('Sidebar Apps frame-src cookie', () => {
  afterEach(() => vi.unstubAllEnvs());

  const frameSrcWith = async (url: string, cookie: string, extra: Record<string, string> = {}) => {
    const res = await proxy(new NextRequest(url + '/en/mail', {
      headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', cookie, ...extra },
    }));
    return /frame-src [^;]*/.exec(res.headers.get('content-security-policy') ?? '')?.[0];
  };
  const planted = 'bulwark_app_frame_origins=https%3A%2F%2Fevil.example';

  it('trusts the unprefixed cookie on plain HTTP', async () => {
    expect(await frameSrcWith('http://localhost:3000', planted)).toContain('https://evil.example');
  });

  it('ignores the unprefixed cookie when COOKIE_SECURE=true, even without X-Forwarded-Proto', async () => {
    vi.stubEnv('COOKIE_SECURE', 'true');
    expect(await frameSrcWith('http://webmail:3000', planted)).not.toContain('evil.example');
    expect(await frameSrcWith('http://webmail:3000', '__Host-bulwark_app_frame_origins=https%3A%2F%2Fboard.example'))
      .toContain('https://board.example');
  });

  it('ignores the unprefixed cookie behind a chain of proxies that starts with https', async () => {
    expect(await frameSrcWith('http://webmail:3000', planted, { 'x-forwarded-proto': 'https, http' }))
      .not.toContain('evil.example');
  });

  it('sends HSTS when COOKIE_SECURE=true says the site is served over TLS', async () => {
    vi.stubEnv('COOKIE_SECURE', 'true');
    const res = await load('/en/mail');
    expect(res.headers.get('strict-transport-security')).toBe('max-age=63072000');
  });
});

// Plugins' declared embed origins widen frame-src only while plugins run.
describe('plugin frame origins', () => {
  afterEach(() => {
    vi.mocked(configManager.getPolicy).mockImplementation(() => ({ features: { pluginsEnabled: false } }) as never);
    vi.mocked(getEnabledPluginFrameOrigins).mockImplementation(async () => []);
  });

  const frameSrc = async () =>
    /frame-src [^;]*/.exec((await load('/en/mail')).headers.get('content-security-policy') ?? '')?.[0];

  it('leaves enabled plugins\' frame origins out while plugins are turned off', async () => {
    vi.mocked(getEnabledPluginFrameOrigins).mockImplementation(async () => ['https://video.example.com']);
    expect(await frameSrc()).not.toContain('video.example.com');

    vi.mocked(configManager.getPolicy).mockImplementation(() => ({ features: { pluginsEnabled: true } }) as never);
    expect(await frameSrc()).toContain('https://video.example.com');
  });
});

describe('isStaticAssetPath', () => {
  it('matches only root-level files and the public/ asset folders', () => {
    for (const path of STATIC_ASSETS) expect(isStaticAssetPath(path), path).toBe(true);
    for (const path of DOTTED_APP_PATHS) expect(isStaticAssetPath(path), path).toBe(false);
    expect(isStaticAssetPath('/en')).toBe(false);
    expect(isStaticAssetPath('/en/mail')).toBe(false);
    expect(isStaticAssetPath('/brandingx/logo.png')).toBe(false);
    // The sandbox documents themselves keep the sandbox CSP.
    expect(isStaticAssetPath('/plugin-sandbox')).toBe(false);
  });
});
