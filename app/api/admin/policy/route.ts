import { NextRequest, NextResponse } from 'next/server';
import { configManager } from '@/lib/admin/config-manager';
import { requireAdminAuth, getClientIP } from '@/lib/admin/session';
import { auditLog } from '@/lib/admin/audit';
import { logger } from '@/lib/logger';
import type { SettingsPolicy } from '@/lib/admin/types';

/**
 * GET /api/admin/policy - Get settings policy (NOT admin-protected - users read this)
 */
export async function GET() {
  try {
    await configManager.ensureLoaded();
    const policy = configManager.getPolicy();
    return NextResponse.json(policy, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    logger.error('Policy read error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * PUT /api/admin/policy - Update settings policy (admin-protected)
 */
export async function PUT(request: NextRequest) {
  try {
    const result = await requireAdminAuth();
    if ('error' in result) return result.error;

    const ip = getClientIP(request);
    const policy = await request.json() as SettingsPolicy;

    if (!policy || typeof policy !== 'object') {
      return NextResponse.json({ error: 'Invalid policy object' }, { status: 400 });
    }

    // Basic validation
    if (policy.restrictions && typeof policy.restrictions !== 'object') {
      return NextResponse.json({ error: 'restrictions must be an object' }, { status: 400 });
    }
    if (policy.features && typeof policy.features !== 'object') {
      return NextResponse.json({ error: 'features must be an object' }, { status: 400 });
    }
    if (policy.themePolicy && typeof policy.themePolicy !== 'object') {
      return NextResponse.json({ error: 'themePolicy must be an object' }, { status: 400 });
    }

    await configManager.setPolicy(policy);
    await auditLog('policy.update', { restrictionCount: Object.keys(policy.restrictions || {}).length }, ip);

    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error('Policy update error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
