/**
 * The {name} segment of a JMAP download URL (RFC 8620 §6.2).
 *
 * The server only uses it for the Content-Disposition filename, but mailers
 * sometimes put a path in a part's name ("/images/banner.jpg"). Percent-
 * encoded, its slashes become %2F, which Apache (without AllowEncodedSlashes
 * NoDecode), Traefik and nginx proxy_pass with a URI reject or decode, so the
 * download failed and inline cid: images showed as blank (#1371). Keep the
 * last path component instead.
 */
export function downloadNameSegment(name: string | undefined): string {
  const base = (name ?? '').split(/[/\\]/).pop()?.trim();
  return base || 'download';
}
