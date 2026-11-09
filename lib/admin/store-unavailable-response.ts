import { NextResponse } from 'next/server';
import { isStoreUnavailable } from './admin-store';

/**
 * The 503 a route answers when the shared store (#1066) couldn't be
 * reached: nothing was written, and the client may try again shortly.
 * Returns null for any other error.
 */
export function storeUnavailableResponse(error: unknown): NextResponse | null {
  if (!isStoreUnavailable(error)) return null;
  return NextResponse.json(
    { error: 'Temporarily unavailable, try again in a moment' },
    { status: 503, headers: { 'Retry-After': '10' } },
  );
}
