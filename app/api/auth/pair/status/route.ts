import { NextRequest, NextResponse } from 'next/server';
import { getPairingStatus } from '@/lib/auth/pairing-store';
import { isStoreUnavailable, storeUnavailableResponse } from '@/lib/auth/store-unavailable';
import { logger } from '@/lib/logger';

// Lets the desktop replace its QR with "Signed in on your phone" once the
// code was redeemed. Polled with the separate status id pair/create returned,
// so the code itself is never repeated in URLs or access logs. A status id
// reveals nothing but whether its own code was used.

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get('id') ?? '';
  try {
    const status = /^[0-9a-f]{32}$/.test(id) ? await getPairingStatus(id) : 'unknown';
    return NextResponse.json({ status }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    // Not "unknown": the desktop would show the QR as expired.
    if (isStoreUnavailable(error)) return storeUnavailableResponse({ 'Cache-Control': 'no-store' });
    logger.error('Pair status error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
