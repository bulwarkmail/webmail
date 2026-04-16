import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '@/lib/admin/session';
import { readAuditLog } from '@/lib/admin/audit';
import { logger } from '@/lib/logger';

/**
 * GET /api/admin/audit - Get paginated audit log entries (admin-protected)
 */
export async function GET(request: NextRequest) {
  try {
    const result = await requireAdminAuth();
    if ('error' in result) return result.error;

    const page = Math.max(1, parseInt(request.nextUrl.searchParams.get('page') || '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(request.nextUrl.searchParams.get('limit') || '50', 10)));
    const action = request.nextUrl.searchParams.get('action') || undefined;

    const { entries, total } = await readAuditLog(page, limit, action);

    return NextResponse.json({ entries, total, page, limit }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    logger.error('Audit log read error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
