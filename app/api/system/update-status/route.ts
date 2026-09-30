import { NextRequest, NextResponse } from 'next/server';
import { checkOnce, freshStatus, loadState } from '@/lib/version-check';
import { configManager } from '@/lib/admin/config-manager';
import { canSeeInstanceDetails } from '@/lib/auth/instance-details';

// Public endpoint that returns the latest cached update status. Fed by the
// background scheduler started in instrumentation.node.ts; in production we
// never trigger a fresh upstream fetch from this route so an unauthenticated
// client can't use it to amplify traffic to the version server.
//
// In development we force a fresh fetch on every hit so changes to the
// version server's overrides take effect on the next page reload instead of
// requiring a dev-server restart. The 5s upstream timeout in fetchStatus
// caps the worst-case latency added to a dev reload.
export async function GET(request: NextRequest) {
  if (process.env.NODE_ENV === 'development') {
    await checkOnce({ reason: 'dev-reload' });
  }

  const state = await loadState();
  // freshStatus drops a status persisted by an earlier build - after an
  // upgrade it would still advertise the version we just upgraded from (#913).
  let status = freshStatus(state);

  // Visitors who are not signed in see the version only where the login
  // page shows it (loginShowVersion), and never the advisory text: a
  // pending security update tells an attacker which hole is still open.
  if (status && !(await canSeeInstanceDetails(request))) {
    await configManager.ensureLoaded();
    status = configManager.get<boolean>('loginShowVersion', true) ? { ...status, advisory: null } : null;
  }

  return NextResponse.json(
    {
      status,
      lastCheckedAt: state.lastCheckedAt,
      lastSuccessAt: state.lastSuccessAt,
    },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  );
}
