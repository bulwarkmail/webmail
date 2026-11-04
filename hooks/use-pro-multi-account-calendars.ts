"use client";

import { useEffect, useMemo, useRef } from "react";
import { useAccountStore } from "@/stores/account-store";
import { useAuthStore } from "@/stores/auth-store";
import { useCalendarStore, type CalendarAccountClient } from "@/stores/calendar-store";
import { useTaskStore } from "@/stores/task-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useIsEmbedded } from "@/hooks/use-is-embedded";

/**
 * Aggregate calendars from every connected account so the calendar sidebar
 * lists them all, grouped by account, and the grid shows the ticked ones
 * together: in the Pro shell (as [[use-pro-multi-account-mailboxes]] does
 * for mail folders), and in the standard interface once two or more
 * logins with calendars are signed in (pim-12).
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

  const connected = useMemo(() => {
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
  }, [accounts]);

  const enabled = proInterface || isEmbedded || connected.length > 1;
  const accountClients = useMemo(() => (enabled ? connected : []), [enabled, connected]);

  // The stores route their own loads (a push, a refresh) and each task
  // change through the logins while several are shown. Going back to one
  // login reloads it with plain ids.
  const wasAggregated = useRef(false);
  useEffect(() => {
    const aggregated = enabled && accountClients.length > 0;
    useCalendarStore.getState().setAccountClients(aggregated ? accountClients : null, activeAccountId);
    useTaskStore.getState().setAccountClients(aggregated ? accountClients : null, useAuthStore.getState().client);
    if (!aggregated && wasAggregated.current) {
      const client = useAuthStore.getState().client;
      const calendarStore = useCalendarStore.getState();
      if (client) {
        void calendarStore.fetchCalendars(client);
        if (calendarStore.dateRange) void calendarStore.fetchEvents(client, calendarStore.dateRange.start, calendarStore.dateRange.end);
      }
    }
    wasAggregated.current = aggregated;
  }, [enabled, accountClients, activeAccountId]);

  // Fetch calendars whenever the set of connected calendar-capable accounts
  // changes. Skips when there isn't an active account yet (auth still
  // bootstrapping).
  useEffect(() => {
    if (!enabled || !activeAccountId || accountClients.length === 0) return;
    void fetchAllAccountsCalendars(accountClients, activeAccountId);
  }, [enabled, activeAccountId, accountClients, fetchAllAccountsCalendars]);

  // Fetch events for the current visible date range across all accounts.
  useEffect(() => {
    if (!enabled || !activeAccountId || accountClients.length === 0) return;
    if (!start || !end) return;
    void fetchAllAccountsEvents(accountClients, start, end);
  }, [enabled, activeAccountId, accountClients, start, end, fetchAllAccountsEvents]);

  return { enabled, accountClients };
}
