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

/**
 * The server an account signed in here uses for this domain, so a second address there
 * goes to the same one without a lookup (the lookup can't find many own servers).
 */
export function serverOfSignedInDomain(accounts: ReadonlyArray<{ username: string; email?: string; serverUrl: string }>, domain: string): string | null {
  const wanted = domain.trim().toLowerCase();
  if (!wanted) return null;
  for (const account of accounts) {
    for (const address of [account.email, account.username]) {
      const at = address?.lastIndexOf('@') ?? -1;
      if (address && at > 0 && address.slice(at + 1).trim().toLowerCase() === wanted && account.serverUrl) return account.serverUrl;
    }
  }
  return null;
}
