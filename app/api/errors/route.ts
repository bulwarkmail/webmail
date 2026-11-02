import { NextRequest, NextResponse } from 'next/server';
import { getClientIP } from '@/lib/admin/session';
import { getStore } from '@/lib/shared-store';
import { recordError } from '@/lib/error-reporting/aggregate';
import { appVersion, isErrorCode } from '@/lib/error-reporting/envelope';
import { scrubName } from '@/lib/error-reporting/scrub';
import { shouldCollectErrors } from '@/lib/error-reporting/settings';
import { sanitizeFrames } from '@/lib/error-reporting/stack';
import { countBrowserError } from '@/lib/metrics';

export const dynamic = 'force-dynamic';

/**
 * POST /api/errors: a browser of this instance reports an error it caught
 * (lib/error-reporting/client.ts), for the per-day error counts. Only while
 * collection is on (a DSN, the metrics endpoint or error-count consent);
 * otherwise 204 and nothing is kept.
 *
 * Same-origin only (the proxy's origin gate), at most 16 KB, 30 a minute per
 * address. Nothing a browser sends is trusted: every field is scrubbed again
 * and the fingerprint is computed here. The DSN gets the browser's own
 * report; this route only counts.
 */

const MAX_BODY_BYTES = 16 * 1024;
const PER_MINUTE = 30;

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function POST(request: NextRequest) {
  if (!(await shouldCollectErrors())) return new NextResponse(null, { status: 204, headers: NO_STORE });

  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > MAX_BODY_BYTES) return NextResponse.json({ error: 'too large' }, { status: 413, headers: NO_STORE });

  const limit = await getStore().counters.reserve([
    { key: `error-reports:${getClientIP(request)}`, max: PER_MINUTE, windowMs: 60_000 },
  ]).catch(() => ({ ok: true }));
  if (!limit.ok) return NextResponse.json({ error: 'rate limited' }, { status: 429, headers: NO_STORE });

  let text: string;
  try {
    text = await request.text();
  } catch {
    return NextResponse.json({ error: 'bad request' }, { status: 400, headers: NO_STORE });
  }
  if (text.length > MAX_BODY_BYTES) return NextResponse.json({ error: 'too large' }, { status: 413, headers: NO_STORE });

  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'bad request' }, { status: 400, headers: NO_STORE });
  }

  const code = isErrorCode(body.code) ? body.code : undefined;
  recordError(
    {
      name: scrubName(body.name),
      frames: sanitizeFrames(body.frames),
      ...(code ? { code } : {}),
    },
    'browser',
    // The version the tab runs (a tab left open across an update runs the
    // old one, and its frames point into that); the server's when absent.
    typeof body.version === 'string' && /^\d+\.\d+\.\d+(?:[-+][\w.-]{1,40})?$/.test(body.version) ? body.version : appVersion(),
  );
  countBrowserError();
  return new NextResponse(null, { status: 204, headers: NO_STORE });
}
