import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import { detectSetupState } from '@/lib/setup/state';
import { wizardSessionRefusal } from '@/lib/setup/session';
import { configWriteErrorResponse } from '@/lib/admin/config-read-only-response';
import { configManager } from '@/lib/admin/config-manager';
import { assertWritable } from '@/lib/admin/paths';
import { brandingDocs } from '@/lib/admin/extension-store';
import { announceChange } from '@/lib/shared-store/changes';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB

const ALLOWED_MIME_TYPES = new Set([
  'image/svg+xml',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

const VALID_SLOTS = new Set([
  'faviconUrl',
  'pwaIconUrl',
  'appLogoLightUrl',
  'appLogoDarkUrl',
  'loginLogoLightUrl',
  'loginLogoDarkUrl',
  'pwaScreenshotMobileUrl',
  'pwaScreenshotDesktopUrl',
]);

const EXT_BY_MIME: Record<string, string> = {
  'image/svg+xml': '.svg',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
};

function sanitizeFilename(name: string): string {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * POST /api/setup/branding - wizard branding upload.
 *
 * Multipart form fields:
 *   file - the image (SVG/PNG/JPEG/WebP/ICO, max 2 MB)
 *   slot - which branding key (faviconUrl, loginLogoLightUrl, etc.)
 *
 * Mirrors /api/admin/branding but authenticates via the wizard cookie
 * instead of admin session - admin auth doesn't exist yet during bootstrap.
 * Files land in the same directory; the public read endpoint at
 * /api/admin/branding/<filename> serves both wizard- and admin-uploaded
 * assets after setup.
 */
export async function POST(request: NextRequest) {
  if (detectSetupState() !== 'bootstrap') {
    return NextResponse.json({ error: 'Setup is not active' }, { status: 404 });
  }
  const wizardRefused = await wizardSessionRefusal();
  if (wizardRefused) return wizardRefused;

  try {
    assertWritable('upload branding asset');

    const formData = await request.formData();
    const file = formData.get('file');
    const slot = formData.get('slot');

    if (!(file instanceof File) || typeof slot !== 'string') {
      return NextResponse.json({ error: 'Missing file or slot' }, { status: 400 });
    }
    if (!VALID_SLOTS.has(slot)) {
      return NextResponse.json({ error: `Invalid slot: ${slot}` }, { status: 400 });
    }
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: 'File too large (max 2 MB)' }, { status: 400 });
    }
    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      return NextResponse.json(
        { error: `Unsupported file type: ${file.type}. Allowed: SVG, PNG, JPEG, WebP, ICO` },
        { status: 400 },
      );
    }

    const ext = EXT_BY_MIME[file.type] ?? '.png';
    const safeName = sanitizeFilename(`${slot}${ext}`);

    // Remove any existing file for this slot with a different extension so
    // the wizard doesn't leave orphan files behind on re-upload.
    const docs = brandingDocs();
    const stored = await docs.list('');
    for (const otherExt of Object.values(EXT_BY_MIME)) {
      if (otherExt === ext) continue;
      if (stored.includes(`${slot}${otherExt}`)) await docs.delete(`${slot}${otherExt}`);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const written = await docs.put(safeName, buffer);

    // Versioned like the admin upload's URL (app/api/admin/branding/route.ts).
    const servedUrl = `/api/admin/branding/${safeName}${written.ok ? `?v=${written.version}` : ''}`;
    await configManager.ensureLoaded();
    await configManager.setAdminConfig({ [slot]: servedUrl });
    await announceChange('branding');

    return NextResponse.json({ url: servedUrl, filename: safeName });
  } catch (error) {
    const refused = configWriteErrorResponse(error);
    if (refused) return refused;
    logger.error('Wizard branding upload failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}

/**
 * DELETE /api/setup/branding - remove an uploaded asset and clear the
 * config override so the slot falls back to the system default.
 *
 * Body: { slot: string }
 */
export async function DELETE(request: NextRequest) {
  if (detectSetupState() !== 'bootstrap') {
    return NextResponse.json({ error: 'Setup is not active' }, { status: 404 });
  }
  const wizardRefused = await wizardSessionRefusal();
  if (wizardRefused) return wizardRefused;

  try {
    assertWritable('remove branding asset');
    const { slot } = (await request.json()) as { slot?: string };
    if (!slot || !VALID_SLOTS.has(slot)) {
      return NextResponse.json({ error: 'Invalid or missing slot' }, { status: 400 });
    }

    const docs = brandingDocs();
    const stored = await docs.list('');
    for (const ext of Object.values(EXT_BY_MIME)) {
      if (stored.includes(`${slot}${ext}`)) await docs.delete(`${slot}${ext}`);
    }

    await configManager.ensureLoaded();
    await configManager.removeAdminOverride(slot);
    await announceChange('branding');

    return NextResponse.json({ ok: true });
  } catch (error) {
    const refused = configWriteErrorResponse(error);
    if (refused) return refused;
    logger.error('Wizard branding delete failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return NextResponse.json({ error: 'Delete failed' }, { status: 500 });
  }
}
