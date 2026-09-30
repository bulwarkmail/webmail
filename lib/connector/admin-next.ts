/**
 * The `?next=` round-trip for the admin area.
 *
 * A connector link to an admin panel lands on `/admin/...` with no admin
 * session, the layout bounces to `/admin/login`, and without this the admin
 * would log in and arrive at the dashboard instead of the extension they
 * clicked Install on.
 *
 * This is the one place in the whole connector flow where a *path* comes out
 * of a URL rather than out of a fixed template, so it gets the strictest
 * check in it. Everything that is not unmistakably an admin path inside this
 * app is thrown away and the login falls back to `/admin`.
 */

const SAFE = /^\/admin(?:\/[A-Za-z0-9._~-]+)*\/?$/;

/**
 * Returns a path safe to `router.replace()` after login, or null.
 *
 * Refuses anything that could leave this origin or this area: a scheme, a
 * protocol-relative `//host`, a backslash (which some browsers normalise to
 * `/`), an encoded separator, a `..` segment, or a path outside `/admin`.
 * A `?tab=` query is allowed, and validated by the caller against the real
 * tab list - the admin shell keeps its tab in a store, so that is how a link
 * reaches a specific panel.
 */
export function safeAdminNext(raw: string | null | undefined): string | null {
  if (!raw) return null;

  let value = raw;
  // One decode, so `%2f%2fevil` cannot smuggle a separator past the checks
  // below. A value that is not valid percent-encoding is not a path we wrote.
  try {
    value = decodeURIComponent(raw);
  } catch {
    return null;
  }

  if (value.length > 512) return null;
  if (value.includes('\\') || value.includes('\0')) return null;
  if (value.startsWith('//')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;

  const [path, query = ''] = value.split('?', 2);
  if (!SAFE.test(path)) return null;
  if (path.split('/').includes('..')) return null;
  // Only the tab hand-off, and only as a plain word.
  if (query && !/^tab=[a-z_]{1,32}$/.test(query)) return null;

  return query ? `${path}?${query}` : path;
}
