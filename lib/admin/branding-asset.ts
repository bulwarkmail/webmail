/**
 * Loading of branding image sources for server-side image generation.
 *
 * A branding URL can point at three different places, and every route that
 * renders a branded image (PWA icon, PWA screenshot, OG image) has to resolve
 * all three the same way.
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { brandingDocs } from '@/lib/admin/extension-store';
import { fetchPublicUrl, type PublicFetchResponse } from '@/lib/security/url-guard';

/** Admin-uploaded assets are served from here but stored in C/branding (or the shared store, #1066). */
const ADMIN_BRANDING_PREFIX = '/api/admin/branding/';

const REMOTE_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;

/**
 * Remote branding URLs come from admin config, but they are still fetched by
 * this process and rendered by public routes, so they go through the
 * rebinding-safe fetch: only public addresses, every redirect hop
 * re-validated. Private-network logos should be uploaded via the admin
 * branding upload instead of linked.
 */
async function fetchRemoteAsset(url: string, label: string): Promise<Buffer> {
  let currentUrl = url;
  let res: PublicFetchResponse | undefined;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    res = await fetchPublicUrl(currentUrl, { signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS) });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) break;
      await res.body?.cancel().catch(() => {});
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    break;
  }
  if (!res || !res.ok) {
    throw new Error(`Failed to fetch ${label}: ${res?.status ?? 'too many redirects'}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Read the bytes behind a branding URL: a remote http(s) URL, an
 * admin-uploaded asset, or a path relative to public/.
 *
 * `label` only shapes the error message for remote fetch failures.
 */
export async function fetchBrandingAsset(url: string, label = 'branding asset'): Promise<Buffer> {
  // Absolute URL (http/https)
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return fetchRemoteAsset(url, label);
  }

  if (url.startsWith(ADMIN_BRANDING_PREFIX)) {
    // The URL carries the upload's version (?v=…) for caches; the file is the path.
    const filename = path.basename(url.slice(ADMIN_BRANDING_PREFIX.length).split(/[?#]/)[0]);
    const doc = await brandingDocs().get(filename);
    if (!doc) throw new Error(`Branding file ${filename} not found`);
    return doc.data;
  }

  // Path relative to public/ directory
  const publicPath = path.join(process.cwd(), 'public', url.replace(/^\//, ''));
  return readFile(publicPath);
}
