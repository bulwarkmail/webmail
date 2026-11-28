// Download path for server-managed plugin bundles.
//
// Used by the plugin store when it syncs the server registry into IndexedDB,
// and by the sandbox loader when a plugin record exists but its bundle does
// not. Records travel with the server registry (every user gets them), the
// bundle bytes only ever lived in the browser that ran the sync - so a second
// browser or profile, a private window, cleared site data or an evicted
// IndexedDB used to strand the plugin on "No bundle in storage" with no way
// for a regular user to repair it (#636). The bundle endpoint needs no admin
// session, so any logged-in user can refill their own cache from here.

import { apiFetch } from '@/lib/browser-navigation';
import { verifySignature } from './bundle-signing';
import { FRAME_SIGNATURE_HEADER } from './protocol';

export function bundleUrl(pluginId: string, bundleHash?: string | null): string {
  // Append the hash as a query string so any intermediary HTTP cache
  // (browser, service worker, CDN) treats each version as a distinct URL.
  const suffix = bundleHash ? `?v=${encodeURIComponent(bundleHash)}` : '';
  return `/api/admin/plugins/${encodeURIComponent(pluginId)}/bundle${suffix}`;
}

/**
 * Fetch a managed bundle and verify its Ed25519 signature. Resolves with the
 * bundle source; rejects with a user-readable reason on any failure.
 *
 * SHA-256 verification against the registry hash is left to the caller
 * (`verifyBundle`): the store deliberately keeps a mismatching bundle so the
 * load-time error shows up on the plugin card instead of the plugin silently
 * vanishing from the list.
 */
/**
 * The server's signature of a privileged bundle for a frame on the plugin
 * origin (protocol.ts). The frame checks it; this page only carries it. Asked
 * with HEAD, so a bundle already in the browser's cache is not downloaded
 * again for it.
 */
export async function fetchFrameSignature(pluginId: string, bundleHash?: string | null): Promise<string> {
  let res: Response;
  try {
    res = await apiFetch(bundleUrl(pluginId, bundleHash), { method: 'HEAD' });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not get the signature of the bundle for plugin "${pluginId}": ${reason}`);
  }
  const signature = res.ok ? res.headers.get(FRAME_SIGNATURE_HEADER) : null;
  if (!signature) {
    throw new Error(`The server gave no signature for the bundle of privileged plugin "${pluginId}"`);
  }
  return signature;
}

export async function downloadManagedBundle(
  pluginId: string,
  bundleHash?: string | null,
  opts: { requireSignature?: boolean } = {},
): Promise<string> {
  let res: Response;
  try {
    res = await apiFetch(bundleUrl(pluginId, bundleHash));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not download the bundle for plugin "${pluginId}": ${reason}`);
  }
  if (!res.ok) {
    throw new Error(`Could not download the bundle for plugin "${pluginId}" (HTTP ${res.status})`);
  }
  const code = await res.text();
  if (!code) {
    throw new Error(`Server returned an empty bundle for plugin "${pluginId}"`);
  }

  // Ed25519 signature verification. Present on every server-managed bundle
  // since the signing module is server-side; refuse a bundle that fails
  // verification. If the header is missing (older server / dev build with
  // signing disabled) we log and allow - the SHA-256 hash check at load time
  // still catches transport corruption.
  const sig = res.headers.get('X-Bundle-Signature');
  if (sig) {
    const ok = await verifySignature(code, sig);
    if (!ok) {
      throw new Error(`Refusing the bundle for plugin "${pluginId}": signature verification failed`);
    }
  } else if (opts.requireSignature) {
    // A privileged plugin runs with full access to the app; it only loads
    // with a signature made when the admin installed it.
    throw new Error(`Refusing the bundle for plugin "${pluginId}": it is not signed`);
  } else {
    console.warn(`[plugin-bundle] Bundle for "${pluginId}" has no Ed25519 signature; loading without it`);
  }
  return code;
}
