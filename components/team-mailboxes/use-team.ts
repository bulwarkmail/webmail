'use client';

/**
 * Hooks that tie a message on screen to its team mailbox and its notes.
 * Everything here is null / empty outside a team mailbox with the feature on,
 * so the UI shows nothing new there.
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import type { Email } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';
import { resolveEmailBlobContext, useEmailStore } from '@/stores/email-store';
import { useConfirmedGroups } from '@/lib/plugin-sandbox/account-kind';
import { teamFor, type TeamRef } from '@/lib/team-mailboxes/team';
import { noteKeyFor, type NoteEntry } from '@/lib/team-mailboxes/note-format';
import {
  ensureTeamLoaded,
  notesOf,
  pendingOf,
  useTeamMailboxStore,
  type PendingNote,
  type TeamState,
} from '@/stores/team-mailbox-store';

type Stamped = Pick<Email, 'sourceClientAccountId' | 'sourceAccountId'> | null | undefined;

export interface TeamContext {
  ref: TeamRef;
  client: IJMAPClient;
}

/** The team mailbox a message belongs to (login + account), or null. Starts loading its notes. */
export function useTeamOf(email: Stamped): TeamContext | null {
  const authClient = useAuthStore((s) => s.client);
  const rawPolicy = usePolicyStore((s) => s.rawPolicy);
  const groupsRevision = useConfirmedGroups((s) => s.revision);
  // The unstamped case reads the folder on screen.
  const selectedMailbox = useEmailStore((s) => s.selectedMailbox);
  const viewingAccountId = useEmailStore((s) => s.viewingAccountId);
  const source = email?.sourceClientAccountId ?? '';
  const owner = email?.sourceAccountId ?? '';
  const context = useMemo(() => {
    void groupsRevision; void selectedMailbox; void viewingAccountId;
    if (!email) return null;
    const { client, accountId, clientAccountId } = resolveEmailBlobContext(email, authClient);
    const ref = teamFor(client, clientAccountId, accountId, rawPolicy);
    return ref && client ? { ref, client } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the stamps, not the object
  }, [source, owner, !!email, authClient, rawPolicy, groupsRevision, selectedMailbox, viewingAccountId]);
  useEffect(() => {
    if (context) void ensureTeamLoaded(context.ref, context.client);
  }, [context]);
  return context;
}

export function useTeamState(key: string | null | undefined): TeamState | undefined {
  return useTeamMailboxStore((s) => (key ? s.teams[key] : undefined));
}

/** The keys and thread ids notes of these messages are filed under. */
export function conversationKeys(messages: ReadonlyArray<Pick<Email, 'id' | 'messageId' | 'threadId'>>, accountId: string): { keys: string[]; threadIds: string[] } {
  return {
    keys: [...new Set(messages.map((m) => noteKeyFor(m, accountId)))],
    threadIds: [...new Set(messages.map((m) => m.threadId).filter((t): t is string => !!t))],
  };
}

/** The notes and timeline entries of a conversation, and its notes still being sent, oldest first. */
export function useConversationNotes(team: TeamState | undefined, keys: readonly string[], threadIds: readonly string[]): { notes: NoteEntry[]; pending: PendingNote[] } {
  const keysKey = keys.join('\n');
  const threadsKey = threadIds.join('\n');
  return useMemo(() => {
    if (!team) return { notes: [], pending: [] };
    return { notes: notesOf(team, keys, threadIds), pending: pendingOf(team, keys) };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version covers every change of the team
  }, [team?.version, team?.ref.key, keysKey, threadsKey]);
}

/**
 * The note field to open, asked for from outside the conversation (the row
 * menu's Note, a notification): the conversation opens it when it shows that
 * message.
 */
interface NoteFieldRequest {
  emailId: string | null;
  /** A note to scroll to (a mention notification). */
  noteId: string | null;
  at: number;
}
export const useNoteFieldRequest = create<NoteFieldRequest>()(() => ({ emailId: null, noteId: null, at: 0 }));

export function requestNoteField(emailId: string): void {
  useNoteFieldRequest.setState({ emailId, noteId: null, at: Date.now() });
}

export function requestNoteFocus(emailId: string, noteId: string): void {
  useNoteFieldRequest.setState({ emailId, noteId, at: Date.now() });
}

function subscribeOnline(callback: () => void): () => void {
  window.addEventListener('online', callback);
  window.addEventListener('offline', callback);
  return () => {
    window.removeEventListener('online', callback);
    window.removeEventListener('offline', callback);
  };
}

/** Whether the browser says it is online. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
}
