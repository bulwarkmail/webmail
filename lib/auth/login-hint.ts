/**
 * The address someone already typed elsewhere: the desktop app's first screen, or a link
 * that names the account. The sign-in page starts with it and asks only for what's
 * missing; a browser sign-in passes it on as OIDC's login_hint.
 *
 * Only something shaped like an address: anything else is ignored, not shown.
 */
export function loginHintFrom(value: string | null | undefined): string {
  const hint = (value ?? '').trim();
  if (!hint || hint.length > 254) return '';
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f<>"]/.test(hint)) return '';
  return /^[^@]+@[^@]+\.[^@.]+$/.test(hint) ? hint : '';
}
