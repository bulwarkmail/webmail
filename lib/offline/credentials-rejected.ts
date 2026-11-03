/**
 * The server refused this login: `invalid_grant`, a lasting 401 after a fresh try
 * (both `certain`), or a 401 at a connect that then failed (not, it's one answer).
 * The auth store follows with a sign-out that hides the account's data, which
 * waits for the new password. The organisation's session limit, an outage or any
 * other refusal doesn't come here. lib/offline/device-wipe.ts listens, to keep the
 * count for the sign-in page and to delete at once where the organisation asks for
 * that. Free of the stores, so the auth store can call it.
 */

type Listener = (accountId: string, certain: boolean) => void;

const listeners = new Set<Listener>();

export function onCredentialsRejected(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function noteCredentialsRejected(accountId: string, certain = true): void {
  for (const listener of [...listeners]) {
    try {
      listener(accountId, certain);
    } catch {
      // A sign-out must go on whatever a listener does.
    }
  }
}
