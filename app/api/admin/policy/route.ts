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
    const result = await requireAdminAuth(request);
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
    if (policy.defaults !== undefined && (typeof policy.defaults !== 'object' || policy.defaults === null || Array.isArray(policy.defaults))) {
      return NextResponse.json({ error: 'defaults must be an object' }, { status: 400 });
    }
    if (policy.themePolicy && typeof policy.themePolicy !== 'object') {
      return NextResponse.json({ error: 'themePolicy must be an object' }, { status: 400 });
    }
    if (policy.defaultSidebarApps !== undefined && !Array.isArray(policy.defaultSidebarApps)) {
      return NextResponse.json({ error: 'defaultSidebarApps must be an array' }, { status: 400 });
    }

    await configManager.setPolicy(policy);
    await auditLog('policy.update', {
      restrictionCount: Object.keys(policy.restrictions || {}).length,
      // Entries the sanitizer dropped never reach users, so log what stuck.
      defaultSidebarAppCount: configManager.getPolicy().defaultSidebarApps?.length ?? 0,
    }, ip);

    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error('Policy update error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
