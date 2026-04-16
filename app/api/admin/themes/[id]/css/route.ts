import { NextRequest, NextResponse } from 'next/server';
import { getThemeCSS, getThemeRegistry } from '@/lib/admin/plugin-registry';
import { logger } from '@/lib/logger';

/**
 * GET /api/admin/themes/[id]/css - Serve theme CSS to clients
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Validate ID format
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(id)) {
      return NextResponse.json({ error: 'Invalid theme ID' }, { status: 400 });
    }

    // Verify theme exists and is enabled
    const registry = await getThemeRegistry();
    const theme = registry.themes.find(t => t.id === id);
    if (!theme) {
      return NextResponse.json({ error: 'Theme not found' }, { status: 404 });
    }
    if (!theme.enabled) {
      return NextResponse.json({ error: 'Theme is disabled' }, { status: 403 });
    }

    const css = await getThemeCSS(id);
    if (!css) {
      return NextResponse.json({ error: 'Theme CSS not found' }, { status: 404 });
    }

    return new NextResponse(css, {
      headers: {
        'Content-Type': 'text/css; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    logger.error('Theme CSS serve error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
