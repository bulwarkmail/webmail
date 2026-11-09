import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '@/lib/admin/session';
import { logger } from '@/lib/logger';
import { storeUnavailableResponse } from '@/lib/admin/store-unavailable-response';
import { readApprovalBundle } from '@/lib/admin/plugin-approvals';
import { readPluginPackage } from '@/lib/extension-package';

/**
 * GET /api/admin/plugin-approvals/source?pluginId=…&bundleHash=…
 *
 * The manifest and code of a plugin a user asked to have approved, read
 * from the ZIP they uploaded, so the admin decides on what will actually run.
 */
export async function GET(request: NextRequest) {
  try {
    const result = await requireAdminAuth(request);
    if ('error' in result) return result.error;

    const pluginId = request.nextUrl.searchParams.get('pluginId') ?? '';
    const bundleHash = request.nextUrl.searchParams.get('bundleHash') ?? '';
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(pluginId) || !/^[a-f0-9]{64}$/.test(bundleHash)) {
      return NextResponse.json({ error: 'invalid pluginId or bundleHash' }, { status: 400 });
    }
    const zip = await readApprovalBundle(pluginId, bundleHash);
    if (!zip) return NextResponse.json({ error: 'No package stored for this request' }, { status: 404 });
    const pkg = await readPluginPackage(zip);
    return NextResponse.json(
      { manifest: pkg.manifest, code: pkg.code, warnings: pkg.warnings },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    const unavailable = storeUnavailableResponse(err);
    if (unavailable) return unavailable;
    logger.error('plugin-approvals source GET', { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
