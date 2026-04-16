import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';

/**
 * GET /api/admin/stalwart-check
 * Check if the currently logged-in user is a Stalwart admin.
 * Probes the admin-only principal-list endpoint - if the user can access it, they're an admin.
 */
export async function GET(request: NextRequest) {
  try {
    const creds = await getStalwartCredentials(request);
    if (!creds) {
      return NextResponse.json({ isStalwartAdmin: false }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    // Probe an admin-only endpoint: listing principals requires admin privileges.
    // Use limit=1 to minimize payload.
    const url = `${creds.apiUrl}/api/principal?limit=1`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': creds.authHeader },
    });

    const isStalwartAdmin = response.ok;
    logger.info('Stalwart admin check', { username: creds.username, status: response.status, isStalwartAdmin });

    return NextResponse.json({ isStalwartAdmin }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    logger.error('Stalwart admin check error', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
    return NextResponse.json({ isStalwartAdmin: false }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
