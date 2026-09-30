import { NextRequest, NextResponse } from 'next/server';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { cookies } from 'next/headers';
import { decryptSession } from '@/lib/auth/crypto';
import { sessionCookieName } from '@/lib/auth/session-cookie';
import { readStalwartAuthContextFromStore } from '@/lib/stalwart/auth-context';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import { logger } from '@/lib/logger';
import { getApprovalStatus, requestApproval, type ApprovalEntry } from '@/lib/admin/plugin-approvals';

/**
 * GET /api/plugin-approval-status?pluginId=X&bundleHash=Y
 *
 * Any logged-in user may query the server-side approval state for a plugin
 * they want to enable. The client uses this BEFORE running `enablePlugin`
 * when the `requirePluginApproval` policy is set.
 *
 * POST same path with body `{ pluginId, bundleHash, manifest }` creates a
 * pending approval entry (or returns the existing one).
 */

async function resolveUsername(): Promise<string | null> {
  const cookieStore = await cookies();
  for (let slot = 0; slot < MAX_ACCOUNT_SLOTS; slot++) {
    const token = cookieStore.get(sessionCookieName(slot))?.value;
    if (token) {
      const sess = decryptSession(token);
      if (sess?.username) return sess.username;
    }
    const ctx = readStalwartAuthContextFromStore(cookieStore, slot);
    if (ctx?.username) return ctx.username;
  }
  return null;
}

function isValidId(s: unknown): s is string {
  return typeof s === 'string' && /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(s) && s.length <= 64;
}
function isValidHash(s: unknown): s is string {
  return typeof s === 'string' && /^[a-f0-9]{16,128}$/i.test(s);
}

export async function GET(request: NextRequest) {
  try {
    const username = await resolveUsername();
    if (!username) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

    const pluginId = request.nextUrl.searchParams.get('pluginId');
    const bundleHash = request.nextUrl.searchParams.get('bundleHash');
    if (!isValidId(pluginId) || !isValidHash(bundleHash)) {
      return NextResponse.json({ error: 'invalid pluginId or bundleHash' }, { status: 400 });
    }
    const status = await getApprovalStatus(pluginId, bundleHash);
    return NextResponse.json(status, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    logger.error('plugin-approval-status GET', { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  // CSRF gate (GHSA-9mvj-98f5-9q6g): this handler acts with the caller's
  // session cookie, which SameSite=Lax still sends from a same-site page.
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  try {
    const username = await resolveUsername();
    if (!username) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

    let body: unknown;
    try { body = await request.json(); } catch { body = null; }
    const b = (body ?? {}) as { pluginId?: unknown; bundleHash?: unknown; manifest?: unknown };
    if (!isValidId(b.pluginId) || !isValidHash(b.bundleHash)) {
      return NextResponse.json({ error: 'invalid pluginId or bundleHash' }, { status: 400 });
    }

    const m = (b.manifest ?? {}) as Record<string, unknown>;
    const manifest: ApprovalEntry['manifest'] = {
      name: typeof m.name === 'string' ? m.name.slice(0, 200) : undefined,
      version: typeof m.version === 'string' ? m.version.slice(0, 64) : undefined,
      author: typeof m.author === 'string' ? m.author.slice(0, 200) : undefined,
      description: typeof m.description === 'string' ? m.description.slice(0, 500) : undefined,
      permissions: Array.isArray(m.permissions) ? (m.permissions as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 50) : undefined,
      httpOrigins: Array.isArray(m.httpOrigins) ? (m.httpOrigins as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 20) : undefined,
      apiPostPaths: Array.isArray(m.apiPostPaths) ? (m.apiPostPaths as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 20) : undefined,
    };

    const entry = await requestApproval(b.pluginId as string, b.bundleHash as string, manifest, username);
    return NextResponse.json({ status: entry.status, requestedAt: entry.requestedAt, decidedAt: entry.decidedAt });
  } catch (err) {
    logger.error('plugin-approval-status POST', { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
