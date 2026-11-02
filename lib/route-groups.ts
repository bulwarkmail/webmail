/**
 * A request path reduced to a fixed, small set of names: the area of the app
 * or the API folder it belongs to. Error reports use it instead of the URL,
 * and the request metrics use it as a label, so neither ever carries a folder
 * name, a message id, a query string or anything else a user typed.
 *
 * lib/__tests__/route-groups.test.ts checks API_GROUPS against app/api and
 * PAGE_AREAS against app/(main)/[locale].
 */

/** The folders under app/api. */
export const API_GROUPS: readonly string[] = [
  'account', 'account-archive', 'admin', 'auth', 'bimi', 'caldav', 'calendar-agenda', 'config',
  'connector', 'dev-jmap', 'errors', 'favicon', 'fetch-ical', 'health', 'metrics', 'offline',
  'og-image', 'plugin-approval-status', 'plugin-proxy', 'plugin-secrets', 'plugin-signing-pubkey',
  'plugins', 'push', 'pwa-icon', 'pwa-screenshot', 'ready', 'settings', 'setup', 'system',
  'translate', 'version', 'webdav', 'wopi',
];

/** The page areas under app/(main)/[locale], plus the pages outside it. */
export const PAGE_AREAS: readonly string[] = [
  'apps', 'auth', 'calendar', 'contacts', 'files', 'login', 'mail', 'plugins', 'pro', 'settings',
  'admin', 'setup', 'connector', 'protocol', 'plugin-sandbox', 'plugin-sandbox-privileged',
];

const API = new Set(API_GROUPS);
const AREAS = new Set(PAGE_AREAS);
const ASSET_FOLDERS = new Set(['branding', 'notification', 'demo', 'plugin-sandbox-assets']);
/** en, de, pt-BR, zh-TW, sr-Latn: what a locale prefix looks like. */
const LOCALE = /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/;

interface Parsed {
  group: string;
  /** Path segments below the group's own. */
  deeper: boolean;
}

function parse(rawPath: string, basePath: string): Parsed {
  let path = rawPath.split(/[?#]/, 1)[0] || '/';
  if (basePath && (path === basePath || path.startsWith(`${basePath}/`))) path = path.slice(basePath.length) || '/';
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return { group: 'page:home', deeper: false };
  const [first, second] = segments;
  if (first === '_next') {
    return { group: second === 'static' ? 'static' : second === 'image' ? 'image' : 'other', deeper: false };
  }
  if (first === 'api') {
    return { group: second && API.has(second) ? `api:${second}` : 'api:other', deeper: segments.length > 2 };
  }
  if ((segments.length === 1 && first.includes('.')) || ASSET_FOLDERS.has(first)) return { group: 'asset', deeper: false };
  const rest = LOCALE.test(first) && !AREAS.has(first) ? segments.slice(1) : segments;
  if (rest.length === 0) return { group: 'page:home', deeper: false };
  return { group: AREAS.has(rest[0]) ? `page:${rest[0]}` : 'page:other', deeper: rest.length > 1 };
}

/**
 * The group of a path: `api:<folder>`, `page:<area>`, `page:home`, `static`,
 * `image`, `asset` or `other`. `basePath` is removed first.
 */
export function routeGroup(rawPath: string, basePath = ''): string {
  return parse(rawPath, basePath).group;
}

/**
 * A path for an error report: the group as a path, and `/…` when the path
 * went deeper. `/de/mail/folder/Projects%20ACME/abc` -> `/mail/…`.
 */
export function scrubRoutePath(rawPath: string, basePath = ''): string {
  const { group, deeper } = parse(rawPath, basePath);
  const base = group === 'page:home' ? '/'
    : group.startsWith('api:') ? `/api/${group.slice(4)}`
    : group.startsWith('page:') ? `/${group.slice(5)}`
    : `/${group}`;
  return deeper ? `${base}/…` : base;
}
