/**
 * The server refused this account's refresh token for good. Nothing wipes on
 * this yet: a refused account is dropped, and its local data stays for the next
 * sign-in. HOOK: the wipe work (lib/store/wipe) registers here to act on a
 * permanent rejection. Free of the stores, so the auth store can call it.
 */

type Listener = (accountId: string) => void;

const listeners = new Set<Listener>();

export function onCredentialsRejected(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function noteCredentialsRejected(accountId: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(accountId);
    } catch {
      // A sign-out must go on whatever a listener does.
    }
  }
}
