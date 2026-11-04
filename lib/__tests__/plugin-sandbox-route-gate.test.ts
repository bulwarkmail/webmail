/**
 * @vitest-environment node
 *
 * /plugin-sandbox and /plugin-sandbox-privileged are documents that carry
 * 'unsafe-eval' so plugin bundles can run. They only make sense as iframes
 * created by the host bridge, yet they used to answer any top-level load,
 * which is what let a foreign site window.open() them and feed them code
 * (GHSA-96cx-gx36-3g79). The proxy now refuses top-level document loads and
 * closes the routes entirely while the plugin feature is off. The runtime's
 * own host gate stays the primary defence for browsers without Sec-Fetch-*.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

let pluginsEnabled = true;
let allowedFrameAncestors = '';
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: vi.fn(async () => {}),
    get: vi.fn((key: string, fallback: unknown) => (key === 'allowedFrameAncestors' ? allowedFrameAncestors : fallback)),
    getPolicy: vi.fn(() => ({ features: { pluginsEnabled } })),
  },
}));
vi.mock('@/lib/setup/state', () => ({ detectSetupState: vi.fn(() => 'configured') }));
vi.mock('@/lib/admin/csp-frame-origins', () => ({ getEnabledPluginFrameOrigins: vi.fn(async () => []) }));
// The sandbox routes skip the intl middleware; ordinary pages pass through it.
vi.mock('next-intl/middleware', async () => {
  const { NextResponse } = await import('next/server');
  return { default: () => () => NextResponse.next() };
});

import { proxy } from '@/proxy';

const SANDBOX_ROUTES = ['/plugin-sandbox', '/plugin-sandbox-privileged'];

function load(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return proxy(new NextRequest(`http://localhost:3000${path}`, { headers }));
}

const IFRAME_LOAD = { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' };

beforeEach(() => {
  vi.clearAllMocks();
  pluginsEnabled = true;
  allowedFrameAncestors = '';
});

describe('plugin sandbox routes (GHSA-96cx-gx36-3g79)', () => {
  it.each(SANDBOX_ROUTES)('serves %s to the host bridge iframe with the eval CSP', async (path) => {
    const response = await load(path, IFRAME_LOAD);

    expect(response.status).toBe(200);
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain("frame-ancestors 'self'");
  });

  // frame-ancestors is checked against every ancestor, so a portal allowed to
  // frame the mail UI must be allowed on the plugin frames inside it too (#1533).
  it.each(SANDBOX_ROUTES)('lets %s load inside a mail UI framed by an allowed portal', async (path) => {
    allowedFrameAncestors = 'https://portal.example';
    const response = await load(path, IFRAME_LOAD);

    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'self' https://portal.example;");
    // X-Frame-Options can't name the portal and would block it in browsers that read it.
    expect(response.headers.get('x-frame-options')).toBeNull();
  });

  it.each(SANDBOX_ROUTES)('refuses %s as a top-level document opened by another site', async (path) => {
    const response = await load(path, { 'sec-fetch-dest': 'document', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' });

    expect(response.status).toBe(403);
    expect(response.headers.get('content-security-policy')).toBeNull();
  });

  it.each(SANDBOX_ROUTES)('refuses %s as a top-level document typed into the address bar', async (path) => {
    const response = await load(path, { 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' });

    expect(response.status).toBe(403);
  });

  it('refuses paths nested under the sandbox routes the same way', async () => {
    const response = await load('/plugin-sandbox/anything', { 'sec-fetch-dest': 'document' });

    expect(response.status).toBe(403);
  });

  it.each(SANDBOX_ROUTES)('still serves %s to a browser that sends no Sec-Fetch-Dest', async (path) => {
    // Pre-2020 browsers: the runtime host gate is the only defence there.
    const response = await load(path);

    expect(response.status).toBe(200);
  });

  it('lets the router refetch the sandbox page as RSC (Sec-Fetch-Dest: empty)', async () => {
    const response = await load('/plugin-sandbox?_rsc=abc12', { 'sec-fetch-dest': 'empty', 'sec-fetch-site': 'same-origin', rsc: '1' });

    expect(response.status).toBe(200);
  });

  it.each(SANDBOX_ROUTES)('does not serve %s at all while plugins are disabled', async (path) => {
    pluginsEnabled = false;

    expect((await load(path, IFRAME_LOAD)).status).toBe(403);
    expect((await load(path)).status).toBe(403);
  });

  // H-03: a plugin's network access must go through api.http.fetch, which
  // checks the manifest's httpOrigins. If the iframe itself may reach any
  // https origin, a plugin with only email:read can post every message it
  // sees to its own server with fetch(), an <img>, a CSS url() or a font.
  it.each(SANDBOX_ROUTES)('gives %s no direct network access beyond its own origin', async (path) => {
    const response = await load(path, IFRAME_LOAD);
    const directives: Record<string, string[]> = Object.fromEntries(
      (response.headers.get('content-security-policy') ?? '')
        .split(';')
        .map((d) => d.trim().split(/\s+/))
        .map(([name, ...sources]) => [name, sources]),
    );

    for (const name of ['connect-src', 'img-src', 'font-src', 'media-src', 'default-src']) {
      const sources = directives[name] ?? [];
      for (const wide of ['https:', 'http:', 'ws:', 'wss:', '*']) {
        expect(sources, `${name} allows ${wide}`).not.toContain(wide);
      }
    }
    // The router refetches the sandbox page itself, so its own origin stays.
    expect(directives['connect-src']).toEqual(["'self'"]);
    // Plugin frames may use forms (allow-forms) but not post them anywhere.
    expect(directives['form-action']).toEqual(["'none'"]);
  });

  it('keeps https images and connections for the mail UI itself', async () => {
    const response = await load('/en/mail', { 'sec-fetch-dest': 'document' });
    const csp = response.headers.get('content-security-policy') ?? '';

    expect(csp).toMatch(/img-src [^;]*https:/);
    expect(csp).toMatch(/connect-src [^;]*https:/);
  });

  it('leaves ordinary pages alone and never hands them the eval CSP', async () => {
    const response = await load('/en/calendar', { 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).not.toContain("'unsafe-eval'");
  });
});
