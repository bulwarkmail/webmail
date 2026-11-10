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
 * The exact pattern the viewers rewrite to blob URLs (rewriteCidReferences),
 * so "referenced" here means "rendered" and a chip is only ever hidden for a
 * part the body shows. A reference ends at `<`/`>` too: an unquoted
 * `<img src=cid:logo>` would otherwise take the rest of the markup with it.
 */
const CID_REFERENCE = /\bcid:([^"'\s)<>]+)/gi;

/**
 * Swaps every `cid:` reference in a raw HTML body for the URL fetched for that
 * part, or `fallback` when there is none.
 */
export function rewriteCidReferences(html: string, urls: Readonly<Record<string, string>>, fallback: string): string {
  return html.replace(CID_REFERENCE, (_match, cid: string) =>
    (Object.prototype.hasOwnProperty.call(urls, cid) ? urls[cid] : fallback));
}

const EMPTY: ReadonlySet<string> = new Set();

/**
 * Strips the RFC angle brackets a Content-ID header may still carry (e.g.
 * `<logo123@sender>`). Body `cid:` references never have them, so every
 * comparison between an attachment's `cid`/`contentId` and a body reference
 * must normalize through this first.
 */
export function normalizeCid(cid: string): string {
  return cid.replace(/^<|>$/g, '');
}

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

/**
 * Machine-readable report parts: the delivery status of a bounce (RFC 3464),
 * the disposition of a read receipt (RFC 8098) and their RFC 6533 UTF-8
 * forms. A multipart/report needs them, but they are not files anyone
 * attached, so no view lists them and a forward leaves them out.
 */
const REPORT_PART_TYPES: ReadonlySet<string> = new Set([
  'message/delivery-status',
  'message/disposition-notification',
  'message/global-delivery-status',
  'message/global-disposition-notification',
]);

export function isReportPart(type: string | null | undefined): boolean {
  return REPORT_PART_TYPES.has((type || '').toLowerCase());
}

export interface AttachmentPartLike {
  cid?: string | null;
  type?: string | null;
  disposition?: string | null;
  size?: number | null;
}

/**
 * True when the part is embedded in the rendered body and should stay out of
 * the attachment list while "hide inline images" is on.
 *
 * - Declared inline images hide as before, referenced or not, unless the
 *   body is shown as plain text.
 * - An explicit `attachment` disposition keeps its chip - the sender asked
 *   for a download, even if the body also references the part - unless the
 *   part only repeats an image the body embeds (isCopyOfEmbeddedImage).
 * - Otherwise a part hides only when the body actually references it AND it
 *   is an image or generically typed (`application/octet-stream`, no type):
 *   a referenced part with a real non-image type keeps its chip, because that
 *   chip is its only download.
 *
 * `parts` are all of the message's attachment parts, `att` among them;
 * without them no part counts as such a copy.
 *
 * With `plainText` (an HTML message shown as plain text) the body draws no
 * image, so every part keeps its chip, declared inline images included. Only
 * an inline image the message also attaches as a copy leaves its chip to the
 * copy, so the file is listed once.
 */
export function isEmbeddedInBody(
  att: AttachmentPartLike,
  referencedCids: ReadonlySet<string>,
  parts: readonly AttachmentPartLike[] = [],
  options: { plainText?: boolean } = {},
): boolean {
  if (options.plainText) {
    return att.disposition !== 'attachment'
      && parts.some((part) => part.disposition === 'attachment' && isSameImage(att, part));
  }
  if (att.disposition === 'attachment') return isCopyOfEmbeddedImage(att, referencedCids, parts);
  return embedsItself(att, referencedCids);
}

/** Whether the body embeds the part by its own declaration or reference. */
function embedsItself(att: AttachmentPartLike, referencedCids: ReadonlySet<string>): boolean {
  if (!att.cid) return false;
  const type = (att.type || '').toLowerCase();
  const isImage = type.startsWith('image/');
  if (att.disposition === 'inline' && isImage) return true;
  if (att.disposition === 'attachment') return false;
  const genericType = !type || type === 'application/octet-stream';
  if (!isImage && !genericType) return false;
  return referencedCids.has(normalizeCid(att.cid));
}

/**
 * Some senders (seen from Exchange Online) attach each image of the body a
 * second time: an `attachment` part with the Content-ID, type and size of the
 * embedded one, the very same file. Such a copy goes wherever the image it
 * repeats goes: it hides as well, but only when the body references that
 * Content-ID and another part of the message is the embedded image itself.
 * Two attachments never make each other copies.
 */
function isCopyOfEmbeddedImage(
  att: AttachmentPartLike,
  referencedCids: ReadonlySet<string>,
  parts: readonly AttachmentPartLike[],
): boolean {
  if (!att.cid || !referencedCids.has(normalizeCid(att.cid))) return false;
  return parts.some((part) => isSameImage(att, part) && embedsItself(part, referencedCids));
}

/** Two parts that are the same image: Content-ID, type and size alike. */
function isSameImage(a: AttachmentPartLike, b: AttachmentPartLike): boolean {
  if (a === b || !a.cid || !b.cid || typeof a.size !== 'number' || a.size <= 0) return false;
  const type = (a.type || '').toLowerCase();
  return type.startsWith('image/')
    && normalizeCid(a.cid) === normalizeCid(b.cid)
    && (b.type || '').toLowerCase() === type
    && b.size === a.size;
}
