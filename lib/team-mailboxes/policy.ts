/**
 * Whether team mailboxes (notes and assignment) are on for one group
 * account, from the organisation policy (`organisation.teamMailboxes.enabled`).
 *
 * Resolved for that group alone: the user's address (so domain scopes
 * apply) and only this group, never all of the user's groups. A scope that
 * names tm-team must not turn the feature on in tm-team2 just because the
 * same person belongs to both.
 */

import type { SettingsPolicy } from '@/lib/admin/types';
import { resolvePolicy } from '@/lib/admin/policy-scopes';

export function teamMailboxesOn(
  rawPolicy: SettingsPolicy | null | undefined,
  userEmail: string | null | undefined,
  groupAddress: string | null | undefined,
): boolean {
  if (!rawPolicy || !groupAddress) return false;
  const subject = { email: (userEmail ?? '').trim().toLowerCase(), groups: [groupAddress.trim().toLowerCase()] };
  return resolvePolicy(rawPolicy, subject).policy.organisation?.teamMailboxes?.enabled === true;
}
