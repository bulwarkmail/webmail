/**
 * Whether the signed-in login has a team mailbox with notes and assignment
 * on: `api.host.features.teamMailboxes` for plugins, and the switch that
 * makes the host hide an older team-inbox plugin's buttons, filters and row
 * badges (lib/plugin-sandbox/handover.ts), so nobody sees them twice.
 */

import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useConfirmedGroups } from '@/lib/plugin-sandbox/account-kind';
import { TEAM_INBOX_PLUGIN_ID } from '@/lib/plugin-sandbox/handover';
import { teamFor } from './team';

/** The team-inbox plugin, retired in favour of team mailboxes. */
export { TEAM_INBOX_PLUGIN_ID };

export function anyTeamMailboxOn(): boolean {
  const { client, activeAccountId } = useAuthStore.getState();
  if (!client || !activeAccountId) return false;
  const groups = useConfirmedGroups.getState().groups.get(client);
  if (!groups || groups.size === 0) return false;
  const rawPolicy = usePolicyStore.getState().rawPolicy;
  for (const accountId of groups) {
    if (teamFor(client, activeAccountId, accountId, rawPolicy)) return true;
  }
  return false;
}

/** True for the team-inbox plugin's parts while core does its job. */
export function teamInboxHandedOver(pluginId: string): boolean {
  return pluginId === TEAM_INBOX_PLUGIN_ID && anyTeamMailboxOn();
}
