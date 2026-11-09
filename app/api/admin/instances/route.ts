import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '@/lib/admin/session';
import { getStore, replicaId } from '@/lib/shared-store';

/** Instances that checked in this recently count as running. */
const RECENT_MS = 60_000;

/**
 * GET /api/admin/instances
 * Which store this deployment uses and how many instances checked in during
 * the last minute (#1066), for the line on the admin overview. The store's
 * address never carries its password.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAdminAuth(request);
  if ('error' in auth) return auth.error;

  const store = getStore();
  const { mode, location } = store.status();
  const headers = { 'Cache-Control': 'no-store' };
  if (mode === 'local') {
    return NextResponse.json({ mode, location, instances: 1, replica: null }, { headers });
  }
  try {
    const replicas = await store.replicas.recent(RECENT_MS);
    return NextResponse.json({
      mode,
      location,
      instances: replicas.length,
      replica: replicaId(),
      replicas: replicas
        .map((r) => ({ id: r.id, version: r.version, startedAt: r.startedAt, lastSeenAt: r.lastSeenAt }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    }, { headers });
  } catch {
    return NextResponse.json({ mode, location, instances: null, replica: replicaId(), error: 'unavailable' }, { headers });
  }
}
