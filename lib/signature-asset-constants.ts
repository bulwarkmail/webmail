/** Maximum size of a single signature image asset (1 MiB). */
export const SIGNATURE_ASSET_MAX_BYTES = 1024 * 1024;

/** Soft limit on images referenced by one signature. */
export const SIGNATURE_ASSETS_PER_IDENTITY_MAX = 5;

export const SIGNATURE_ASSET_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const;

export type SignatureAssetMimeType = (typeof SIGNATURE_ASSET_MIME_TYPES)[number];

/** Client-safe asset metadata shape (no Node dependencies). */
export interface SignatureAssetMeta {
  id: string;
  identityId: string;
  filename: string;
  mimeType: SignatureAssetMimeType | string;
  size: number;
  width?: number;
  height?: number;
  createdAt?: string;
}
