import { NextRequest, NextResponse } from 'next/server';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { MigrationRequestError, userReportCsv } from '@/lib/migration/service';

/** GET /api/migration/report - the signed-in user's own migration report as CSV. */
export async function GET(request: NextRequest) {
  const creds = await getStalwartCredentials(request);
  if (!creds) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  try {
    const csv = await userReportCsv({ username: creds.username, accountName: creds.accountName, serverUrl: creds.serverUrl, trusted: creds.trusted });
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="migration-report.csv"',
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    if (error instanceof MigrationRequestError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
