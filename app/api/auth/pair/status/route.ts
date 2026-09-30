import { NextRequest, NextResponse } from 'next/server';
import { getPairingStatus } from '@/lib/auth/pairing-store';

// Lets the desktop replace its QR with "Signed in on your phone" once the
// code was redeemed. Polled with the separate status id pair/create returned,
// so the code itself is never repeated in URLs or access logs. A status id
// reveals nothing but whether its own code was used.

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get('id') ?? '';
  const status = /^[0-9a-f]{32}$/.test(id) ? getPairingStatus(id) : 'unknown';
  return NextResponse.json({ status }, { headers: { 'Cache-Control': 'no-store' } });
}
