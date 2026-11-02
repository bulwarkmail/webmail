import { NextResponse } from 'next/server';
import { isStoreUnavailableError, type StoreUnavailableError } from '@/lib/shared-store/types';

/**
 * Answers for when the shared store (#1066) can't be reached. Sign-in limits
 * fail closed: a limit that can't be counted refuses the attempt instead of
 * letting it through. Pairing and the mobile hand-off can neither issue nor
 * redeem anything without the store.
 */

export const STORE_RETRY_AFTER_SECONDS = 10;

/** By name, as every bundle has its own copy of the error class (see isStoreUnavailableError). */
export function isStoreUnavailable(error: unknown): error is StoreUnavailableError {
  return isStoreUnavailableError(error);
}

export function storeUnavailableResponse(headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(
    { error: 'temporarily_unavailable', hint: 'Sign-in is temporarily unavailable. Try again in a few seconds.' },
    { status: 503, headers: { ...headers, 'Retry-After': String(STORE_RETRY_AFTER_SECONDS) } },
  );
}
