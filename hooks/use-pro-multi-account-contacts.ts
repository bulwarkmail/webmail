"use client";

import { useEffect, useMemo } from "react";
import { useAccountStore } from "@/stores/account-store";
import { useAuthStore } from "@/stores/auth-store";
import { useContactStore, type ContactAccountClient } from "@/stores/contact-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useIsEmbedded } from "@/hooks/use-is-embedded";

/**
 * Pro-shell counterpart to [[useProMultiAccountCalendars]] - aggregates
 * contacts and address books from every connected JMAP account so the
 * contacts sidebar lists them all, grouped by local account.
 */
export function useProMultiAccountContacts(): {
  enabled: boolean;
  accountClients: ContactAccountClient[];
} {
  const isEmbedded = useIsEmbedded();
  const proInterface = useSettingsStore((s) => s.proInterface);
  const accounts = useAccountStore((s) => s.accounts);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  const fetchAllAccountsAddressBooks = useContactStore((s) => s.fetchAllAccountsAddressBooks);
  const fetchAllAccountsContacts = useContactStore((s) => s.fetchAllAccountsContacts);

  const enabled = proInterface || isEmbedded;

  const accountClients = useMemo(() => {
    if (!enabled) return [];
    const getClientForAccount = useAuthStore.getState().getClientForAccount;
    const pairs: ContactAccountClient[] = [];
    for (const account of accounts) {
      if (!account.isConnected) continue;
      const client = getClientForAccount(account.id);
      if (!client || !client.supportsContacts()) continue;
      pairs.push({ localAccountId: account.id, client });
    }
    return pairs;
  }, [enabled, accounts]);

  useEffect(() => {
    if (!enabled || !activeAccountId || accountClients.length === 0) return;
    void fetchAllAccountsAddressBooks(accountClients);
    void fetchAllAccountsContacts(accountClients);
  }, [enabled, activeAccountId, accountClients, fetchAllAccountsAddressBooks, fetchAllAccountsContacts]);

  return { enabled, accountClients };
}
