/**
 * Shared inline-image types and send-time rewrite used by the composer for
 * both manually inserted images and persistent signature assets.
 */

export interface InlineImage {
  cid: string;
  blobId: string;
  type: string;
  name: string;
  size: number;
  dataUrl: string;
  /** When set, this inline image came from a Bulwark signature asset. */
  signatureAssetId?: string;
}

export interface InlineImageAttachment {
  blobId: string;
  name: string;
  type: string;
  size: number;
  disposition: 'inline';
  cid: string;
}

/**
 * Rewrite editor HTML that uses data URLs + data-cid into cid: references and
 * collect the matching inline attachments for the JMAP send payload.
 */
export function rewriteInlineImagesHtml(
  html: string,
  known: InlineImage[],
): { html: string; attachments: InlineImageAttachment[] } {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const used = new Map<string, InlineImage>();

  if (known.length > 0) {
    doc.querySelectorAll('img[data-cid]').forEach((img) => {
      const cid = img.getAttribute('data-cid');
      if (!cid) return;
      const entry = known.find((e) => e.cid === cid);
      if (!entry) return;
      img.setAttribute('src', `cid:${cid}`);
      img.removeAttribute('data-cid');
      // data-signature-asset is editor-only; strip before send.
      img.removeAttribute('data-signature-asset');
      used.set(cid, entry);
    });
  }

  // Recipient mail clients apply default <p> margins inside table cells,
  // inflating row height. Tiptap wraps cell text in <p>, so force margin:0
  // to match the composer's tight rows.
  doc.querySelectorAll('td > p, th > p').forEach((p) => {
    const existing = p.getAttribute('style') || '';
    p.setAttribute('style', `margin:0;${existing}`);
  });

  return {
    html: doc.body.innerHTML,
    attachments: Array.from(used.values()).map((e) => ({
      blobId: e.blobId,
      name: e.name,
      type: e.type,
      size: e.size,
      disposition: 'inline' as const,
      cid: e.cid,
    })),
  };
}

/** Drop inline-image registrations that belong to a previous signature. */
export function removeSignatureInlineImages(
  images: InlineImage[],
  signatureAssetIds?: Set<string>,
): InlineImage[] {
  if (!signatureAssetIds || signatureAssetIds.size === 0) {
    return images.filter((img) => !img.signatureAssetId);
  }
  return images.filter(
    (img) => !img.signatureAssetId || !signatureAssetIds.has(img.signatureAssetId),
  );
}
