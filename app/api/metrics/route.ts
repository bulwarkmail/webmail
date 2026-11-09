import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { metrics, metricsToken } from '@/lib/metrics';

export const dynamic = 'force-dynamic';

/**
 * GET /api/metrics: Prometheus metrics of this replica.
 *
 * Off by default: without METRICS_TOKEN (or METRICS_TOKEN_FILE) it answers
 * 404 as if it didn't exist. With one, the scraper sends
 * `Authorization: Bearer <token>`; anything else gets 401.
 *
 * https://bulwarkmail.org/docs/deployment/monitoring#metrics
 */

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: NextRequest) {
  const token = metricsToken();
  if (!token) return new NextResponse('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store' } });

  const header = request.headers.get('authorization') ?? '';
  const given = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  if (!given || !sameToken(given, token)) {
    return new NextResponse('Unauthorized', {
      status: 401,
      headers: { 'Cache-Control': 'no-store', 'WWW-Authenticate': 'Bearer realm="metrics"' },
    });
  }

  const { registry } = metrics();
  return new NextResponse(await registry.metrics(), {
    status: 200,
    headers: { 'Content-Type': registry.contentType, 'Cache-Control': 'no-store' },
  });
}
