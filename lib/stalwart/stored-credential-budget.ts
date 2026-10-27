import { createHash } from 'node:crypto';

/**
 * Failure budget for the credentials the context cookies hold (extends
 * GHSA-g6c7).
 *
 * The cookie-authed routes (JMAP passthrough, WebDAV, calendar agenda, push
 * previews, WOPI, ...) replay the stored credential to the mail server on
 * every call. Once it is stale (password changed, app password revoked) each
 * call is a failed login from this server's address, and enough of them get
 * the webmail banned by Stalwart's fail2ban, locking out every user. So:
 *
 *  - a credential the mail server refused is refused here for an hour,
 *    without asking the server again;
 *  - past GLOBAL_MAX_FAILURES refusals in a window (several stale app
 *    passwords would each get their own hour), only credentials that worked
 *    within the window still go upstream until the window ends.
 *
 * Only Basic credentials count: Stalwart does not count an expired or unknown
 * access token as a failed login, and access tokens expire all the time.
 */

const REFUSE_MS = 60 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const GLOBAL_MAX_FAILURES = 20;
const MAX_TRACKED = 10_000;

/** Credential key -> time until which it is refused. */
const refused = new Map<string, number>();
/** Credential key -> time it last got a successful answer. */
const succeeded = new Map<string, number>();
let failureWindow = { failures: 0, resetAt: 0 };

function keyOf(authHeader: string): string | null {
  if (!/^basic /i.test(authHeader)) return null;
  return createHash('sha256').update(authHeader).digest('base64url');
}

function currentWindow(now: number) {
  if (failureWindow.resetAt <= now) failureWindow = { failures: 0, resetAt: now + WINDOW_MS };
  return failureWindow;
}

function remember(map: Map<string, number>, key: string, value: number): void {
  map.delete(key);
  // Insertion order is age order: drop the oldest when full.
  if (map.size >= MAX_TRACKED) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

/** True when `authHeader` must not be sent to the mail server right now. */
export function isStoredCredentialRefused(authHeader: string, now: number = Date.now()): boolean {
  const key = keyOf(authHeader);
  if (!key) return false;
  const until = refused.get(key);
  if (until !== undefined) {
    if (until > now) return true;
    refused.delete(key);
  }
  if (currentWindow(now).failures < GLOBAL_MAX_FAILURES) return false;
  const lastSuccess = succeeded.get(key);
  return lastSuccess === undefined || now - lastSuccess > WINDOW_MS;
}

/** Record the mail server's answer to a request that carried `authHeader`. */
export function recordStoredCredentialStatus(authHeader: string, status: number, now: number = Date.now()): void {
  const key = keyOf(authHeader);
  if (!key) return;
  if (status === 401) {
    succeeded.delete(key);
    remember(refused, key, now + REFUSE_MS);
    currentWindow(now).failures++;
  } else if (status >= 200 && status < 400) {
    refused.delete(key);
    remember(succeeded, key, now);
  }
}

/** The answer a refused credential gets instead of an upstream request. */
export function refusedCredentialResponse(): Response {
  return Response.json({ error: 'Authentication failed', reason: 'credential_refused' }, { status: 401 });
}

export function resetStoredCredentialBudgetForTests(): void {
  refused.clear();
  succeeded.clear();
  failureWindow = { failures: 0, resetAt: 0 };
}
