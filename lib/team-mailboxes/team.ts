/**
 * Which team mailbox a message, folder or account belongs to, if any.
 *
 * A team mailbox is a JMAP account that the server confirms as a group
 * (Principal/get type "group", lib/plugin-sandbox/account-kind.ts) and for
 * which the organisation policy turns the feature on for that group alone
 * (lib/team-mailboxes/policy.ts). The user's own account and a mailbox one
 * person shared with another are never team mailboxes.
 *
 * Ids repeat across accounts and logins, so a team is always the pair
 * (login, JMAP account).
 */

import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { SettingsPolicy } from '@/lib/admin/types';
import { mailAccountKind } from '@/lib/plugin-sandbox/account-kind';
import { teamMailboxesOn } from './policy';

export interface TeamRef {
  /** `${loginId}|${accountId}` */
  key: string;
  /** The signed-in account (auth store id) the team is reached through. */
  loginId: string;
  /** The group's JMAP account id (= its principal id on Stalwart). */
  accountId: string;
  /** The group's address (the session's account name). */
  groupAddress: string;
}

export function teamKey(loginId: string, accountId: string): string {
  return `${loginId}|${accountId}`;
}

/**
 * The team for `accountId` reached through `client` (login `loginId`), or
 * null when it isn't a team mailbox with the feature on. Synchronous: until
 * the server confirmed the account as a group it says null, and asks.
 */
export function teamFor(
  client: IJMAPClient | null | undefined,
  loginId: string | null | undefined,
  accountId: string | null | undefined,
  rawPolicy: SettingsPolicy | null | undefined,
): TeamRef | null {
  if (!client || !loginId || !accountId) return null;
  if (mailAccountKind(client, accountId) !== 'group') return null;
  const groupAddress = client.getAccountInfo?.(accountId)?.name?.trim().toLowerCase();
  if (!groupAddress) return null;
  if (!teamMailboxesOn(rawPolicy, client.getUsername(), groupAddress)) return null;
  return { key: teamKey(loginId, accountId), loginId, accountId, groupAddress };
}
