import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Minimal PNG (1x1)
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('signature-assets storage', () => {
  let dataDir: string;
  let prevSecret: string | undefined;
  let prevDir: string | undefined;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'bulwark-sig-'));
    prevSecret = process.env.SESSION_SECRET;
    prevDir = process.env.SIGNATURE_DATA_DIR;
    process.env.SESSION_SECRET = 'test-session-secret-for-signature-assets';
    process.env.SIGNATURE_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (prevSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = prevSecret;
    if (prevDir === undefined) delete process.env.SIGNATURE_DATA_DIR;
    else process.env.SIGNATURE_DATA_DIR = prevDir;
    await rm(dataDir, { recursive: true, force: true });
  });

  it('saves, lists, loads, and deletes an asset for the owning account', async () => {
    const {
      saveSignatureAsset,
      listSignatureAssets,
      loadSignatureAsset,
      deleteSignatureAsset,
    } = await import('../signature-assets');

    const asset = await saveSignatureAsset('user@example.com', 'https://mail.example.com', 'h', {
      buffer: PNG_BYTES,
      filename: 'logo.png',
      mimeType: 'image/png',
    });

    expect(asset.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(asset.mimeType).toBe('image/png');
    expect(asset.size).toBe(PNG_BYTES.length);

    const listed = await listSignatureAssets('user@example.com', 'https://mail.example.com', 'h');
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(asset.id);

    const loaded = await loadSignatureAsset('user@example.com', 'https://mail.example.com', asset.id);
    expect(Buffer.compare(loaded.bytes, PNG_BYTES)).toBe(0);
    expect(loaded.asset.identityId).toBe('h');

    await deleteSignatureAsset('user@example.com', 'https://mail.example.com', asset.id);
    const after = await listSignatureAssets('user@example.com', 'https://mail.example.com', 'h');
    expect(after).toHaveLength(0);
  });

  it('isolates assets by account', async () => {
    const { saveSignatureAsset, loadSignatureAsset, SignatureAssetError } = await import(
      '../signature-assets'
    );

    const asset = await saveSignatureAsset('alice@example.com', 'https://mail.example.com', 'a', {
      buffer: PNG_BYTES,
      filename: 'a.png',
      mimeType: 'image/png',
    });

    await expect(
      loadSignatureAsset('bob@example.com', 'https://mail.example.com', asset.id),
    ).rejects.toMatchObject({ code: 'not_found' } satisfies Partial<InstanceType<typeof SignatureAssetError>>);
  });

  it('rejects invalid MIME and oversized files', async () => {
    const { saveSignatureAsset, SIGNATURE_ASSET_MAX_BYTES, SignatureAssetError } = await import(
      '../signature-assets'
    );

    await expect(
      saveSignatureAsset('user@example.com', 'https://mail.example.com', 'h', {
        buffer: Buffer.from('%PDF-1.4'),
        filename: 'x.pdf',
        mimeType: 'application/pdf',
      }),
    ).rejects.toMatchObject({ code: 'invalid_mime' } satisfies Partial<InstanceType<typeof SignatureAssetError>>);

    await expect(
      saveSignatureAsset('user@example.com', 'https://mail.example.com', 'h', {
        buffer: Buffer.alloc(SIGNATURE_ASSET_MAX_BYTES + 1, 0xff),
        filename: 'big.jpg',
        mimeType: 'image/jpeg',
      }),
    ).rejects.toMatchObject({ code: 'too_large' } satisfies Partial<InstanceType<typeof SignatureAssetError>>);
  });

  it('rejects path-unsafe identity ids', async () => {
    const { listSignatureAssets, SignatureAssetError } = await import('../signature-assets');
    await expect(
      listSignatureAssets('user@example.com', 'https://mail.example.com', '../etc'),
    ).rejects.toMatchObject({ code: 'invalid_identity' } satisfies Partial<InstanceType<typeof SignatureAssetError>>);
  });
});
