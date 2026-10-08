import type { NextRequest } from 'next/server';

function httpOrigin(value: string | null): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : '';
  } catch {
    return '';
  }
}

/**
 * The origin the browser has this webmail open on (#1130).
 *
 * `request.nextUrl.origin` is not it behind a reverse proxy: Next's standalone
 * server builds that URL from HOSTNAME/PORT, so it reads `http://0.0.0.0:3000`.
 * The launch request is a same-origin POST, which always carries `Origin` -
 * the very header the CSRF gate checks - so that is the page's origin. Clients
 * that send none fall back to what the reverse proxy forwarded.
 */
export function wopiBrowserOrigin(request: NextRequest): string {
  const origin = httpOrigin(request.headers.get('origin'));
  if (origin) return origin;

  const host = (request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '')
    .split(',')[0]
    .trim();
  if (host) {
    const proto =
      (request.headers.get('x-forwarded-proto') ?? '').split(',')[0].trim() ||
      request.nextUrl.protocol.replace(/:$/, '');
    const forwarded = httpOrigin(`${proto}://${host}`);
    if (forwarded) return forwarded;
  }
  return request.nextUrl.origin;
}

/**
 * Base URL the editor calls this webmail on; `/api/wopi/files/<id>` is
 * appended to form the WOPISrc. Defaults to the browser's origin, and
 * `wopiHostUrl` overrides it where the editor sees a different host than the
 * browser (docker networks, split DNS).
 *
 * The API only exists under the base path of a sub-path install, so it is
 * added to the default and to an override that is a bare origin. An override
 * that carries a path of its own is taken as written.
 */
export function wopiHostBase(request: NextRequest, override: string): string {
  const basePath = (request.nextUrl.basePath ?? '').replace(/\/+$/, '');
  const configured = override.trim().replace(/\/+$/, '');
  if (!configured) return `${wopiBrowserOrigin(request)}${basePath}`;
  try {
    const url = new URL(configured);
    if (url.pathname === '/' || url.pathname === '') return `${url.origin}${basePath}`;
  } catch {
    // Not a URL - nothing to add a path to.
  }
  return configured;
}
