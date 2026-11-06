/**
 * Admin-provided sidebar apps (#931) and how they combine with the user's own.
 *
 * An operator can pin a set of apps in the admin dashboard so every user gets
 * them in the navigation rail without configuring anything. They are stored in
 * the settings policy, so they arrive with the policy the client already
 * fetches, and they are read-only there - the merge below marks them `managed`
 * so the UI can render them without edit/delete affordances.
 *
 * Everything a user could see here comes from the policy file, which an
 * operator can also edit by hand, so entries are sanitized on the way in
 * rather than trusted: a malformed app is dropped, not rendered.
 */

import type { AdminSidebarApp, SidebarAppFeature } from '@/lib/admin/types';
import { appUrlToFrameOrigin } from '@/lib/security/app-frame-origins';

/** Cap on how many apps an operator can pin, matching the CSP origin budget. */
export const MAX_DEFAULT_SIDEBAR_APPS = 20;

/** Prefix every admin app id carries, so it can never collide with a user's. */
export const DEFAULT_SIDEBAR_APP_ID_PREFIX = 'admin-app-';

const MAX_APP_NAME_LENGTH = 50;
const MAX_APP_URL_LENGTH = 2048;

/**
 * Icon names: `tabler:<name>` or a bare Tabler name, or a Lucide PascalCase
 * name saved before the switch to Tabler (translated when rendered). Anything
 * else can't resolve.
 */
const ICON_NAME_RE = /^(?:(?:tabler:)?[a-z0-9]+(?:-[a-z0-9]+){0,7}|[A-Za-z][A-Za-z0-9]{0,63})$/;

const ID_SUFFIX_RE = /[^a-zA-Z0-9_-]/g;

/**
 * The browser features an operator can grant an inline app's frame, each a
 * Permissions Policy feature: copy buttons, calls and screen sharing, full
 * screen. Anything else in a policy's `allow` is dropped.
 */
export const SIDEBAR_APP_FEATURES: readonly SidebarAppFeature[] = [
  'clipboard-write',
  'microphone',
  'camera',
  'display-capture',
  'fullscreen',
];

/** What every inline app's frame gets. */
const BASE_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox';

/** A sidebar app as rendered: the user's own, or one pinned by the operator. */
export interface ResolvedSidebarApp extends AdminSidebarApp {
  /** True for admin-provided apps, which the user cannot edit or remove. */
  managed?: boolean;
}

function sanitizeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const url = raw.trim();
  if (!url || url.length > MAX_APP_URL_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!parsed.host) return null;
  return url;
}

function sanitizeAllow(raw: unknown): SidebarAppFeature[] {
  if (!Array.isArray(raw)) return [];
  return SIDEBAR_APP_FEATURES.filter((feature) => raw.includes(feature));
}

/**
 * An app's own image as its icon: https and on the app's own origin, so it
 * names no host the app doesn't already (the page's CSP allows that origin in
 * img-src: `https:`, or the app's origin with no third-party traffic).
 */
function sanitizeIconUrl(raw: unknown, appUrl: string): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const iconUrl = raw.trim();
  if (!iconUrl || iconUrl.length > MAX_APP_URL_LENGTH) return undefined;
  let icon: URL;
  try {
    icon = new URL(iconUrl);
  } catch {
    return undefined;
  }
  if (icon.protocol !== 'https:' || icon.username || icon.password) return undefined;
  return icon.origin === new URL(appUrl).origin ? iconUrl : undefined;
}

/**
 * Validates the operator's app list. Bad entries are dropped individually so a
 * single typo never blanks out the rest, and ids are forced into the admin
 * namespace so a hand-written policy can't shadow a user's own app.
 */
export function sanitizeDefaultSidebarApps(raw: unknown): AdminSidebarApp[] {
  if (!Array.isArray(raw)) return [];
  const seenIds = new Set<string>();
  const out: AdminSidebarApp[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const app = entry as Partial<AdminSidebarApp>;

    const name = typeof app.name === 'string' ? app.name.trim().slice(0, MAX_APP_NAME_LENGTH) : '';
    if (!name) continue;

    const url = sanitizeUrl(app.url);
    if (!url) continue;

    const icon = typeof app.icon === 'string' && ICON_NAME_RE.test(app.icon) ? app.icon : 'Globe';
    const iconUrl = sanitizeIconUrl(app.iconUrl, url);

    // Ids only have to be stable and unique; the shape is ours to impose.
    const rawId = typeof app.id === 'string' ? app.id.replace(ID_SUFFIX_RE, '') : '';
    const base = rawId.startsWith(DEFAULT_SIDEBAR_APP_ID_PREFIX)
      ? rawId
      : `${DEFAULT_SIDEBAR_APP_ID_PREFIX}${rawId || out.length + 1}`;
    let id = base;
    for (let n = 2; seenIds.has(id); n++) id = `${base}-${n}`;
    seenIds.add(id);

    const openMode = app.openMode === 'inline' ? 'inline' : 'tab';
    // Only a frame can use them, so a tab app keeps none.
    const allow = openMode === 'inline' ? sanitizeAllow(app.allow) : [];

    out.push({
      id,
      name,
      url,
      icon,
      ...(iconUrl ? { iconUrl } : {}),
      openMode,
      showOnMobile: app.showOnMobile === true,
      ...(allow.length > 0 ? { allow } : {}),
    });
    if (out.length >= MAX_DEFAULT_SIDEBAR_APPS) break;
  }

  return out;
}

/**
 * The rail's app list: operator-provided apps first, then the user's own.
 *
 * Callers pass an empty user list when the `sidebarAppsEnabled` gate is off -
 * that gate governs custom apps only, so an operator's own set survives it.
 */
export function mergeSidebarApps(
  // Untyped on purpose: this is the raw policy value, sanitized below.
  defaults: unknown,
  userApps: readonly AdminSidebarApp[] | undefined | null
): ResolvedSidebarApp[] {
  const managed = sanitizeDefaultSidebarApps(defaults);
  const seen = new Set(managed.map((app) => app.id));
  const own = (Array.isArray(userApps) ? userApps : []).filter((app) => app && !seen.has(app.id));
  return [...managed.map((app) => ({ ...app, managed: true })), ...own];
}

/** An inline app's frame attributes; `allow` absent when nothing is granted. */
export interface AppFrameRights {
  sandbox: string;
  allow?: string;
}

/**
 * What an inline app's frame may do. An app of the policy (matched by id and
 * origin, so a user's own app can't borrow an operator's id) also gets
 * downloads and dialogs, as the office editor's frame does, and the features
 * the operator listed, each for the app's origin only. A user's own app gets
 * the base sandbox and nothing else. Never `allow-top-navigation`.
 */
export function appFrameRights(
  app: { id: string; url: string },
  managedApps: readonly AdminSidebarApp[],
  { downloadsOff = false }: { downloadsOff?: boolean } = {}
): AppFrameRights {
  const origin = appUrlToFrameOrigin(app.url);
  const managed = origin
    ? managedApps.find((m) => m.id === app.id && m.openMode === 'inline' && appUrlToFrameOrigin(m.url) === origin)
    : undefined;
  if (!managed || !origin) return { sandbox: BASE_SANDBOX };

  const sandbox = `${BASE_SANDBOX}${downloadsOff ? '' : ' allow-downloads'} allow-modals`;
  const features = sanitizeAllow(managed.allow);
  if (features.length === 0) return { sandbox };
  return { sandbox, allow: features.map((feature) => `${feature} ${origin}`).join('; ') };
}

/**
 * Origins of the policy's inline apps granted a feature. Bulwark's own
 * `Permissions-Policy` header turns camera and microphone off, which no
 * frame's `allow` can widen, so the proxy names these origins there.
 */
export function managedAppOriginsWith(defaults: unknown, feature: SidebarAppFeature): string[] {
  const out: string[] = [];
  for (const app of sanitizeDefaultSidebarApps(defaults)) {
    if (!app.allow?.includes(feature)) continue;
    const origin = appUrlToFrameOrigin(app.url);
    if (origin && !out.includes(origin)) out.push(origin);
  }
  return out;
}
