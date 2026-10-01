"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAccountStore } from "@/stores/account-store";
import { useAuthStore } from "@/stores/auth-store";
import { useIdentityStore } from "@/stores/identity-store";
import type { Identity } from "@/lib/jmap/types";

interface AccountIdentityGroup {
  localAccountId: string;
  accountLabel: string;
  identities: Identity[];
}

const CROSS_ACCOUNT_IDENTITY_DELIMITER = '::';

// Identities last fetched per non-active account, shared by every mounted
// instance. mail-app keeps one mounted, so a composer opened later starts with
// the other accounts' identities instead of a round-trip behind: reply-all
// leaves our own addresses out based on its first render (#1104). Each mount
// still refetches.
const remoteIdentityCache = new Map<string, Identity[]>();

/** Every non-active account's identities fetched so far (raw ids). */
export function cachedRemoteIdentities(): Identity[] {
  return [...remoteIdentityCache.values()].flat();
}

/** Cross-account identity IDs are namespaced to avoid collisions between JMAP
 * servers that happen to issue the same opaque ID. EVERY aggregated account is
 * namespaced (including the active one) so an id doesn't change form when the
 * active account changes; consumers resolve the raw id via
 * stripCrossAccountIdentityPrefix. Single-account mode (hook disabled) uses the
 * identity store's raw ids directly.
 */
export function isCrossAccountIdentityId(id: string): boolean {
  return id.includes(CROSS_ACCOUNT_IDENTITY_DELIMITER);
}

export function stripCrossAccountIdentityPrefix(id: string): { localAccountId: string | null; rawId: string } {
  const idx = id.indexOf(CROSS_ACCOUNT_IDENTITY_DELIMITER);
  if (idx < 0) return { localAccountId: null, rawId: id };
  return {
    localAccountId: id.slice(0, idx),
    rawId: id.slice(idx + CROSS_ACCOUNT_IDENTITY_DELIMITER.length),
  };
}

/**
 * Load identities from every connected account and group them by local
 * account so the composer's From dropdown can render an <optgroup> per
 * account - mirrors [[useProMultiAccountCalendars]] and
 * [[useProMultiAccountContacts]].
 *
 * Not limited to the Pro shell: the standard shell opens other accounts'
 * messages too (Unified Inbox, a non-active account's folders), and a reply
 * can only default to the receiving account's identity if that identity is in
 * the list (#1104).
 *
 * With a single connected account the hook returns `enabled: false` and the
 * caller falls back to the active account's identities from
 * [[useIdentityStore]].
 */
export function useProMultiAccountIdentities(): {
  enabled: boolean;
  groups: AccountIdentityGroup[];
  /** Flat list across all accounts, useful for lookup-by-id. */
  allIdentities: Identity[];
} {
  const accounts = useAccountStore((s) => s.accounts);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  const activeIdentities = useIdentityStore((s) => s.identities);

  const enabled = accounts.filter(a => a.isConnected).length > 1;

  const [remoteIdentities, setRemoteIdentities] = useState<Record<string, Identity[]>>(
    () => Object.fromEntries(remoteIdentityCache),
  );

  // Cache identities fetched per non-active account. Active account's
  // identities come live from useIdentityStore so signature/alias edits
  // there are reflected immediately without an extra round-trip.
  //
  // Each mount fetches each account once. Keyed on the set of connected
  // logins, not on `accounts`: while a browser restores its logins they
  // connect one after another, and refetching every account on each
  // connection cost 1 + 2 + … + N identity reads - 45 with ten logins.
  const connectedSignature = useAccountStore((s) =>
    s.accounts.filter((a) => a.isConnected).map((a) => a.id).sort().join("\n"),
  );
  const fetchedThisMount = useRef(new Map<string, unknown>());
  // Read at run time: the effect is keyed on the connected set, not on every
  // rewrite of `accounts`.
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;
  // A read outlives the run that started it - the effect re-runs on every
  // connection - so its result is dropped only once the hook is gone.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!enabled) {
      setRemoteIdentities({});
      return;
    }
    const current = accountsRef.current;
    for (const id of remoteIdentityCache.keys()) {
      if (!current.some((a) => a.id === id)) remoteIdentityCache.delete(id);
    }
    const wanted = current.filter((a) => a.isConnected && a.id !== activeAccountId);
    const wantedIds = new Set(wanted.map((a) => a.id));
    const keepWanted = (record: Record<string, Identity[]>) =>
      Object.fromEntries(Object.entries(record).filter(([id]) => wantedIds.has(id)));
    // What is already known shows at once; only the logins not yet read by
    // this mount - or whose client was replaced - are fetched.
    setRemoteIdentities((prev) => ({
      ...keepWanted(prev),
      ...Object.fromEntries(wanted.flatMap((a) => {
        const cached = remoteIdentityCache.get(a.id);
        return cached ? [[a.id, cached]] : [];
      })),
    }));
    const getClientForAccount = useAuthStore.getState().getClientForAccount;
    for (const account of wanted) {
      const client = getClientForAccount(account.id);
      if (!client || fetchedThisMount.current.get(account.id) === client) continue;
      fetchedThisMount.current.set(account.id, client);
      client.getIdentities()
        .then((list) => {
          remoteIdentityCache.set(account.id, list);
          if (mounted.current) setRemoteIdentities((prev) => ({ ...prev, [account.id]: list }));
        })
        .catch(() => {
          // Skip accounts that fail to load identities - one bad account
          // shouldn't blank the whole dropdown. Try again on the next run.
          remoteIdentityCache.delete(account.id);
          fetchedThisMount.current.delete(account.id);
        });
    }
  }, [enabled, connectedSignature, activeAccountId]);

  const groups = useMemo<AccountIdentityGroup[]>(() => {
    if (!enabled) return [];
    // Namespace EVERY account's identity ids, including the active one, so an id
    // stably identifies (account, identity) regardless of which account is
    // active. Consumers resolve the raw id via stripCrossAccountIdentityPrefix.
    // Mirrors the calendar/contact stores' consistent-namespacing invariant.
    const group = (accountId: string, list: Identity[], label: string): AccountIdentityGroup => ({
      localAccountId: accountId,
      accountLabel: label,
      identities: list.map((id) => ({
        ...id,
        id: `${accountId}${CROSS_ACCOUNT_IDENTITY_DELIMITER}${id.id}`,
        localAccountId: accountId,
        accountName: label,
      })),
    });
    const out: AccountIdentityGroup[] = [];
    if (activeAccountId) {
      const active = accounts.find((a) => a.id === activeAccountId);
      const label = active?.label || active?.email || active?.username || activeAccountId;
      out.push(group(activeAccountId, activeIdentities, label));
    }
    for (const account of accounts) {
      if (!account.isConnected || account.id === activeAccountId) continue;
      const list = remoteIdentities[account.id];
      if (!list || list.length === 0) continue;
      const label = account.label || account.email || account.username;
      out.push(group(account.id, list, label));
    }
    return out;
  }, [enabled, accounts, activeAccountId, activeIdentities, remoteIdentities]);

  const allIdentities = useMemo(() => groups.flatMap((g) => g.identities), [groups]);

  return { enabled, groups, allIdentities };
}
