// The document of every plugin iframe (/plugin-sandbox and
// /plugin-sandbox-privileged): a root element, the UI kit's stylesheet and
// the runtime script, built by scripts/build-plugin-sandbox.mjs into
// public/plugin-sandbox-assets/.
//
// It used to be a Next page. Each frame then loaded and hydrated Next's
// client router as well (~250 kB more to parse in every frame, on the host
// page's main thread), and the server rendered the page per frame, one after
// another when a dozen plugins started at once. proxy.ts still sets the
// sandbox CSP on this response; the script carries its nonce.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { BUNDLE_KEY_META, HOST_ORIGIN_HEADER, HOST_ORIGIN_META } from './protocol';
import { getPublicKeyBase64 } from '@/lib/admin/plugin-signing';

export const SANDBOX_ASSETS_PATH = '/plugin-sandbox-assets';

interface SandboxAssets {
  script: string;
  style: string;
  /** Chunks the script imports statically. */
  preload: string[];
  /** Chunks of the renderer (React DOM and the UI kit), for slot frames. */
  slotPreload: string[];
}

let cached: Promise<SandboxAssets> | null = null;

function loadAssets(): Promise<SandboxAssets> {
  // `next dev` keeps running while the assets are rebuilt.
  if (cached && process.env.NODE_ENV !== 'development') return cached;
  cached = readFile(path.join(process.cwd(), 'public', SANDBOX_ASSETS_PATH, 'manifest.json'), 'utf8')
    .then((text) => {
      const m = JSON.parse(text) as Partial<SandboxAssets>;
      if (typeof m.script !== 'string' || typeof m.style !== 'string') throw new Error('bad manifest');
      const names = (v: unknown) => (Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : []);
      return { script: m.script, style: m.style, preload: names(m.preload), slotPreload: names(m.slotPreload) };
    });
  cached.catch(() => { cached = null; });
  return cached;
}

const escapeAttr = (v: string) => v.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);

export async function sandboxDocument(request: Request): Promise<Response> {
  let assets: SandboxAssets;
  try {
    assets = await loadAssets();
  } catch {
    return new Response('The plugin sandbox is not built. Run `node scripts/build-plugin-sandbox.mjs`.', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  const nonce = escapeAttr(request.headers.get('x-nonce') ?? '');
  const base = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}${SANDBOX_ASSETS_PATH}`;
  const slot = new URL(request.url).searchParams.get('frame') === 'slot';
  const preload = slot ? [...assets.preload, ...assets.slotPreload] : assets.preload;
  // On the plugin origin (frame-origin.ts) the frame's host is not served
  // from this document's origin. proxy.ts works out the webmail's origin from
  // the host name and hands it over; the runtime takes its host from here.
  const hostOrigin = request.headers.get(HOST_ORIGIN_HEADER) ?? '';
  // There the frame checks the bundle it is given against this key before it
  // runs it. Without a key the document carries none and the frame runs
  // nothing.
  let bundleKey = '';
  if (hostOrigin) {
    try {
      bundleKey = await getPublicKeyBase64();
    } catch {
      bundleKey = '';
    }
  }
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="robots" content="noindex, nofollow"><title>Plugin sandbox</title>'
    + (hostOrigin ? `<meta name="${HOST_ORIGIN_META}" content="${escapeAttr(hostOrigin)}">` : '')
    + (bundleKey ? `<meta name="${BUNDLE_KEY_META}" content="${escapeAttr(bundleKey)}">` : '')
    + `<link rel="stylesheet" href="${escapeAttr(`${base}/${assets.style}`)}">`
    + preload.map((p) => `<link rel="modulepreload" nonce="${nonce}" href="${escapeAttr(`${base}/${p}`)}">`).join('')
    + `<script type="module" nonce="${nonce}" src="${escapeAttr(`${base}/${assets.script}`)}"></script>`
    + '</head><body style="margin:0;padding:0;background:transparent"><div id="plugin-sandbox-root"></div></body></html>';
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
