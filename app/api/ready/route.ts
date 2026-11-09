import { NextResponse } from 'next/server';
import { bootState, getStore, replicaId } from '@/lib/shared-store';

export const dynamic = 'force-dynamic';

/**
 * Readiness probe (#1066), separate from the liveness probe /api/health.
 *
 * 200 when this instance can serve: always once booted with local files;
 * with a shared store, once boot finished and the store answered a ping
 * within a second. 503 otherwise, with the reason in `state`.
 *
 * Kubernetes: readinessProbe here, livenessProbe on /api/health. A store
 * outage then takes pods out of the Service without restarting them.
 *
 * The ping result is reused for a second, so probes can't flood the store.
 */

const CACHE_MS = 1000;
let last: { at: number; ok: boolean } | null = null;

async function storeAnswers(): Promise<boolean> {
  if (last && Date.now() - last.at < CACHE_MS) return last.ok;
  let ok = true;
  try {
    await getStore().ping(1000);
  } catch {
    ok = false;
  }
  last = { at: Date.now(), ok };
  return ok;
}

async function readiness(): Promise<{ status: number; body: Record<string, unknown> }> {
  const store = getStore();
  const state = bootState();
  if (state !== 'ready') {
    return { status: 503, body: { ready: false, store: store.mode, state } };
  }
  if (store.mode === 'local') return { status: 200, body: { ready: true, store: 'local' } };
  if (!(await storeAnswers())) {
    return { status: 503, body: { ready: false, store: store.mode, state: 'store-down', replica: replicaId() } };
  }
  return { status: 200, body: { ready: true, store: store.mode, replica: replicaId() } };
}

export async function GET() {
  const { status, body } = await readiness();
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function HEAD() {
  const { status } = await readiness();
  return new NextResponse(null, { status, headers: { 'Cache-Control': 'no-store' } });
}
