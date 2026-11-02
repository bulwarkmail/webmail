"use client";

import { useSyncExternalStore } from 'react';
import { noThirdPartyTraffic, subscribeThirdPartyMode } from '@/lib/third-party-mode';
import type { SettingsPolicy } from '@/lib/admin/types';
import { accountSubjectPending, subjectForAccount, useAccountSubjects } from '@/lib/org/account-subjects';
import { usePolicyStore } from '@/stores/policy-store';
import { useAuthStore } from '@/stores/auth-store';

/**
 * Whether the browser must stay off built-in outside hosts (#903), as React
 * state: components re-render when the config arrives. True while the config
 * is still unknown, so nothing reaches out before it says it may.
 */
export function useNoThirdPartyTraffic(): boolean {
  return useSyncExternalStore(subscribeThirdPartyMode, noThirdPartyTraffic, () => true);
}

type PolicyState = ReturnType<typeof usePolicyStore.getState>;

/**
 * The effective policy of a signed-in account (AccountEntry id): the active
 * one's from the store, another one's (a message of it in the unified
 * inbox or a Pro tab) resolved for its own domain and group scopes.
 */
function policyForAccount(state: PolicyState, accountId: string | null | undefined): SettingsPolicy {
  const subject = subjectForAccount(accountId ?? null);
  return subject === state.subject ? state.policy : state.resolveFor(subject);
}

/**
 * The external content setting locked to "block" by the organisation, or
 * limited to "block" as its only allowed value.
 */
function externalContentLockedToBlock(policy: SettingsPolicy): boolean {
  const restriction = policy.restrictions?.externalContentPolicy;
  const allowed = restriction?.allowedValues;
  if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes('allow') && !allowed.includes('ask')) return true;
  if (restriction?.locked !== true) return false;
  // A lock without a value locks the organisation's default (as the
  // settings store applies it).
  const value = Object.prototype.hasOwnProperty.call(restriction, 'value')
    ? restriction.value
    : policy.defaults?.externalContentPolicy;
  return value === 'block';
}

/** Another signed-in account than the active one. */
function isOtherAccount(accountId: string | null | undefined): accountId is string {
  const auth = useAuthStore.getState();
  return !!accountId && accountId !== auth.activeAccountId && !!auth.getClientForAccount?.(accountId);
}

/**
 * Whether the policy that may lock remote content for `accountId` isn't
 * known yet: the first fetch hasn't answered, only the public subset is in
 * (just after sign-in), or the policy has domain or group scopes and the
 * account's groups are still being worked out. A later refetch keeps the
 * policy it already has, so it doesn't count.
 */
function policyPending(state: PolicyState, accountId: string | null | undefined): boolean {
  if (state.fetching && !state.loaded) return true;
  if (state.partial) return true;
  if ((state.rawPolicy.scopes ?? []).length === 0) return false;
  return isOtherAccount(accountId) ? accountSubjectPending(accountId) : state.subjectPending;
}

/** Re-renders on anything the remote-content decisions read. */
function usePolicyInputs(): void {
  useSyncExternalStore(subscribeThirdPartyMode, noThirdPartyTraffic, () => true);
  usePolicyStore((s) => s.policy);
  usePolicyStore((s) => s.rawPolicy);
  usePolicyStore((s) => s.subject);
  usePolicyStore((s) => s.subjectPending);
  usePolicyStore((s) => s.fetching);
  usePolicyStore((s) => s.loaded);
  usePolicyStore((s) => s.partial);
  useAccountSubjects((s) => s.subjects);
  useAccountSubjects((s) => s.settled);
  useAuthStore((s) => s.activeAccountId);
}

/**
 * Whether the organisation keeps remote content in mail from loading at all
 * for the account a message belongs to (the active one when left out): no
 * third-party traffic, or the external content setting locked to "block" in
 * that account's policy. Then neither a one-off load nor a trusted sender
 * lets it through.
 */
export function remoteContentBlockedByOrg(accountId?: string | null): boolean {
  return noThirdPartyTraffic() || externalContentLockedToBlock(policyForAccount(usePolicyStore.getState(), accountId));
}

/**
 * Whether remote content stays blocked whatever the user chose: blocked by
 * the organisation, or the policy that may lock it isn't known yet. Until
 * it is, neither a trusted sender nor a one-off load lets anything through,
 * so the first paint can't fire a tracker the organisation blocks.
 */
export function remoteContentHeldBack(accountId?: string | null): boolean {
  return remoteContentBlockedByOrg(accountId) || policyPending(usePolicyStore.getState(), accountId);
}

/**
 * remoteContentHeldBack for every signed-in account: for content whose
 * account isn't known (a re-opened draft's quote, which may come from any).
 */
export function remoteContentHeldBackAnywhere(): boolean {
  const connected = useAuthStore.getState().getAllConnectedClients?.();
  const ids = connected ? [...connected.keys()] : [];
  return remoteContentHeldBack() || ids.some((id) => remoteContentHeldBack(id));
}

/** remoteContentHeldBackAnywhere as React state (attachment previews, whose account isn't known). */
export function useRemoteContentHeldBackAnywhere(): boolean {
  usePolicyInputs();
  useAuthStore((s) => s.connectedAccountsRevision);
  return remoteContentHeldBackAnywhere();
}

/** remoteContentBlockedByOrg as React state, for the account a message belongs to. */
export function useRemoteContentBlockedByOrg(accountId?: string | null): boolean {
  usePolicyInputs();
  return remoteContentBlockedByOrg(accountId);
}

/** remoteContentHeldBack as React state, for the account a message belongs to. */
export function useRemoteContentHeldBack(accountId?: string | null): boolean {
  usePolicyInputs();
  return remoteContentHeldBack(accountId);
}

/**
 * For views with messages of several accounts (a conversation): re-renders
 * on what the decisions read and hands back the per-account checks.
 */
export function useRemoteContentChecks(): {
  heldBack: (accountId?: string | null) => boolean;
  blockedByOrg: (accountId?: string | null) => boolean;
} {
  usePolicyInputs();
  return { heldBack: remoteContentHeldBack, blockedByOrg: remoteContentBlockedByOrg };
}
