import { sanitizeSignatureHtml } from "@/lib/email-sanitization";
import { htmlToPlainText } from "@/lib/html-to-text";
import { plainTextToComposerBody } from "@/lib/email-composer-utils";
import {
  appendPlainTextSignature,
  plainTextBodyHasSignature,
  plainTextBodyWithoutSignature,
} from "@/lib/signature-utils";
import { wantsSignatureSeparator } from "@/lib/signature-delimiter";
import { buildSignatureBlock, SIGNATURE_RANGE_MARKER } from "@/components/email/signature-block";

/**
 * Helpers for the composer's per-message HTML <-> plain-text switch (#1022).
 *
 * Both directions preserve the one invariant the send and draft-save paths
 * rely on: whether the body *carries* the signature. An HTML body carries it
 * as a marker-bracketed range (`containsEmbeddedSignature`), a plain-text
 * body by ending with the signature text (`plainTextBodyHasSignature`). The
 * converters strip the signature in the source format and re-append it in
 * the target format, so a switch never produces a doubled or lost signature.
 */

export type SignatureIdentityLike = {
  htmlSignature?: string;
  textSignature?: string;
} | null | undefined;

// Render the embedded signature. Bracketed with `data-signature-block` marker
// paragraphs so we can swap the inner content when the user switches identity
// without losing the surrounding draft or quoted message. The markers are
// preserved through TipTap by the StyledParagraph extension. The HTML
// signature itself is wrapped in a SignatureBlock atom node so its inline
// styling survives the editor (see signature-block.ts) instead of being
// flattened by the schema.
export function buildEmbeddedSignatureHtml(
  identity: SignatureIdentityLike,
  options: { embed: boolean; separator: boolean }
): string {
  if (!options.embed) return '';
  const startMarker = wantsSignatureSeparator(options.separator, identity)
    ? `<p ${SIGNATURE_RANGE_MARKER}="separator">-- </p>`
    : `<p ${SIGNATURE_RANGE_MARKER}="start"></p>`;
  const endMarker = `<p ${SIGNATURE_RANGE_MARKER}="end"></p>`;
  if (identity?.htmlSignature) {
    return `${startMarker}${buildSignatureBlock(sanitizeSignatureHtml(identity.htmlSignature))}${endMarker}`;
  }
  if (identity?.textSignature) {
    const escaped = identity.textSignature
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
    return `${startMarker}<p>${escaped}</p>${endMarker}`;
  }
  return '';
}

function isQuoteBoundary(node: Node | null): boolean {
  if (!node || node.nodeType !== 1) return false;
  const el = node as Element;
  return el.tagName === 'BLOCKQUOTE' || el.hasAttribute('data-quoted-html');
}

/**
 * Remove the embedded signature range [start/separator marker … end marker]
 * from a parsed body. Without an end marker the removal stops before the next
 * quote boundary (a legacy <blockquote> or the QuotedHtml island) so it never
 * eats into the quoted message. Returns the removed nodes' former position so
 * a caller can splice a replacement in, or null when the body has no range.
 */
export function removeSignatureRange(
  doc: Document,
): { parent: Node; insertBefore: Node | null } | null {
  const startEl = doc.querySelector(
    `[${SIGNATURE_RANGE_MARKER}="separator"], [${SIGNATURE_RANGE_MARKER}="start"]`
  );
  if (!startEl) return null;
  const parent = startEl.parentNode;
  if (!parent) return null;
  const endEl = doc.querySelector(`[${SIGNATURE_RANGE_MARKER}="end"]`);
  const removeUntil = endEl && endEl.parentNode === parent ? endEl : null;

  const toRemove: Node[] = [];
  let cursor: Node | null = startEl;
  while (cursor) {
    toRemove.push(cursor);
    if (cursor === removeUntil) break;
    const next: Node | null = cursor.nextSibling;
    if (!removeUntil && isQuoteBoundary(next)) break;
    cursor = next;
  }
  let insertBefore = toRemove[toRemove.length - 1]?.nextSibling ?? null;
  toRemove.forEach((node) => parent.removeChild(node));
  // The end marker is the empty line under the signature, so a click below
  // the signature puts the caret there. Text typed into it is the user's,
  // not part of the signature: keep it as an ordinary paragraph after it.
  if (removeUntil && removeUntil.textContent?.trim()) {
    const kept = removeUntil.cloneNode(true) as Element;
    kept.removeAttribute(SIGNATURE_RANGE_MARKER);
    parent.insertBefore(kept, insertBefore);
    insertBefore = kept;
  }
  return { parent, insertBefore };
}

/**
 * The HTML body with its embedded signature range removed, plus whether one
 * was there. A bare signature atom without range markers (a body whose marker
 * paragraphs were dropped) is left in place - it has no defined extent.
 */
export function stripEmbeddedSignature(html: string): { html: string; hadSignature: boolean } {
  if (!html.includes(SIGNATURE_RANGE_MARKER)) return { html, hadSignature: false };
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const removed = removeSignatureRange(doc);
  if (!removed) return { html, hadSignature: false };
  return { html: doc.body.innerHTML, hadSignature: true };
}

/**
 * The HTML body with its embedded signature swapped for `signatureHtml` (from
 * buildEmbeddedSignatureHtml; empty for an identity without a signature).
 * The new signature goes where the old one was. A body without one - the
 * previous identity had none - gets it where getInitialBody would have put
 * it: above the quote header of a reply or forward (`quoteHeader`, the
 * header's first line, e.g. "On ... wrote:"), else before the quote, else at
 * the end.
 */
export function replaceEmbeddedSignature(
  html: string,
  signatureHtml: string,
  options: { quoteHeader?: string } = {},
): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let removed = removeSignatureRange(doc);
  if (!removed) {
    if (!signatureHtml) return html;
    const children = Array.from(doc.body.childNodes);
    const header = options.quoteHeader
      ? children.find((node) => node.textContent?.includes(options.quoteHeader!))
      : undefined;
    const quote = header ?? children.find(isQuoteBoundary) ?? null;
    // With no line above it, the signature would open the body and leave no
    // place to type (#1503). Put an empty one first, as getInitialBody does,
    // and keep the bare line breaks for the gap down to the quote.
    const above = quote ? children.slice(0, children.indexOf(quote)) : children;
    const hasLineAbove = above.some((node) => node.nodeType === 1
      ? (node as Element).tagName !== 'BR'
      : !!node.textContent?.trim());
    if (!hasLineAbove) {
      removed = { parent: doc.body, insertBefore: above[0] ?? quote };
      signatureHtml = `<p></p>${signatureHtml}`;
    } else {
      removed = { parent: doc.body, insertBefore: quote };
    }
  }
  const host = doc.createElement('div');
  host.innerHTML = signatureHtml;
  Array.from(host.childNodes).forEach((node) =>
    removed.parent.insertBefore(node, removed.insertBefore)
  );
  return doc.body.innerHTML;
}

/**
 * The plain-text body with the previous identity's trailing signature swapped
 * for the next one's. A body that doesn't end with the previous signature was
 * edited there (or never had one) and is only given the new signature when
 * the previous identity had none.
 */
export function replacePlainTextSignature(
  body: string,
  previous: SignatureIdentityLike,
  next: SignatureIdentityLike,
  options: { separator: boolean },
): string {
  const hadSignature = plainTextBodyHasSignature(body, previous);
  if (!hadSignature && (previous?.htmlSignature || previous?.textSignature)) return body;
  const bare = hadSignature ? plainTextBodyWithoutSignature(body, previous) : body;
  return appendPlainTextSignature(bare, next, options);
}

/**
 * replacePlainTextSignature for a plain-text reply or forward with the
 * signature above the quote: the signature ends the part before the quote
 * header (`quoteHeader`, its first line). A body whose header can't be found
 * is returned unchanged.
 */
export function replacePlainTextSignatureAboveQuote(
  body: string,
  quoteHeader: string,
  previous: SignatureIdentityLike,
  next: SignatureIdentityLike,
  options: { separator: boolean },
): string {
  const at = quoteHeader ? body.indexOf(quoteHeader) : -1;
  if (at < 0) return body;
  const head = body.slice(0, at).replace(/\n+$/, '');
  return `${replacePlainTextSignature(head, previous, next, options)}\n\n${body.slice(at)}`;
}

/**
 * Convert the rich-text editor's body to a plain-text body. Formatting is
 * dropped (that is the point of plain text); an embedded signature comes back
 * as the identity's plain-text signature so the body still "carries" it.
 * The quote keeps its "> " lines and lists their markers, as in the text part
 * the send path builds: the attachment reminder and plugin edits find the
 * quote by them.
 */
export function htmlComposeBodyToPlainText(
  html: string,
  identity: SignatureIdentityLike,
  options: { separator: boolean; imageAlt?: (alt: string) => string },
): string {
  const stripped = stripEmbeddedSignature(html);
  const text = htmlToPlainText(stripped.html, { paragraphSpacing: true, mailMarkup: true, imageAlt: options.imageAlt });
  if (!stripped.hadSignature) return text;
  return appendPlainTextSignature(text, identity, { separator: options.separator });
}

const QUOTE_LINE = /^>/;

// Plain text to editor HTML, with runs of "> " lines as a <blockquote> (one
// level per ">"), so a quote stays a quote in the rich editor.
function plainTextWithQuotesToHtml(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (!lines.some((line) => QUOTE_LINE.test(line))) return plainTextToComposerBody(text);
  const parts: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const quoted = QUOTE_LINE.test(lines[i]);
    const run: string[] = [];
    while (i < lines.length && QUOTE_LINE.test(lines[i]) === quoted) run.push(lines[i++]);
    if (quoted) {
      parts.push(`<blockquote>${plainTextWithQuotesToHtml(run.map((line) => line.replace(/^> ?/, '')).join('\n')) || '<p></p>'}</blockquote>`);
    } else {
      parts.push(plainTextToComposerBody(run.join('\n').replace(/^\n+|\n+$/g, '')));
    }
  }
  return parts.join('');
}

/**
 * Convert a plain-text body to editor HTML: paragraphs per blank line, <br>
 * per newline, "> " lines as a quote. A trailing plain-text signature is
 * swapped for the embedded (marker-bracketed) HTML signature so identity
 * switches and the send path keep working as in a body that started out as
 * HTML.
 */
export function plainComposeBodyToHtml(
  text: string,
  identity: SignatureIdentityLike,
  options: { separator: boolean },
): string {
  const hadSignature = plainTextBodyHasSignature(text, identity);
  const userText = hadSignature ? plainTextBodyWithoutSignature(text, identity) : text;
  const html = plainTextWithQuotesToHtml(userText);
  if (!hadSignature) return html;
  const embedded = buildEmbeddedSignatureHtml(identity, { embed: true, separator: options.separator });
  return `${html || '<p></p>'}${embedded}`;
}
