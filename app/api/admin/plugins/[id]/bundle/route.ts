import { NextRequest, NextResponse } from 'next/server';
import { getPluginBundle, getPlugin } from '@/lib/admin/plugin-registry';

/**
 * GET /api/admin/plugins/[id]/bundle - Serve plugin JS bundle
 *
 * Public endpoint so the client-side plugin loader can fetch bundles.
 * Only serves plugins that exist in the registry and are enabled.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    // Validate ID format to prevent path traversal
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(id)) {
      return NextResponse.json({ error: 'Invalid plugin ID' }, { status: 400 });
    }

    const plugin = await getPlugin(id);
    if (!plugin) {
      return NextResponse.json({ error: 'Plugin not found' }, { status: 404 });
    }

    if (!plugin.enabled) {
      return NextResponse.json({ error: 'Plugin is disabled' }, { status: 403 });
    }

    const code = await getPluginBundle(id);
    if (!code) {
      return NextResponse.json({ error: 'Bundle not found' }, { status: 404 });
    }

    return new NextResponse(code, {
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=3600, must-revalidate',
        'Content-Length': String(Buffer.byteLength(code, 'utf-8')),
      },
    });
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
}
