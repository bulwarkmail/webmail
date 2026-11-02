import { NextRequest, NextResponse } from 'next/server';
import { completePolicy, configManager, isPolicyConflict } from '@/lib/admin/config-manager';
import { requireAdminAuth, getClientIP } from '@/lib/admin/session';
import { auditLog } from '@/lib/admin/audit';
import { logger } from '@/lib/logger';
import { summarizePolicyChange } from '@/lib/admin/policy-diff';
import { configReadOnlyResponse } from '@/lib/admin/config-read-only-response';
import type { SettingsPolicy } from '@/lib/admin/types';

/** Largest policy file an import accepts. */
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

/**
 * GET /api/admin/policy/file - the whole user policy as a policy.json
 * download: the same file the server reads, so it can go into git, into
 * another instance's ADMIN_CONFIG_DIR or next to a Lite build.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAdminAuth(request);
  if ('error' in auth) return auth.error;
  await configManager.ensureLoaded();
  const policy = configManager.getPolicy();
  await auditLog('policy.export', { scopeCount: policy.scopes?.length ?? 0 }, getClientIP(request));
  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(`${JSON.stringify(policy, null, 2)}\n`, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="bulwark-policy-${date}.json"`,
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * POST /api/admin/policy/file - import a policy file. With `?preview=1` it
 * only says what would change; otherwise it replaces the policy. The file
 * goes through the same defaults and sanitising as policy.json on load, and
 * the preview shows the result of that, not the raw file.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdminAuth(request);
  if ('error' in auth) return auth.error;
  try {
    const text = await request.text();
    if (text.length > MAX_IMPORT_BYTES) {
      return NextResponse.json({ error: 'The file is larger than 2 MB' }, { status: 413 });
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: 'The file is not valid JSON' }, { status: 400 });
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return NextResponse.json({ error: 'The file does not hold a policy object' }, { status: 400 });
    }

    await configManager.ensureLoaded();
    const next = completePolicy(raw as Partial<SettingsPolicy>);
    if (request.nextUrl.searchParams.get('preview') === '1') {
      return NextResponse.json({ summary: summarizePolicyChange(configManager.getPolicy(), next) });
    }

    // The import replaces the policy it was compared with: a save that lands
    // in between is compared again, so the summary says what was replaced.
    let summary: ReturnType<typeof summarizePolicyChange>;
    for (let attempt = 1; ; attempt++) {
      const version = configManager.getPolicyVersion();
      summary = summarizePolicyChange(configManager.getPolicy(), next);
      try {
        await configManager.setPolicy(next, { ifVersion: version });
        break;
      } catch (error) {
        if (!isPolicyConflict(error)) throw error;
        if (attempt >= 3) return NextResponse.json({ error: error.message }, { status: 409 });
      }
    }
    await auditLog('policy.import', {
      scopeCount: next.scopes?.length ?? 0,
      scopesAdded: summary.scopes.added.length,
      scopesRemoved: summary.scopes.removed.length,
      restrictionsChanged: summary.restrictions.added.length + summary.restrictions.changed.length + summary.restrictions.removed.length,
    }, getClientIP(request));
    return NextResponse.json({ ok: true, summary });
  } catch (error) {
    const readOnly = configReadOnlyResponse(error);
    if (readOnly) return readOnly;
    logger.error('Policy import error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
