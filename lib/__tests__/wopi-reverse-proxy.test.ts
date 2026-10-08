// @vitest-environment node
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { NextRequest } from 'next/server';

// #1130: the webmail under /webmail behind a TLS-terminating reverse proxy,
// the editor reached internally for discovery and publicly by the browser.
// Next's standalone server then sees itself as http://0.0.0.0:3000, and the
// editor is served from an origin wopiClientUrl does not name.

const config = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));

vi.mock('@/lib/auth/session-secret', () => ({
  getSessionSecret: () => 'x'.repeat(32),
  hasSessionSecret: () => true,
}));
vi.mock('@/lib/logger', () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback: unknown) => config.values[key] ?? fallback,
    getPolicy: () => ({ features: { pluginsEnabled: false } }),
  },
}));
vi.mock('@/lib/setup/state', () => ({ detectSetupState: () => 'configured' }));
vi.mock('@/lib/admin/csp-frame-origins', () => ({ getEnabledPluginFrameOrigins: async () => [] }));
vi.mock('next-intl/middleware', async () => {
  const { NextResponse } = await import('next/server');
  return { default: () => () => NextResponse.next() };
});
vi.mock('@/lib/stalwart/credentials', () => ({ getStalwartCredentials: vi.fn() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));
vi.mock('@/lib/stalwart/server-fetch', () => ({
  fetchJmapServer: vi.fn(),
  isTrustedJmapServerUrl: async () => true,
}));
vi.mock('@/lib/stalwart/jmap-api', () => ({
  fetchJmapSession: vi.fn(),
  postJmap: vi.fn(),
  rebaseApiUrl: () => null,
}));

import { proxy } from '@/proxy';
import { POST as launch } from '@/app/api/wopi/launch/route';
import { GET as checkFileInfo } from '@/app/api/wopi/files/[fileId]/route';
import { buildWopiActionUrl, getWopiEditorOrigins } from '@/lib/wopi/discovery';
import { wopiBrowserOrigin, wopiHostBase } from '@/lib/wopi/origin';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { fetchJmapServer } from '@/lib/stalwart/server-fetch';
import { fetchJmapSession } from '@/lib/stalwart/jmap-api';

process.env.ADMIN_STATE_DIR = mkdtempSync(path.join(tmpdir(), 'bw-wopi-'));

const BIND = 'http://0.0.0.0:3000';
const PUBLIC = 'https://mail.example.com';
const DISCOVERY = `<wopi-discovery><net-zone name="external-http">
  <app name="writer">
    <action default="true" ext="docx" name="edit" urlsrc="https://office.example.com/browser/201368fc8d/cool.html?"/>
    <action ext="pdf" name="view" urlsrc="https://office.example.com/browser/201368fc8d/cool.html?"/>
  </app>
</net-zone></wopi-discovery>`;

let discoveryFetch: Mock;
let internalHost = 0;

function request(
  pathname: string,
  init: { body?: unknown; headers?: Record<string, string>; basePath?: string } = {},
) {
  const nextUrl = Object.assign(new URL(pathname, BIND), { basePath: init.basePath ?? '' });
  return {
    nextUrl,
    headers: new Headers(init.headers),
    json: async () => init.body,
  } as unknown as Parameters<typeof launch>[0];
}

beforeEach(() => {
  // A fresh discovery URL per test, so no test reads another one's cache.
  internalHost += 1;
  config.values = { wopiClientUrl: `http://10.0.0.${internalHost}:9980` };
  discoveryFetch = vi.fn(async () => new Response(DISCOVERY, { status: 200 }));
  vi.stubGlobal('fetch', discoveryFetch);
  (getStalwartCredentials as Mock).mockResolvedValue({
    serverUrl: 'https://stalwart.example.com',
    authHeader: 'Basic dXNlcjpwYXNz',
    username: 'user@example.com',
    trusted: true,
    slot: 0,
  });
  (fetchJmapSession as Mock).mockResolvedValue({
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'c' },
    accounts: { c: {} },
    downloadUrl: 'https://stalwart.example.com/jmap/download/{accountId}/{blobId}/{name}?accept={type}',
  });
  (fetchJmapServer as Mock).mockImplementation(async () =>
    new Response('DOCX-BYTES', { status: 200, headers: { 'Content-Length': '10' } }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('editor origins in the page CSP', () => {
  it('names the origin the browser loads the editor from, not only the discovery address', async () => {
    expect(await getWopiEditorOrigins()).toEqual([
      `http://10.0.0.${internalHost}:9980`,
      'https://office.example.com',
    ]);
  });

  it('allows that origin as a frame and as a form target', async () => {
    const response = await proxy(new NextRequest('http://localhost:3000/en/mail', {
      headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' },
    }));
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toMatch(/frame-src 'self' blob: [^;]*https:\/\/office\.example\.com/);
    expect(csp).toMatch(/form-action 'self' [^;]*https:\/\/office\.example\.com/);
  });

  it('fetches discovery once for many pages', async () => {
    await Promise.all([getWopiEditorOrigins(), getWopiEditorOrigins()]);
    await getWopiEditorOrigins();
    expect(discoveryFetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to the configured origin while the editor is down, without asking again per page', async () => {
    discoveryFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await getWopiEditorOrigins()).toEqual([`http://10.0.0.${internalHost}:9980`]);
    await getWopiEditorOrigins();
    expect(discoveryFetch).toHaveBeenCalledTimes(1);
  });

  it('adds nothing when no editor is configured', async () => {
    config.values = {};
    expect(await getWopiEditorOrigins()).toEqual([]);
    expect(discoveryFetch).not.toHaveBeenCalled();
  });
});

describe('wopiBrowserOrigin', () => {
  it('takes the Origin of the launch request over the bind address', () => {
    expect(wopiBrowserOrigin(request('/api/wopi/launch', { headers: { origin: PUBLIC } }))).toBe(PUBLIC);
  });

  it('falls back to what the reverse proxy forwarded, then to the request URL', () => {
    expect(wopiBrowserOrigin(request('/api/wopi/launch', {
      headers: { host: 'mail.example.com', 'x-forwarded-proto': 'https' },
    }))).toBe(PUBLIC);
    expect(wopiBrowserOrigin(request('/api/wopi/launch', { headers: { origin: 'null' } }))).toBe(BIND);
  });
});

describe('wopiHostBase', () => {
  const req = request('/api/wopi/launch', { headers: { origin: PUBLIC }, basePath: '/webmail' });

  it('defaults to the public origin under the base path', () => {
    expect(wopiHostBase(req, '')).toBe(`${PUBLIC}/webmail`);
  });

  it('adds the base path to an override that is a bare origin', () => {
    expect(wopiHostBase(req, 'http://10.0.0.4')).toBe('http://10.0.0.4/webmail');
    expect(wopiHostBase(req, 'http://10.0.0.4:3000/')).toBe('http://10.0.0.4:3000/webmail');
  });

  it('takes an override with a path as written', () => {
    expect(wopiHostBase(req, 'http://10.0.0.4/webmail/')).toBe('http://10.0.0.4/webmail');
    expect(wopiHostBase(req, 'http://gateway/mail')).toBe('http://gateway/mail');
  });
});

describe('buildWopiActionUrl with a language', () => {
  const SRC = 'http://h/api/wopi/files/f1';

  it('passes lang to an editor whose discovery has no placeholder (Collabora)', () => {
    expect(buildWopiActionUrl('https://office.example.com/browser/abc/cool.html?', SRC, 'fr')).toBe(
      `https://office.example.com/browser/abc/cool.html?lang=fr&WOPISrc=${encodeURIComponent(SRC)}`,
    );
  });

  it('fills the UI language placeholders and drops the others', () => {
    expect(buildWopiActionUrl('https://o.example/edit?<ui=UI_LLCC&><rs=DC_LLCC&><showcomments=DISABLE_CHAT&>', SRC, 'zh-TW')).toBe(
      `https://o.example/edit?ui=zh-TW&rs=zh-TW&WOPISrc=${encodeURIComponent(SRC)}`,
    );
  });

  it('ignores a language that is not a tag', () => {
    expect(buildWopiActionUrl('https://o.example/edit?', SRC, 'fr&WOPISrc=http://evil')).toBe(
      `https://o.example/edit?WOPISrc=${encodeURIComponent(SRC)}`,
    );
  });
});

describe('launch behind a reverse proxy', () => {
  async function launched(wopiHostUrl?: string) {
    if (wopiHostUrl) config.values.wopiHostUrl = wopiHostUrl;
    const res = await launch(request('/api/wopi/launch', {
      // nginx passes the public Host on; the CSRF gate compares Origin to it.
      headers: { origin: PUBLIC, host: 'mail.example.com' },
      basePath: '/webmail',
      body: { blobId: 'Gblob1', name: 'Quote.docx', lang: 'fr' },
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    const url = new URL(data.url);
    return { url, wopiSrc: url.searchParams.get('WOPISrc')!, token: data.accessToken as string };
  }

  it('builds WOPISrc on the public origin and base path, in the webmail language', async () => {
    const { url, wopiSrc } = await launched();
    expect(wopiSrc).toMatch(/^https:\/\/mail\.example\.com\/webmail\/api\/wopi\/files\/[\w-]+$/);
    expect(url.searchParams.get('lang')).toBe('fr');
  });

  it('adds the base path to WOPI_HOST_URL', async () => {
    const { wopiSrc } = await launched('http://10.0.0.4');
    expect(wopiSrc.startsWith('http://10.0.0.4/webmail/api/wopi/files/')).toBe(true);
  });

  it('reports the page origin as PostMessageOrigin', async () => {
    const { wopiSrc, token } = await launched();
    const documentId = wopiSrc.split('/').pop()!;
    const res = await checkFileInfo(
      request(`/api/wopi/files/${documentId}?access_token=${encodeURIComponent(token)}`),
      { params: Promise.resolve({ fileId: documentId }) },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).PostMessageOrigin).toBe(PUBLIC);
  });
});
