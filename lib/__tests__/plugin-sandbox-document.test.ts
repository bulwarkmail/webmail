// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const files = vi.hoisted(() => new Map<string, string>());
vi.mock('node:fs/promises', async (orig) => ({
  ...(await orig<typeof import('node:fs/promises')>()),
  readFile: vi.fn(async (p: string) => {
    const key = String(p).replace(/\\/g, '/').split('/public/')[1];
    if (key && files.has(key)) return files.get(key)!;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
}));

const signingKey = vi.hoisted(() => ({ get: async (): Promise<string> => 'S0VZ' }));
vi.mock('@/lib/admin/plugin-signing', () => ({ getPublicKeyBase64: () => signingKey.get() }));

import { GET as untrusted } from '@/app/(sandbox)/plugin-sandbox/route';
import { GET as privileged } from '@/app/(sandbox)/plugin-sandbox-privileged/route';

const MANIFEST = 'plugin-sandbox-assets/manifest.json';

function request(nonce = 'n0nce'): Request {
  return new Request('http://localhost:3000/plugin-sandbox', { headers: { 'x-nonce': nonce } });
}

beforeEach(() => {
  files.clear();
  files.set(MANIFEST, JSON.stringify({ script: 'runtime-ABC.js', style: 'kit-123.css', preload: ['chunk-ICONS.js'], slotPreload: ['chunk-DOM.js'] }));
  vi.stubEnv('NODE_ENV', 'development'); // re-read the manifest for every test
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// Plugin frames used to load a Next page: its client router and hydration
// in every frame, and a server render per frame.
describe('plugin sandbox document', () => {
  it.each([['/plugin-sandbox', untrusted], ['/plugin-sandbox-privileged', privileged]])(
    '%s is a plain page with the runtime script and the kit stylesheet', async (_path, GET) => {
      const res = await GET(request());
      const html = await res.text();

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(html).toContain('<script type="module" nonce="n0nce" src="/plugin-sandbox-assets/runtime-ABC.js"></script>');
      expect(html).toContain('<link rel="stylesheet" href="/plugin-sandbox-assets/kit-123.css">');
      // Fetched with the script, not after it has been parsed.
      expect(html).toContain('<link rel="modulepreload" nonce="n0nce" href="/plugin-sandbox-assets/chunk-ICONS.js">');
      expect(html).toContain('<div id="plugin-sandbox-root"></div>');
      expect(html).not.toContain('/_next/');
    });

  it('preloads React DOM and the kit for slot frames only', async () => {
    const slot = await (await untrusted(new Request('http://localhost:3000/plugin-sandbox?frame=slot', { headers: { 'x-nonce': 'n' } }))).text();
    const background = await (await untrusted(request())).text();

    expect(slot).toContain('href="/plugin-sandbox-assets/chunk-DOM.js"');
    expect(background).not.toContain('chunk-DOM.js');
  });

  it('serves the assets under the base path', async () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/webmail');
    const html = await (await untrusted(request())).text();

    expect(html).toContain('src="/webmail/plugin-sandbox-assets/runtime-ABC.js"');
    expect(html).toContain('href="/webmail/plugin-sandbox-assets/kit-123.css"');
  });

  it('does not let the nonce header break out of its attribute', async () => {
    const html = await (await untrusted(request('x"><script>alert(1)</script>'))).text();

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html.match(/<script/g)).toHaveLength(1);
  });

  it('says what to run when the assets were not built', async () => {
    files.clear();
    const res = await untrusted(request());

    expect(res.status).toBe(503);
    expect(await res.text()).toContain('build-plugin-sandbox');
  });
});

// PLUGIN_FRAME_SUBDOMAIN (frame-origin.ts): on the plugin origin the runtime
// takes its host from the document, which proxy.ts names in a request header.
describe('the webmail origin in a plugin-origin document', () => {
  const named = (origin: string) => new Request('http://plugins.localhost:3000/plugin-sandbox-privileged', {
    headers: { 'x-nonce': 'n0nce', 'x-plugin-host-origin': origin },
  });

  it('is written for the runtime to read', async () => {
    const html = await (await privileged(named('http://localhost:3000'))).text();

    expect(html).toContain('<meta name="bulwark-host-origin" content="http://localhost:3000">');
  });

  it('is left out on the webmail origin', async () => {
    expect(await (await privileged(request())).text()).not.toContain('bulwark-host-origin');
    expect(await (await privileged(named(''))).text()).not.toContain('bulwark-host-origin');
  });

  it('comes with the key the frame checks its bundle against', async () => {
    const html = await (await privileged(named('http://localhost:3000'))).text();

    expect(html).toContain('<meta name="bulwark-bundle-key" content="S0VZ">');
    expect(await (await privileged(request())).text()).not.toContain('bulwark-bundle-key');
  });

  // The frame then runs nothing: it never falls back to taking the page's word.
  it('carries no key when the server has none to give', async () => {
    signingKey.get = async () => { throw new Error('no key'); };
    const html = await (await privileged(named('http://localhost:3000'))).text();
    signingKey.get = async () => 'S0VZ';

    expect(html).toContain('bulwark-host-origin');
    expect(html).not.toContain('bulwark-bundle-key');
  });

  it('cannot break out of the attribute', async () => {
    const html = await (await privileged(named('"><script>alert(1)</script>'))).text();

    expect(html).not.toContain('<script>alert(1)');
  });
});
