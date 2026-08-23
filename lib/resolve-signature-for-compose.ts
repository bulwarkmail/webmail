import { generateUUID } from '@/lib/utils';
import {
  SIGNATURE_ASSET_ATTR,
  applyResolvedSignatureAssets,
  collectSignatureAssetIds,
  getExtendedSignature,
  type ExtendedSignaturesMap,
} from '@/lib/extended-signatures';
import {
  fetchSignatureAssetBlob,
  blobToDataUrl,
} from '@/lib/signature-assets-client';
import type { InlineImage } from '@/lib/inline-images';
import { sanitizeSignatureHtml } from '@/lib/email-sanitization';

type UploadBlobFn = (
  file: File,
) => Promise<{ blobId: string; type?: string; size?: number }>;

export type SignatureSource = {
  id?: string;
  htmlSignature?: string;
  textSignature?: string;
} | null | undefined;

/** Prefer Bulwark extended signature HTML when present for this identity. */
export function getEffectiveHtmlSignature(
  identity: SignatureSource,
  accountId: string | null | undefined,
  extendedSignatures: ExtendedSignaturesMap | undefined,
): string {
  if (!identity?.id || !accountId) {
    return identity?.htmlSignature || '';
  }
  const extended = getExtendedSignature(extendedSignatures, accountId, identity.id);
  if (extended?.html?.trim()) return extended.html;
  return identity.htmlSignature || '';
}

/**
 * Load signature assets, upload them as JMAP blobs, and return editor HTML
 * plus InlineImage entries for the existing send pipeline.
 */
export async function resolveSignatureAssetsForCompose(options: {
  html: string;
  username: string;
  serverUrl: string;
  uploadBlob: UploadBlobFn;
}): Promise<{
  html: string;
  images: InlineImage[];
  failedAssetIds: string[];
}> {
  const sanitized = sanitizeSignatureHtml(options.html);
  const assetIds = collectSignatureAssetIds(sanitized);
  if (assetIds.length === 0) {
    return { html: sanitized, images: [], failedAssetIds: [] };
  }

  const resolved = new Map<string, { dataUrl: string; cid: string }>();
  const images: InlineImage[] = [];
  const failedAssetIds: string[] = [];

  for (const assetId of assetIds) {
    try {
      const blob = await fetchSignatureAssetBlob(
        options.username,
        options.serverUrl,
        assetId,
      );
      const file = new File(
        [blob],
        `signature-${assetId.slice(0, 8)}.${extensionForMime(blob.type)}`,
        { type: blob.type || 'application/octet-stream' },
      );
      const [{ blobId }, dataUrl] = await Promise.all([
        options.uploadBlob(file),
        blobToDataUrl(blob),
      ]);
      const cid = `${generateUUID()}@webmail`;
      resolved.set(assetId, { dataUrl, cid });
      images.push({
        cid,
        blobId,
        type: file.type || blob.type || 'application/octet-stream',
        name: file.name,
        size: file.size,
        dataUrl,
        signatureAssetId: assetId,
      });
    } catch {
      failedAssetIds.push(assetId);
    }
  }

  const html = applyResolvedSignatureAssets(
    sanitized,
    resolved,
    new Set(failedAssetIds),
  );

  return { html, images, failedAssetIds };
}

function extensionForMime(mime: string): string {
  switch (mime) {
    case 'image/png':
      return 'png';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'image/jpeg':
    default:
      return 'jpg';
  }
}

/** True when the HTML references at least one Bulwark signature asset. */
export function htmlHasSignatureAssets(html: string | undefined | null): boolean {
  return !!html && html.includes(SIGNATURE_ASSET_ATTR);
}
