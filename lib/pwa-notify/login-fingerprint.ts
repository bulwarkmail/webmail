/**
 * Names a login (server and user) in a notification's data, without naming
 * either. A cookie slot goes to whoever signs in next, and JMAP account ids
 * repeat across servers, so neither says that an action on a notification
 * from yesterday still means the same mailbox.
 *
 * Runs in the page and on the server: both ends compare the result.
 */
function canonicalServerUrl(serverUrl: string): string {
  // The registry keeps what the user typed, the cookie what the login route
  // normalised: `https://Mail.Example.org:443/` and `https://mail.example.org`
  // are the same server.
  try {
    const url = new URL(serverUrl);
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    return serverUrl.replace(/\/+$/, '');
  }
}

export async function loginFingerprint(serverUrl: string, username: string | undefined): Promise<string> {
  const text = `${canonicalServerUrl(serverUrl)}\n${(username ?? '').trim().toLowerCase()}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest).slice(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
