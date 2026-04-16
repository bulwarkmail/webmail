import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth, getClientIP } from '@/lib/admin/session';
import { auditLog } from '@/lib/admin/audit';
import { configManager } from '@/lib/admin/config-manager';
import { logger } from '@/lib/logger';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const BRANDING_DIR = path.join(process.cwd(), 'data', 'admin', 'branding');
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB
const ALLOWED_MIME_TYPES = new Set([
  'image/svg+xml',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

/** Slots that correspond to branding config keys */
const VALID_SLOTS = new Set([
  'faviconUrl',
  'appLogoLightUrl',
  'appLogoDarkUrl',
  'loginLogoLightUrl',
  'loginLogoDarkUrl',
]);

function sanitizeFilename(name: string): string {
  // Strip directory traversal, keep only safe chars
  return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * POST /api/admin/branding - Upload a branding image file
 *
 * Expects multipart/form-data with:
 *   - file: the image file
 *   - slot: which branding field this is for (e.g. "faviconUrl")
 */
export async function POST(request: NextRequest) {
  try {
    const result = await requireAdminAuth();
    if ('error' in result) return result.error;

    const ip = getClientIP(request);
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const slot = formData.get('slot') as string | null;

    if (!file || !slot) {
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

    // Determine extension from mime type
    const extMap: Record<string, string> = {
      'image/svg+xml': '.svg',
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/webp': '.webp',
      'image/x-icon': '.ico',
      'image/vnd.microsoft.icon': '.ico',
    };
    const ext = extMap[file.type] || '.png';
    const safeName = sanitizeFilename(`${slot}${ext}`);
    const filePath = path.join(BRANDING_DIR, safeName);

    // Ensure branding directory exists
    if (!existsSync(BRANDING_DIR)) {
      await mkdir(BRANDING_DIR, { recursive: true });
    }

    // Write file to disk
    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(filePath, buffer);

    // Update config to point to the served URL
    const servedUrl = `/api/admin/branding/${safeName}`;
    await configManager.ensureLoaded();
    await configManager.setAdminConfig({ [slot]: servedUrl });

    await auditLog('branding_upload', { slot, filename: safeName, size: file.size, mimeType: file.type }, ip);

    return NextResponse.json({ url: servedUrl, filename: safeName });
  } catch (error) {
    logger.error('Branding upload error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/branding - Remove an uploaded branding file
 *
 * Expects JSON body: { slot: string }
 */
export async function DELETE(request: NextRequest) {
  try {
    const result = await requireAdminAuth();
    if ('error' in result) return result.error;

    const ip = getClientIP(request);
    const { slot } = await request.json();

    if (!slot || !VALID_SLOTS.has(slot)) {
      return NextResponse.json({ error: 'Invalid or missing slot' }, { status: 400 });
    }

    // Find and remove matching files for this slot
    const possibleExts = ['.svg', '.png', '.jpg', '.webp', '.ico'];
    let removed = false;
    for (const ext of possibleExts) {
      const filePath = path.join(BRANDING_DIR, `${slot}${ext}`);
      if (existsSync(filePath)) {
        await unlink(filePath);
        removed = true;
      }
    }

    // Clear the config override so it falls back to default/env
    await configManager.ensureLoaded();
    await configManager.removeAdminOverride(slot);

    await auditLog('branding_delete', { slot, fileRemoved: removed }, ip);

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Branding delete error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
