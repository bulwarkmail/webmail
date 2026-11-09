import { NextResponse } from 'next/server';
import { readiness } from '@/lib/health/readiness';

export const dynamic = 'force-dynamic';

/**
 * Readiness: 200 when this replica can serve, 503 otherwise. Checks that
 * the config is loaded, the shared store (if any) answers, the data dirs are
 * writable and Stalwart's session resource answers within 2 s. The body
 * names the checks only. Results are reused for 5 s.
 * https://bulwarkmail.org/docs/deployment/monitoring#health
 */
const HEADERS = { 'Cache-Control': 'no-store' };

export async function GET() {
  const result = await readiness();
  return NextResponse.json(result, { status: result.ready ? 200 : 503, headers: HEADERS });
}

export async function HEAD() {
  const result = await readiness();
  return new NextResponse(null, { status: result.ready ? 200 : 503, headers: HEADERS });
}
