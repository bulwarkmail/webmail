/**
 * The list filters of a team mailbox's folders: Open, Assigned to me,
 * Mentions me and With notes. One at a time; picking the active one again
 * clears it. Server-side like the plugins' list filters: the condition is
 * ANDed into the folder's Email/query (stores/email-store.ts
 * folderListFilter). A filter belongs to the team it was picked in and
 * applies to no other folder list.
 *
 * With notes and Mentions me ask about the conversation
 * (someInThreadHaveKeyword): the note may be about a message of the
 * conversation in another folder, such as the team's reply in Sent.
 */

import { create } from 'zustand';
import { DONE_KEYWORD, assignedKeyword } from './keywords';
import { NOTES_KEYWORD, mentionKeyword } from './note-format';

export type TeamListFilterKey = 'open' | 'mine' | 'mentions' | 'notes';
export const TEAM_LIST_FILTERS: readonly TeamListFilterKey[] = ['open', 'mine', 'mentions', 'notes'];

interface TeamListFilterState {
  /** The team (TeamRef.key) the filter was picked in, and which filter. */
  active: { teamKey: string; key: TeamListFilterKey } | null;
}

export const useTeamListFilter = create<TeamListFilterState>()(() => ({ active: null }));

/** Picks a filter, or clears it when it was already on. */
export function toggleTeamListFilter(teamKey: string, key: TeamListFilterKey): void {
  const current = useTeamListFilter.getState().active;
  useTeamListFilter.setState({
    active: current && current.teamKey === teamKey && current.key === key ? null : { teamKey, key },
  });
}

export function clearTeamListFilter(): void {
  useTeamListFilter.setState({ active: null });
}

/** The JMAP condition of a filter, for the user whose principal id is `selfId`. */
export function teamFilterCondition(key: TeamListFilterKey, selfId: string): Record<string, unknown> {
  switch (key) {
    case 'open': return { notKeyword: DONE_KEYWORD };
    case 'mine': return { hasKeyword: assignedKeyword(selfId) };
    case 'mentions': return { someInThreadHaveKeyword: mentionKeyword(selfId) };
    case 'notes': return { someInThreadHaveKeyword: NOTES_KEYWORD };
  }
}

/** The condition for the folder list of `teamKey`, or null when no filter of that team is on. */
export function activeTeamFilterCondition(teamKey: string | null | undefined, selfId: string): Record<string, unknown> | null {
  const active = useTeamListFilter.getState().active;
  if (!active || !teamKey || active.teamKey !== teamKey) return null;
  return teamFilterCondition(active.key, selfId);
}
