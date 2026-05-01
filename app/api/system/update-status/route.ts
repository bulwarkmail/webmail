import { NextResponse } from 'next/server';
import { loadState } from '@/lib/version-check';

// Public endpoint that returns the latest cached update status. Fed by the
// background scheduler started in instrumentation.node.ts; we never trigger
// a fresh upstream fetch from this route, so an unauthenticated client cannot
// use it to amplify traffic to the version server.
export async function GET() {
  const state = await loadState();
  return NextResponse.json(
    {
      status: state.status,
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
