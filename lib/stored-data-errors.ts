import { NextResponse } from 'next/server';
import { isStoreUnavailableError } from '@/lib/shared-store/types';

/**
 * A user's stored document exists but can't be read: it doesn't decrypt
 * (another session secret), it is cut short, or the read failed. It is not
 * the same as "nothing stored": a route that treated it as empty would merge
 * into nothing and overwrite the user's real data on the next save. Routes
 * answer 503 and write nothing.
 */
export class StoredDataUnreadableError extends Error {
  constructor(what: string, options?: { cause?: unknown }) {
    super(`Stored ${what} could not be read`, options);
    this.name = 'StoredDataUnreadableError';
  }
}

// By name, not instanceof: Next bundles each entry with its own copy of a
// module, so the store's error class may not be the one this file imports.
function named(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}

/** The shared store couldn't be reached (StoreUnavailableError from lib/shared-store). */
export function isStoreUnavailable(error: unknown): boolean {
  return isStoreUnavailableError(error);
}

export function isStoredDataUnreadable(error: unknown): boolean {
  return named(error, 'StoredDataUnreadableError');
}

/** True for the errors that mean "try again later, nothing was written". */
export function isStoredDataUnavailable(error: unknown): boolean {
  return isStoredDataUnreadable(error) || isStoreUnavailable(error);
}

/**
 * The 503 for an unreadable document or an unreachable shared store, or null
 * for any other error. The client keeps its own copy and retries.
 */
export function storedDataUnavailableResponse(
  error: unknown,
  headers?: Record<string, string>,
): NextResponse | null {
  if (isStoredDataUnreadable(error)) {
    return NextResponse.json(
      { error: 'Your stored data could not be read on the server. Nothing was changed.', code: 'stored_data_unreadable' },
      { status: 503, headers: { 'Retry-After': '10', ...headers } },
    );
  }
  if (isStoreUnavailable(error)) {
    return NextResponse.json(
      { error: 'Storage is temporarily unavailable. Nothing was changed.', code: 'store_unavailable' },
      { status: 503, headers: { 'Retry-After': '10', ...headers } },
    );
  }
  return null;
}
