import { NextRequest, NextResponse } from 'next/server';
import { configManager } from '@/lib/admin/config-manager';
import { discoverMailServer } from '@/lib/auth/discover-mail-server';
import { createFailureBudget } from '@/lib/auth/verify-budget';
import { loginClientAddress } from '@/lib/auth/client-address';
import { isStoreUnavailable } from '@/lib/auth/store-unavailable';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { logger } from '@/lib/logger';

/**
 * Finds the mail server of the address typed on the sign-in form, when the
 * form lets people sign in to a server of their own (allowCustomJmapEndpoint,
 * and the desktop app's standalone mode). Answers `{ serverUrl }`, null when
 * nothing was found: the form then asks for the server.
 *
 * Each lookup asks a domain the caller chose, so it is budgeted per client:
 * enough for someone typing, not for using this server to knock on others.
 */
const discoverBudget = createFailureBudget({ name: 'discover-server', clientMax: 30, globalMax: 600 });

function answer(serverUrl: string | null, status = 200) {
  return NextResponse.json({ serverUrl }, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: NextRequest) {
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  await configManager.ensureLoaded();
  if (!configManager.get<boolean>('allowCustomJmapEndpoint', false)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const body = await request.json().catch(() => null);
  const email = body?.email;
  if (typeof email !== 'string' || !email || email.length > 320) {
    return NextResponse.json({ error: 'Missing email' }, { status: 400 });
  }
  try {
    const reserved = await discoverBudget.reserve(loginClientAddress(request));
    if (!reserved) return answer(null, 429);
  } catch (error) {
    if (isStoreUnavailable(error)) return answer(null, 503);
    throw error;
  }
  try {
    return answer(await discoverMailServer(email));
  } catch (error) {
    logger.warn('Mail server discovery failed', { error: error instanceof Error ? error.message : 'Unknown error' });
    return answer(null);
  }
}
