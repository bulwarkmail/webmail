// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Shortcuts, file handlers and the share target in the manifest, with what
// the route already did (per-domain branding, the deployment subpath).

const hoisted = vi.hoisted(() => ({
  requestHeaders: {} as Record<string, string>,
  config: {} as Record<string, unknown>,
  sources: {} as Record<string, { source: string }>,
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers(hoisted.requestHeaders),
}));

// The real strings, so a missing or misnamed key fails here.
vi.mock('next-intl/server', () => ({
  getTranslations: async ({ locale, namespace }: { locale: string; namespace: string }) => {
    const messages = JSON.parse(readFileSync(join(process.cwd(), 'locales', locale, 'common.json'), 'utf8'));
    return (key: string) => {
      const value = messages[namespace]?.[key];
      if (typeof value !== 'string') throw new Error(`missing ${namespace}.${key} in ${locale}`);
      return value;
    };
  },
}));

vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback: unknown) => hoisted.config[key] ?? fallback,
    getAllWithSources: () => hoisted.sources,
  },
}));

type Manifest = {
  name: string;
  shortcuts: Array<{ name: string; url: string; icons: Array<{ src: string }> }>;
  file_handlers: Array<{ action: string; accept: Record<string, string[]> }>;
  share_target: { action: string; method: string; enctype: string; params: Record<string, unknown> };
  protocol_handlers: Array<{ protocol: string; url: string }>;
};

async function load(): Promise<Manifest> {
  vi.resetModules();
  const { default: manifest } = await import('@/app/manifest');
  return (await manifest()) as unknown as Manifest;
}

beforeEach(() => {
  hoisted.requestHeaders = {};
  hoisted.config = {};
  hoisted.sources = {
    pwaIconUrl: { source: 'default' },
    faviconUrl: { source: 'default' },
    pwaScreenshotMobileUrl: { source: 'default' },
    pwaScreenshotDesktopUrl: { source: 'default' },
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('manifest launch fields', () => {
  it('offers the three shortcuts', async () => {
    const m = await load();
    expect(m.shortcuts.map((s) => [s.name, s.url])).toEqual([
      ['New message', '/?compose=1'],
      ['Calendar', '/calendar'],
      ['Contacts', '/contacts'],
    ]);
  });

  it('names the shortcuts in the language the browser asks in', async () => {
    hoisted.requestHeaders = { 'accept-language': 'de-DE,de;q=0.9,en;q=0.8' };
    expect((await load()).shortcuts.map((s) => s.name)).toEqual(['Neue Nachricht', 'Kalender', 'Kontakte']);
  });

  it('falls back to English for a language it does not have', async () => {
    hoisted.requestHeaders = { 'accept-language': 'xx' };
    expect((await load()).shortcuts[0].name).toBe('New message');
  });

  it('handles .eml, .ics and .vcf', async () => {
    const m = await load();
    const extensions = (action: string) => Object.values(m.file_handlers.find((h) => h.action === action)?.accept ?? {}).flat();
    expect(extensions('/mail')).toEqual(['.eml']);
    expect(extensions('/calendar')).toEqual(expect.arrayContaining(['.ics']));
    expect(extensions('/contacts')).toEqual(expect.arrayContaining(['.vcf']));
    expect(m.file_handlers).toHaveLength(3);
  });

  it('takes shares as multipart POST outside /api/, with files and links', async () => {
    const { share_target: share } = await load();
    expect(share.action).toBe('/protocol/share');
    expect(share.action.startsWith('/api/')).toBe(false);
    expect(share.method).toBe('POST');
    expect(share.enctype).toBe('multipart/form-data');
    expect(share.params).toEqual({ title: 'title', text: 'text', url: 'url', files: [{ name: 'files', accept: ['*/*'] }] });
  });

  it('prefixes every new address with the subpath', async () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/webmail');
    const m = await load();
    expect(m.shortcuts.map((s) => s.url)).toEqual(['/webmail/?compose=1', '/webmail/calendar', '/webmail/contacts']);
    expect(m.shortcuts[0].icons[0].src).toBe('/webmail/icon-192x192.png');
    expect(m.file_handlers.map((h) => h.action)).toEqual(['/webmail/mail', '/webmail/calendar', '/webmail/contacts']);
    expect(m.share_target.action).toBe('/webmail/protocol/share');
  });

  it("keeps a domain's branding, its icon on the shortcuts too", async () => {
    hoisted.requestHeaders = { host: 'mail.acme.example' };
    hoisted.config = { domainBranding: [{ host: 'mail.acme.example', appName: 'Acme Mail', pwaIconUrl: 'https://cdn.example/i.png' }] };
    const m = await load();
    expect(m.name).toBe('Acme Mail');
    expect(m.shortcuts[0].icons[0].src).toBe('/api/pwa-icon/192');
    expect(m.file_handlers).toHaveLength(3);
    expect(m.share_target.action).toBe('/protocol/share');
  });

  it('leaves the protocol handlers as they are', async () => {
    expect((await load()).protocol_handlers.map((h) => h.url)).toEqual(['/protocol/mailto?url=%s', '/protocol/webcal?url=%s']);
  });
});

describe('Lite', () => {
  it('has no share target or file handlers: no service worker, no launch consumer behind them', async () => {
    const { buildManifest } = await import('@/scripts/lite/lib.mjs');
    const lite = buildManifest({ appName: 'Acme' });
    expect(lite).not.toHaveProperty('share_target');
    expect(lite).not.toHaveProperty('file_handlers');
    expect(lite).not.toHaveProperty('shortcuts');
  });
});

describe('share route without a service worker', () => {
  const route = () => import('@/app/(main)/protocol/share/route');

  function post(form: FormData | null, contentLength?: string) {
    const request = new Request('https://mail.example.com/protocol/share', { method: 'POST', ...(form ? { body: form } : {}) });
    if (contentLength !== undefined) {
      const headers = new Headers(request.headers);
      headers.set('content-length', contentLength);
      return { headers, formData: () => request.formData() } as unknown as Request;
    }
    return request;
  }

  it('sends text and links on to a new draft, and goes to the app with a 303', async () => {
    const { POST } = await route();
    const form = new FormData();
    form.set('title', 'T');
    form.set('text', 'B');
    form.set('url', 'https://example.org/');
    const res = await POST(post(form, '500'));
    expect(res.status).toBe(303);
    const landing = new URL(res.headers.get('location')!, 'https://x.example');
    expect(landing.pathname).toBe('/');
    // In the fragment: it never reaches an access log.
    expect(landing.search).toBe('');
    expect(Object.fromEntries(new URLSearchParams(landing.hash.slice(1)))).toEqual({ share: 'unavailable', share_title: 'T', share_text: 'B', share_url: 'https://example.org/' });
  });

  it('says files were lost', async () => {
    const { POST } = await route();
    const form = new FormData();
    form.set('text', 'B');
    form.append('files', new File(['x'], 'a.png'));
    const res = await POST(post(form, '500'));
    expect(res.headers.get('location')).toContain('share_files=1');
  });

  it('does not read a large upload into memory', async () => {
    const { POST } = await route();
    const form = new FormData();
    form.set('text', 'B');
    const spy = vi.fn(async () => form);
    const request = { headers: new Headers({ 'content-length': String(50 * 1024 * 1024) }), formData: spy } as unknown as Request;
    const res = await POST(request);
    expect(spy).not.toHaveBeenCalled();
    expect(res.headers.get('location')).toContain('share_files=1');
  });

  it.each([
    ['Latin', 'x'],
    ['Japanese, 9 encoded bytes each', 'あ'],
    ['emoji, whole characters only', '😀'],
  ])('keeps the address short and says it cut: %s', async (_name, character) => {
    const { POST } = await route();
    const form = new FormData();
    form.set('text', character.repeat(3000));
    form.set('title', character.repeat(3000));
    form.set('url', character.repeat(3000));
    const res = await POST(post(form, '100000'));
    const location = res.headers.get('location')!;
    expect(location.length).toBeLessThan(4000);
    const fragment = new URLSearchParams(new URL(location, 'https://x.example').hash.slice(1));
    expect(fragment.get('share_cut')).toBe('1');
    // Decodes cleanly: no half a character at the end.
    expect(fragment.get('share_text')!.endsWith(character)).toBe(true);
  });

  it('does not say it cut what fits', async () => {
    const { POST } = await route();
    const form = new FormData();
    form.set('text', 'あ'.repeat(100));
    const res = await POST(post(form, '1000'));
    expect(res.headers.get('location')).not.toContain('share_cut');
  });

  it('honours the subpath', async () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/webmail');
    vi.resetModules();
    const { GET } = await route();
    expect(GET().headers.get('location')).toBe('/webmail/');
  });
});
