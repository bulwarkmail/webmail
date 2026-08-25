"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccountStore } from "@/stores/account-store";
import { useAuthStore } from "@/stores/auth-store";
import { useIdentityStore } from "@/stores/identity-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useIsEmbedded } from "@/hooks/use-is-embedded";
import type { Identity } from "@/lib/jmap/types";

interface AccountIdentityGroup {
  localAccountId: string;
  accountLabel: string;
  identities: Identity[];
}

const CROSS_ACCOUNT_IDENTITY_DELIMITER = '::';

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
 * Pro shell only: load identities from every connected account and group
 * them by local account so the composer's From dropdown can render an
 * <optgroup> per account - mirrors [[useProMultiAccountCalendars]] and
 * [[useProMultiAccountContacts]].
 *
 * Outside Pro / embedded mode the hook returns `enabled: false` and the
 * caller falls back to the active account's identities from
 * [[useIdentityStore]].
 */
export function useProMultiAccountIdentities(): {
  enabled: boolean;
  groups: AccountIdentityGroup[];
  /** Flat list across all accounts, useful for lookup-by-id. */
  allIdentities: Identity[];
} {
  const isEmbedded = useIsEmbedded();
  const proInterface = useSettingsStore((s) => s.proInterface);
  const accounts = useAccountStore((s) => s.accounts);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  const activeIdentities = useIdentityStore((s) => s.identities);

  const enabled = (proInterface || isEmbedded) && accounts.filter(a => a.isConnected).length > 1;

  const [remoteIdentities, setRemoteIdentities] = useState<Record<string, Identity[]>>({});

  // Cache identities fetched per non-active account. Active account's
  // identities come live from useIdentityStore so signature/alias edits
  // there are reflected immediately without an extra round-trip.
  useEffect(() => {
    if (!enabled) {
      setRemoteIdentities({});
      return;
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
              if (!cancelled) next[account.id] = list;
            } catch {
              // Skip accounts that fail to load identities - one bad
              // account shouldn't blank the whole dropdown.
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
