"use client";

import { useEffect, useMemo, useRef } from "react";
import { useAuthStore } from "@/stores/auth-store";
import { useAccountStore } from "@/stores/account-store";
import { useEmailStore } from "@/stores/email-store";
import { reconcilePushBindings, releasePushBindings, type PushBinding } from "@/lib/push-bindings";
import { emitPushStateChange } from "@/lib/push-events";
import type { JMAPClient } from "@/lib/jmap/client";
import { debug } from "@/lib/debug";

/**
 * Push bindings for the whole app: one per CONNECTED client, kept for as long
 * as that client is connected, on every page. They used to live in the mail
 * view, so the calendar page never heard of changes (#1349). Surfaces
 * subscribe to the changes through lib/push-events.ts.
 *
 * We bind every connected login, not just the active one: background accounts
 * must drive the unified-section counters too. (#281 background push)
 *
 * The bindings are reconciled, not rebuilt. This effect re-runs each time a
 * login connects - once per account while a browser with many of them
 * restores - and tearing every binding down to set them all up again made
 * each run close and reopen the live streams and re-prime every slow poll:
 * with ten logins, 21 stream openings and ~180 state-poll methods in the
 * first seconds, quadratic in the number of accounts. Now a run binds only
 * the clients that are new, unbinds only the ones that are gone, and on an
 * account switch re-binds just the two whose role changed.
 */
export function PushBindingsHost() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const client = useAuthStore((s) => s.client);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  // Bumped when checkAuth finishes connecting background accounts after the UI
  // already unblocked - the effect below must re-run over them.
  const connectedAccountsRevision = useAuthStore((s) => s.connectedAccountsRevision);
  const accounts = useAccountStore((s) => s.accounts);
  const connectedAccountsSignature = useMemo(
    () => accounts.filter((a) => a.isConnected).map((a) => a.id).sort().join(","),
    [accounts],
  );
  const setPushConnected = useEmailStore((s) => s.setPushConnected);
  const bindingsRef = useRef(new Map<JMAPClient, PushBinding>());

  useEffect(() => {
    const bindings = bindingsRef.current;
    if (!isAuthenticated || !client) {
      releasePushBindings(bindings);
      setPushConnected(false);
      return;
    }
    reconcilePushBindings({
      bindings,
      clients: useAuthStore.getState().getAllConnectedClients(),
      activeAccountId,
      listen: (c, role) => c.onStateChange((change) => emitPushStateChange(change, c, role)),
      onError: (accId, error) => debug.log('push', '[Push] Failed to setup push notifications for account:', accId, error),
    });
    if (bindings.size > 0) {
      setPushConnected(true);
      debug.log('push', `[Push] Push notifications enabled for ${bindings.size} account(s)`);
    } else {
      setPushConnected(false);
    }
  }, [isAuthenticated, client, activeAccountId, connectedAccountsSignature, connectedAccountsRevision, setPushConnected]);

  // Unbind everything when the app goes away.
  useEffect(() => {
    const bindings = bindingsRef.current;
    return () => releasePushBindings(bindings);
  }, []);

  return null;
}
