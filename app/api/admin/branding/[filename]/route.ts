import { NextRequest, NextResponse } from 'next/server';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const BRANDING_DIR = path.join(process.cwd(), 'data', 'admin', 'branding');

const MIME_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

/**
 * GET /api/admin/branding/[filename] - Serve uploaded branding images
 *
 * This endpoint is public (no admin auth) so browsers can load images.
 * Only files in the branding directory are served; directory traversal is prevented.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ filename: string }> },
) {
  try {
    const { filename } = await params;

    // Sanitize: only allow basename, no path separators
    const safe = path.basename(filename);
    if (safe !== filename || filename.includes('..')) {
      return NextResponse.json({ error: 'Invalid filename' }, { status: 400 });
    }

    const ext = path.extname(safe).toLowerCase();
    const contentType = MIME_TYPES[ext];
    if (!contentType) {
      return NextResponse.json({ error: 'Unsupported file type' }, { status: 400 });
    }

    const filePath = path.join(BRANDING_DIR, safe);

    // Ensure resolved path is still within BRANDING_DIR
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(BRANDING_DIR))) {
      return NextResponse.json({ error: 'Invalid filename' }, { status: 400 });
    }

    const fileStat = await stat(resolved).catch(() => null);
    if (!fileStat || !fileStat.isFile()) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const buffer = await readFile(resolved);

    return new NextResponse(buffer, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600, must-revalidate',
        'Content-Length': String(buffer.length),
      },
    });
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
}
