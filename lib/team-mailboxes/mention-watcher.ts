/**
 * Mentions of the user in team notes, from sign-in on, wherever the user is
 * in the app: a light watcher per team mailbox with its own Email/changes
 * baseline, independent of the notes index (which loads only when a team
 * mailbox is opened). It reads the few header properties of new messages in
 * the team account and reports notes (kind `note`) that mention the user's
 * own principal id and that someone else wrote. Nothing for anybody else.
 *
 * Listeners: the in-app toast and notification centre
 * (components/team-mailboxes/team-mention-host.tsx) and the desktop app's OS
 * notification (lib/desktop/mention-notifications.ts).
 */

import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { StateChange } from '@/lib/jmap/types';
import { subscribePushStateChanges } from '@/lib/push-events';
import { debug } from '@/lib/debug';
import { NOTE_KEYWORD } from './hidden-folders';
import { NOTE_INDEX_PROPERTIES, isOwnNote, parseNote, type NoteEntry } from './note-format';
import type { TeamRef } from './team';

export interface MentionEvent {
  ref: TeamRef;
  client: IJMAPClient;
  note: NoteEntry;
}

type MentionListener = (event: MentionEvent) => void;

interface Watch {
  ref: TeamRef;
  client: IJMAPClient;
  baseline: string | null;
  queue: Promise<unknown>;
  /** Notes already reported (a push can repeat a change). */
  told: Set<string>;
}

const listeners = new Set<MentionListener>();
const watches = new Map<string, Watch>();
let unsubscribe: (() => void) | null = null;
/** A note older than this when it is first seen isn't news. */
const FRESH_MS = 24 * 60 * 60 * 1000;

export function onMention(listener: MentionListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Watches exactly these teams (others stop). Called again whenever the
 * logins, the policy or the confirmed groups change.
 */
export function watchMentions(teams: ReadonlyArray<{ ref: TeamRef; client: IJMAPClient }>): void {
  const wanted = new Set(teams.map((t) => t.ref.key));
  for (const key of [...watches.keys()]) if (!wanted.has(key)) watches.delete(key);
  for (const { ref, client } of teams) {
    const existing = watches.get(ref.key);
    if (existing && existing.client === client) continue;
    const watch: Watch = { ref, client, baseline: null, queue: Promise.resolve(), told: new Set() };
    watches.set(ref.key, watch);
    run(watch, () => takeBaseline(watch));
  }
  if (watches.size > 0 && !unsubscribe) unsubscribe = subscribePushStateChanges((change, client) => onPush(change, client));
  if (watches.size === 0 && unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}

function run(watch: Watch, task: () => Promise<void>): Promise<void> {
  const next = watch.queue.then(task, task).catch((error) => debug.warn('team-mailboxes', 'Mention check failed:', error));
  watch.queue = next;
  return next;
}

async function takeBaseline(watch: Watch): Promise<void> {
  if (!watch.client.getTeamNotes) return;
  watch.baseline = (await watch.client.getTeamNotes(watch.ref.accountId, [], ['id'])).state ?? null;
}

function onPush(change: StateChange, client: IJMAPClient): void {
  for (const watch of watches.values()) {
    if (watch.client !== client || !change.changed[watch.ref.accountId]?.Email) continue;
    void run(watch, () => check(watch));
  }
}

/** New messages in the team account since the baseline: mentions of the user among them. */
export async function check(watch: Watch): Promise<void> {
  const { client, ref } = watch;
  if (!client.getEmailChanges || !client.getTeamNotes) return;
  if (!watch.baseline) return takeBaseline(watch);
  const created: string[] = [];
  let since = watch.baseline;
  for (let round = 0; round < 10; round += 1) {
    const delta = await client.getEmailChanges(since, ref.accountId, 500);
    // Too far behind to say what's new: start over from now, telling nothing.
    if (!delta) return takeBaseline(watch);
    created.push(...delta.created);
    since = delta.newState;
    if (!delta.hasMoreChanges) break;
  }
  watch.baseline = since;
  if (created.length === 0) return;
  const { list } = await client.getTeamNotes(ref.accountId, created, NOTE_INDEX_PROPERTIES);
  const me = client.getAccountId().toLowerCase();
  const own = client.getUsername();
  for (const raw of list) {
    if ((raw.keywords as Record<string, boolean> | undefined)?.[NOTE_KEYWORD] !== true) continue;
    const note = parseNote(raw);
    if (!note || note.kind !== 'note' || !note.mentions.includes(me) || isOwnNote(note, own)) continue;
    if (watch.told.has(note.id) || Date.now() - note.at > FRESH_MS) continue;
    watch.told.add(note.id);
    for (const listener of [...listeners]) {
      try {
        listener({ ref, client, note });
      } catch (error) {
        debug.warn('team-mailboxes', 'Mention listener failed:', error);
      }
    }
  }
}

/** For tests. */
export function resetMentionWatcher(): void {
  watches.clear();
  listeners.clear();
  unsubscribe?.();
  unsubscribe = null;
}

/** For tests: wait for every queued check. */
export async function settleMentionWatcher(): Promise<void> {
  await Promise.all([...watches.values()].map((w) => w.queue));
}
