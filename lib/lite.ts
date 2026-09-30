/**
 * Bulwark Lite: the static build of this repo (`npm run build:lite`).
 *
 * Lite is the same client shell exported with `output: "export"`: mail,
 * calendar, contacts and files talk to the JMAP server straight from the
 * browser, so nothing here needs the Next.js server. What the server used to
 * provide is either replaced by a static file next to `index.html`
 * (`config.json`, `policy.json`), done in the browser against Stalwart's own
 * endpoints (token login, "remember me"), or switched off (admin console,
 * plugins, settings sync, cookie-backed features).
 *
 * `IS_LITE` is a build-time constant (`NEXT_PUBLIC_BULWARK_LITE=1`), so the
 * bundler can drop the server-only branches from the Lite bundle and the
 * Lite-only branches from the regular one. Keep the checks cheap and boolean:
 * `if (IS_LITE) ...` next to the existing feature gates.
 */
export const IS_LITE = process.env.NEXT_PUBLIC_BULWARK_LITE === '1';

/**
 * Which host the Lite export was built for (`npm run build:lite -- --target=`):
 *
 * - `static` (default): any static web host. Each surface is its own HTML
 *   shell, the host's rewrite rules (or 404.html) route deep links to it, and
 *   `config.json` is edited after unzipping.
 * - `stalwart`: a Stalwart `Application` bundle. Stalwart answers every
 *   unknown path under the mount prefix with the root `index.html` (after
 *   rewriting its `<base href>` to the prefix), so that file boots the right
 *   shell in place and the app learns its mount prefix at runtime
 *   (`getLiteMount`). Same origin as JMAP: no server URL, no CORS.
 */
export const LITE_TARGET: 'static' | 'stalwart' =
  IS_LITE && process.env.NEXT_PUBLIC_LITE_TARGET === 'stalwart' ? 'stalwart' : 'static';
export const IS_LITE_STALWART = LITE_TARGET === 'stalwart';

/**
 * Identifies one Lite build. The Stalwart target appends it as `?v=` to every
 * un-hashed file it fetches (shells, config.json, policy.json, manifest),
 * because Stalwart serves everything except the root index.html with an
 * immutable cache header: a new bundle must mean new URLs.
 */
export const LITE_BUILD_ID = process.env.NEXT_PUBLIC_LITE_BUILD_ID ?? '';

/**
 * Globals the Stalwart entry document (scripts/lite/lib.mjs,
 * buildStalwartEntry) sets before it writes a shell into the page: the mount
 * prefix Stalwart put into `<base href>`, and the Application's
 * `oauthClientId` from `<meta name="oauth-client-id">`. Both only exist in
 * the root document, which the shell replaces.
 */
export const LITE_MOUNT_GLOBAL = '__BULWARK_LITE_MOUNT__';
export const LITE_OAUTH_CLIENT_ID_GLOBAL = '__BULWARK_LITE_OAUTH_CLIENT_ID__';

/**
 * A Stalwart mount prefix: empty, or one path segment (Stalwart matches
 * `urlPrefix` against the first segment only). Mirrors the check in the entry
 * document, which refuses to boot under anything else.
 */
export const LITE_MOUNT_PATTERN = /^(\/[A-Za-z0-9._~-]+)?$/;

function readStringGlobal(name: string): string | null {
  if (typeof window === 'undefined') return null;
  const value = (window as unknown as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : null;
}

/**
 * The runtime mount prefix of a Stalwart-hosted Lite bundle (`/webmail`), or
 * `null` when the page was not booted by the Stalwart entry document.
 */
export function getLiteMount(): string | null {
  if (!IS_LITE_STALWART) return null;
  const mount = readStringGlobal(LITE_MOUNT_GLOBAL);
  return mount !== null && LITE_MOUNT_PATTERN.test(mount) ? mount : null;
}

/** The Application's `oauthClientId` as Stalwart injected it, or '' when unset. */
export function getLiteInjectedClientId(): string {
  if (!IS_LITE_STALWART) return '';
  return (readStringGlobal(LITE_OAUTH_CLIENT_ID_GLOBAL) ?? '').trim();
}

/**
 * An asset URL Turbopack baked as `/_next/...` (`new URL(..., import.meta.url)`),
 * pointed at the Stalwart mount. `.mjs` becomes `.js`: Stalwart serves `.mjs`
 * as application/octet-stream, which browsers refuse for module workers, so
 * the Stalwart build ships a `.js` copy of every `.mjs` asset.
 */
export function liteMountedAssetUrl(url: string): string {
  const mount = getLiteMount();
  if (mount === null || typeof window === 'undefined') return url;
  try {
    const parsed = new URL(url, window.location.href);
    if (parsed.origin !== window.location.origin || !parsed.pathname.startsWith('/_next/')) return url;
    parsed.pathname = `${mount}${parsed.pathname.replace(/\.mjs$/, '.js')}`;
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Appends the build id to an un-hashed Lite file URL (Stalwart target only). */
export function withLiteBuildId(path: string): string {
  if (!IS_LITE_STALWART || !LITE_BUILD_ID) return path;
  return `${path}${path.includes('?') ? '&' : '?'}v=${encodeURIComponent(LITE_BUILD_ID)}`;
}

/** Runtime config file a deployer edits after unzipping (relative to the mount prefix). */
export const LITE_CONFIG_PATH = '/config.json';

/** Optional admin policy file next to `config.json`; missing means defaults. */
export const LITE_POLICY_PATH = '/policy.json';

/** sessionStorage key the 404 shim parks a deep link under (see not-found.tsx). */
export const LITE_PENDING_PATH_KEY = 'bulwark-lite:pending-path';
