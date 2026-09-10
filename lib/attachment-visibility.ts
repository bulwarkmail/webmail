/**
 * Which attachment parts belong in the attachment list, and which are really
 * pieces of the rendered body.
 *
 * A message body embeds images by `cid:` reference. Well-behaved senders mark
 * those parts `Content-Disposition: inline` with an `image/*` type, and the
 * "hide inline images" setting keeps them out of the attachment list. Sloppy
 * senders (Foxmail, various order/invoice systems - #543's pattern) ship the
 * very same parts as `application/octet-stream` with no disposition and no
 * name: the body still renders them, but the declaration-based check let them
 * through and they showed up as nameless "Attachment" chips next to the real
 * files. The reference scan below closes that gap for the viewers the way the
 * composer's forward path already handles it.
 */

/**
 * The exact pattern the viewers rewrite to blob URLs, so "referenced" here
 * means "rendered" and a chip is only ever hidden for a part the body shows.
 */
const CID_REFERENCE = /\bcid:([^"'\s)]+)/gi;

const EMPTY: ReadonlySet<string> = new Set();

/**
 * Content-IDs a raw HTML body references via `cid:` URLs (img src, table
 * background, style url(...) - anything), exactly as written. `null` (the
 * message renders as plain text) yields an empty set: nothing is embedded, so
 * nothing must be hidden.
 */
export function collectReferencedCids(html: string | null | undefined): ReadonlySet<string> {
  if (!html || html.indexOf('cid:') === -1) return EMPTY;
  const cids = new Set<string>();
  for (const match of html.matchAll(CID_REFERENCE)) {
    cids.add(match[1]);
  }
  return cids;
}

export interface AttachmentPartLike {
  cid?: string | null;
  type?: string | null;
  disposition?: string | null;
}

/**
 * True when the part is embedded in the rendered body and should stay out of
 * the attachment list while "hide inline images" is on.
 *
 * - Declared inline images hide as before, referenced or not.
 * - An explicit `attachment` disposition always keeps its chip - the sender
 *   asked for a download, even if the body also references the part.
 * - Otherwise a part hides only when the body actually references it AND it
 *   is an image or generically typed (`application/octet-stream`, no type):
 *   a referenced part with a real non-image type keeps its chip, because that
 *   chip is its only download.
 */
export function isEmbeddedInBody(
  att: AttachmentPartLike,
  referencedCids: ReadonlySet<string>,
): boolean {
  if (!att.cid) return false;
  const type = (att.type || '').toLowerCase();
  const isImage = type.startsWith('image/');
  if (att.disposition === 'inline' && isImage) return true;
  if (att.disposition === 'attachment') return false;
  const genericType = !type || type === 'application/octet-stream';
  if (!isImage && !genericType) return false;
  // The Content-ID may still carry its angle brackets; body references never do.
  return referencedCids.has(att.cid.replace(/^<|>$/g, ''));
}
