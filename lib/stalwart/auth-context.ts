import { cookies } from 'next/headers';
import { decryptPayload, decryptSession, encryptPayload, sessionAuthHeader } from '@/lib/auth/crypto';
import { isPastMaxAge, limitsEnforcedSince, maxSessionHoursFor, readSignInStamp } from '@/lib/auth/session-age';
import { sessionCookieName } from '@/lib/auth/session-cookie';
import { getCookieOptions } from '@/lib/oauth/cookie-config';
import { refreshTokenCookieName } from '@/lib/oauth/tokens';

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
  /**
   * When the session this credential belongs to signed in (ms), for the
   * organisation's maximum session length (lib/auth/session-age.ts). The
   * writer works it out from the slot's other cookies; whatever a caller
   * passes here is not used. Absent in contexts written before it was
   * recorded, and for a sign-in that has no recorded time itself: those
   * count from limitsEnforcedSince(), like the other cookies.
   */
  signedInAt?: number;
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
    && (candidate.accountName === undefined || typeof candidate.accountName === 'string')
    && (candidate.signedInAt === undefined || (typeof candidate.signedInAt === 'number' && Number.isFinite(candidate.signedInAt)));
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
  const { serverUrl, username, authHeader, accountName, signedInAt } = payload;
  return {
    serverUrl,
    username,
    authHeader,
    ...(accountName ? { accountName } : {}),
    ...(signedInAt !== undefined ? { signedInAt } : {}),
  };
}

/**
 * The account whose maximum session length applies to a context. An
 * impersonation login is `target%master`; the policy is the target's.
 */
function contextAccount(context: StalwartAuthContext): string {
  return (context.accountName ?? context.username).split('%', 1)[0];
}

/**
 * The slot's context, or null when there is none or its session has
 * outlived the organisation's maximum session length. A context past the
 * maximum is cleared. Every route that acts with the stored credential reads
 * it through this; without a maximum it is the plain read.
 */
export async function readCurrentStalwartAuthContext(
  cookieStore: CookieStore,
  slot: number,
): Promise<StalwartAuthContext | null> {
  const context = readStalwartAuthContextFromStore(cookieStore, slot);
  if (!context) return null;
  const maxHours = await maxSessionHoursFor(contextAccount(context));
  if (!maxHours) return context;
  if (!isPastMaxAge(context.signedInAt ?? await limitsEnforcedSince(), maxHours)) return context;
  clearStalwartAuthContextInStore(cookieStore, slot);
  return null;
}

/**
 * When the session a context is written for signed in, from the slot's
 * other cookies:
 * - a remembered sign-in (the slot's session cookie holds this credential):
 *   its sign-in time, so restoring it never starts a new session;
 * - a provider sign-in (a bearer credential beside the slot's refresh
 *   token): the time of the stamp that travels with that token;
 * - otherwise the credential was checked with the mail server just now
 *   (POST /api/auth/stalwart-context): a sign-in that starts now.
 * Undefined where that source has no time either (a cookie or token from
 * before sign-in times were recorded): the context then counts from
 * limitsEnforcedSince(), as the source does.
 */
function signedInAtFor(cookieStore: CookieStore, slot: number, context: StalwartAuthContext): number | undefined {
  const remembered = cookieStore.get(sessionCookieName(slot))?.value;
  const session = remembered ? decryptSession(remembered) : null;
  if (session && sessionAuthHeader(session) === context.authHeader) return session.signedInAt;
  if (context.authHeader.startsWith('Bearer ')) {
    const refreshToken = cookieStore.get(refreshTokenCookieName(slot))?.value;
    if (refreshToken) return readSignInStamp(cookieStore, slot, refreshToken)?.signedInAt;
  }
  return Date.now();
}

export function setStalwartAuthContextInStore(
  cookieStore: CookieStore,
  slot: number,
  context: StalwartAuthContext,
): void {
  const { signedInAt: _given, ...credential } = context;
  const signedInAt = signedInAtFor(cookieStore, slot, credential);
  cookieStore.set(
    stalwartAuthContextCookieName(slot),
    encryptPayload({ ...credential, ...(signedInAt !== undefined ? { signedInAt } : {}) }, 'session-context'),
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
