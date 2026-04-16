import { NextRequest, NextResponse } from 'next/server';
import { configManager } from '@/lib/admin/config-manager';
import { requireAdminAuth, getClientIP } from '@/lib/admin/session';
import { auditLog } from '@/lib/admin/audit';
import { CONFIG_ENV_MAP } from '@/lib/admin/types';
import { logger } from '@/lib/logger';

/**
 * GET /api/admin/config - Get full config with sources (admin-protected)
 */
export async function GET() {
  try {
    const result = await requireAdminAuth();
    if ('error' in result) return result.error;

    await configManager.ensureLoaded();
    const config = configManager.getAllWithSources();

    return NextResponse.json(config, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    logger.error('Admin config read error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * PATCH /api/admin/config - Update config overrides (admin-protected)
 */
export async function PATCH(request: NextRequest) {
  try {
    const result = await requireAdminAuth();
    if ('error' in result) return result.error;

    const ip = getClientIP(request);
    const updates = await request.json();

    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return NextResponse.json({ error: 'Request body must be an object' }, { status: 400 });
    }

    // Validate keys
    const validKeys = Object.keys(CONFIG_ENV_MAP);
    const invalidKeys = Object.keys(updates).filter(k => !validKeys.includes(k));
    if (invalidKeys.length > 0) {
      return NextResponse.json({ error: `Unknown config keys: ${invalidKeys.join(', ')}` }, { status: 400 });
    }

    // Get old values for audit
    const oldValues: Record<string, unknown> = {};
    for (const key of Object.keys(updates)) {
      oldValues[key] = configManager.get(key);
    }

    await configManager.setAdminConfig(updates);
    await auditLog('config.update', { changes: Object.keys(updates).map(k => ({ key: k, old: oldValues[k], new: updates[k] })) }, ip);

    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error('Admin config update error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/config - Remove admin override for a key (revert to env/default)
 */
export async function DELETE(request: NextRequest) {
  try {
    const result = await requireAdminAuth();
    if ('error' in result) return result.error;

    const ip = getClientIP(request);
    const { key } = await request.json();

    if (!key || typeof key !== 'string') {
      return NextResponse.json({ error: 'Key is required' }, { status: 400 });
    }

    if (!CONFIG_ENV_MAP[key]) {
      return NextResponse.json({ error: `Unknown config key: ${key}` }, { status: 400 });
    }

    const oldValue = configManager.get(key);
    await configManager.removeAdminOverride(key);
    await auditLog('config.revert', { key, oldValue }, ip);

    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error('Admin config revert error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
