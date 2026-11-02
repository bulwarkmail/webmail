/**
 * @vitest-environment node
 *
 * On HOSTNAME=127.0.0.1, Next renames the host in request.nextUrl to
 * "localhost" while its router keeps 127.0.0.1. A proxy rewrite or redirect
 * built from nextUrl then points at another origin: rewrites were proxied
 * back to the server itself (over TLS when X-Forwarded-Proto said https, an
 * EPROTO 500), and with skipProxyUrlNormalize redirects would send the
 * browser to localhost (#1046, #1487).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

let setupState: 'configured' | 'bootstrap' = 'configured';

vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: vi.fn(async () => {}),
    get: vi.fn((_key: string, fallback: unknown) => fallback),
    getPolicy: vi.fn(() => ({ features: {} })),
  },
}));
vi.mock('@/lib/setup/state', () => ({ detectSetupState: vi.fn(() => setupState) }));
vi.mock('@/lib/admin/csp-frame-origins', () => ({ getEnabledPluginFrameOrigins: vi.fn(async () => []) }));
vi.mock('next-intl/middleware', async () => {
  const { NextResponse } = await import('next/server');
  return { default: () => () => NextResponse.next() };
});

import { proxy } from '@/proxy';

beforeEach(() => {
  // What the build inlines for skipProxyUrlNormalize: true. NextRequest then
  // keeps request.url as given instead of the renamed nextUrl.
  vi.stubEnv('__NEXT_NO_MIDDLEWARE_URL_NORMALIZE', 'true');
});

afterEach(() => {
  setupState = 'configured';
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('proxy redirects on a loopback listen address', () => {
  it('sends a configured install from /setup to /admin/login on the same origin', async () => {
    const response = await proxy(new NextRequest('https://127.0.0.1:3000/setup'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://127.0.0.1:3000/admin/login');
  });

  it('sends every page to /setup on the same origin while the wizard runs, keeping the query', async () => {
    setupState = 'bootstrap';
    const response = await proxy(new NextRequest('http://[::1]:3000/mail?x=1'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://[::1]:3000/setup?x=1');
  });

  it('keeps the base path of a sub-path install', async () => {
    const request = new NextRequest('https://127.0.0.1:3000/webmail/setup', {
      nextConfig: { basePath: '/webmail' },
    });
    const response = await proxy(request);

    expect(response.headers.get('location')).toBe('https://127.0.0.1:3000/webmail/admin/login');
  });
});

describe('next.config', () => {
  it('leaves proxy rewrites on the URL the router built', async () => {
    vi.resetModules();
    const { default: config } = await import('../../next.config');
    expect(config.skipProxyUrlNormalize).toBe(true);
  });
});
