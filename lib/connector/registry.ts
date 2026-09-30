/**
 * The instance half of the connector contract.
 *
 * A connector link names a destination, not a host:
 *
 *   https://connector.bulwarkmail.org/settings?tab=filters
 *
 * The connector (repos/connector, github.com/bulwarkmail/connector) resolves
 * that against whichever instance the reader's browser has stored, and sends
 * them to `<instance>/connector/settings?tab=filters`. This file is what
 * happens next: it turns a target name plus its parameters into a real path
 * inside this app.
 *
 * The split is deliberate. The connector knows the *names* and the parameter
 * schemas; only this file knows the *paths*. So a route can move here without
 * breaking a link that was published a year ago, and an instance older than
 * the connector renders a "this version doesn't know that link" card instead
 * of a 404.
 *
 * `TARGET_NAMES` and `PARAMS` mirror `src/lib/registry.ts` in the connector.
 * `__tests__/connector-registry.test.ts` checks the halves agree; when they
 * diverge, this side is the one that must not silently accept something it
 * cannot resolve.
 *
 * Nothing here interpolates raw input into a path. Every parameter is checked
 * against its declared type first, and the templates are fixed strings - there
 * is deliberately no parameter that carries a path, a URL, or a redirect.
 */

import { ADMIN_TABS, type AdminTabId } from '@/stores/admin-tab-store';
import type { SettingsSearchTab } from '@/lib/settings-search';
import { buildSettingsPath, buildFilesPath } from '@/lib/deep-links';

/** Mirrors `SettingsSearchTab`. Listed so an unknown tab is refused here. */
const SETTINGS_TABS: readonly SettingsSearchTab[] = [
  'account', 'language', 'notifications', 'appearance', 'layout', 'reading',
  'composing', 'downloads', 'identities', 'vacation', 'filters', 'templates',
  'folders', 'keywords', 'security', 'content_senders', 'calendar', 'contacts',
  'files', 'protocol_handlers', 'sidebar_apps', 'about_data', 'themes',
  'plugins', 'debug',
];

const CALENDAR_VIEWS = ['month', 'week', 'day', 'agenda', 'tasks'] as const;

// A mailbox ref is validated as an opaque id here, not against a list: the
// readable aliases (`inbox`, `unified-sent`, ...) are resolved by
// `resolveFolderRef` in lib/deep-links.ts, and a custom folder only has its
// JMAP id. The connector carries the alias list purely as suggestions for its
// link generator.

export type ParamType = 'enum' | 'slug' | 'date' | 'id' | 'path';

export interface ParamSpec {
  readonly type: ParamType;
  readonly values?: readonly string[];
  readonly required?: boolean;
}

/**
 * What a resolved target asks the client to do.
 *
 * Most targets are just a path. The admin ones carry a `tab` as well, because
 * the admin shell keeps its active tab in a zustand store rather than in the
 * URL (see app/(main)/admin/layout.tsx) - so reaching a specific panel means
 * setting that store before navigating to /admin. If admin ever gains real
 * `/admin/<tab>` routes, this collapses back into a plain path.
 */
export interface Resolution {
  /** App-relative path; feed through `appPath()` before navigating. */
  readonly path: string;
  readonly adminTab?: AdminTabId;
  /** True when the destination requires an admin session, not a user one. */
  readonly admin?: boolean;
}

export interface Target {
  readonly name: string;
  /** Shown on the "this version doesn't know that link" card. */
  readonly label: string;
  readonly params?: Readonly<Record<string, ParamSpec>>;
  readonly resolve: (params: Readonly<Record<string, string>>) => Resolution;
}

export const TARGETS: readonly Target[] = [
  {
    name: 'app',
    label: 'Bulwark',
    resolve: () => ({ path: '/mail' }),
  },
  {
    name: 'settings',
    label: 'Settings',
    params: { tab: { type: 'enum', values: SETTINGS_TABS } },
    resolve: (p) => ({ path: buildSettingsPath(p.tab ?? null) }),
  },
  {
    name: 'mail_folder',
    label: 'a mail folder',
    params: { ref: { type: 'id' } },
    resolve: (p) => ({
      path: p.ref ? `/mail/folder/${encodeURIComponent(p.ref)}` : '/mail',
    }),
  },
  {
    name: 'calendar',
    label: 'Calendar',
    params: {
      view: { type: 'enum', values: CALENDAR_VIEWS },
      date: { type: 'date' },
    },
    resolve: (p) => {
      const view = p.view ?? 'month';
      return { path: p.date ? `/calendar/${view}/${p.date}` : `/calendar/${view}` };
    },
  },
  {
    name: 'contacts',
    label: 'Contacts',
    resolve: () => ({ path: '/contacts' }),
  },
  {
    name: 'files',
    label: 'Files',
    params: { path: { type: 'path' } },
    resolve: (p) => ({ path: buildFilesPath(p.path ?? '') }),
  },
  {
    name: 'admin',
    label: 'the admin area',
    params: { tab: { type: 'enum', values: ADMIN_TABS } },
    resolve: (p) => ({
      path: '/admin',
      adminTab: (p.tab as AdminTabId | undefined) ?? 'dashboard',
      admin: true,
    }),
  },
  {
    name: 'admin_extension',
    label: 'an extension in the marketplace',
    params: { slug: { type: 'slug', required: true } },
    resolve: (p) => ({
      path: `/admin/marketplace/${encodeURIComponent(p.slug)}`,
      admin: true,
    }),
  },
  {
    name: 'admin_plugin',
    label: "a plugin's settings",
    params: { id: { type: 'slug', required: true } },
    resolve: (p) => ({ path: `/admin/plugins/${encodeURIComponent(p.id)}`, admin: true }),
  },
  {
    name: 'admin_auth',
    label: 'authentication settings',
    resolve: () => ({ path: '/admin', adminTab: 'auth', admin: true }),
  },
  {
    name: 'setup',
    label: 'the setup wizard',
    resolve: () => ({ path: '/setup' }),
  },
] as const;

const BY_NAME = new Map(TARGETS.map((t) => [t.name, t]));

/** Names this instance can resolve - what `/api/connector/capabilities` reports. */
export const TARGET_NAMES: readonly string[] = TARGETS.map((t) => t.name);

export function getTarget(name: string | null | undefined): Target | null {
  if (!name) return null;
  return BY_NAME.get(name) ?? null;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const MAX_PARAM_LENGTH = 512;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

function checkParam(spec: ParamSpec, value: string): boolean {
  if (value.length > MAX_PARAM_LENGTH) return false;
  switch (spec.type) {
    case 'enum':
      return (spec.values ?? []).includes(value);
    case 'slug':
      return SLUG.test(value);
    case 'date':
      return isRealDate(value);
    case 'id':
      // Becomes one path segment, so it must not be able to climb out of it.
      // `%` is refused along with the separators because the value is decoded
      // twice on the way in - once by the router, once by `resolveFolderRef`
      // in deep-links.ts - so `..%2Fadmin` would arrive as `../admin`. Real
      // JMAP ids have no percent signs in them.
      return !/[/\\?#%]/.test(value) && value !== '.' && value !== '..';
    case 'path': {
      const segments = value.split('/').filter(Boolean);
      if (segments.length === 0 || segments.length > 32) return false;
      return !segments.some((s) => s === '.' || s === '..' || /[\\?#]/.test(s));
    }
  }
}

export type ResolveResult =
  | { readonly kind: 'ok'; readonly target: Target; readonly resolution: Resolution }
  /** The registry has no such name - an instance older than the link. */
  | { readonly kind: 'unknown-target' }
  /** A declared parameter is malformed. Never echoed back into the page. */
  | { readonly kind: 'bad-param'; readonly target: Target; readonly param: string };

/**
 * Turns `/connector/<name>?<params>` into a path inside this app.
 *
 * Never throws and never 404s: an unparseable link is a card the user can read,
 * not a dead end. Unknown parameters are dropped rather than refused, so a
 * newer connector can hand an older instance a link carrying something extra
 * and have it still open the right surface.
 */
export function resolveTarget(
  name: string | null | undefined,
  search: URLSearchParams | Readonly<Record<string, string>>,
): ResolveResult {
  const target = getTarget(name);
  if (!target) return { kind: 'unknown-target' };

  const read = (key: string): string | null =>
    search instanceof URLSearchParams ? search.get(key) : (search[key] ?? null);

  const params: Record<string, string> = {};
  for (const [key, spec] of Object.entries(target.params ?? {})) {
    const value = read(key);
    if (value === null || value === '') {
      if (spec.required) return { kind: 'bad-param', target, param: key };
      continue;
    }
    if (!checkParam(spec, value)) return { kind: 'bad-param', target, param: key };
    params[key] = value;
  }

  return { kind: 'ok', target, resolution: target.resolve(params) };
}
