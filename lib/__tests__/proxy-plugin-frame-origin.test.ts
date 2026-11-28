/**
 * @vitest-environment node
 *
 * PLUGIN_FRAME_SUBDOMAIN in the proxy (lib/plugin-sandbox/frame-origin.ts).
 * On <label>.<webmail host> this server is the privileged sandbox document
 * and its assets, and nothing else; the webmail's own origin stops serving
 * that document; and the two name each other in their CSPs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const adminConfig = vi.hoisted(() => ({} as Record<string, unknown>));
const policy = vi.hoisted(() => ({ features: { pluginsEnabled: true } }));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: vi.fn(async () => {}),
    get: vi.fn((key: string, fallback: unknown) => (key in adminConfig ? adminConfig[key] : fallback)),
    getPolicy: vi.fn(() => policy),
  },
}));
vi.mock('@/lib/setup/state', () => ({ detectSetupState: vi.fn(() => 'configured') }));
vi.mock('@/lib/admin/csp-frame-origins', () => ({ getEnabledPluginFrameOrigins: vi.fn(async () => []) }));
vi.mock('next-intl/middleware', async () => {
  const { NextResponse } = await import('next/server');
  return { default: () => () => NextResponse.next() };
});

import { proxy } from '@/proxy';

const MAIL = 'mail.example.org';
const PLUGINS = 'plugins.mail.example.org';

/** A request as the browser sends it for an iframe (or a page with dest "document"). */
function load(host: string, path: string, opts: { dest?: string; headers?: Record<string, string> } = {}): Promise<Response> {
  return proxy(new NextRequest(`http://${host}${path}`, {
    headers: { host, 'sec-fetch-dest': opts.dest ?? 'iframe', ...opts.headers },
  }));
}

const csp = (response: Response) => response.headers.get('content-security-policy') ?? '';
const directive = (response: Response, name: string) =>
  csp(response).split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? '';
const HOST_ORIGIN = 'x-middleware-request-x-plugin-host-origin';

beforeEach(() => {
  for (const key of Object.keys(adminConfig)) delete adminConfig[key];
  adminConfig.pluginFrameSubdomain = 'plugins';
  policy.features.pluginsEnabled = true;
});

describe('the plugin host', () => {
  it('serves the privileged sandbox document, framed by its webmail', async () => {
    const response = await load(PLUGINS, '/plugin-sandbox-privileged');

    expect(response.status).toBe(200);
    expect(directive(response, 'frame-ancestors')).toBe(`frame-ancestors http://${MAIL} 'self'`);
    expect(directive(response, 'script-src')).toContain("'unsafe-eval'");
    // What the sandbox document writes into its <meta> for the runtime.
    expect(response.headers.get(HOST_ORIGIN)).toBe(`http://${MAIL}`);
  });

  it('keeps the portals that may frame the webmail around the plugin frame too', async () => {
    adminConfig.allowedFrameAncestors = 'https://portal.example.com';
    const response = await load(PLUGINS, '/plugin-sandbox-privileged');

    expect(directive(response, 'frame-ancestors'))
      .toBe(`frame-ancestors http://${MAIL} 'self' https://portal.example.com`);
  });

  it('reads the host and the scheme a reverse proxy passes on', async () => {
    const response = await proxy(new NextRequest('http://127.0.0.1:3000/plugin-sandbox-privileged?frame=slot', {
      headers: { host: '127.0.0.1:3000', 'x-forwarded-host': PLUGINS, 'x-forwarded-proto': 'https', 'sec-fetch-dest': 'iframe' },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get(HOST_ORIGIN)).toBe(`https://${MAIL}`);
  });

  it('serves the sandbox assets', async () => {
    expect((await load(PLUGINS, '/plugin-sandbox-assets/runtime-ABC123.js', { dest: 'script' })).status).toBe(200);
  });

  // No mail UI, no API and no sign-in page under a second origin.
  it.each([
    '/', '/en', '/en/mail', '/en/login', '/admin', '/api/config', '/api/auth/session', '/api/health/x',
    '/plugin-sandbox', '/sw.js', '/favicon.ico', '/branding/logo.png', '/_next/static/chunks/main.js',
  ])('answers 404 for %s', async (path) => {
    const response = await load(PLUGINS, path, { dest: path.startsWith('/api/') ? 'empty' : 'document' });

    expect(response.status).toBe(404);
    expect(response.headers.get(HOST_ORIGIN)).toBeNull();
  });

  it('refuses the privileged document as a top-level page, as on the webmail', async () => {
    expect((await load(PLUGINS, '/plugin-sandbox-privileged', { dest: 'document' })).status).toBe(403);
  });

  it('is gone while plugins are off', async () => {
    policy.features.pluginsEnabled = false;
    expect((await load(PLUGINS, '/plugin-sandbox-privileged')).status).toBe(403);
  });
});

describe('the webmail, with a plugin origin set', () => {
  it('may frame the plugin origin', async () => {
    const response = await load(MAIL, '/en/mail', { dest: 'document' });

    expect(response.status).toBe(200);
    expect(directive(response, 'frame-src')).toBe(`frame-src 'self' blob: http://${PLUGINS}`);
  });

  it('does not name it while plugins are off', async () => {
    policy.features.pluginsEnabled = false;
    expect(directive(await load(MAIL, '/en/mail', { dest: 'document' }), 'frame-src')).toBe("frame-src 'self' blob:");
  });

  // A privileged frame can never run with the webmail's own origin by mistake.
  it('no longer serves the privileged document on its own origin', async () => {
    expect((await load(MAIL, '/plugin-sandbox-privileged')).status).toBe(403);
  });

  it('still serves the untrusted sandbox document, which has no origin', async () => {
    const response = await load(MAIL, '/plugin-sandbox');

    expect(response.status).toBe(200);
    expect(response.headers.get(HOST_ORIGIN)).toBe('');
  });

  // An IP address has no subdomains: privileged plugins have nowhere to load.
  it('opened by IP address, has no plugin origin and serves no privileged document', async () => {
    const page = await load('10.0.0.5:3000', '/en/mail', { dest: 'document' });
    expect(directive(page, 'frame-src')).toBe("frame-src 'self' blob:");
    expect((await load('10.0.0.5:3000', '/plugin-sandbox-privileged')).status).toBe(403);
  });
});

describe('without the setting', () => {
  beforeEach(() => { adminConfig.pluginFrameSubdomain = ''; });

  it('serves the privileged document on the webmail, as before', async () => {
    const response = await load(MAIL, '/plugin-sandbox-privileged');

    expect(response.status).toBe(200);
    expect(directive(response, 'frame-ancestors')).toBe("frame-ancestors 'self'");
    expect(directive(await load(MAIL, '/en/mail', { dest: 'document' }), 'frame-src')).toBe("frame-src 'self' blob:");
  });

  it('treats a host called "plugins." like any other host', async () => {
    expect((await load(PLUGINS, '/en/mail', { dest: 'document' })).status).toBe(200);
  });

  it('is off for a value that is not one label', async () => {
    adminConfig.pluginFrameSubdomain = 'https://plugins.mail.example.org';
    expect((await load(MAIL, '/plugin-sandbox-privileged')).status).toBe(200);
  });

  // The route would write it into the document as the runtime's host.
  it('never passes on a host origin the client sent', async () => {
    const response = await load(MAIL, '/plugin-sandbox-privileged', { headers: { 'x-plugin-host-origin': 'https://attacker.example' } });

    expect(response.headers.get(HOST_ORIGIN)).toBe('');
  });
});

describe('a host origin the client sent', () => {
  it('is replaced on the plugin host as well', async () => {
    const response = await load(PLUGINS, '/plugin-sandbox-privileged', { headers: { 'x-plugin-host-origin': 'https://attacker.example' } });

    expect(response.headers.get(HOST_ORIGIN)).toBe(`http://${MAIL}`);
  });
});
