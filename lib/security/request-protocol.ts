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
