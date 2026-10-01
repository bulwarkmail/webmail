/**
 * Reconciles live push bindings with the set of connected logins.
 *
 * Every connected login keeps one binding - its state-change callback plus its
 * live stream or slow poll - for as long as it stays connected. The effect
 * that drives this re-runs each time a login connects, which while a browser
 * with many logins restores means once per account; rebuilding every binding
 * on each run closed and reopened the streams and re-primed every poll, so the
 * cost grew with the square of the number of accounts. Reconciling touches only
 * what changed: new clients are bound, departed ones unbound, and an account
 * switch re-binds just the two logins whose role flipped.
 */

export type PushRole = 'active' | 'background';

/** The slice of a JMAP client a binding needs. */
export interface PushBindable {
  setupPushNotifications(): unknown;
  closePushNotifications(): void;
  hasSSEStream(): boolean;
}

export interface PushBinding {
  accountId: string;
  role: PushRole;
}

export interface ReconcileOptions<C extends PushBindable> {
  /** Current bindings, updated in place. */
  bindings: Map<C, PushBinding>;
  /** Connected logins: account id → client. */
  clients: Map<string, C>;
  activeAccountId: string | null;
  /**
   * Installs the state-change callback for a role. Must be callable again on
   * an already-bound client: it replaces the previous callback.
   */
  listen: (client: C, role: PushRole) => void;
  onError?: (accountId: string, error: unknown) => void;
}

export function reconcilePushBindings<C extends PushBindable>({
  bindings, clients, activeAccountId, listen, onError,
}: ReconcileOptions<C>): void {
  const wanted = new Map<C, string>();
  for (const [accountId, client] of clients) wanted.set(client, accountId);

  const unbind = (client: C) => {
    try { client.closePushNotifications(); } catch { /* already closed */ }
    bindings.delete(client);
  };
  const bind = (client: C, accountId: string, role: PushRole) => {
    try {
      listen(client, role);
      client.setupPushNotifications();
      bindings.set(client, { accountId, role });
    } catch (error) {
      onError?.(accountId, error);
    }
  };

  // Gone: signed out, or replaced by a fresh client for the same login.
  for (const [client, binding] of [...bindings]) {
    if (wanted.get(client) !== binding.accountId) unbind(client);
  }

  // The active login first: live streams are capped per tab (#702) and handed
  // out in setup order, so the account on screen must claim one before the
  // background logins do.
  const ordered = [...clients.entries()].sort(([a], [b]) =>
    (a === activeAccountId ? 0 : 1) - (b === activeAccountId ? 0 : 1),
  );
  const demoted: Array<[C, string]> = [];
  for (const [accountId, client] of ordered) {
    const role: PushRole = accountId === activeAccountId ? 'active' : 'background';
    const bound = bindings.get(client);
    if (!bound) {
      bind(client, accountId, role);
    } else if (bound.role !== role) {
      if (role === 'active' && !client.hasSSEStream()) {
        // Newly active on a slow poll: take the stream from the login that
        // just stopped being active - re-bound as background below - so the
        // account the user is looking at still updates live.
        for (const [other, b] of [...bindings]) {
          if (b.role === 'active' && other !== client) {
            unbind(other);
            demoted.push([other, b.accountId]);
          }
        }
        unbind(client);
        bind(client, accountId, role);
      } else {
        listen(client, role);
        bound.role = role;
      }
    }
  }
  for (const [client, accountId] of demoted) {
    if (wanted.get(client) === accountId && !bindings.has(client)) bind(client, accountId, 'background');
  }
}

/** Unbinds everything, e.g. on logout or when the mail app unmounts. */
export function releasePushBindings<C extends PushBindable>(bindings: Map<C, PushBinding>): void {
  for (const client of bindings.keys()) {
    try { client.closePushNotifications(); } catch { /* already closed */ }
  }
  bindings.clear();
}
