import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

const VALID_SIZES = new Set([192, 512]);

// Cache resized images in memory to avoid reprocessing on every request
const cache = new Map<number, Blob>();

async function fetchSourceImage(iconUrl: string): Promise<Buffer> {
  // Absolute URL (http/https)
  if (iconUrl.startsWith('http://') || iconUrl.startsWith('https://')) {
    const res = await fetch(iconUrl);
    if (!res.ok) throw new Error(`Failed to fetch PWA icon: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  // Path relative to public/ directory
  const publicPath = path.join(process.cwd(), 'public', iconUrl.replace(/^\//, ''));
  return readFile(publicPath);
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ size: string }> }
) {
  const { size: sizeParam } = await params;
  const size = parseInt(sizeParam, 10);

  if (!VALID_SIZES.has(size)) {
    return new NextResponse('Invalid size. Allowed: 192, 512', { status: 400 });
  }

  const iconUrl = process.env.PWA_ICON_URL || process.env.FAVICON_URL;
  if (!iconUrl) {
    return new NextResponse('No PWA icon configured', { status: 404 });
  }

  const pngHeaders = {
    'Content-Type': 'image/png',
    'Cache-Control': 'public, max-age=86400',
  };

  try {
    if (cache.has(size)) {
      return new NextResponse(cache.get(size)!, { headers: pngHeaders });
    }

    const sourceBuffer = await fetchSourceImage(iconUrl);
    const resized = await sharp(sourceBuffer)
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    const ab = new ArrayBuffer(resized.byteLength);
    new Uint8Array(ab).set(resized);
    const blob = new Blob([ab], { type: 'image/png' });
    cache.set(size, blob);

    return new NextResponse(blob, { headers: pngHeaders });
  } catch (err) {
    console.error('Failed to generate PWA icon:', err);
    return new NextResponse('Failed to generate icon', { status: 500 });
  }
}
