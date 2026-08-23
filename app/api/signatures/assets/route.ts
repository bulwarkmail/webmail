import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { hasSessionSecret } from '@/lib/auth/session-secret';
import { verifyAccountIdentity } from '@/lib/auth/verify-account-identity';
import {
  SignatureAssetError,
  listSignatureAssets,
  saveSignatureAsset,
  SIGNATURE_ASSET_MAX_BYTES,
} from '@/lib/signature-assets';

function classifyAssetError(error: unknown): { message: string; status: number } {
  if (error instanceof SignatureAssetError) {
    switch (error.code) {
      case 'not_configured':
        return { message: error.message, status: 503 };
      case 'invalid_identity':
      case 'invalid_asset_id':
      case 'invalid_mime':
      case 'too_large':
      case 'too_many':
        return { message: error.message, status: 400 };
      case 'not_found':
        return { message: error.message, status: 404 };
      case 'forbidden':
        return { message: error.message, status: 403 };
      case 'path':
        return { message: 'Invalid request', status: 400 };
    }
  }
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM') {
    return {
      message: 'Write permission denied on signature data directory.',
      status: 500,
    };
  }
  if (code === 'ENOSPC') {
    return { message: 'No disk space available to save signature image.', status: 507 };
  }
  const msg = error instanceof Error ? error.message : 'Unknown error';
  return { message: `Internal server error: ${msg}`, status: 500 };
}

function requireConfigured(): NextResponse | null {
  if (!hasSessionSecret()) {
    return NextResponse.json(
      { error: 'Signature image storage requires SESSION_SECRET' },
      { status: 503 },
    );
  }
  return null;
}

/**
 * GET /api/signatures/assets?identityId=...
 * Headers: x-settings-username, x-settings-server (same as settings sync)
 */
export async function GET(request: NextRequest) {
  const blocked = requireConfigured();
  if (blocked) return blocked;

  const username = request.headers.get('x-settings-username');
  const serverUrl = request.headers.get('x-settings-server');
  const identityId = request.nextUrl.searchParams.get('identityId');
  if (!username || !serverUrl || !identityId) {
    return NextResponse.json({ error: 'Missing identity headers or identityId' }, { status: 400 });
  }

  if (!(await verifyAccountIdentity(username, serverUrl))) {
    return NextResponse.json({ error: 'Identity mismatch' }, { status: 403 });
  }

  try {
    const assets = await listSignatureAssets(username, serverUrl, identityId);
    return NextResponse.json({ assets });
  } catch (error) {
    const classified = classifyAssetError(error);
    if (classified.status >= 500) {
      logger.error('Signature asset list error', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
    return NextResponse.json({ error: classified.message }, { status: classified.status });
  }
}

/**
 * POST /api/signatures/assets
 * multipart/form-data: identityId, file
 * Headers: x-settings-username, x-settings-server
 */
export async function POST(request: NextRequest) {
  const blocked = requireConfigured();
  if (blocked) return blocked;

  const username = request.headers.get('x-settings-username');
  const serverUrl = request.headers.get('x-settings-server');
  if (!username || !serverUrl) {
    return NextResponse.json({ error: 'Missing identity headers' }, { status: 400 });
  }

  if (!(await verifyAccountIdentity(username, serverUrl))) {
    return NextResponse.json({ error: 'Identity mismatch' }, { status: 403 });
  }

  try {
    const form = await request.formData();
    const identityId = String(form.get('identityId') || '');
    const file = form.get('file');
    if (!identityId || !(file instanceof File)) {
      return NextResponse.json({ error: 'identityId and file are required' }, { status: 400 });
    }
    if (file.size > SIGNATURE_ASSET_MAX_BYTES) {
      return NextResponse.json(
        { error: `Image exceeds the ${SIGNATURE_ASSET_MAX_BYTES} byte limit` },
        { status: 400 },
      );
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const asset = await saveSignatureAsset(username, serverUrl, identityId, {
      buffer,
      filename: file.name || 'signature-image',
      mimeType: file.type,
    });
    return NextResponse.json({ asset });
  } catch (error) {
    const classified = classifyAssetError(error);
    if (classified.status >= 500) {
      logger.error('Signature asset upload error', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
    return NextResponse.json({ error: classified.message }, { status: classified.status });
  }
}
