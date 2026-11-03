/**
 * The server really refused this login (`invalid_grant`), which the auth store
 * follows with a sign-out that wipes the account's local data. An outage or any
 * other refusal doesn't come here, and keeps the data. HOOK: lib/store/wipe
 * registers here for what else a permanent rejection should do. Free of the
 * stores, so the auth store can call it.
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
