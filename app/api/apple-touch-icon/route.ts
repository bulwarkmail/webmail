import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { configManager } from '@/lib/admin/config-manager';
import { getConfigDir } from '@/lib/admin/paths';
import {
  matchDomainBranding,
  parseDomainBranding,
  pickRequestHost,
} from '@/lib/admin/domain-branding';

async function fetchIconImage(iconUrl: string): Promise<Buffer> {
  if (iconUrl.startsWith('http://') || iconUrl.startsWith('https://')) {
    const res = await fetch(iconUrl);
    if (!res.ok) throw new Error(`Failed to fetch icon: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  const ADMIN_BRANDING_PREFIX = '/api/admin/branding/';
  if (iconUrl.startsWith(ADMIN_BRANDING_PREFIX)) {
    const filename = path.basename(iconUrl.slice(ADMIN_BRANDING_PREFIX.length));
    return readFile(path.join(getConfigDir(), 'branding', filename));
  }

  const publicPath = path.join(process.cwd(), 'public', iconUrl.replace(/^\//, ''));
  return readFile(publicPath);
}

export async function GET(req: NextRequest) {
  await configManager.ensureLoaded();
  const host = pickRequestHost(req);
  const domainOverrides = matchDomainBranding(
    host,
    parseDomainBranding(configManager.get<unknown>('domainBranding', [])),
  );
  const sources = configManager.getAllWithSources();
  
  const iconUrl =
    domainOverrides.pwaIconUrl ||
    domainOverrides.faviconUrl ||
    (sources.pwaIconUrl?.source !== 'default' ? (sources.pwaIconUrl?.value as string) : '') ||
    (sources.faviconUrl?.source !== 'default' ? (sources.faviconUrl?.value as string) : '') ||
    '/icon-192x192.png';

  try {
    const iconBuffer = await fetchIconImage(iconUrl);
    
    const headers = {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
      Vary: 'Host, X-Forwarded-Host',
    };

    const ab = new ArrayBuffer(iconBuffer.byteLength);
    new Uint8Array(ab).set(iconBuffer);
    const blob = new Blob([ab], { type: 'image/png' });

    return new NextResponse(blob, { headers });
  } catch (err) {
    console.error('Failed to serve apple-touch-icon:', err);
    
    try {
      const fallbackBuffer = await readFile(
        path.join(process.cwd(), 'public', 'icon-192x192.png')
      );
      const ab = new ArrayBuffer(fallbackBuffer.byteLength);
      new Uint8Array(ab).set(fallbackBuffer);
      const blob = new Blob([ab], { type: 'image/png' });
      
      return new NextResponse(blob, {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    } catch {
      return new NextResponse('Icon not found', { status: 404 });
    }
  }
}
