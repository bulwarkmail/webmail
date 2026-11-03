/**
 * The key the sign-in routes budget failures on, in the desktop build.
 *
 * There's one client on the embedded server, so a client key would make every
 * account on the machine share five failures per 15 minutes: a stale password
 * on one server would lock sign-in on the others. What the budget protects is
 * the mail server's failure allowance for this address, so it counts per
 * server. The value is no IP address, so forwardedClientHeaders passes nothing
 * upstream.
 */
export function desktopLoginBudgetKey(serverUrl: unknown): string {
  try {
    return `server:${new URL(String(serverUrl)).origin}`;
  } catch {
    return 'server:invalid';
  }
}
