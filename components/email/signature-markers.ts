// Marker attribute that identifies the signature wrapper in serialized HTML,
// so parseHTML can recognise it on the way back in (initial content, drafts).
export const SIGNATURE_BLOCK_MARKER = "data-signature-block-node";

// Marker attribute on the paragraphs that bracket an embedded signature
// (`data-signature-block="separator" | "start" | "end"`). The composer keys the
// identity-swap splice on it, and it is what tells a re-opened draft that its
// body already carries the signature.
export const SIGNATURE_RANGE_MARKER = "data-signature-block";

/**
 * Build the editor-content wrapper that embeds the signature as a single
 * SignatureBlock node. The inner HTML must be pre-sanitized
 * (sanitizeSignatureHtml). The `data-signature-block-node` marker is what
 * parseHTML keys on, so this exact form must be what serializeEditorContent
 * emits too (round-trip consistency).
 */
export function buildSignatureBlock(sanitizedInnerHtml: string): string {
  return `<div ${SIGNATURE_BLOCK_MARKER}>${sanitizedInnerHtml}</div>`;
}

/**
 * Whether an HTML body already carries an embedded signature. Both markers are
 * checked via the shared prefix: `SIGNATURE_BLOCK_MARKER` starts with
 * `SIGNATURE_RANGE_MARKER`, so a bracketed signature and a bare signature atom
 * (e.g. a body whose marker paragraphs were dropped) both match.
 *
 * A re-opened draft always comes back in `compose` mode, so the markers are the
 * only evidence the send path has that the signature is already in the body and
 * must not be appended a second time (#823).
 */
export function containsEmbeddedSignature(html: string): boolean {
  return html.includes(SIGNATURE_RANGE_MARKER);
}
