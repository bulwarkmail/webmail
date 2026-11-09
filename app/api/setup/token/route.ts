import { NextRequest, NextResponse } from 'next/server';
import { detectSetupState } from '@/lib/setup/state';
import { verifySetupToken } from '@/lib/setup/token';
import { buildSessionCookieAttributes, setupStoreUnavailableResponse } from '@/lib/setup/session';
import { isStoreUnavailableError } from '@/lib/shared-store';

export const dynamic = 'force-dynamic';

/**
 * POST /api/setup/token - exchange the bootstrap token (printed to logs at
 * startup) for a wizard session cookie. After this, subsequent step calls
 * authenticate via the cookie instead of pasting the token every time.
 *
 * Body: { token: string }
 */
export async function POST(request: NextRequest) {
  if (detectSetupState() !== 'bootstrap') {
    return NextResponse.json({ error: 'Setup is not active' }, { status: 404 });
  }

  let body: { token?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const submitted = typeof body?.token === 'string' ? body.token.trim() : '';
  if (!submitted) {
    return NextResponse.json({ error: 'Token required' }, { status: 400 });
  }

  let ok: boolean;
  try {
    ok = await verifySetupToken(submitted);
  } catch (error) {
    if (isStoreUnavailableError(error)) return setupStoreUnavailableResponse();
    throw error;
  }
  if (!ok) {
    // Don't differentiate between "wrong token" and "no token issued" - the
    // operator either has it from the logs or they don't.
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  const attrs = buildSessionCookieAttributes(request);
  response.cookies.set(attrs.name, submitted, {
    httpOnly: attrs.httpOnly,
    sameSite: attrs.sameSite,
    secure: attrs.secure,
    path: attrs.path,
    maxAge: attrs.maxAge,
  });
  return response;
}
