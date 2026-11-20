import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '@/lib/admin/session';
import { logger } from '@/lib/logger';
import { listAccounts, listMigrations } from '@/lib/migration/store';
import { reportCsv } from '@/lib/migration/service';

/**
 * GET /api/admin/migration/report[?migration=<id>] - "Download report": the
 * accounts of one migration, or of all of them, as CSV. Counts and problems
 * only: no passwords, no message content, no subjects.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAdminAuth(request);
    if ('error' in auth) return auth.error;
    const migrationId = request.nextUrl.searchParams.get('migration');
    const migrations = (await listMigrations()).filter((m) => !migrationId || m.id === migrationId);
    if (migrationId && migrations.length === 0) return NextResponse.json({ error: 'No such migration' }, { status: 404 });
    const accounts = (await Promise.all(migrations.map((m) => listAccounts(m.id)))).flat();
    return new NextResponse(reportCsv(accounts), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="migration-report${migrationId ? `-${migrationId}` : ''}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    logger.error('Migration report error', { error: error instanceof Error ? error.name : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
