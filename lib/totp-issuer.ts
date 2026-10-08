// The issuer is what the authenticator app lists the entry under. A branded
// deployment (APP_NAME) uses its own name; a stock install has the default
// "Webmail", which says nothing in a list of entries, so it keeps naming the
// account's server. (#1160)
export function totpIssuer(appName: string | undefined | null): string {
  const name = appName?.trim();
  return name && name !== 'Webmail' ? name : 'Stalwart';
}
