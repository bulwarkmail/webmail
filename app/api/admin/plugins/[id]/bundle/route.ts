import { NextRequest, NextResponse } from 'next/server';
import { getPluginBundle, getPlugin, getPluginSignature, isBundleMismatch } from '@/lib/admin/plugin-registry';
import { getDevPlugin, readDevBundle } from '@/lib/admin/plugin-dev';
import { signBytes } from '@/lib/admin/plugin-signing';
import { canSeeInstanceDetails } from '@/lib/auth/instance-details';
import { storeUnavailableResponse } from '@/lib/admin/store-unavailable-response';

async function safeSign(code: string): Promise<string | null> {
  try { return await signBytes(code); } catch { return null; }
}

/**
 * GET /api/admin/plugins/[id]/bundle - Serve plugin JS bundle
 *
 * Serves bundles to signed-in users so the client-side plugin loader can fetch them.
 * Only serves plugins that exist in the registry and are enabled.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Bundles are delivered to signed-in users only, like the plugin list
  // that names them (/api/plugins).
  if (!(await canSeeInstanceDetails(request))) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  try {
    const { id } = await params;

    // Validate ID format to prevent path traversal
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(id)) {
      return NextResponse.json({ error: 'Invalid plugin ID' }, { status: 400 });
    }

    // Dev plugins are read (and optionally bundled) straight from disk and
    // served with no caching so every refresh picks up the latest source.
    const devEntry = await getDevPlugin(id);
    if (devEntry) {
      const code = await readDevBundle(devEntry);
      const signature = await safeSign(code);
      const headers: Record<string, string> = {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
        'ETag': `"${devEntry.plugin.bundleHash}"`,
        'Content-Length': String(Buffer.byteLength(code, 'utf-8')),
      };
      if (signature) headers['X-Bundle-Signature'] = signature;
      return new NextResponse(code, { headers });
    }

    const plugin = await getPlugin(id);
    if (!plugin) {
      return NextResponse.json({ error: 'Plugin not found' }, { status: 404 });
    }

    if (!plugin.enabled) {
      return NextResponse.json({ error: 'Plugin is disabled' }, { status: 403 });
    }

    const code = await getPluginBundle(id, plugin.bundleHash);
    if (!code) {
      return NextResponse.json({ error: 'Bundle not found' }, { status: 404 });
    }

    // Use the registry's bundleHash as the ETag so the browser can revalidate
    // cheaply. Cache-Control: no-cache forces revalidation on every request,
    // but a matching If-None-Match returns 304 with no body.
    const etag = plugin.bundleHash ? `"${plugin.bundleHash}"` : undefined;
    const headers: Record<string, string> = {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'private, no-cache, must-revalidate',
    };
    if (etag) headers['ETag'] = etag;

    const signature = await getPluginSignature(id, code, plugin.bundleHash);
    if (signature) headers['X-Bundle-Signature'] = signature;

    if (etag && request.headers.get('if-none-match') === etag) {
      return new NextResponse(null, { status: 304, headers });
    }

    headers['Content-Length'] = String(Buffer.byteLength(code, 'utf-8'));
    return new NextResponse(code, { headers });
  } catch (error) {
    // Logged where it was found. 409 on every replica alike.
    if (isBundleMismatch(error)) {
      return NextResponse.json({ error: (error as Error).message }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
    }
    const unavailable = storeUnavailableResponse(error);
    if (unavailable) return unavailable;
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
}
