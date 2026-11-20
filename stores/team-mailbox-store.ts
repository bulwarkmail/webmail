/**
 * Team notes per team mailbox (lib/team-mailboxes/team.ts): the index the
 * conversation, the line above the message and the list rows read, kept
 * current from the server.
 *
 * - Loaded on first use of a team mailbox: the notes of the last 90 days,
 *   newest first, at most 2,000, without their text (lib/team-mailboxes/
 *   note-format.ts NOTE_INDEX_PROPERTIES). `windowStart` says how far back
 *   the index reaches; a conversation older than that looks its notes up by
 *   subject (Stalwart doesn't index custom headers by default, so a header
 *   query finds nothing; local-data/team-mailboxes-facts.md §2).
 * - Text is loaded per conversation when it opens.
 * - Kept current from Email/changes against the store's own baseline on
 *   every push for the group account (never a pushed state as baseline).
 * - Writes go to the team's own login and JMAP account, always the server's
 *   word (no offline answers). A note that couldn't be saved stays pending
 *   with the reason, for the field's error and Retry.
 */

import { create } from 'zustand';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Identity, MailboxRights, StateChange } from '@/lib/jmap/types';
import { jmapErrorType } from '@/lib/jmap/jmap-error';
import { subscribePushStateChanges } from '@/lib/push-events';
import { debug } from '@/lib/debug';
import { keywordPointer } from '@/lib/jmap/patch-pointer';
import {
  assignChanges,
  assigneesOf,
  doneChanges,
  reopenChanges,
  reversePatch,
  unassignChanges,
  type KeywordPatch,
} from '@/lib/team-mailboxes/keywords';
import { addToTeamNames, useTeamNamesStore, type Person } from '@/lib/team-mailboxes/names';
import { NOTE_KEYWORD, TEAM_NOTES_FOLDER_NAME, isTeamNotesFolder } from '@/lib/team-mailboxes/hidden-folders';
import {
  NOTES_KEYWORD,
  NOTE_INDEX_PROPERTIES,
  buildNoteEmail,
  isOwnNote,
  mentionKeyword,
  noteKeyFor,
  parseNote,
  type NoteAuthor,
  type NoteEntry,
  type NoteKind,
} from '@/lib/team-mailboxes/note-format';
import type { TeamRef } from '@/lib/team-mailboxes/team';
import { SEEN_METADATA_KEY, decodeSeen, encodeSeen, isUnseen, markThreadSeen, type SeenMap } from '@/lib/team-mailboxes/seen';

export const NOTES_WINDOW_DAYS = 90;
export const NOTES_INDEX_CAP = 2000;
const PAGE = 500;
/** Most candidates an older-notes lookup reads before it gives up. */
export const LOOKUP_CAP = 5000;

export type TeamStatus = 'loading' | 'ready' | 'error' | 'offline';
export type NoteSaveError = 'failed' | 'forbidden' | 'overQuota' | 'offline';

export interface PendingNote {
  localId: string;
  key: string;
  threadId: string | null;
  text: string;
  mentions: string[];
  at: number;
  status: 'sending' | 'error';
  error?: NoteSaveError;
}

/** What a conversation's notes are: loading, there, or couldn't be loaded. */
export type ConversationStatus = 'loading' | 'ready' | 'error' | 'offline';

export interface TeamState {
  ref: TeamRef;
  status: TeamStatus;
  /** Raw ids of the "Team notes" folders (normally one). */
  folderIds: string[];
  /** Whether this user can write notes here; null until known. */
  canWrite: boolean | null;
  /** The person notes are written as (never the group's address). */
  author: NoteAuthor | null;
  /** The index reaches back to here (ms); older notes are looked up on demand. */
  windowStart: number;
  notes: Record<string, NoteEntry>;
  pending: Record<string, PendingNote>;
  /** Per conversation (its sorted thread ids and keys, joined). */
  conversations: Record<string, ConversationStatus>;
  /** Bumped on every change, for memoised selectors. */
  version: number;
}

export interface ConversationMessage {
  id: string;
  messageId?: readonly string[] | string | null;
  threadId?: string | null;
  subject?: string | null;
  receivedAt?: string | null;
}

interface TeamMailboxStore {
  teams: Record<string, TeamState>;
  /** Per login: which notes the user has seen, per team account (lib/team-mailboxes/seen.ts). */
  seen: Record<string, SeenMap>;
}

export const useTeamMailboxStore = create<TeamMailboxStore>()(() => ({ teams: {}, seen: {} }));

// ── Runtime per team, outside React state ─────────────────────────────

interface Runtime {
  client: IJMAPClient;
  baseline: string | null;
  queue: Promise<unknown>;
  loading: Promise<void> | null;
}
const runtimes = new Map<string, Runtime>();
type ArrivalListener = (ref: TeamRef, client: IJMAPClient, notes: NoteEntry[]) => void;
const arrivalListeners = new Set<ArrivalListener>();
let unsubscribePush: (() => void) | null = null;

/** Notes that arrived from someone else's write (push), for the mention watcher and live announcements. */
export function onNotesArrived(listener: ArrivalListener): () => void {
  arrivalListeners.add(listener);
  return () => { arrivalListeners.delete(listener); };
}

function patchTeam(key: string, patch: (team: TeamState) => Partial<TeamState>): void {
  useTeamMailboxStore.setState((state) => {
    const team = state.teams[key];
    if (!team) return state;
    return { teams: { ...state.teams, [key]: { ...team, ...patch(team), version: team.version + 1 } } };
  });
}

function team(key: string): TeamState | undefined {
  return useTeamMailboxStore.getState().teams[key];
}

/** Runs `task` after everything queued for this team, so writes and syncs don't interleave. */
function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const runtime = runtimes.get(key);
  if (!runtime) return Promise.reject(new Error('No such team'));
  const run = runtime.queue.then(task, task);
  runtime.queue = run.catch(() => undefined);
  return run;
}

function isOffline(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'OfflineUnavailableError';
}

function saveError(error: unknown): NoteSaveError {
  if (isOffline(error)) return 'offline';
  const type = jmapErrorType(error);
  if (type === 'forbidden') return 'forbidden';
  if (type === 'overQuota') return 'overQuota';
  return 'failed';
}

function folderFilter(folderIds: readonly string[]): Record<string, unknown> {
  return folderIds.length === 1
    ? { inMailbox: folderIds[0] }
    : { operator: 'OR', conditions: folderIds.map((id) => ({ inMailbox: id })) };
}

function withNotes(team: TeamState, entries: NoteEntry[]): Record<string, NoteEntry> {
  const notes = { ...team.notes };
  for (const entry of entries) {
    const previous = notes[entry.id];
    // Text loaded before stays: the index never carries it.
    notes[entry.id] = previous?.text !== undefined && entry.text === undefined
      ? { ...entry, text: previous.text, truncated: previous.truncated }
      : entry;
  }
  return notes;
}

// ── Loading ───────────────────────────────────────────────────────────

/** The person this login writes as: the identity with the login's address, else the address. */
async function resolveAuthor(client: IJMAPClient): Promise<NoteAuthor> {
  const login = client.getUsername().trim().toLowerCase();
  const identities: Identity[] = await client.getIdentities().catch(() => []);
  const own = identities.find((i) => i.email?.toLowerCase() === login);
  return { name: own?.name?.trim() ?? '', email: login };
}

async function findFolders(client: IJMAPClient, accountId: string): Promise<{ ids: string[]; rights: MailboxRights | null; anyCreate: boolean }> {
  const all = await client.getMailboxes(accountId, { includeHidden: true });
  const notes = all
    .filter((m) => isTeamNotesFolder({ name: m.name, parentId: m.parentId, role: m.role }, false))
    .sort((a, b) => (a.originalId ?? a.id).localeCompare(b.originalId ?? b.id));
  return {
    ids: notes.map((m) => m.originalId ?? m.id),
    rights: notes[0]?.myRights ?? null,
    anyCreate: all.some((m) => m.myRights?.mayCreateChild),
  };
}

/**
 * Loads a team's index once (later calls wait for the same load). Safe to
 * call on every render path that shows a team mailbox.
 */
export function ensureTeamLoaded(ref: TeamRef, client: IJMAPClient): Promise<void> {
  ensurePushSubscription();
  const existing = runtimes.get(ref.key);
  if (existing && existing.client === client) {
    return existing.loading ?? Promise.resolve();
  }
  const runtime: Runtime = { client, baseline: null, queue: Promise.resolve(), loading: null };
  runtimes.set(ref.key, runtime);
  useTeamMailboxStore.setState((state) => ({
    teams: {
      ...state.teams,
      [ref.key]: {
        ref, status: 'loading', folderIds: [], canWrite: null, author: null,
        windowStart: Date.now() - NOTES_WINDOW_DAYS * 86_400_000,
        notes: {}, pending: {}, conversations: {}, version: 0,
      },
    },
  }));
  runtime.loading = enqueue(ref.key, async () => {
    await ensureSeenLoaded(ref, client);
    ensureBaseline(ref);
    await loadIndex(ref, client);
  }).finally(() => { runtime.loading = null; });
  return runtime.loading;
}

/** Loads the index again (Retry after "Notes couldn't be loaded"). */
export function reloadTeam(key: string): Promise<void> {
  const runtime = runtimes.get(key);
  const current = team(key);
  if (!runtime || !current) return Promise.resolve();
  patchTeam(key, () => ({ status: 'loading', conversations: {} }));
  runtime.loading = enqueue(key, () => loadIndex(current.ref, runtime.client)).finally(() => { runtime.loading = null; });
  return runtime.loading;
}

async function loadIndex(ref: TeamRef, client: IJMAPClient): Promise<void> {
  const runtime = runtimes.get(ref.key);
  try {
    const [author, folders] = await Promise.all([resolveAuthor(client), findFolders(client, ref.accountId)]);
    const canWrite = folders.ids.length > 0
      ? folders.rights?.mayAddItems === true
      : folders.anyCreate && client.getAccountInfo(ref.accountId)?.isReadOnly !== true;
    let windowStart = Date.now() - NOTES_WINDOW_DAYS * 86_400_000;
    const entries: NoteEntry[] = [];
    let baseline: string | null = null;
    if (folders.ids.length > 0 && client.queryTeamNotes) {
      const filter = { operator: 'AND', conditions: [folderFilter(folders.ids), { after: new Date(windowStart).toISOString() }] };
      for (let position = 0; position < NOTES_INDEX_CAP; position += PAGE) {
        const page = await client.queryTeamNotes(ref.accountId, filter, { limit: PAGE, position, properties: NOTE_INDEX_PROPERTIES });
        if (baseline === null) baseline = page.state ?? null;
        for (const raw of page.list) {
          const entry = parseNote(raw);
          if (entry) entries.push(entry);
        }
        if (page.ids.length < PAGE) break;
        // The cap is reached: the index covers what it holds, the rest is looked up.
        if (position + PAGE >= NOTES_INDEX_CAP) {
          const oldest = entries.reduce((min, e) => Math.min(min, e.at), Number.POSITIVE_INFINITY);
          if (Number.isFinite(oldest)) windowStart = Math.max(windowStart, oldest);
        }
      }
    } else if (client.getTeamNotes) {
      // No folder yet: only the state, so the first note anyone writes arrives as a change.
      baseline = (await client.getTeamNotes(ref.accountId, [], ['id'])).state ?? null;
    }
    if (runtime) runtime.baseline = baseline;
    patchTeam(ref.key, (t) => ({
      status: 'ready', author, canWrite, folderIds: folders.ids, windowStart,
      notes: withNotes({ ...t, notes: {} }, entries), conversations: {},
    }));
  } catch (error) {
    debug.warn('team-mailboxes', `Loading notes of ${ref.accountId} failed:`, error);
    patchTeam(ref.key, () => ({ status: isOffline(error) ? 'offline' : 'error' }));
  }
}

// ── Live updates ──────────────────────────────────────────────────────

function ensurePushSubscription(): void {
  if (unsubscribePush) return;
  unsubscribePush = subscribePushStateChanges((change, client) => onPush(change, client));
}

function onPush(change: StateChange, client: IJMAPClient): void {
  for (const [key, runtime] of runtimes) {
    if (runtime.client !== client) continue;
    const current = team(key);
    if (!current || current.status !== 'ready') continue;
    if (!change.changed[current.ref.accountId]?.Email) continue;
    void enqueue(key, () => applyChanges(key)).catch((error) => debug.warn('team-mailboxes', 'Note sync failed:', error));
  }
}

/** Email/changes since the team's baseline: new, changed and deleted notes. */
export async function applyChanges(key: string): Promise<void> {
  const runtime = runtimes.get(key);
  const current = team(key);
  if (!runtime || !current) return;
  const { client } = runtime;
  if (!client.getEmailChanges || !client.getTeamNotes) return;
  const { accountId } = current.ref;
  if (!runtime.baseline) return reloadIndexQuietly(key);
  const created: string[] = [];
  const changed: string[] = [];
  const destroyed: string[] = [];
  let since = runtime.baseline;
  for (let round = 0; round < 20; round += 1) {
    const delta = await client.getEmailChanges(since, accountId, 500);
    if (!delta) return reloadIndexQuietly(key);
    created.push(...delta.created);
    changed.push(...delta.updated);
    destroyed.push(...delta.destroyed);
    since = delta.newState;
    if (!delta.hasMoreChanges) break;
  }
  const ids = [...new Set([...created, ...changed])];
  const fetched = ids.length > 0 ? (await client.getTeamNotes(accountId, ids, NOTE_INDEX_PROPERTIES)).list : [];
  const latest = team(key);
  if (!latest) return;
  const folderIds = new Set(latest.folderIds);
  const arrived: NoteEntry[] = [];
  const kept: NoteEntry[] = [];
  const leftFolder: string[] = [];
  for (const raw of fetched) {
    const keywords = raw.keywords as Record<string, boolean> | undefined;
    const boxes = Object.keys((raw.mailboxIds as Record<string, boolean> | undefined) ?? {});
    const inNotes = boxes.some((id) => folderIds.has(id)) || keywords?.[NOTE_KEYWORD] === true;
    if (!inNotes) {
      if (latest.notes[raw.id as string]) leftFolder.push(raw.id as string);
      continue;
    }
    // A folder another member just created.
    for (const id of boxes) folderIds.add(id);
    const entry = parseNote(raw);
    if (!entry) continue;
    kept.push(entry);
    if (created.includes(entry.id) && !latest.notes[entry.id]) arrived.push(entry);
  }
  runtime.baseline = since;
  const gone = new Set([...destroyed, ...leftFolder]);
  patchTeam(key, (t) => {
    const notes = withNotes(t, kept);
    for (const id of gone) delete notes[id];
    return { notes, folderIds: [...folderIds].sort() };
  });
  // Text of new notes, so an open conversation shows them in full at once.
  if (arrived.length > 0) {
    await loadTexts(key, arrived.map((n) => n.id)).catch(() => undefined);
    const withText = arrived.map((n) => team(key)?.notes[n.id] ?? n);
    for (const listener of [...arrivalListeners]) {
      try {
        listener(latest.ref, client, withText);
      } catch (error) {
        debug.warn('team-mailboxes', 'Note listener failed:', error);
      }
    }
  }
}

async function reloadIndexQuietly(key: string): Promise<void> {
  const runtime = runtimes.get(key);
  const current = team(key);
  if (!runtime || !current) return;
  await loadIndex(current.ref, runtime.client);
}

async function loadTexts(key: string, ids: readonly string[]): Promise<void> {
  const runtime = runtimes.get(key);
  const current = team(key);
  if (!runtime || !current || ids.length === 0 || !runtime.client.getTeamNotes) return;
  const { list } = await runtime.client.getTeamNotes(current.ref.accountId, ids, NOTE_INDEX_PROPERTIES, { text: true });
  const entries = list.map(parseNote).filter((e): e is NoteEntry => !!e);
  patchTeam(key, (t) => ({ notes: withNotes(t, entries) }));
}

// ── Conversations ─────────────────────────────────────────────────────

export function conversationKeyOf(keys: readonly string[], threadIds: readonly string[]): string {
  return [...new Set(threadIds)].sort().join(' ') + '|' + [...new Set(keys)].sort().join(' ');
}

/** "Re: Fwd: Offer" → "Offer": the words a subject search matches on. */
export function baseSubject(subject: string | null | undefined): string {
  let s = (subject ?? '').trim();
  for (;;) {
    const next = s.replace(/^\s*(re|fw|fwd|aw|wg|sv|vs|antw|rif|tr|r)\s*(\[\d+\])?\s*:\s*/i, '');
    if (next === s) break;
    s = next;
  }
  return s.trim();
}

/**
 * Makes sure everything about these messages is loaded: notes older than the
 * index window (looked up by subject), and the text of every note. Messages
 * are the conversation's (or the single message's).
 */
export function loadConversation(key: string, messages: readonly ConversationMessage[], keys: readonly string[]): Promise<void> {
  const current = team(key);
  if (!current) return Promise.resolve();
  const threadIds = messages.map((m) => m.threadId).filter((t): t is string => !!t);
  const convKey = conversationKeyOf(keys, threadIds);
  const status = current.conversations[convKey];
  if (status === 'ready' || status === 'loading') return Promise.resolve();
  patchTeam(key, (t) => ({ conversations: { ...t.conversations, [convKey]: 'loading' } }));
  return enqueue(key, async () => {
    try {
      const t = team(key);
      if (!t) return;
      const oldest = messages.reduce((min, m) => Math.min(min, Date.parse(m.receivedAt ?? '') || Date.now()), Date.now());
      if (oldest < t.windowStart && t.folderIds.length > 0) await lookUpOlder(key, messages, keys, threadIds);
      const after = team(key);
      if (!after) return;
      const missing = notesOf(after, keys, threadIds).filter((n) => n.text === undefined).map((n) => n.id);
      await loadTexts(key, missing);
      patchTeam(key, (x) => ({ conversations: { ...x.conversations, [convKey]: 'ready' } }));
    } catch (error) {
      patchTeam(key, (x) => ({ conversations: { ...x.conversations, [convKey]: isOffline(error) ? 'offline' : 'error' } }));
    }
  });
}

/** Retry for "Notes couldn't be loaded" in one conversation. */
export function retryConversation(key: string, messages: readonly ConversationMessage[], keys: readonly string[]): Promise<void> {
  const threadIds = messages.map((m) => m.threadId).filter((t): t is string => !!t);
  const convKey = conversationKeyOf(keys, threadIds);
  patchTeam(key, (t) => {
    const conversations = { ...t.conversations };
    delete conversations[convKey];
    return { conversations };
  });
  return loadConversation(key, messages, keys);
}

async function lookUpOlder(key: string, messages: readonly ConversationMessage[], keys: readonly string[], threadIds: readonly string[]): Promise<void> {
  const runtime = runtimes.get(key);
  const t = team(key);
  if (!runtime || !t || !runtime.client.queryTeamNotes) return;
  const wanted = new Set(keys);
  const threads = new Set(threadIds);
  const subjects = [...new Set(messages.map((m) => baseSubject(m.subject)))];
  const before = new Date(t.windowStart).toISOString();
  const found: NoteEntry[] = [];
  for (const subject of subjects) {
    const conditions: Record<string, unknown>[] = [folderFilter(t.folderIds), { before }];
    if (subject) conditions.push({ subject });
    const filter = { operator: 'AND', conditions };
    let read = 0;
    for (let position = 0; ; position += PAGE) {
      if (read >= LOOKUP_CAP) throw new Error('Too many notes to look through');
      const page = await runtime.client.queryTeamNotes(t.ref.accountId, filter, { limit: PAGE, position, properties: NOTE_INDEX_PROPERTIES });
      read += page.ids.length;
      for (const raw of page.list) {
        const entry = parseNote(raw);
        if (entry && (wanted.has(entry.key) || (entry.threadId && threads.has(entry.threadId)))) found.push(entry);
      }
      if (page.ids.length < PAGE) break;
    }
  }
  if (found.length > 0) patchTeam(key, (x) => ({ notes: withNotes(x, found) }));
}

/** The notes (and timeline entries) of a conversation, oldest first. */
export function notesOf(t: TeamState, keys: readonly string[], threadIds: readonly string[]): NoteEntry[] {
  const keySet = new Set(keys);
  const threadSet = new Set(threadIds);
  return Object.values(t.notes)
    .filter((n) => keySet.has(n.key) || (!!n.threadId && threadSet.has(n.threadId)))
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

/** Notes still being sent, or that couldn't be saved, for these messages. */
export function pendingOf(t: TeamState, keys: readonly string[]): PendingNote[] {
  const keySet = new Set(keys);
  return Object.values(t.pending).filter((p) => keySet.has(p.key)).sort((a, b) => a.at - b.at);
}

// ── Writing ───────────────────────────────────────────────────────────

export interface NoteTarget {
  /** The message the note is about: its id in the group account. */
  emailId: string;
  key: string;
  threadId: string | null;
  subject: string | null | undefined;
}

async function ensureFolder(key: string): Promise<string> {
  const runtime = runtimes.get(key)!;
  const t = team(key)!;
  if (t.folderIds.length > 0) return t.folderIds[0];
  const { client } = runtime;
  // Someone may have made it since the index loaded.
  const again = await findFolders(client, t.ref.accountId);
  if (again.ids.length > 0) {
    patchTeam(key, () => ({ folderIds: again.ids }));
    return again.ids[0];
  }
  if (!client.createTeamNotesFolder) throw new Error('This client cannot write notes');
  const all = await client.getMailboxes(t.ref.accountId);
  const inbox = all.find((m) => m.role === 'inbox');
  const shareWith = inbox && client.getMailboxShareWith
    ? await client.getMailboxShareWith(inbox.originalId ?? inbox.id, t.ref.accountId).catch(() => null)
    : null;
  try {
    const id = await client.createTeamNotesFolder(t.ref.accountId, TEAM_NOTES_FOLDER_NAME, shareWith);
    patchTeam(key, () => ({ folderIds: [id] }));
    return id;
  } catch (error) {
    // Two members writing the first note at once: the other one made it.
    if (jmapErrorType(error) === 'alreadyExists' || jmapErrorType(error) === 'invalidProperties') {
      const made = await findFolders(client, t.ref.accountId);
      if (made.ids.length > 0) {
        patchTeam(key, () => ({ folderIds: made.ids }));
        return made.ids[0];
      }
    }
    throw error;
  }
}

/**
 * Writes a note (kind `note`) or a timeline entry. A note shows at once as
 * pending; on failure it stays pending with the reason (and `canWrite`
 * turns false on `forbidden`). Resolves with the created note's id, or null
 * when it couldn't be saved.
 */
export function writeNote(
  key: string,
  target: NoteTarget,
  input: { kind?: NoteKind; text?: string; mentions?: readonly string[]; localId?: string },
): Promise<string | null> {
  const kind = input.kind ?? 'note';
  const localId = input.localId ?? `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const mentions = kind === 'note' ? [...new Set((input.mentions ?? []).map((m) => m.toLowerCase()))] : [...(input.mentions ?? [])];
  if (kind === 'note') {
    patchTeam(key, (t) => ({
      pending: {
        ...t.pending,
        [localId]: { localId, key: target.key, threadId: target.threadId, text: input.text ?? '', mentions, at: Date.now(), status: 'sending' },
      },
    }));
  }
  return enqueue(key, async () => {
    const runtime = runtimes.get(key);
    const t = team(key);
    if (!runtime || !t?.author || !runtime.client.createTeamNote) throw new Error('Team not loaded');
    try {
      const mailboxId = await ensureFolder(key);
      const { email, messageId } = buildNoteEmail({
        mailboxId, author: t.author, groupAddress: t.ref.groupAddress, subject: target.subject,
        key: target.key, threadId: target.threadId, kind, mentions, text: input.text,
      });
      const { id } = await runtime.client.createTeamNote(t.ref.accountId, email);
      const entry: NoteEntry = {
        id, messageId, key: target.key, threadId: target.threadId, kind, author: t.author, at: Date.now(),
        mentions, text: kind === 'note' ? (input.text ?? '').trim() : '', subject: target.subject ?? '',
      };
      patchTeam(key, (x) => {
        const pending = { ...x.pending };
        delete pending[localId];
        return { pending, notes: withNotes(x, [entry]), canWrite: true };
      });
      if (kind === 'note') void markOriginal(key, target.emailId, mentions);
      return id;
    } catch (error) {
      const reason = saveError(error);
      debug.warn('team-mailboxes', `Saving a ${kind} failed (${reason}):`, error);
      patchTeam(key, (x) => ({
        ...(reason === 'forbidden' ? { canWrite: false } : {}),
        pending: kind === 'note'
          ? { ...x.pending, [localId]: { ...x.pending[localId], status: 'error', error: reason } }
          : x.pending,
      }));
      return null;
    }
  });
}

/** Retry for a note that couldn't be saved: same text, same place in the list. */
export function retryNote(key: string, localId: string, target: NoteTarget): Promise<string | null> {
  const p = team(key)?.pending[localId];
  if (!p) return Promise.resolve(null);
  return writeNote(key, target, { kind: 'note', text: p.text, mentions: p.mentions, localId });
}

/** Drops a failed note (its text went back into the field). */
export function discardPending(key: string, localId: string): void {
  patchTeam(key, (t) => {
    const pending = { ...t.pending };
    delete pending[localId];
    return { pending };
  });
}

// ── Assignment ────────────────────────────────────────────────────────

/** The message an assignment is about, in the group account, with the keywords it has now. */
export interface AssignableEmail {
  id: string;
  messageId?: readonly string[] | null;
  threadId?: string | null;
  subject?: string | null;
  keywords?: Readonly<Record<string, boolean>> | null;
}

export type AssignmentKind = 'assigned' | 'unassigned' | 'done' | 'reopened';

export interface AssignmentResult {
  kind: AssignmentKind;
  /** False when the message already was that way: nothing was written, there is nothing to undo. */
  changed: boolean;
  /** For `assigned`: who has it now, for the toast ("Assigned to you" when `me`). `name` is '' when unknown. */
  assignee?: { id: string; name: string; me: boolean };
  /** The message's keywords after the change, for the caller's row. */
  keywords: Record<string, boolean>;
  /** The keyword change written (keyword → true, or null for removed). */
  patch: KeywordPatch;
  /**
   * Takes the change back: the keywords as they were, and the timeline
   * entry removed (or, if it can't be, the opposite entry written). Rejects
   * when the keywords can't be written back.
   */
  undo: () => Promise<void>;
  /** The timeline entry's id once written; null when it couldn't be (the change stands). */
  timeline: Promise<string | null>;
}

function pointerPatch(patch: KeywordPatch): Record<string, boolean | null> {
  return Object.fromEntries(Object.entries(patch).map(([keyword, value]) => [keywordPointer(keyword), value]));
}

function patchedKeywords(keywords: AssignableEmail['keywords'], patch: KeywordPatch): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [keyword, on] of Object.entries(keywords ?? {})) {
    if (on && !(keyword.toLowerCase() in patch)) out[keyword] = true;
  }
  for (const [keyword, value] of Object.entries(patch)) if (value === true) out[keyword] = true;
  return out;
}

/** A name for a principal id from what the team knows: the names list, the directory, the user. */
function knownPerson(t: TeamState, client: IJMAPClient, id: string): Person | null {
  const names = useTeamNamesStore.getState();
  const listed = names.lists[t.ref.key]?.[id] ?? names.directory[t.ref.loginId]?.[id];
  if (listed) return listed;
  if (id === client.getAccountId().toLowerCase() && t.author) return { name: t.author.name || t.author.email, email: t.author.email };
  return null;
}

/** The timeline entry that says the opposite, for an undo whose entry couldn't be removed. */
function oppositeEntry(kind: AssignmentKind, before: readonly string[]): { kind: AssignmentKind; mentions: string[] } {
  switch (kind) {
    case 'assigned':
    case 'unassigned':
      return before[0] ? { kind: 'assigned', mentions: [before[0]] } : { kind: 'unassigned', mentions: [] };
    case 'done':
      return { kind: 'reopened', mentions: [] };
    case 'reopened':
      return { kind: 'done', mentions: [] };
  }
}

/**
 * One keyword write on the message in the team's own account (rejects when
 * it fails, for "Couldn't change the message. Try again."), then the
 * timeline entry, which never fails the change.
 */
async function changeAssignment(
  key: string,
  email: AssignableEmail,
  kind: AssignmentKind,
  patch: KeywordPatch,
  assignee?: AssignmentResult['assignee'],
): Promise<AssignmentResult> {
  const runtime = runtimes.get(key);
  const t = team(key);
  if (!runtime || !t) throw new Error('Team not loaded');
  const { client } = runtime;
  const { accountId } = t.ref;
  if (Object.keys(patch).length === 0) {
    return { kind, changed: false, assignee, keywords: patchedKeywords(email.keywords, {}), patch, undo: async () => {}, timeline: Promise.resolve(null) };
  }
  await client.batchUpdateKeywords([email.id], pointerPatch(patch), accountId);
  const before = assigneesOf(email.keywords);
  const target: NoteTarget = { emailId: email.id, key: noteKeyFor(email, accountId), threadId: email.threadId ?? null, subject: email.subject };
  const timeline = writeNote(key, target, { kind, mentions: kind === 'assigned' && assignee ? [assignee.id] : [] })
    .catch((error) => {
      debug.warn('team-mailboxes', `The ${kind} line couldn't be written; the change stands:`, error);
      return null;
    });
  // One-shot: the toast's Undo and Ctrl+Z may both reach it.
  let undoing: Promise<void> | null = null;
  const undo = () => {
    undoing ??= (async () => {
      await client.batchUpdateKeywords([email.id], pointerPatch(reversePatch(patch)), accountId);
      const entryId = await timeline;
      if (entryId) await removeTimelineEntry(key, entryId, target, oppositeEntry(kind, before));
    })();
    return undoing;
  };
  return { kind, changed: true, assignee, keywords: patchedKeywords(email.keywords, patch), patch, undo, timeline };
}

/** Removes a timeline entry after an undo; where that fails, writes the opposite entry so the timeline still tells the truth. */
function removeTimelineEntry(key: string, entryId: string, target: NoteTarget, opposite: { kind: AssignmentKind; mentions: string[] }): Promise<void> {
  return enqueue(key, async () => {
    const runtime = runtimes.get(key);
    const t = team(key);
    if (!runtime?.client.destroyTeamNote || !t) throw new Error('Team not loaded');
    await runtime.client.destroyTeamNote(t.ref.accountId, entryId);
    patchTeam(key, (x) => {
      const notes = { ...x.notes };
      delete notes[entryId];
      return { notes };
    });
  }).catch(async (error) => {
    // Already gone (someone else removed it): nothing to put right.
    if (jmapErrorType(error) === 'notFound') return;
    debug.warn('team-mailboxes', 'Removing a timeline line after an undo failed:', error);
    await writeNote(key, target, opposite).catch(() => null);
  });
}

/**
 * Assigns the message to `principalId` and nobody else. `person` (from the
 * Assign to dialog) names them; the assignee and the user go into the
 * team's names list, best effort.
 */
export async function assign(key: string, email: AssignableEmail, principalId: string, person?: Person | null): Promise<AssignmentResult> {
  const runtime = runtimes.get(key);
  const t = team(key);
  if (!runtime || !t) throw new Error('Team not loaded');
  const { client } = runtime;
  const id = principalId.toLowerCase();
  const selfId = client.getAccountId().toLowerCase();
  const me = id === selfId;
  const who = person?.name || person?.email ? person : knownPerson(t, client, id);
  const result = await changeAssignment(key, email, 'assigned', assignChanges(email.keywords, id), { id, name: who?.name || who?.email || '', me });
  const additions: Record<string, Person> = {};
  const self = knownPerson(t, client, selfId);
  if (self) additions[selfId] = self;
  if (who && !me) additions[id] = { name: who.name || who.email, email: who.email };
  if (Object.keys(additions).length > 0) void addToTeamNames(t.ref, client, additions);
  return result;
}

/** Assign to me: the user's principal id is their primary account id. */
export function assignToMe(key: string, email: AssignableEmail): Promise<AssignmentResult> {
  const runtime = runtimes.get(key);
  if (!runtime) return Promise.reject(new Error('Team not loaded'));
  return assign(key, email, runtime.client.getAccountId());
}

export function unassign(key: string, email: AssignableEmail): Promise<AssignmentResult> {
  return changeAssignment(key, email, 'unassigned', unassignChanges(email.keywords));
}

export function markDone(key: string, email: AssignableEmail): Promise<AssignmentResult> {
  return changeAssignment(key, email, 'done', doneChanges(email.keywords));
}

export function reopen(key: string, email: AssignableEmail): Promise<AssignmentResult> {
  return changeAssignment(key, email, 'reopened', reopenChanges(email.keywords));
}

/**
 * The keywords on the message itself that the With notes and Mentions me
 * filters read. Best effort: a failure never fails the note, and opening the
 * conversation repairs them (repairOriginalKeywords).
 */
async function markOriginal(key: string, emailId: string, mentions: readonly string[]): Promise<void> {
  const runtime = runtimes.get(key);
  const t = team(key);
  if (!runtime || !t) return;
  // Patch paths, not keyword names: batchUpdateKeywords sends them as is.
  const patch: Record<string, boolean> = { [keywordPointer(NOTES_KEYWORD)]: true };
  for (const id of mentions) patch[keywordPointer(mentionKeyword(id))] = true;
  await runtime.client.batchUpdateKeywords([emailId], patch, t.ref.accountId)
    .catch((error) => debug.warn('team-mailboxes', 'Marking the message as having notes failed:', error));
}

/**
 * Brings the filter keywords of the conversation's messages in line with
 * their notes (both ways), once the conversation's notes are complete.
 * `messages` carry their keywords. Only where the user may set keywords.
 */
export async function repairOriginalKeywords(
  key: string,
  messages: ReadonlyArray<{ id: string; key: string; keywords?: Record<string, boolean> }>,
): Promise<void> {
  const runtime = runtimes.get(key);
  const t = team(key);
  if (!runtime || !t || t.status !== 'ready') return;
  for (const message of messages) {
    const notes = Object.values(t.notes).filter((n) => n.key === message.key && n.kind === 'note');
    const want: Record<string, boolean> = {};
    if (notes.length > 0) want[NOTES_KEYWORD] = true;
    for (const n of notes) for (const id of n.mentions) want[mentionKeyword(id)] = true;
    const have = Object.keys(message.keywords ?? {}).filter((k) => k === NOTES_KEYWORD || k.startsWith('$bulwark-mention-'));
    const patch: Record<string, boolean | null> = {};
    for (const k of Object.keys(want)) if (!message.keywords?.[k]) patch[keywordPointer(k)] = true;
    for (const k of have) if (!want[k]) patch[keywordPointer(k)] = null;
    if (Object.keys(patch).length === 0) continue;
    await runtime.client.batchUpdateKeywords([message.id], patch, t.ref.accountId)
      .catch((error) => debug.warn('team-mailboxes', 'Repairing note keywords failed:', error));
  }
}

/**
 * Deletes the user's own note for good. Someone else's note is refused here,
 * not only by hiding the button. Resolves with an undo that writes it back
 * with the same Message-ID and time, or null when the delete failed (the
 * note is back in the list then).
 */
export function deleteNote(key: string, noteId: string): Promise<(() => Promise<boolean>) | null> {
  const t = team(key);
  const note = t?.notes[noteId];
  if (!t || !note || note.kind !== 'note' || !isOwnNote(note, t.author?.email)) return Promise.resolve(null);
  patchTeam(key, (x) => {
    const notes = { ...x.notes };
    delete notes[noteId];
    return { notes };
  });
  return enqueue(key, async () => {
    const runtime = runtimes.get(key);
    if (!runtime?.client.destroyTeamNote) return null;
    try {
      await runtime.client.destroyTeamNote(t.ref.accountId, noteId);
    } catch (error) {
      debug.warn('team-mailboxes', 'Deleting a note failed:', error);
      patchTeam(key, (x) => ({ notes: withNotes(x, [note]) }));
      return null;
    }
    return () => undoDelete(key, note);
  });
}

function undoDelete(key: string, note: NoteEntry): Promise<boolean> {
  return enqueue(key, async () => {
    const runtime = runtimes.get(key);
    const t = team(key);
    if (!runtime || !t?.author || !runtime.client.createTeamNote) return false;
    try {
      const mailboxId = await ensureFolder(key);
      const { email } = buildNoteEmail({
        mailboxId, author: t.author, groupAddress: t.ref.groupAddress, subject: note.subject,
        key: note.key, threadId: note.threadId, kind: note.kind, mentions: note.mentions, text: note.text,
        messageId: note.messageId ?? undefined, receivedAt: new Date(note.at).toISOString(),
      });
      const { id } = await runtime.client.createTeamNote(t.ref.accountId, email);
      patchTeam(key, (x) => ({ notes: withNotes(x, [{ ...note, id }]) }));
      return true;
    } catch (error) {
      debug.warn('team-mailboxes', 'Bringing a note back failed:', error);
      return false;
    }
  });
}

// ── Seen notes (the dot on list rows) ─────────────────────────────────

const SEEN_WRITE_GAP_MS = 60_000;
const seenLogins = new Map<string, { client: IJMAPClient; loading: Promise<void> | null; lastWrite: number; timer: ReturnType<typeof setTimeout> | null }>();
const seenStorageKey = (loginId: string) => `bulwark-team-seen:${loginId}`;

function privateMetadata(client: IJMAPClient): boolean {
  return !!client.advertisesPrivateBulwarkMetadata?.() && !!client.getBulwarkMetadata && !!client.setBulwarkMetadata;
}

/** Reads the login's seen map once: private Inbox metadata where the server has it, else this device. */
function ensureSeenLoaded(ref: TeamRef, client: IJMAPClient): Promise<void> {
  const known = seenLogins.get(ref.loginId);
  if (known) return known.loading ?? Promise.resolve();
  const entry = { client, loading: null as Promise<void> | null, lastWrite: 0, timer: null as ReturnType<typeof setTimeout> | null };
  seenLogins.set(ref.loginId, entry);
  entry.loading = (async () => {
    let map: SeenMap = {};
    try {
      if (privateMetadata(client)) {
        const entries = await client.getBulwarkMetadata!(undefined, { private: true });
        map = decodeSeen(entries?.[SEEN_METADATA_KEY]);
      } else {
        map = decodeSeen(JSON.parse(localStorage.getItem(seenStorageKey(ref.loginId)) ?? 'null'));
      }
    } catch (error) {
      debug.warn('team-mailboxes', 'Reading seen notes failed:', error);
    }
    useTeamMailboxStore.setState((s) => ({ seen: { ...s.seen, [ref.loginId]: { ...map, ...(s.seen[ref.loginId] ?? {}) } } }));
  })().finally(() => { entry.loading = null; });
  return entry.loading;
}

/** The first visit to a team mailbox: older notes count as seen. */
function ensureBaseline(ref: TeamRef): void {
  const map = useTeamMailboxStore.getState().seen[ref.loginId] ?? {};
  if (map[ref.accountId]) return;
  setSeen(ref.loginId, { ...map, [ref.accountId]: { baseline: Date.now(), threads: {} } });
}

function setSeen(loginId: string, map: SeenMap): void {
  useTeamMailboxStore.setState((s) => ({ seen: { ...s.seen, [loginId]: map } }));
  scheduleSeenWrite(loginId);
}

/** At most one write a minute: a private metadata write changes the user's Inbox state. */
function scheduleSeenWrite(loginId: string): void {
  const entry = seenLogins.get(loginId);
  if (!entry || entry.timer) return;
  const wait = Math.max(0, entry.lastWrite + SEEN_WRITE_GAP_MS - Date.now());
  entry.timer = setTimeout(() => {
    entry.timer = null;
    void flushSeen(loginId);
  }, wait);
}

export async function flushSeen(loginId: string): Promise<void> {
  const entry = seenLogins.get(loginId);
  const map = useTeamMailboxStore.getState().seen[loginId];
  if (!entry || !map) return;
  entry.lastWrite = Date.now();
  const value = encodeSeen(map);
  try {
    if (privateMetadata(entry.client)) await entry.client.setBulwarkMetadata!(undefined, SEEN_METADATA_KEY, value, { private: true });
    else localStorage.setItem(seenStorageKey(loginId), JSON.stringify(value));
  } catch (error) {
    debug.warn('team-mailboxes', 'Saving seen notes failed:', error);
    try { localStorage.setItem(seenStorageKey(loginId), JSON.stringify(value)); } catch { /* storage full or blocked */ }
  }
}

/** The conversation is on screen: its notes up to now are seen. */
export function markConversationSeen(key: string, threadIds: readonly string[]): void {
  const t = team(key);
  if (!t) return;
  const { loginId, accountId } = t.ref;
  let map = useTeamMailboxStore.getState().seen[loginId] ?? {};
  const before = map;
  for (const threadId of threadIds) {
    const newest = Object.values(t.notes).reduce((max, n) => (n.threadId === threadId && n.kind === 'note' ? Math.max(max, n.at) : max), 0);
    if (newest > 0) map = markThreadSeen(map, accountId, threadId, newest);
  }
  if (map !== before) setSeen(loginId, map);
}

const rowInfoCache = new WeakMap<TeamState, { seen: SeenMap | undefined; byThread: Map<string, { count: number; newestOther: number }>; byKey: Map<string, number> }>();

/**
 * For a list row: how many notes its conversation has (timeline entries
 * don't count) and whether one by someone else is new to the user.
 */
export function rowNotesInfo(t: TeamState, threadId: string | null | undefined, key?: string): { count: number; unseen: boolean } {
  const seenMap = useTeamMailboxStore.getState().seen[t.ref.loginId];
  let cached = rowInfoCache.get(t);
  if (!cached || cached.seen !== seenMap) {
    const byThread = new Map<string, { count: number; newestOther: number }>();
    const byKey = new Map<string, number>();
    const own = t.author?.email ?? '';
    for (const n of Object.values(t.notes)) {
      if (n.kind !== 'note') continue;
      if (n.threadId) {
        const row = byThread.get(n.threadId) ?? { count: 0, newestOther: 0 };
        row.count += 1;
        if (n.author.email !== own) row.newestOther = Math.max(row.newestOther, n.at);
        byThread.set(n.threadId, row);
      } else {
        byKey.set(n.key, (byKey.get(n.key) ?? 0) + 1);
      }
    }
    cached = { seen: seenMap, byThread, byKey };
    rowInfoCache.set(t, cached);
  }
  const row = threadId ? cached.byThread.get(threadId) : undefined;
  const count = (row?.count ?? 0) + (key ? cached.byKey.get(key) ?? 0 : 0);
  const unseen = !!row && !!threadId && row.newestOther > 0 && isUnseen(seenMap?.[t.ref.accountId], threadId, row.newestOther);
  return { count, unseen };
}

/** For tests: forget every team. */
export function resetTeamMailboxStore(): void {
  runtimes.clear();
  arrivalListeners.clear();
  for (const entry of seenLogins.values()) if (entry.timer) clearTimeout(entry.timer);
  seenLogins.clear();
  unsubscribePush?.();
  unsubscribePush = null;
  useTeamMailboxStore.setState({ teams: {}, seen: {} });
}
