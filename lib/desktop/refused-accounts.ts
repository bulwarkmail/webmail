/**
 * Which accounts the device's OS policy refuses, and what follows from it. Pure, so
 * the auth store only has to carry it out: a server taken off AllowedJmapServers stops
 * its accounts without signing them out.
 */

import { getDesktopPolicy, jmapServerAllowedByDesktopPolicy } from './policy';
import type { PolicySnapshot } from './policy-schema';

interface AccountLike {
  id: string;
  serverUrl: string;
  isConnected?: boolean;
}

export function accountRefusedByDesktopPolicy(account: { serverUrl: string }, snapshot: PolicySnapshot = getDesktopPolicy()): boolean {
  return !jmapServerAllowedByDesktopPolicy(account.serverUrl, snapshot);
}

export interface RefusedPlan {
  refused: string[];
  /** To stop now: the refused ones, in the order stored. */
  stop: string[];
  activeRefused: boolean;
  /** Where the active account moves: a connected one first, as a sign-out does. */
  next: string | null;
}

export function planForRefusedAccounts(accounts: readonly AccountLike[], activeId: string | null, snapshot: PolicySnapshot): RefusedPlan {
  const refused = accounts.filter((account) => accountRefusedByDesktopPolicy(account, snapshot)).map((account) => account.id);
  const allowed = accounts.filter((account) => !refused.includes(account.id));
  const activeRefused = !!activeId && refused.includes(activeId);
  return {
    refused,
    stop: refused,
    activeRefused,
    next: activeRefused ? (allowed.find((account) => account.isConnected) ?? allowed[0])?.id ?? null : null,
  };
}
