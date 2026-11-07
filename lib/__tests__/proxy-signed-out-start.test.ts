/**
 * @vitest-environment node
 *
 * proxy.ts sends a page load of the root with no session cookie and no kept
 * accounts to the sign-in page (lib/signed-out-start.ts) instead of starting
 * the mail view, which only found out after downloading and running it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

let demoMode = false;
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: vi.fn(async () => {}),
    get: vi.fn((key: string, fallback: unknown) => (key === 'demoMode' ? demoMode : fallback)),
    getPolicy: vi.fn(() => ({ features: {} })),
  },
}));
vi.mock('@/lib/setup/state', () => ({ detectSetupState: vi.fn(() => 'configured') }));
vi.mock('@/lib/admin/csp-frame-origins', () => ({ getEnabledPluginFrameOrigins: vi.fn(async () => []) }));
// Stands in for next-intl (its ESM build doesn't load under vitest's node
// resolver): rewrites to /en, or with localePrefix "always" redirects there
// and sets its locale cookie.
let intlMode: 'rewrite' | 'redirect' = 'rewrite';
vi.mock('next-intl/middleware', async () => {
  const { NextResponse } = await import('next/server');
  return {
    default: () => (request: Request) => {
      const url = new URL(request.url);
      url.pathname = url.pathname === '/' ? '/en' : `/en${url.pathname}`;
      if (intlMode === 'redirect') {
        const response = NextResponse.redirect(url);
        response.cookies.set('NEXT_LOCALE', 'en');
        return response;
      }
      return NextResponse.rewrite(url);
    },
  };
});

import { proxy } from '@/proxy';

const PAGE_LOAD = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', accept: 'text/html,application/xhtml+xml' };

function load(url: string, headers: Record<string, string> = {}) {
  return proxy(new NextRequest(url, { headers: { ...PAGE_LOAD, ...headers } }));
}

beforeEach(() => {
  intlMode = 'rewrite';
  demoMode = false;
});

describe('proxy: a signed-out first visit goes straight to the sign-in page', () => {
  it('redirects the root to /login and marks the redirect for the page script', async () => {
    const response = await load('https://mail.example.com/');
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://mail.example.com/login');
    const start = response.cookies.get('bulwark_start');
    expect(start?.value).toBe('1');
    expect(start?.maxAge).toBe(60);
    expect(start?.httpOnly).toBeFalsy();
    // Still a page of the app's: the security headers are on the redirect too.
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  it('goes to the locale\'s sign-in page in one step when the locale middleware redirects', async () => {
    intlMode = 'redirect';
    const response = await load('https://mail.example.com/');
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://mail.example.com/en/login');
    expect(response.cookies.get('NEXT_LOCALE')?.value).toBe('en');
    const prefixed = await load('https://mail.example.com/en');
    expect(prefixed.headers.get('location')).toBe('https://mail.example.com/en/login');
  });

  it('starts the mail view as before with a session cookie or kept accounts', async () => {
    for (const cookie of ['jmap_session_0=abc', 'jmap_rt=x', 'bulwark_local=1']) {
      const response = await load('https://mail.example.com/', { cookie });
      expect(response.headers.get('location'), cookie).toBeNull();
      expect(response.headers.get('x-middleware-rewrite'), cookie).toBe('https://mail.example.com/en');
    }
  });

  it('leaves router requests, deep links, queries and demo mode alone', async () => {
    expect((await load('https://mail.example.com/', { rsc: '1', 'sec-fetch-dest': 'empty' })).headers.get('location')).toBeNull();
    expect((await load('https://mail.example.com/mail/message/abc')).headers.get('location')).toBeNull();
    expect((await load('https://mail.example.com/?mailto=a%40b.c')).headers.get('location')).toBeNull();
    expect((await load('https://mail.example.com/', { 'sec-fetch-dest': 'iframe' })).headers.get('location')).toBeNull();
    demoMode = true;
    expect((await load('https://mail.example.com/')).headers.get('location')).toBeNull();
  });
});
