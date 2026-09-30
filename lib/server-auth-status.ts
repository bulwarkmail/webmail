/**
 * Why the server holds no usable sign-in context for this browser.
 *
 * Sign-in runs in the browser, but server-side helpers such as the calendar
 * feed proxy (/api/fetch-ical) need the context cookie that
 * /api/auth/stalwart-context mints after checking the credential against the
 * mail server. When that check fails (the server cannot reach or trust the
 * mail server) or the browser drops the cookie (Secure cookie over http),
 * those helpers can only answer "Not authenticated" (#1073). The auth store
 * records the reason here so the 401 can be explained where it surfaces.
 */
let issue: string | null = null;

export function setServerAuthIssue(reason: string | null): void {
  issue = reason;
}

export function getServerAuthIssue(): string | null {
  return issue;
}

/**
 * Error text for a failed response from a cookie-gated route: the recorded
 * reason when the route answered 401, otherwise the route's own message.
 */
export function explainServerAuthError(status: number, error: string | undefined, fallback: string): string {
  const message = error || fallback;
  if (status !== 401 || !issue) return message;
  return `${message}: ${issue}`;
}
