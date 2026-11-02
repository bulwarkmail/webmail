import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth, getClientIP } from '@/lib/admin/session';
import { auditLog } from '@/lib/admin/audit';
import { logger } from '@/lib/logger';
import { listApprovals, decideApproval, revokeApproval } from '@/lib/admin/plugin-approvals';
import { configReadOnlyResponse } from '@/lib/admin/config-read-only-response';
import { storeUnavailableResponse } from '@/lib/admin/store-unavailable-response';

/**
 * Admin-protected CRUD for the per-(pluginId, bundleHash) approval table.
 *
 *   GET    /api/admin/plugin-approvals               → list all entries
 *   POST   /api/admin/plugin-approvals               → { pluginId, bundleHash, decision: 'approved'|'denied' }
 *   DELETE /api/admin/plugin-approvals?pluginId=…&bundleHash=…   → revoke
 */

function isValidId(s: unknown): s is string {
  return typeof s === 'string' && /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(s) && s.length <= 64;
}
function isValidHash(s: unknown): s is string {
  return typeof s === 'string' && /^[a-f0-9]{16,128}$/i.test(s);
}

export async function GET(request: NextRequest) {
  try {
    const result = await requireAdminAuth(request);
    if ('error' in result) return result.error;
    const entries = await listApprovals();
    return NextResponse.json({ entries }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const unavailable = storeUnavailableResponse(err);
    if (unavailable) return unavailable;
    logger.error('plugin-approvals GET', { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const result = await requireAdminAuth(request);
    if ('error' in result) return result.error;
    // AdminSessionPayload carries only role/iat/exp; we use a stable label
    // for the audit trail rather than a per-user identity.
    const adminUser = 'admin';
    void result;
    const ip = getClientIP(request);

    let body: unknown;
    try { body = await request.json(); } catch { body = null; }
    const b = (body ?? {}) as { pluginId?: unknown; bundleHash?: unknown; decision?: unknown };
    if (!isValidId(b.pluginId) || !isValidHash(b.bundleHash)) {
      return NextResponse.json({ error: 'invalid pluginId or bundleHash' }, { status: 400 });
    }
    if (b.decision !== 'approved' && b.decision !== 'denied') {
      return NextResponse.json({ error: 'decision must be "approved" or "denied"' }, { status: 400 });
    }

    const entry = await decideApproval(b.pluginId, b.bundleHash, b.decision, adminUser);
    await auditLog('plugin.approval', { pluginId: entry.pluginId, bundleHash: entry.bundleHash, decision: entry.status }, ip);
    return NextResponse.json({ entry });
  } catch (err) {
    const readOnly = configReadOnlyResponse(err);
    if (readOnly) return readOnly;
    logger.error('plugin-approvals POST', { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const result = await requireAdminAuth(request);
    if ('error' in result) return result.error;
    // AdminSessionPayload carries only role/iat/exp; we use a stable label
    // for the audit trail rather than a per-user identity.
    const adminUser = 'admin';
    void result;
    const ip = getClientIP(request);

    const pluginId = request.nextUrl.searchParams.get('pluginId');
    const bundleHash = request.nextUrl.searchParams.get('bundleHash');
    if (!isValidId(pluginId) || !isValidHash(bundleHash)) {
      return NextResponse.json({ error: 'invalid pluginId or bundleHash' }, { status: 400 });
    }
    await revokeApproval(pluginId, bundleHash);
    await auditLog('plugin.approval.revoke', { pluginId, bundleHash, by: adminUser }, ip);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const readOnly = configReadOnlyResponse(err);
    if (readOnly) return readOnly;
    logger.error('plugin-approvals DELETE', { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
