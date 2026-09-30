"use client";

import { useEffect, useMemo, useState } from "react";
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
  useEffect(() => {
    if (!enabled) {
      setRemoteIdentities({});
      return;
    }
    for (const id of remoteIdentityCache.keys()) {
      if (!accounts.some((a) => a.id === id)) remoteIdentityCache.delete(id);
    }
    let cancelled = false;
    const getClientForAccount = useAuthStore.getState().getClientForAccount;
    (async () => {
      const next: Record<string, Identity[]> = {};
      await Promise.all(
        accounts
          .filter((a) => a.isConnected && a.id !== activeAccountId)
          .map(async (account) => {
            const client = getClientForAccount(account.id);
            if (!client) return;
            try {
              const list = await client.getIdentities();
              remoteIdentityCache.set(account.id, list);
              if (!cancelled) next[account.id] = list;
            } catch {
              // Skip accounts that fail to load identities - one bad
              // account shouldn't blank the whole dropdown.
              remoteIdentityCache.delete(account.id);
            }
          }),
      );
      if (!cancelled) setRemoteIdentities(next);
    })();
    return () => { cancelled = true; };
  }, [enabled, accounts, activeAccountId]);

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
