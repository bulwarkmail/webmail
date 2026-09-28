import { NextRequest, NextResponse } from 'next/server';
import { configManager } from '@/lib/admin/config-manager';
import { requireAdminAuth, getClientIP } from '@/lib/admin/session';
import { auditLog } from '@/lib/admin/audit';
import { logger } from '@/lib/logger';
import { POLICY_SCOPE_HEADER, type SettingsPolicy } from '@/lib/admin/types';
import { canSeeInstanceDetails } from '@/lib/auth/instance-details';

/**
 * GET /api/admin/policy - Get settings policy (NOT admin-protected - users read this;
 * visitors who are not signed in get the subset the login page needs)
 */
export async function GET(request: NextRequest) {
  try {
    await configManager.ensureLoaded();
    const policy = configManager.getPolicy();
    if (!(await canSeeInstanceDetails(request))) {
      // The login page needs the theme policy and gates; the plugin lists,
      // push relays and sidebar app URLs map the deployment and are only
      // used after signing in, when the client fetches the policy again.
      return NextResponse.json(
        {
          ...policy,
          forceEnabledPlugins: [],
          approvedPlugins: [],
          pushRelays: [],
          pushRelayUrl: '',
          pushRelayUrlLocked: false,
          defaultSidebarApps: [],
        },
        { headers: { 'Cache-Control': 'no-store', [POLICY_SCOPE_HEADER]: 'public' } },
      );
    }
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
