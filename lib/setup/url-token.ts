/**
 * The setup link printed at startup carries the token in the fragment
 * (`/setup#token=...`): a fragment never reaches the server, a reverse
 * proxy's access log or a Referer. Older logs printed `?token=`, which is
 * still accepted. Either way the token is removed from the address bar (and
 * so from history) as soon as it is read.
 */
export function takeSetupTokenFromUrl(
  location: Pick<Location, 'hash' | 'search' | 'pathname'>,
  history: Pick<History, 'replaceState' | 'state'>,
): string {
  const fromHash = new URLSearchParams(location.hash.replace(/^#/, '')).get('token');
  const search = new URLSearchParams(location.search);
  const fromQuery = search.get('token');
  if (fromHash === null && fromQuery === null) return '';

  search.delete('token');
  const rest = search.toString();
  history.replaceState(history.state, '', location.pathname + (rest ? `?${rest}` : ''));
  return (fromHash ?? fromQuery ?? '').trim();
}
