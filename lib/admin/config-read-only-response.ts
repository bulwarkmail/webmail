import { NextResponse } from 'next/server';
import { isStoreUnavailableError } from '@/lib/shared-store';

/**
 * The answer an admin or setup route gives when a config write failed for
 * a reason the admin should see, or null for any other error, which the
 * route keeps reporting as a 500:
 *
 * - 409 when the write hit ADMIN_CONFIG_READONLY, carrying the
 *   ConfigReadOnlyError message so the panel can show why nothing was
 *   saved (#1249).
 * - 503 with Retry-After when the shared store can't be reached (#1066):
 *   nothing was saved, and trying again in a moment may work.
 *
 * By the error's name, not instanceof: the config manager on globalThis
 * comes from another bundle's copy of lib/admin/paths.ts (the
 * instrumentation creates it), whose ConfigReadOnlyError is a different
 * class, and a read-only refusal then answered 500.
 */
export function configWriteErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof Error && error.name === 'ConfigReadOnlyError') {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  if (isStoreUnavailableError(error)) {
    return NextResponse.json(
      { error: 'Nothing was saved: the shared store can\'t be reached right now. Try again in a moment.' },
      { status: 503, headers: { 'Retry-After': '10' } },
    );
  }
  return null;
}

/** The same as configWriteErrorResponse; the name the admin routes use. */
export const configReadOnlyResponse = configWriteErrorResponse;
