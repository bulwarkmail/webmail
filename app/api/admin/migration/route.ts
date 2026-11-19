import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth, getClientIP } from '@/lib/admin/session';
import { auditLog } from '@/lib/admin/audit';
import { logger } from '@/lib/logger';
import { storedDataUnavailableResponse } from '@/lib/stored-data-errors';
import {
  MigrationRequestError,
  adminOverview,
  adminRequestPass,
  adminTestSource,
  cancelMigration,
  deleteSource,
  finishMigration,
  migrationAccounts,
  removeMigration,
  saveMigrationOptions,
  saveSource,
  startBulkMigration,
  validateBulkCsv,
} from '@/lib/migration/service';

/**
 * Admin > Mailbox migration (#1760).
 *
 * GET  /api/admin/migration                      sources, options, migrations
 * GET  /api/admin/migration?migration=<id>&q=&status=&offset=&limit=
 *                                                one migration's accounts
 * POST /api/admin/migration { action, ... }      the changes below
 *
 * Source passwords go in and never come out: the answers say "saved" only.
 * Every change is audited without them.
 */

const NO_STORE = { 'Cache-Control': 'no-store' };

function errorResponse(error: unknown): NextResponse {
  if (error instanceof MigrationRequestError) {
    return NextResponse.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, { status: error.status, headers: NO_STORE });
  }
  const unavailable = storedDataUnavailableResponse(error, NO_STORE);
  if (unavailable) return unavailable as NextResponse;
  logger.error('Migration admin error', { error: error instanceof Error ? error.name : 'Unknown error' });
  return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: NO_STORE });
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAdminAuth(request);
    if ('error' in auth) return auth.error;
    const params = request.nextUrl.searchParams;
    const migrationId = params.get('migration');
    if (migrationId) {
      const result = await migrationAccounts(migrationId, {
        q: params.get('q') ?? undefined,
        status: params.get('status') ?? undefined,
        offset: Number(params.get('offset')) || 0,
        limit: Number(params.get('limit')) || 100,
      });
      return NextResponse.json(result, { headers: NO_STORE });
    }
    return NextResponse.json(await adminOverview(), { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAdminAuth(request);
    if ('error' in auth) return auth.error;
    const ip = getClientIP(request);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.action !== 'string') {
      return NextResponse.json({ error: 'action required' }, { status: 400 });
    }
    const migrationId = str(body.migrationId);
    const accountKey = str(body.accountKey) || undefined;

    switch (body.action) {
      case 'save-source': {
        const source = await saveSource(body.source);
        // publicSource: the password is never part of it.
        await auditLog(body.source && (body.source as { id?: unknown }).id ? 'migration.source.update' : 'migration.source.add', { source }, ip);
        return NextResponse.json({ source }, { headers: NO_STORE });
      }
      case 'delete-source': {
        const id = str(body.id);
        if (!(await deleteSource(id))) return NextResponse.json({ error: 'No such source' }, { status: 404 });
        await auditLog('migration.source.delete', { id }, ip);
        return NextResponse.json({ ok: true }, { headers: NO_STORE });
      }
      case 'test-source': {
        // The test login is typed into the dialog and used once; it is neither stored nor logged.
        const results = await adminTestSource(body);
        return NextResponse.json({ results }, { headers: NO_STORE });
      }
      case 'save-options': {
        const options = await saveMigrationOptions(body.options);
        await auditLog('migration.options', { options }, ip);
        return NextResponse.json({ options }, { headers: NO_STORE });
      }
      case 'validate-csv': {
        const { rows, problems } = await validateBulkCsv(str(body.sourceId), str(body.csv));
        return NextResponse.json({ rows: rows.length, problems }, { headers: NO_STORE });
      }
      case 'start-bulk': {
        const result = await startBulkMigration(body);
        if ('problems' in result) return NextResponse.json({ problems: result.problems }, { status: 422, headers: NO_STORE });
        await auditLog('migration.start', { migration: result.migration.id, source: result.migration.sourceName, accounts: result.migration.accountCount, what: result.migration.what }, ip);
        return NextResponse.json(result, { headers: NO_STORE });
      }
      case 'pass': {
        const queued = await adminRequestPass(migrationId, accountKey);
        await auditLog('migration.pass', { migration: migrationId, ...(accountKey ? { account: accountKey } : {}), queued }, ip);
        return NextResponse.json({ queued }, { headers: NO_STORE });
      }
      case 'cancel': {
        await cancelMigration(migrationId, accountKey);
        await auditLog('migration.cancel', { migration: migrationId, ...(accountKey ? { account: accountKey } : {}) }, ip);
        return NextResponse.json({ ok: true }, { headers: NO_STORE });
      }
      case 'finish': {
        await finishMigration(migrationId);
        await auditLog('migration.finish', { migration: migrationId }, ip);
        return NextResponse.json({ ok: true }, { headers: NO_STORE });
      }
      case 'remove': {
        await removeMigration(migrationId);
        await auditLog('migration.remove', { migration: migrationId }, ip);
        return NextResponse.json({ ok: true }, { headers: NO_STORE });
      }
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (error) {
    return errorResponse(error);
  }
}
