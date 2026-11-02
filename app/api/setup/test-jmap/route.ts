import { NextRequest, NextResponse } from 'next/server';
import { detectSetupState } from '@/lib/setup/state';
import { wizardSessionRefusal } from '@/lib/setup/session';

export const dynamic = 'force-dynamic';

const JMAP_ENDPOINTS = ['/.well-known/jmap', '/jmap/session', '/jmap'];
const FETCH_TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;

/**
 * Follow redirects by hand and only towards the same host (path / trailing
 * slash fixes) or an https upgrade of it. The wizard's server is allowed to
 * be private (it usually is - docker-internal Stalwart), but a probe URL must
 * not be steerable at some *other* internal host via a redirect chain.
 */
async function probe(url: string, method: 'GET' | 'HEAD'): Promise<Response> {
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(current, { method, redirect: 'manual', signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get('location');
    if (!location) return res;
    const next = new URL(location, current);
    const sameHost = next.host === current.host && next.protocol === current.protocol;
    const httpsUpgrade = next.protocol === 'https:' && next.hostname === current.hostname;
    if (!sameHost && !httpsUpgrade) {
      throw new Error(`Redirected to a different host (${next.host})`);
    }
    await res.body?.cancel().catch(() => {});
    current = next;
  }
  throw new Error('Too many redirects');
}

/**
 * POST /api/setup/test-jmap - server-side probe of a JMAP server. Mirrors
 * the check_jmap_server() helper in setup.sh: we hit a few common session
 * endpoints and look for capability strings to confirm the URL is actually
 * a JMAP server (vs. a generic HTTP 200 page).
 *
 * Body: { url: string }
 */
export async function POST(request: NextRequest) {
  if (detectSetupState() !== 'bootstrap') {
    return NextResponse.json({ error: 'Setup is not active' }, { status: 404 });
  }
  const wizardRefused = await wizardSessionRefusal();
  if (wizardRefused) return wizardRefused;

  let body: { url?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const raw = typeof body?.url === 'string' ? body.url.trim() : '';
  if (!raw) {
    return NextResponse.json({ error: 'url required' }, { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return NextResponse.json({ status: 'invalid_url', message: 'URL is not well-formed' });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return NextResponse.json({ status: 'invalid_url', message: 'URL must use http or https' });
  }

  const base = raw.replace(/\/+$/, '');

  for (const endpoint of JMAP_ENDPOINTS) {
    const target = base + endpoint;
    try {
      const res = await probe(target, 'GET');

      if (!res.ok) continue;
      const text = await res.text();
      if (looksLikeJmapSession(text)) {
        return NextResponse.json({
          status: 'jmap_detected',
          endpoint,
          httpStatus: res.status,
        });
      }
    } catch {
      // Try the next endpoint; we'll fall through to a final reachability
      // check below if none match.
    }
  }

  // No JMAP session found. Was the server even reachable?
  try {
    const res = await probe(base, 'HEAD');
    return NextResponse.json({
      status: 'reachable_no_jmap',
      httpStatus: res.status,
      message:
        'Server responded but no JMAP session was found at standard paths. ' +
        'This is OK if a reverse proxy routes JMAP separately.',
    });
  } catch (error) {
    return NextResponse.json({
      status: 'unreachable',
      message: error instanceof Error ? error.message : 'Connection failed',
    });
  }
}

function looksLikeJmapSession(body: string): boolean {
  return /"capabilities"|"apiUrl"|"downloadUrl"|"urn:ietf:params:jmap/i.test(body);
}
