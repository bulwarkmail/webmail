/**
 * Loading of branding image sources for server-side image generation.
 *
 * A branding URL can point at three different places, and every route that
 * renders a branded image (PWA icon, PWA screenshot, OG image) has to resolve
 * all three the same way.
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { getConfigDir } from '@/lib/admin/paths';

/** Admin-uploaded assets are served from here but stored under getConfigDir()/branding/. */
const ADMIN_BRANDING_PREFIX = '/api/admin/branding/';

/**
 * Read the bytes behind a branding URL: a remote http(s) URL, an
 * admin-uploaded asset, or a path relative to public/.
 *
 * `label` only shapes the error message for remote fetch failures.
 */
export async function fetchBrandingAsset(url: string, label = 'branding asset'): Promise<Buffer> {
  // Absolute URL (http/https)
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${label}: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  if (url.startsWith(ADMIN_BRANDING_PREFIX)) {
    const filename = path.basename(url.slice(ADMIN_BRANDING_PREFIX.length));
    return readFile(path.join(getConfigDir(), 'branding', filename));
  }

  // Path relative to public/ directory
  const publicPath = path.join(process.cwd(), 'public', url.replace(/^\//, ''));
  return readFile(publicPath);
}
