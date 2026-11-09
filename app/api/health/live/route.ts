import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Liveness: 200 while the process answers. Nothing else is checked, so a
 * Stalwart or store outage never makes an orchestrator restart Bulwark.
 * Readiness is /api/health/ready. https://bulwarkmail.org/docs/deployment/monitoring#health
 */
const HEADERS = { 'Cache-Control': 'no-store' };

export function GET() {
  return NextResponse.json({ status: 'ok' }, { headers: HEADERS });
}

export function HEAD() {
  return new NextResponse(null, { status: 200, headers: HEADERS });
}
