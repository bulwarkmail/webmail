/**
 * Whether an outgoing body already carries the organisation signature or
 * the disclaimer, part by part. Matching is by whole lines, so a user who
 * typed the word "ACME" doesn't count as carrying the signature "ACME", and
 * the HTML part is matched against the HTML template while the text part
 * is matched against the text template (and the text made from the HTML,
 * which is what the text part of an HTML message holds).
 */

import { extractUserAuthoredText } from '@/lib/email-composer-utils';
import { sanitizeSignatureHtml } from '@/lib/email-sanitization';
import { htmlToPlainText } from '@/lib/html-to-text';
import { getPlainTextSignature } from '@/lib/signature-utils';
import { SIGNATURE_BLOCK_MARKER } from '@/components/email/signature-markers';
import type { FilledSignature } from '@/lib/org-signature';

/** The disclaimer's wrapper in the HTML part (lib/org/outgoing.ts). */
export const DISCLAIMER_MARKER = 'data-org-disclaimer';

const QUOTES = '[data-quoted-html], blockquote';

/** Non-empty lines with their whitespace collapsed. */
export function textLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function indexOfLines(haystack: string[], needle: string[]): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((line, j) => haystack[i + j] === line)) return i;
  }
  return -1;
}

const containsLines = (haystack: string[], needle: string[]) => indexOfLines(haystack, needle) >= 0;

function endsWithLines(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  const start = haystack.length - needle.length;
  return needle.every((line, j) => haystack[start + j] === line);
}

/** The lines a filled template shows in an HTML body. */
export function htmlLinesOf(filled: FilledSignature): string[] {
  return filled.html.trim()
    ? textLines(htmlToPlainText(sanitizeSignatureHtml(filled.html)))
    : textLines(filled.text);
}

/** The lines a filled template shows in a text body. */
export function textLinesOf(filled: FilledSignature): string[] {
  return textLines(getPlainTextSignature({ textSignature: filled.text, htmlSignature: filled.html }));
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html');
}

/**
 * Whether an HTML body carries the signature: the composer's signature
 * block holding it, its lines in the user's part (no quote, nothing from
 * the "Forwarded message" line on), or its lines at the very end, where the
 * composer appends it below a quoted or forwarded message.
 */
export function htmlCarriesSignature(html: string, signature: FilledSignature, forwardedSeparator?: string): boolean {
  const lines = htmlLinesOf(signature);
  if (lines.length === 0) return true;
  const doc = parse(html);
  doc.querySelectorAll(QUOTES).forEach((el) => el.remove());
  for (const block of Array.from(doc.querySelectorAll(`[${SIGNATURE_BLOCK_MARKER}]`))) {
    if (containsLines(textLines(htmlToPlainText(block.innerHTML)), lines)) return true;
  }
  const own = extractUserAuthoredText(html, { plainTextMode: false, forwardedSeparator });
  return containsLines(textLines(own), lines) || endsWithLines(textLines(htmlToPlainText(doc.body.innerHTML)), lines);
}

/**
 * Whether a text body carries the signature, as the text template or as the
 * text made from the HTML one: in the user's part, or at the very end.
 */
export function textCarriesSignature(text: string, signature: FilledSignature, forwardedSeparator?: string): boolean {
  const variants = [textLinesOf(signature), htmlLinesOf(signature)].filter((lines) => lines.length > 0);
  if (variants.length === 0) return true;
  const own = textLines(extractUserAuthoredText(text, { plainTextMode: true, forwardedSeparator }));
  const unquoted = textLines(text.split(/\r?\n/).filter((line) => !/^\s*>/.test(line)).join('\n'));
  return variants.some((lines) => containsLines(own, lines) || endsWithLines(unquoted, lines));
}

/**
 * Whether an HTML body already ends with the disclaimer (a message sent
 * again after Undo): its wrapper outside the quote, or its lines at the end
 * once the quote is left out.
 */
export function htmlCarriesDisclaimer(html: string, disclaimer: FilledSignature): boolean {
  const doc = parse(html);
  doc.querySelectorAll(QUOTES).forEach((el) => el.remove());
  if (doc.querySelector(`[${DISCLAIMER_MARKER}]`)) return true;
  return endsWithLines(textLines(htmlToPlainText(doc.body.innerHTML)), htmlLinesOf(disclaimer));
}

/** Whether a text body ends with the disclaimer, as the text template or as the text made from the HTML one. */
export function textCarriesDisclaimer(text: string, disclaimer: FilledSignature): boolean {
  const own = textLines(text.split(/\r?\n/).filter((line) => !/^\s*>/.test(line)).join('\n'));
  return endsWithLines(own, textLinesOf(disclaimer)) || endsWithLines(own, htmlLinesOf(disclaimer));
}
