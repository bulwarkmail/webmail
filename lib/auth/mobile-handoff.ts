/**
 * The browser-login handoff to the Bulwark mobile app.
 *
 * The app opens `/login?mobile_redirect_uri=…&mobile_state=…` in the system
 * browser; once the user has signed in, the page navigates to that URI with
 * the credential material in the fragment. Two things bound what that page
 * will do with a user's password or tokens:
 *
 *  - The target is the app's one callback link, not any `bulwarkmobile://`
 *    URL a query string names. A custom scheme is claimable by any app on
 *    the device (RFC 8252 §8.4), so a narrower target is not proof of who
 *    receives it, but it is the one the app registers and nothing else.
 *  - The page never navigates on its own. It shows what is about to happen
 *    and lets the user confirm (components/auth/mobile-handoff-consent.tsx):
 *    a link that opens the webmail with these parameters otherwise reads
 *    exactly like the normal sign-in page and hands the typed password to
 *    whichever app owns the scheme.
 */
export const MOBILE_HANDOFF_REDIRECT_URI = 'bulwarkmobile://auth/callback';

/** The handoff target when `raw` is the app's callback link, else ''. */
export function mobileHandoffTarget(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  return trimmed === MOBILE_HANDOFF_REDIRECT_URI || trimmed === `${MOBILE_HANDOFF_REDIRECT_URI}/`
    ? MOBILE_HANDOFF_REDIRECT_URI
    : '';
}

/**
 * The desktop app's loopback listener (RFC 8252), the other kind of target. Only ever
 * with a code: unlike the phone's link, it has no older builds that take the sign-in in a
 * fragment, so without a valid challenge this isn't a hand-off at all. The code goes
 * nowhere but this computer, whichever port a link names, and it's worthless without the
 * verifier behind the challenge.
 */
const DESKTOP_TARGET = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})\/bulwark-desktop\/callback$/;

export function desktopHandoffTarget(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  const match = DESKTOP_TARGET.exec(raw.trim());
  return match && Number(match[1]) <= 65535 ? match[0] : '';
}

/** The port a desktop target names, for the question the page asks. */
export function desktopHandoffPort(target: string): string {
  return DESKTOP_TARGET.exec(target)?.[1] ?? '';
}

/** "Not now": ends the app's flow at its listener, so it isn't left waiting. No code in it. */
export function desktopHandoffDeclineUrl(target: string, state: string): string {
  return `${target}?${new URLSearchParams({ error: 'access_denied', state }).toString()}`;
}

/** Either kind of target, as the callback page reads it back. */
export function handoffTarget(raw: string | null | undefined): string {
  return mobileHandoffTarget(raw) || desktopHandoffTarget(raw);
}

/** The URL the browser hands to the app: the target plus the fragment. */
export function buildMobileHandoffUrl(target: string, fragment: Record<string, string>): string {
  return `${target}#${new URLSearchParams(fragment).toString()}`;
}

/**
 * App builds that send `mobile_code_challenge` (PKCE S256: the base64url
 * SHA-256 of a verifier only the app knows) get no credentials in the link.
 * The sign-in is parked on the server (lib/auth/handoff-store.ts) and the
 * link carries a one-time code the app redeems with its verifier at
 * /api/auth/handoff/redeem. Older builds send no challenge and keep getting
 * the fragment above. Contract: bulwarkmail.org/docs/development/mobile-handoff.
 */
export function isMobileCodeChallenge(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

/** The challenge when `raw` is a well-formed S256 challenge, else ''. */
export function mobileCodeChallenge(raw: string | null | undefined): string {
  return isMobileCodeChallenge(raw) ? raw : '';
}

/** The URL the browser hands to an app that sent a challenge: code and state only. */
export function buildMobileHandoffCodeUrl(target: string, code: string, state: string): string {
  return `${target}?${new URLSearchParams({ code, state }).toString()}`;
}

/**
 * What the login page does once the browser is signed in:
 *  - `handoff`: a mobile hand-off whose sign-in just happened here; show the
 *    consent for handing it to the app.
 *  - `stay`: a mobile hand-off opened by a browser that was already signed
 *    in. The app needs a sign-in of its own (the password flow hands back
 *    what the user types here), so keep the form. Opening the mailbox would
 *    strand the user inside the app's sign-in sheet with no way back.
 *  - `mailbox`: a normal sign-in; go to the mailbox.
 *  - `none`: add-account mode handles its own navigation.
 */
export function signedInLoginAction(opts: {
  isMobileHandoff: boolean;
  isAddAccountMode: boolean;
  hasHandoffPayload: boolean;
}): 'handoff' | 'stay' | 'mailbox' | 'none' {
  if (opts.isAddAccountMode) return 'none';
  if (opts.isMobileHandoff) return opts.hasHandoffPayload ? 'handoff' : 'stay';
  return 'mailbox';
}
