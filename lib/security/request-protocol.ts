/**
 * Whether the browser reached us over HTTPS.
 *
 * The app itself only ever speaks plain HTTP: TLS terminates at the reverse
 * proxy in front of it, which is expected to say so in `X-Forwarded-Proto`.
 * Without a proxy the request URL's own scheme is the truth. Both the setup
 * wizard and the admin session derive the cookie `Secure` flag from this, so
 * the answer is the same for both.
 */
export function isHttpsRequest(request: Request): boolean {
  const forwarded = request.headers.get('x-forwarded-proto');
  if (forwarded) {
    return forwarded.split(',')[0]!.trim().toLowerCase() === 'https';
  }
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Whether the site is served over HTTPS, for decisions a missing proxy header
 * must not weaken: which cookie name to trust, whether to send HSTS. A TLS
 * proxy that sends no X-Forwarded-Proto makes every request look like plain
 * HTTP, so COOKIE_SECURE=true counts as the operator saying it is HTTPS.
 */
export function isServedOverHttps(request: Request): boolean {
  return process.env.COOKIE_SECURE === 'true' || isHttpsRequest(request);
}

/**
 * The `Secure` flag for a cookie the server sets. An explicit COOKIE_SECURE
 * wins, as it does for the mailbox cookies; otherwise it follows the request,
 * because the browser drops Secure cookies on plain HTTP. Without a request
 * the production default stands.
 */
export function secureCookieFlag(request?: Request): boolean {
  if (process.env.COOKIE_SECURE !== undefined) return process.env.COOKIE_SECURE === 'true';
  return request ? isHttpsRequest(request) : process.env.NODE_ENV === 'production';
}
