"use client";

import { useEffect, useMemo } from "react";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import type { TeamRef } from "@/lib/team-mailboxes/team";
import { ensureTeamNames, lookUpNames, mergeTeamPeople, useTeamNamesStore, type TeamPeople } from "@/lib/team-mailboxes/names";
import { useTeamMailboxStore } from "@/stores/team-mailbox-store";

export interface TeamPeopleView extends TeamPeople {
  /** Asks the server for the names of these ids (assignees nobody named), batched and rate limited. */
  lookUp: (ids: readonly string[]) => void;
}

/**
 * The people of a team mailbox (lib/team-mailboxes/names.ts mergeTeamPeople):
 * the user, the names list, the team's note authors and assignees, and the
 * names the directory gave. Reads the names list once per session.
 */
export function useTeamPeople(ref: TeamRef | null | undefined, client: IJMAPClient | null | undefined): TeamPeopleView {
  const key = ref?.key ?? "";
  const author = useTeamMailboxStore((s) => s.teams[key]?.author ?? null);
  const notes = useTeamMailboxStore((s) => s.teams[key]?.notes);
  const list = useTeamNamesStore((s) => s.lists[key]);
  const directory = useTeamNamesStore((s) => (ref ? s.directory[ref.loginId] : undefined));

  useEffect(() => {
    if (ref && client) void ensureTeamNames(ref, client);
    // The ref is a new object on every render; its key names the team.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, client]);

  return useMemo(() => {
    let self = null;
    if (client) {
      const login = client.getUsername().trim().toLowerCase();
      const email = author?.email || login;
      self = { id: client.getAccountId(), name: author?.name || email, email };
    }
    const merged = mergeTeamPeople({ self, list, notes: notes ? Object.values(notes) : [], directory });
    return {
      ...merged,
      lookUp: (ids: readonly string[]) => {
        if (ref && client && ids.length > 0) lookUpNames(ref.loginId, client, ids);
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, client, author, list, notes, directory]);
}
