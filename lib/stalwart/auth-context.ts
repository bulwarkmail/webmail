import { cookies } from 'next/headers';
import { decryptPayload, encryptPayload } from '@/lib/auth/crypto';
import { getCookieOptions } from '@/lib/oauth/cookie-config';

const STALWART_AUTH_CONTEXT_COOKIE = 'jmap_stalwart_ctx';

export interface StalwartAuthContext {
  serverUrl: string;
  username: string;
  authHeader: string;
  /**
   * The account the credential belongs to, when it differs from the login
   * name the client claimed (see ResolvedJmapIdentity.accountName). Per-user
   * data such as synced settings is keyed on this.
   */
  accountName?: string;
}

type CookieStore = Awaited<ReturnType<typeof cookies>>;

export function stalwartAuthContextCookieName(slot: number): string {
  return slot === 0 ? STALWART_AUTH_CONTEXT_COOKIE : `${STALWART_AUTH_CONTEXT_COOKIE}_${slot}`;
}

function isValidContext(payload: unknown): payload is StalwartAuthContext {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const candidate = payload as Record<string, unknown>;
  // A session context is exactly these three strings. The envelope purpose
  // already keeps blobs minted elsewhere out; rejecting the markers those
  // blobs carry is the second lock, so an office editor token or a pairing
  // proof cannot be read back as a signed-in session even if it reaches this
  // function by some other route (GHSA-cqqx-mjcf-mh55).
  if (candidate.t !== undefined || candidate.purpose !== undefined) {
    return false;
  }
  return typeof candidate.serverUrl === 'string'
    && typeof candidate.username === 'string'
    && typeof candidate.authHeader === 'string'
    && (candidate.accountName === undefined || typeof candidate.accountName === 'string');
}

function getSessionCookieOptions() {
  const { maxAge: _maxAge, ...cookieOptions } = getCookieOptions();
  return cookieOptions;
}

export function readStalwartAuthContextFromStore(
  cookieStore: CookieStore,
  slot: number,
): StalwartAuthContext | null {
  const token = cookieStore.get(stalwartAuthContextCookieName(slot))?.value;
  if (!token) return null;

  const payload = decryptPayload(token, 'session-context');
  if (!isValidContext(payload)) return null;

  // Hand back exactly the declared shape: the envelope's own bookkeeping
  // stays in the envelope rather than riding along into the credentials.
  const { serverUrl, username, authHeader, accountName } = payload;
  return accountName ? { serverUrl, username, authHeader, accountName } : { serverUrl, username, authHeader };
}

export async function readStalwartAuthContext(slot: number): Promise<StalwartAuthContext | null> {
  const cookieStore = await cookies();
  return readStalwartAuthContextFromStore(cookieStore, slot);
}

export function setStalwartAuthContextInStore(
  cookieStore: CookieStore,
  slot: number,
  context: StalwartAuthContext,
): void {
  cookieStore.set(
    stalwartAuthContextCookieName(slot),
    encryptPayload(context as unknown as Record<string, unknown>, 'session-context'),
    getSessionCookieOptions(),
  );
}

export async function setStalwartAuthContext(slot: number, context: StalwartAuthContext): Promise<void> {
  const cookieStore = await cookies();
  setStalwartAuthContextInStore(cookieStore, slot, context);
}

export function clearStalwartAuthContextInStore(cookieStore: CookieStore, slot: number): void {
  cookieStore.delete(stalwartAuthContextCookieName(slot));
}

export async function clearStalwartAuthContext(slot: number): Promise<void> {
  const cookieStore = await cookies();
  clearStalwartAuthContextInStore(cookieStore, slot);
}