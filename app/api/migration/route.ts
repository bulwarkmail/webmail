import { NextRequest, NextResponse } from 'next/server';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { logger } from '@/lib/logger';
import { storedDataUnavailableResponse } from '@/lib/stored-data-errors';
import {
  MigrationRequestError,
  startUserMigration,
  userCancel,
  userFinish,
  userOverview,
  userRemove,
  userRequestPass,
  userTestSource,
  type MigrationUser,
} from '@/lib/migration/service';

/**
 * Settings > Backup & import > Move from another server (#1760).
 *
 * GET  /api/migration               what the user may pick, and their own migration
 * POST /api/migration { action }    test | start | pass | cancel | finish | remove
 *
 * The target is always the signed-in account: it comes from the session,
 * never from the body. The user sees and changes only their own migration.
 */

const NO_STORE = { 'Cache-Control': 'no-store' };

async function currentUser(request: NextRequest): Promise<MigrationUser | null> {
  const creds = await getStalwartCredentials(request);
  if (!creds) return null;
  return { username: creds.username, accountName: creds.accountName, serverUrl: creds.serverUrl, trusted: creds.trusted };
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof MigrationRequestError) {
    return NextResponse.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, { status: error.status, headers: NO_STORE });
  }
  const unavailable = storedDataUnavailableResponse(error, NO_STORE);
  if (unavailable) return unavailable;
  logger.error('Migration error', { error: error instanceof Error ? error.name : 'Unknown error' });
  return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: NO_STORE });
}

export async function GET(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  try {
    return NextResponse.json(await userOverview(user), { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.action !== 'string') return NextResponse.json({ error: 'action required' }, { status: 400 });
  try {
    switch (body.action) {
      case 'test':
        return NextResponse.json({ results: await userTestSource(user, body) }, { headers: NO_STORE });
      case 'start':
        return NextResponse.json({ migration: await startUserMigration(user, body) }, { headers: NO_STORE });
      case 'pass':
        return NextResponse.json(await userRequestPass(user, body), { headers: NO_STORE });
      case 'cancel':
        await userCancel(user);
        return NextResponse.json({ ok: true }, { headers: NO_STORE });
      case 'finish':
        await userFinish(user);
        return NextResponse.json({ ok: true }, { headers: NO_STORE });
      case 'remove':
        await userRemove(user);
        return NextResponse.json({ ok: true }, { headers: NO_STORE });
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (error) {
    return errorResponse(error);
  }
}
