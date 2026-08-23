import { createHash, createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, unlink, mkdir, rename, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { logger } from '@/lib/logger';
import { getSessionSecret } from '@/lib/auth/session-secret';
import { sniffImageMime } from '@/lib/image-mime';
import {
  SIGNATURE_ASSET_MAX_BYTES,
  SIGNATURE_ASSETS_PER_IDENTITY_MAX,
  SIGNATURE_ASSET_MIME_TYPES,
  type SignatureAssetMimeType,
} from '@/lib/signature-asset-constants';

export {
  SIGNATURE_ASSET_MAX_BYTES,
  SIGNATURE_ASSETS_PER_IDENTITY_MAX,
  SIGNATURE_ASSET_MIME_TYPES,
  type SignatureAssetMimeType,
};

export interface SignatureAsset {
  id: string;
  identityId: string;
  filename: string;
  mimeType: SignatureAssetMimeType;
  size: number;
  width?: number;
  height?: number;
  createdAt: string;
}

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export class SignatureAssetError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'not_configured'
      | 'invalid_identity'
      | 'invalid_asset_id'
      | 'invalid_mime'
      | 'too_large'
      | 'too_many'
      | 'not_found'
      | 'forbidden'
      | 'path',
  ) {
    super(message);
    this.name = 'SignatureAssetError';
  }
}

const ASSET_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTITY_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function getKey(): Buffer {
  const secret = getSessionSecret();
  if (!secret) throw new SignatureAssetError('SESSION_SECRET not configured', 'not_configured');
  return createHash('sha256').update(secret).digest();
}

export function getSignaturesDir(): string {
  return process.env.SIGNATURE_DATA_DIR || path.join(process.cwd(), 'data', 'signatures');
}

export function accountStorageKey(username: string, serverUrl: string): string {
  return createHash('sha256').update(`${username}:${serverUrl}`).digest('hex');
}

function identityDirName(identityId: string): string {
  return createHash('sha256').update(identityId).digest('hex').slice(0, 32);
}

function assertSafePath(filePath: string, rootDir: string): string {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedPath = path.resolve(filePath);
  if (!resolvedPath.startsWith(resolvedRoot + path.sep) && resolvedPath !== resolvedRoot) {
    throw new SignatureAssetError('Invalid signature asset path', 'path');
  }
  return resolvedPath;
}

function getAccountDir(username: string, serverUrl: string): string {
  return assertSafePath(
    path.join(getSignaturesDir(), accountStorageKey(username, serverUrl)),
    getSignaturesDir(),
  );
}

function getIdentityDir(username: string, serverUrl: string, identityId: string): string {
  assertIdentityId(identityId);
  return assertSafePath(
    path.join(getAccountDir(username, serverUrl), identityDirName(identityId)),
    getSignaturesDir(),
  );
}

export function assertIdentityId(identityId: string): void {
  if (!IDENTITY_ID_RE.test(identityId)) {
    throw new SignatureAssetError('Invalid identity id', 'invalid_identity');
  }
}

export function assertAssetId(assetId: string): void {
  if (!ASSET_ID_RE.test(assetId)) {
    throw new SignatureAssetError('Invalid asset id', 'invalid_asset_id');
  }
}

function encryptBytes(plain: Buffer): Buffer {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]);
}

function decryptBytes(data: Buffer): Buffer {
  if (data.length < IV_LENGTH + TAG_LENGTH) {
    throw new SignatureAssetError('Corrupt signature asset', 'not_found');
  }
  const key = getKey();
  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

async function ensureDir(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
}

function metadataPath(identityDir: string): string {
  return assertSafePath(path.join(identityDir, 'metadata.enc'), getSignaturesDir());
}

function assetPath(identityDir: string, assetId: string): string {
  assertAssetId(assetId);
  return assertSafePath(path.join(identityDir, `${assetId}.enc`), getSignaturesDir());
}

async function readMetadata(identityDir: string): Promise<SignatureAsset[]> {
  const filePath = metadataPath(identityDir);
  try {
    const data = await readFile(filePath);
    const json = decryptBytes(data).toString('utf8');
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSignatureAsset);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    if (error instanceof SignatureAssetError) throw error;
    logger.warn('Failed to load signature asset metadata', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return [];
  }
}

function isSignatureAsset(value: unknown): value is SignatureAsset {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.identityId === 'string' &&
    typeof v.filename === 'string' &&
    typeof v.mimeType === 'string' &&
    typeof v.size === 'number' &&
    typeof v.createdAt === 'string'
  );
}

async function writeMetadata(identityDir: string, assets: SignatureAsset[]): Promise<void> {
  await ensureDir(identityDir);
  const payload = encryptBytes(Buffer.from(JSON.stringify(assets), 'utf8'));
  const target = metadataPath(identityDir);
  const tmp = target + '.tmp';
  await writeFile(tmp, payload, { mode: 0o600 });
  await rename(tmp, target);
}

function sanitizeFilename(name: string): string {
  const base = path.basename(name || 'signature-image').replace(/[^\w.\-()+ ]+/g, '_');
  return base.slice(0, 180) || 'signature-image';
}

function normalizeMime(declared: string | undefined, bytes: Uint8Array): SignatureAssetMimeType {
  const sniffed = sniffImageMime(bytes);
  const candidate = (sniffed || declared || '').toLowerCase();
  const normalized = candidate === 'image/jpg' ? 'image/jpeg' : candidate;
  if (!(SIGNATURE_ASSET_MIME_TYPES as readonly string[]).includes(normalized)) {
    throw new SignatureAssetError(
      'Unsupported image type. Use JPEG, PNG, GIF, or WebP.',
      'invalid_mime',
    );
  }
  // Prefer sniffed type when available so a spoofed Content-Type cannot slip through.
  return (sniffed || normalized) as SignatureAssetMimeType;
}

export async function listSignatureAssets(
  username: string,
  serverUrl: string,
  identityId: string,
): Promise<SignatureAsset[]> {
  const dir = getIdentityDir(username, serverUrl, identityId);
  const assets = await readMetadata(dir);
  return assets.filter((a) => a.identityId === identityId);
}

export async function saveSignatureAsset(
  username: string,
  serverUrl: string,
  identityId: string,
  file: { buffer: Buffer; filename: string; mimeType?: string },
): Promise<SignatureAsset> {
  assertIdentityId(identityId);
  if (file.buffer.length === 0) {
    throw new SignatureAssetError('Empty image file', 'invalid_mime');
  }
  if (file.buffer.length > SIGNATURE_ASSET_MAX_BYTES) {
    throw new SignatureAssetError(
      `Image exceeds the ${SIGNATURE_ASSET_MAX_BYTES} byte limit`,
      'too_large',
    );
  }

  const mimeType = normalizeMime(file.mimeType, file.buffer);
  const dir = getIdentityDir(username, serverUrl, identityId);
  const existing = await readMetadata(dir);
  if (existing.length >= SIGNATURE_ASSETS_PER_IDENTITY_MAX) {
    throw new SignatureAssetError(
      `A signature may include at most ${SIGNATURE_ASSETS_PER_IDENTITY_MAX} images`,
      'too_many',
    );
  }

  const asset: SignatureAsset = {
    id: randomUUID(),
    identityId,
    filename: sanitizeFilename(file.filename),
    mimeType,
    size: file.buffer.length,
    createdAt: new Date().toISOString(),
  };

  await ensureDir(dir);
  const binPath = assetPath(dir, asset.id);
  const tmp = binPath + '.tmp';
  await writeFile(tmp, encryptBytes(file.buffer), { mode: 0o600 });
  await rename(tmp, binPath);
  await writeMetadata(dir, [...existing, asset]);
  return asset;
}

export async function loadSignatureAsset(
  username: string,
  serverUrl: string,
  assetId: string,
): Promise<{ asset: SignatureAsset; bytes: Buffer }> {
  assertAssetId(assetId);
  const accountDir = getAccountDir(username, serverUrl);
  if (!existsSync(accountDir)) {
    throw new SignatureAssetError('Signature asset not found', 'not_found');
  }

  // Scan identity subdirs under this account only — never cross accounts.
  let entries: string[] = [];
  try {
    entries = await readdir(accountDir);
  } catch {
    throw new SignatureAssetError('Signature asset not found', 'not_found');
  }

  for (const entry of entries) {
    if (!/^[0-9a-f]{32}$/.test(entry)) continue;
    const identityDir = assertSafePath(path.join(accountDir, entry), getSignaturesDir());
    const assets = await readMetadata(identityDir);
    const asset = assets.find((a) => a.id === assetId);
    if (!asset) continue;
    try {
      const bytes = decryptBytes(await readFile(assetPath(identityDir, assetId)));
      return { asset, bytes };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new SignatureAssetError('Signature asset not found', 'not_found');
      }
      throw error;
    }
  }

  throw new SignatureAssetError('Signature asset not found', 'not_found');
}

export async function deleteSignatureAsset(
  username: string,
  serverUrl: string,
  assetId: string,
): Promise<void> {
  assertAssetId(assetId);
  const accountDir = getAccountDir(username, serverUrl);
  if (!existsSync(accountDir)) {
    throw new SignatureAssetError('Signature asset not found', 'not_found');
  }

  let entries: string[] = [];
  try {
    entries = await readdir(accountDir);
  } catch {
    throw new SignatureAssetError('Signature asset not found', 'not_found');
  }

  for (const entry of entries) {
    if (!/^[0-9a-f]{32}$/.test(entry)) continue;
    const identityDir = assertSafePath(path.join(accountDir, entry), getSignaturesDir());
    const assets = await readMetadata(identityDir);
    const index = assets.findIndex((a) => a.id === assetId);
    if (index === -1) continue;

    const next = assets.slice(0, index).concat(assets.slice(index + 1));
    await writeMetadata(identityDir, next);
    try {
      await unlink(assetPath(identityDir, assetId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('Failed to delete signature asset binary', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
    return;
  }

  throw new SignatureAssetError('Signature asset not found', 'not_found');
}

/** Test helper: wipe an account's signature directory. */
export async function deleteAllSignatureAssetsForAccount(
  username: string,
  serverUrl: string,
): Promise<void> {
  const accountDir = getAccountDir(username, serverUrl);
  if (!existsSync(accountDir)) return;
  const { rm } = await import('node:fs/promises');
  await rm(accountDir, { recursive: true, force: true });
}
