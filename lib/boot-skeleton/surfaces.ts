/**
 * Which page skeleton a URL gets.
 *
 * The server knows the route it renders, so most pages pick their skeleton
 * directly. The tables here cover the cases where the skeleton belongs to a
 * different page than the URL: a connector link draws its destination, the
 * protocol handlers draw the app they hand over to.
 */

export type BootSurface =
  | 'mail'
  | 'calendar'
  | 'contacts'
  | 'files'
  | 'apps'
  | 'settings'
  | 'pro'
  | 'admin'
  | 'admin-login'
  | 'login'
  | 'setup';

/**
 * Connector target name -> the surface its destination path opens.
 * lib/boot-skeleton/__tests__/surfaces.test.ts checks this covers every
 * target in lib/connector/registry.ts.
 */
export const CONNECTOR_SURFACES: Record<string, BootSurface> = {
  app: 'mail',
  settings: 'settings',
  mail_folder: 'mail',
  calendar: 'calendar',
  contacts: 'contacts',
  files: 'files',
  admin: 'admin',
  admin_extension: 'admin',
  admin_plugin: 'admin',
  admin_auth: 'admin',
  setup: 'setup',
};

/** Protocol handler -> the surface it forwards to (mailto opens the composer over mail). */
export const PROTOCOL_SURFACES: Record<string, BootSurface> = {
  mailto: 'mail',
  webcal: 'calendar',
};

/** Surfaces the Pro interface takes over on a desktop (components/pro/pro-interface-redirect.tsx). */
export const PRO_SURFACES: readonly BootSurface[] = ['mail', 'calendar', 'contacts', 'files', 'settings'];

/** Surfaces a signed-out visitor is sent away from to /login. */
export const SIGNED_IN_SURFACES: readonly BootSurface[] = ['mail', 'calendar', 'contacts', 'files', 'apps', 'settings', 'pro'];

export const CALENDAR_VIEWS = ['month', 'week', 'day', 'agenda', 'tasks'] as const;

const PATH_SURFACES: readonly BootSurface[] = ['mail', 'calendar', 'contacts', 'files', 'apps', 'settings', 'pro', 'login', 'setup'];

/**
 * The surface a pathname (as usePathname reports it: no base path, maybe a
 * locale) belongs to, or null for pages without a skeleton. The boot script
 * does the same in the browser for the variant attributes.
 */
export function surfaceFromPath(pathname: string, localeList: readonly string[]): BootSurface | null {
  let seg = pathname.split('/').filter(Boolean);
  // A Lite bundle mounted under a prefix (/webmail/de/...) keeps the prefix
  // in the path: everything up to the locale goes.
  const firstKnown = (s: string | undefined) =>
    s !== undefined && ((PATH_SURFACES as readonly string[]).includes(s) || s === 'admin' || s === 'connector' || s === 'protocol');
  if (!firstKnown(seg[0])) {
    const at = seg.findIndex((s) => localeList.includes(s));
    if (at !== -1 && at < 3) seg = seg.slice(at + 1);
  }
  const first = seg[0] ?? '';
  if (first === '') return 'mail';
  if (first === 'admin') return seg[1] === 'login' ? 'admin-login' : 'admin';
  if (first === 'connector') return CONNECTOR_SURFACES[seg[1] ?? ''] ?? null;
  if (first === 'protocol') return PROTOCOL_SURFACES[seg[1] ?? ''] ?? null;
  return (PATH_SURFACES as readonly string[]).includes(first) ? (first as BootSurface) : null;
}
