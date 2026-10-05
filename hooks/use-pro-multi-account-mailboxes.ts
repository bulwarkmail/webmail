"use client";

import { useEffect, useRef } from "react";
import { useAccountStore } from "@/stores/account-store";
import { useAuthStore } from "@/stores/auth-store";
import { invalidateUnifiedMailboxes, loadAccountMailboxes } from "@/stores/email-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useIsEmbedded } from "@/hooks/use-is-embedded";
import type { IJMAPClient } from "@/lib/jmap/client-interface";

/**
 * Keeps `useEmailStore.accountMailboxes` populated with one entry per
 * connected account while the Pro shell is the active interface. The Pro
 * sidebar reads this cache to render a Thunderbird-style per-account folder
 * tree (see [[project_pro_mode]]). Outside Pro the cache stays empty.
 *
 * Mountain View needs the same cache for a different reason: its account
 * popover puts the unread waiting in each account next to that address, and
 * the active login's folder list knows nothing about the others. It is only
 * worth the extra round trips once a second account is connected - with one
 * account the popover has nothing to compare.
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
  const mountainView = useSettingsStore((s) => s.interfaceLayout === "mountain-view");
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
    if (!proInterface && !isEmbedded && !(mountainView && connected.length > 1)) return;
    if (connected.length === 0) return;

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
      void loadAccountMailboxes(client, id).then((ok) => {
        // Try a failed login again on the next run, as the identities hook does.
        if (!ok && loaded.current.get(id) === client) loaded.current.delete(id);
      });
    }
  }, [proInterface, isEmbedded, mountainView, connectedSignature, activeAccountId]);
}
