"use client";

import { useEffect, useMemo } from "react";
import { useAccountStore } from "@/stores/account-store";
import { useAuthStore } from "@/stores/auth-store";
import { useCalendarStore, type CalendarAccountClient } from "@/stores/calendar-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useIsEmbedded } from "@/hooks/use-is-embedded";

/**
 * When the Pro shell is the active interface, aggregate calendars from
 * every connected account so the calendar sidebar lists them all - the
 * same way [[use-pro-multi-account-mailboxes]] does for mail folders.
 *
 * Returns the resolved list of `{ localAccountId, client }` pairs so the
 * caller (calendar page) can fetch events the same way without
 * re-deriving the set.
 */
export function useProMultiAccountCalendars(start: string | null, end: string | null): {
  enabled: boolean;
  accountClients: CalendarAccountClient[];
} {
  const isEmbedded = useIsEmbedded();
  const proInterface = useSettingsStore((s) => s.proInterface);
  const accounts = useAccountStore((s) => s.accounts);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  const fetchAllAccountsCalendars = useCalendarStore((s) => s.fetchAllAccountsCalendars);
  const fetchAllAccountsEvents = useCalendarStore((s) => s.fetchAllAccountsEvents);

  const enabled = proInterface || isEmbedded;

  const accountClients = useMemo(() => {
    if (!enabled) return [];
    const getClientForAccount = useAuthStore.getState().getClientForAccount;
    const pairs: CalendarAccountClient[] = [];
    for (const account of accounts) {
      if (!account.isConnected) continue;
      const client = getClientForAccount(account.id);
      if (!client || !client.supportsCalendars()) continue;
      pairs.push({ localAccountId: account.id, client });
    }
    return pairs;
    // accounts identity changes whenever the connected set or login states
    // change, so this is the only dependency we need.
  }, [enabled, accounts]);

  // Fetch calendars whenever the set of connected calendar-capable accounts
  // changes. Skips when there isn't an active account yet (auth still
  // bootstrapping).
  useEffect(() => {
    if (!enabled || !activeAccountId || accountClients.length === 0) return;
    void fetchAllAccountsCalendars(accountClients);
  }, [enabled, activeAccountId, accountClients, fetchAllAccountsCalendars]);

  // Fetch events for the current visible date range across all accounts.
  useEffect(() => {
    if (!enabled || !activeAccountId || accountClients.length === 0) return;
    if (!start || !end) return;
    void fetchAllAccountsEvents(accountClients, start, end);
  }, [enabled, activeAccountId, accountClients, start, end, fetchAllAccountsEvents]);

  return { enabled, accountClients };
}
