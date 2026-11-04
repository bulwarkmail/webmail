"use client";

import { useEffect, useRef } from "react";
import { useAccountStore } from "@/stores/account-store";
import { useAuthStore } from "@/stores/auth-store";
import { invalidateUnifiedMailboxes, loadAccountMailboxes } from "@/stores/email-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useIsEmbedded } from "@/hooks/use-is-embedded";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import { changesAnyType, subscribePushStateChanges } from "@/lib/push-events";

/**
 * Keeps `useEmailStore.accountMailboxes` populated with one entry per
 * connected account while the Pro shell is the active interface. The Pro
 * sidebar reads this cache to render a Thunderbird-style per-account folder
 * tree (see [[project_pro_mode]]). Outside Pro the cache stays empty.
 *
 * Every layout needs the same cache once a second account is connected: the
 * account switcher puts the unread waiting in each account next to that
 * address, and the app badge and the desktop tray count every account's
 * inbox, while the active login's folder list knows nothing about the others.
 * With one account there is nothing to compare, and nothing is fetched.
 *
 * A background login's push says when its counts moved; its list is then read
 * again (one Mailbox/get), a moment later so a burst of changes costs one.
 *
 * Each login is loaded once per client, not once per connection: while a
 * browser restores its logins they connect one after another, and reloading
 * every connected account on each connection cost 1 + 2 + … + N folder lists
 * - 55 of them with ten logins. Pushes keep the lists current from there (see
 * invalidateUnifiedMailboxes); an account switch reloads them all once, as a
 * user moving between mailboxes expects fresh counters. Adding or removing an
 * account in another tab is still reflected without a reload.
 */
export function useProMultiAccountMailboxes(): void {
  const isEmbedded = useIsEmbedded();
  const proInterface = useSettingsStore((s) => s.proInterface);
  // The ids of the connected logins, as one string: `accounts` itself changes
  // for display-name and login-time updates that call for no fetch at all.
  const connectedSignature = useAccountStore((s) =>
    s.accounts.filter((a) => a.isConnected).map((a) => a.id).sort().join("\n"),
  );
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const loaded = useRef(new Map<string, IJMAPClient>());
  const lastActive = useRef<string | null>(null);

  useEffect(() => {
    const connected = connectedSignature ? connectedSignature.split("\n") : [];
    if (!proInterface && !isEmbedded && connected.length < 2) return;
    if (connected.length === 0) return;
    // The Pro sidebar lists each login's shared mailboxes under it (#1486);
    // the account switcher and the badge only count the login's own unread.
    const withShared = proInterface || isEmbedded;

    if (lastActive.current !== null && lastActive.current !== activeAccountId) {
      invalidateUnifiedMailboxes();
      loaded.current.clear();
    }
    lastActive.current = activeAccountId;

    const getClientForAccount = useAuthStore.getState().getClientForAccount;
    for (const id of [...loaded.current.keys()]) {
      if (!connected.includes(id)) loaded.current.delete(id);
    }
    for (const id of connected) {
      const client = getClientForAccount(id);
      if (!client || loaded.current.get(id) === client) continue;
      loaded.current.set(id, client);
      void loadAccountMailboxes(client, id, { withShared }).then((ok) => {
        // Try a failed login again on the next run, as the identities hook does.
        if (!ok && loaded.current.get(id) === client) loaded.current.delete(id);
      });
    }
  }, [proInterface, isEmbedded, connectedSignature, activeAccountId]);

  // The active login's counts live in `mailboxes` and follow its push there.
  // A background login's change re-reads its list. The mail view's own push
  // handler (createMailPushListener) drops that login's cached list on the
  // push itself, so this is a fetch, or nothing when the all-accounts views
  // have already read and published the list again.
  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const stop = subscribePushStateChanges((change, client, role) => {
      if (role === "active" || !changesAnyType(change, ["Mailbox", "Email"])) return;
      const id = [...loaded.current].find(([, c]) => c === client)?.[0];
      if (!id || timers.has(id)) return;
      timers.set(id, setTimeout(() => {
        timers.delete(id);
        if (loaded.current.get(id) !== client) return;
        const withShared = useSettingsStore.getState().proInterface || isEmbedded;
        void loadAccountMailboxes(client, id, { withShared });
      }, BACKGROUND_REFRESH_DELAY_MS));
    });
    return () => {
      stop();
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [isEmbedded]);
}

/** How long a background login's changes are gathered before its folders are read again. */
const BACKGROUND_REFRESH_DELAY_MS = 1500;
