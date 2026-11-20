'use client';

/**
 * Team notes in a conversation (or a single message): the cards between the
 * messages in time order, the note field at the newest end, the line above
 * the message and the Note button's action. One provider per conversation
 * view; outside a team mailbox it provides nothing and every piece renders
 * nothing.
 *
 * Where a note goes: after the last message that arrived before it (notes
 * written before the first message's time go after the first message).
 * Notes still being sent go after the newest message.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { Email } from '@/lib/jmap/types';
import { StickyNote, RotateCcw } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { toast } from '@/stores/toast-store';
import { toastWithUndo } from '@/lib/email-action-toast';
import { noteKeyFor, type NoteEntry } from '@/lib/team-mailboxes/note-format';
import {
  deleteNote,
  loadConversation,
  onNotesArrived,
  repairOriginalKeywords,
  reloadTeam,
  retryConversation,
  markConversationSeen,
  retryNote,
  writeNote,
  conversationKeyOf,
  type NoteTarget,
  type PendingNote,
  type TeamState,
} from '@/stores/team-mailbox-store';
import { isOwnNote } from '@/lib/team-mailboxes/note-format';
import { NoteCard, PendingNoteCard, TeamOnlyLine, TimelineLine, displayName } from './note-cards';
import { NoteField, type NoteFieldHandle } from './note-field';
import { useTeamPeople } from '@/hooks/use-team-people';
import { mentionsIn } from '@/lib/team-mailboxes/mentions';
import { useMentionPicker } from './mention-picker';
import {
  conversationKeys,
  useConversationNotes,
  useNoteFieldRequest,
  useOnline,
  useTeamOf,
  useTeamState,
  type TeamContext,
} from './use-team';

type Message = Pick<Email, 'id' | 'messageId' | 'threadId' | 'subject' | 'receivedAt' | 'keywords'>;

interface Slot {
  notes: NoteEntry[];
  pending: PendingNote[];
}

interface TeamNotesValue {
  context: TeamContext;
  team: TeamState;
  /** Notes after each message id; `first` tells which slot shows "Only your team sees this". */
  slots: Map<string, Slot>;
  firstSlot: string | null;
  notes: NoteEntry[];
  fieldOpen: boolean;
  openField: (emailId?: string) => void;
  closeField: () => void;
  /** The message a note written now is about: the one whose Note was clicked, else the newest. */
  target: Message | undefined;
  highlightNoteId: string | null;
  nameOf: (principalId: string) => string | null;
  /** "New note from Mabel", for the polite live region in the note area. */
  announcement: string;
}

const TeamNotesContext = createContext<TeamNotesValue | null>(null);

/** Whether the message on screen is in a team mailbox with notes on, and opens its note field. */
export function useTeamNotesAction(): { available: boolean; openField: (emailId?: string) => void } {
  const value = useContext(TeamNotesContext);
  return { available: !!value, openField: value?.openField ?? (() => {}) };
}

/** A note's assignee and similar ids → names, from the notes' authors until the names list is in. */
function useNameOf(context: TeamContext | null, selfName: string | null): (id: string) => string | null {
  const people = useTeamPeople(context?.ref ?? null, context?.client ?? null);
  const selfId = context?.client.getAccountId().toLowerCase() ?? null;
  return useCallback((id: string) => {
    if (selfId && id === selfId && selfName) return selfName;
    const person = people.byId(id);
    return person?.name || person?.email || null;
  }, [selfId, selfName, people]);
}

export function TeamNotesProvider({ email, messages, children }: {
  /** The open message (its login and account decide the team); null renders no team. */
  email: Pick<Email, 'sourceClientAccountId' | 'sourceAccountId'> | null;
  /** Every message of the conversation on screen, or just the open one. */
  messages: readonly Message[];
  children: React.ReactNode;
}) {
  const context = useTeamOf(email);
  const team = useTeamState(context?.ref.key);
  const value = useTeamNotesValue(context && team ? context : null, context && team ? team : undefined, messages);
  // Always the same single element, team or not, so the viewer below is
  // never remounted when the message on screen changes.
  return <TeamNotesContext.Provider value={value}>{children}</TeamNotesContext.Provider>;
}

const NO_MESSAGES: readonly Message[] = [];

function useTeamNotesValue(context: TeamContext | null, team: TeamState | undefined, messages: readonly Message[]): TeamNotesValue | null {
  const t = useTranslations('team_mailboxes');
  const accountId = context?.ref.accountId ?? '';
  const key = context?.ref.key ?? '';
  const ordered = useMemo(
    () => (context ? [...messages].sort((a, b) => (Date.parse(a.receivedAt) || 0) - (Date.parse(b.receivedAt) || 0)) : NO_MESSAGES),
    [messages, context],
  );
  const idsKey = ordered.map((m) => m.id).join(',');
  const { keys, threadIds } = useMemo(() => conversationKeys(ordered, accountId), [ordered, accountId]);
  const { notes, pending } = useConversationNotes(team, keys, threadIds);

  // Everything about these messages: older notes and the text of all of them.
  useEffect(() => {
    if (team?.status === 'ready' && ordered.length > 0) void loadConversation(key, ordered, keys);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- by message ids
  }, [key, team?.status, idsKey]);

  // The filter keywords on the messages follow their notes, once complete.
  const convStatus = team?.conversations[conversationKeyOf(keys, threadIds)];
  useEffect(() => {
    if (convStatus !== 'ready' || !team?.canWrite) return;
    void repairOriginalKeywords(key, ordered.map((m) => ({ id: m.id, key: noteKeyFor(m, accountId), keywords: m.keywords })));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per completed conversation
  }, [convStatus, team?.canWrite, key, idsKey]);

  // On screen: its notes count as seen (the dot on the list row goes).
  const newestNote = notes.reduce((max, n) => (n.kind === 'note' ? Math.max(max, n.at) : max), 0);
  useEffect(() => {
    if (key && newestNote > 0) markConversationSeen(key, threadIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- by the newest note
  }, [key, newestNote, threadIds.join(',')]);

  const slots = useMemo(() => {
    const map = new Map<string, Slot>();
    for (const m of ordered) map.set(m.id, { notes: [], pending: [] });
    if (ordered.length === 0) return map;
    for (const note of notes) {
      let after = ordered[0].id;
      for (const m of ordered) if ((Date.parse(m.receivedAt) || 0) <= note.at) after = m.id;
      map.get(after)!.notes.push(note);
    }
    map.get(ordered[ordered.length - 1].id)!.pending.push(...pending);
    return map;
  }, [ordered, notes, pending]);
  const firstSlot = useMemo(() => {
    for (const m of ordered) {
      const slot = slots.get(m.id);
      if (slot && (slot.notes.length > 0 || slot.pending.length > 0)) return m.id;
    }
    return null;
  }, [ordered, slots]);

  const [fieldOpen, setFieldOpen] = useState(false);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [highlightNoteId, setHighlightNoteId] = useState<string | null>(null);
  const openField = useCallback((emailId?: string) => {
    setTargetId(emailId ?? null);
    setFieldOpen(true);
  }, []);
  const closeField = useCallback(() => setFieldOpen(false), []);
  // Another conversation: the field starts closed again.
  useEffect(() => { setFieldOpen(false); setTargetId(null); }, [idsKey]);

  // Asked from outside (the Note buttons, the row menu, a mention notification).
  const request = useNoteFieldRequest();
  useEffect(() => {
    if (!context || !request.emailId || !ordered.some((m) => m.id === request.emailId)) return;
    if (request.noteId) setHighlightNoteId(request.noteId);
    else openField(request.emailId);
    useNoteFieldRequest.setState({ emailId: null, noteId: null });
  }, [context, request.at, request.emailId, request.noteId, ordered, openField]);
  useEffect(() => {
    if (!highlightNoteId) return;
    const el = document.querySelector<HTMLElement>(`[data-team-note="${CSS.escape(highlightNoteId)}"]`);
    if (!el) return;
    el.scrollIntoView?.({ block: 'center' });
    el.focus({ preventScroll: true });
    const timer = setTimeout(() => setHighlightNoteId(null), 4000);
    return () => clearTimeout(timer);
  }, [highlightNoteId, notes]);

  // New notes from others are announced politely; focus never moves.
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (!key) return;
    return onNotesArrived((ref, _client, arrived) => {
      if (ref.key !== key) return;
      const mine = arrived.filter((n) => n.kind === 'note' && (keys.includes(n.key) || (!!n.threadId && threadIds.includes(n.threadId))));
      if (mine.length > 0) setAnnouncement(t('new_note_from', { name: displayName(mine[mine.length - 1].author) }));
    });
  }, [key, keys, threadIds, t]);

  const selfName = team?.author ? displayName(team.author) : null;
  const nameOf = useNameOf(context, selfName);
  const target: Message | undefined = ordered.find((m) => m.id === targetId) ?? ordered[ordered.length - 1];
  return useMemo<TeamNotesValue | null>(() => (context && team ? {
    context, team, slots, firstSlot, notes, fieldOpen, openField, closeField, target, highlightNoteId, nameOf, announcement,
  } : null), [context, team, slots, firstSlot, notes, fieldOpen, openField, closeField, target, highlightNoteId, nameOf, announcement]);
}

/** Whether notes follow a message (a folded run keeps such a message in view). */
export function useHasNotesAfter(): (emailId: string) => boolean {
  const value = useContext(TeamNotesContext);
  return useCallback((emailId: string) => {
    const slot = value?.slots.get(emailId);
    return !!slot && (slot.notes.length > 0 || slot.pending.length > 0);
  }, [value]);
}

/** The notes that follow one message (between it and the next). */
export function NotesAfter({ emailId, className }: { emailId: string; className?: string }) {
  const value = useContext(TeamNotesContext);
  const t = useTranslations('team_mailboxes');
  if (!value) return null;
  const slot = value.slots.get(emailId);
  if (!slot || (slot.notes.length === 0 && slot.pending.length === 0)) return null;
  const { team, context } = value;
  const own = team.author?.email ?? null;
  const target = (localKey: string): NoteTarget => {
    const message = value.target;
    return {
      emailId: message?.id ?? emailId, key: localKey, threadId: message?.threadId ?? null, subject: message?.subject,
    };
  };
  const onDelete = async (note: NoteEntry) => {
    const undo = await deleteNote(context.ref.key, note.id);
    if (!undo) {
      toast.error(t('delete_failed'));
      return;
    }
    toastWithUndo(t('deleted'), { label: t('undo'), onClick: () => { void undo(); } });
  };
  return (
    <div className={className ?? 'px-4 py-2 desk:px-6'} data-team-notes-after={emailId}>
      {value.firstSlot === emailId && <TeamOnlyLine />}
      <ul className="mt-1 space-y-2" aria-label={t('list_label')}>
        {slot.notes.map((note) => note.kind === 'note'
          ? <NoteCard key={note.id} note={note} highlighted={value.highlightNoteId === note.id} onDelete={isOwnNote(note, own) ? () => { void onDelete(note); } : undefined} />
          : <TimelineLine key={note.id} note={note} nameOf={value.nameOf} />)}
        {slot.pending.map((p) => (
          <PendingNoteCard key={p.localId} pending={p} author={team.author ?? { name: '', email: '' }} onRetry={() => { void retryNote(context.ref.key, p.localId, target(p.key)); }} />
        ))}
      </ul>
    </div>
  );
}

/** "3 notes · Mabel: waiting for feedback from the client"; scrolls to the notes. */
export function NotesSummaryLine({ className }: { className?: string }) {
  const value = useContext(TeamNotesContext);
  const t = useTranslations('team_mailboxes');
  if (!value) return null;
  const written = value.notes.filter((n) => n.kind === 'note');
  if (written.length === 0) return null;
  const latest = written[written.length - 1];
  const onClick = () => {
    const el = document.querySelector<HTMLElement>(`[data-team-note="${CSS.escape(written[0].id)}"]`);
    el?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    el?.focus({ preventScroll: true });
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className={className ?? 'flex w-full min-w-0 items-center gap-1.5 px-4 py-1.5 text-start text-xs text-muted-foreground hover:text-foreground desk:px-6'}
      data-team-notes-summary=""
    >
      <StickyNote className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="shrink-0 font-medium">{t('summary_count', { count: written.length })}</span>
      {latest.text ? <span className="min-w-0 truncate" dir="auto">· {t('summary_latest', { name: displayName(latest.author), text: latest.text })}</span> : null}
    </button>
  );
}

/**
 * The end of the conversation: the Note button, or the open field, or the
 * sentence that says why there is no field. Also where a load failure says
 * so, with Retry.
 */
export function TeamNoteArea({ className, messages }: { className?: string; messages: readonly Message[] }) {
  const value = useContext(TeamNotesContext);
  const t = useTranslations('team_mailboxes');
  const online = useOnline();
  const field = useRef<NoteFieldHandle>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const key = value?.context.ref.key ?? '';
  const convKey = value ? conversationKeyOf(conversationKeys(messages, value.context.ref.accountId).keys, conversationKeys(messages, value.context.ref.accountId).threadIds) : '';
  const draft = drafts[convKey] ?? '';
  // @ mentions: the team's people (the same people Assign to… offers).
  const people = useTeamPeople(value?.context.ref ?? null, value?.context.client ?? null);
  const candidates = useMemo(
    () => people.people.filter((p) => !!p.id).map((p) => ({ id: p.id as string, name: p.name ?? '', email: p.email ?? '' })),
    [people.people],
  );
  const mention = useMentionPicker({
    people: candidates,
    selfId: value?.context.client.getAccountId().toLowerCase() ?? null,
    text: draft,
    setText: (text, caret) => {
      setDrafts((d) => ({ ...d, [convKey]: text }));
      field.current?.setCaret(caret);
    },
  });
  const fieldOpen = value?.fieldOpen ?? false;
  useEffect(() => {
    if (!fieldOpen) return;
    areaRef.current?.scrollIntoView?.({ block: 'nearest' });
    field.current?.focus();
  }, [fieldOpen]);
  if (!value) return null;
  const { team } = value;
  const convStatus = team.conversations[convKey];
  const loadFailed = team.status === 'error' || convStatus === 'error';
  const offline = !online || team.status === 'offline' || convStatus === 'offline';
  const readOnly = team.canWrite === false;

  const send = () => {
    const text = draft.trim();
    const target = value.target;
    if (!text || !target) return;
    // Only people still named in the text, and only people of the team.
    const mentions = mentionsIn(text, mention.picked, new Set(candidates.map((c) => c.id.toLowerCase())));
    setDrafts((d) => ({ ...d, [convKey]: '' }));
    mention.reset();
    void writeNote(key, {
      emailId: target.id, key: noteKeyFor(target, value.context.ref.accountId), threadId: target.threadId ?? null, subject: target.subject,
    }, { text, mentions });
    field.current?.focus();
  };
  const close = () => value.closeField();

  return (
    <div ref={areaRef} className={className ?? 'px-4 pb-4 pt-2 desk:px-6'} data-team-note-area="">
      <span className="sr-only" role="status" aria-live="polite">{value.announcement}</span>
      {loadFailed && (
        <p className="mb-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground" role="alert">
          {t('load_failed')}
          <button type="button" className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-2 hover:underline" onClick={() => {
            if (team.status === 'error') void reloadTeam(key);
            else void retryConversation(key, messages, conversationKeys(messages, value.context.ref.accountId).keys);
          }}>
            <RotateCcw className="h-3.5 w-3.5" />
            {t('retry')}
          </button>
        </p>
      )}
      {!fieldOpen && readOnly && value.notes.length > 0 ? (
        <p className="text-sm text-muted-foreground" role="status">{t('read_only')}</p>
      ) : !fieldOpen ? (
        <Button type="button" variant="outline" size="sm" className="gap-2 rounded-full px-5" onClick={() => value.openField()} data-team-note-button="">
          <StickyNote className="h-4 w-4" />
          {t('note')}
        </Button>
      ) : offline ? (
        <p className="text-sm text-muted-foreground" role="status">{t('offline')}</p>
      ) : readOnly ? (
        <p className="text-sm text-muted-foreground" role="status">{t('read_only')}</p>
      ) : (
        <NoteField
          ref={field}
          value={draft}
          onChange={(text) => setDrafts((d) => ({ ...d, [convKey]: text }))}
          onSubmit={send}
          onClose={close}
          onKeyDownFirst={mention.onKeyDown}
          textareaProps={mention.fieldProps}
        >
          {mention.list}
        </NoteField>
      )}
    </div>
  );
}
