// The two notes in sessionStorage that keep the login page from redirecting
// to the identity provider on its own (auto-SSO). Both hold the time they
// were written and only count for a short while: the tab stays the same for
// hours, and a note that outlives its round trip turns auto-SSO off in that
// tab for good (#1819).

const SIGNED_OUT_KEY = 'signed_out';
const SSO_ATTEMPT_KEY = 'sso_attempted';

/**
 * How long a sign-out keeps the login page from signing straight back in:
 * long enough for the provider's logout page to send the user back, not so
 * long that a visit much later (from a portal the logout led to) skips it.
 */
export const SIGNED_OUT_WINDOW_MS = 2 * 60_000;

/**
 * How long after one automatic redirect the login page waits before the
 * next. A failed round trip comes back well within it, so the page stops
 * there instead of redirecting in a loop.
 */
export const SSO_ATTEMPT_WINDOW_MS = 30_000;

/** Whether a note written at the time `stored` holds is younger than `windowMs`. */
function isRecent(stored: string | null, windowMs: number, now: number): boolean {
  if (stored === null) return false;
  const at = Number(stored);
  if (!Number.isFinite(at)) return false;
  const age = now - at;
  return age >= 0 && age < windowMs;
}

/** Note that the user signed out on purpose (#905). */
export function markSignedOut(now = Date.now()): void {
  try {
    sessionStorage.setItem(SIGNED_OUT_KEY, String(now));
  } catch {
    // Only the login page's automatic redirect goes by it.
  }
}

/**
 * True once after the user signed out on purpose, within
 * SIGNED_OUT_WINDOW_MS. The login page then skips automatic SSO: it would
 * sign the user straight back in whenever the provider's session outlived
 * the sign-out (#905).
 */
export function consumeSignedOut(now = Date.now()): boolean {
  try {
    const stored = sessionStorage.getItem(SIGNED_OUT_KEY);
    sessionStorage.removeItem(SIGNED_OUT_KEY);
    return isRecent(stored, SIGNED_OUT_WINDOW_MS, now);
  } catch {
    return false;
  }
}

/**
 * Whether the login page may redirect to the provider now, noting the
 * attempt when it may: false while an earlier attempt from this tab is
 * younger than SSO_ATTEMPT_WINDOW_MS.
 */
export function claimAutoSsoAttempt(now = Date.now()): boolean {
  try {
    if (isRecent(sessionStorage.getItem(SSO_ATTEMPT_KEY), SSO_ATTEMPT_WINDOW_MS, now)) return false;
    sessionStorage.setItem(SSO_ATTEMPT_KEY, String(now));
  } catch {
    // sessionStorage unavailable
  }
  return true;
}
