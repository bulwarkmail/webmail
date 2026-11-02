import { NextResponse } from 'next/server';
import { getThemeCSS, getThemeRegistry, getThemeSkin } from './plugin-registry';
import { logger } from '@/lib/logger';
import { storeUnavailableResponse } from './store-unavailable-response';

/**
 * Serve an enabled theme's CSS or skin. Clients put the theme's content hash
 * in the URL, so the response may be revalidated freely but never served
 * stale after an update (it used to be cached publicly for an hour).
 */
export async function serveThemeAsset(id: string, kind: 'css' | 'skin'): Promise<NextResponse> {
  try {
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(id)) {
      return NextResponse.json({ error: 'Invalid theme ID' }, { status: 400 });
    }
    const registry = await getThemeRegistry();
    const theme = registry.themes.find(t => t.id === id);
    if (!theme) {
      return NextResponse.json({ error: 'Theme not found' }, { status: 404 });
    }
    if (!theme.enabled) {
      return NextResponse.json({ error: 'Theme is disabled' }, { status: 403 });
    }
    const body = kind === 'css' ? await getThemeCSS(id) : await getThemeSkin(id);
    if (!body) {
      return NextResponse.json({ error: kind === 'css' ? 'Theme CSS not found' : 'Theme has no skin' }, { status: 404 });
    }
    return new NextResponse(body, {
      headers: {
        'Content-Type': 'text/css; charset=utf-8',
        'Cache-Control': 'private, no-cache',
        ...(theme.contentHash ? { ETag: `"${theme.contentHash}"` } : {}),
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    const unavailable = storeUnavailableResponse(error);
    if (unavailable) return unavailable;
    logger.error('Theme asset serve error', { kind, error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
