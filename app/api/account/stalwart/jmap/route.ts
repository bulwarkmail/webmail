import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';

/**
 * POST /api/account/stalwart/jmap
 *
 * Passthrough to Stalwart's JMAP endpoint using the stored basic-auth
 * context so the browser does not need access to the user's credentials.
 *
 * Body: standard JMAP request `{ using: string[], methodCalls: [...] }`
 *
 * In Stalwart 0.16 all management operations (password change, app
 * passwords, API keys, account settings, etc.) are exposed as JMAP
 * methods under the `x:` namespace on the same endpoint.
 */
export async function POST(request: NextRequest) {
  try {
    const creds = await getStalwartCredentials(request);
    if (!creds) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const body = await request.text();

    const response = await fetch(`${creds.serverUrl}/jmap/`, {
      method: 'POST',
      headers: {
        'Authorization': creds.authHeader,
        'Content-Type': 'application/json',
      },
      body,
    });

    const responseText = await response.text();
    return new NextResponse(responseText, {
      status: response.status,
      headers: { 'Content-Type': response.headers.get('Content-Type') || 'application/json' },
    });
  } catch (error) {
    logger.error('Stalwart JMAP passthrough error', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
