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

import type { AdminSidebarApp } from '@/lib/admin/types';

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

    // Ids only have to be stable and unique; the shape is ours to impose.
    const rawId = typeof app.id === 'string' ? app.id.replace(ID_SUFFIX_RE, '') : '';
    const base = rawId.startsWith(DEFAULT_SIDEBAR_APP_ID_PREFIX)
      ? rawId
      : `${DEFAULT_SIDEBAR_APP_ID_PREFIX}${rawId || out.length + 1}`;
    let id = base;
    for (let n = 2; seenIds.has(id); n++) id = `${base}-${n}`;
    seenIds.add(id);

    out.push({
      id,
      name,
      url,
      icon,
      openMode: app.openMode === 'inline' ? 'inline' : 'tab',
      showOnMobile: app.showOnMobile === true,
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
