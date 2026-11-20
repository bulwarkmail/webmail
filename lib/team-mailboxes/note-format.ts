/**
 * A team note is one small plain-text message in the "Team notes" folder of a
 * team mailbox (lib/team-mailboxes/hidden-folders.ts), created with
 * Email/set and never sent:
 *
 *   From: the person who wrote it          To: the group's address
 *   Subject: Note: <subject of the message it is about>
 *   Message-ID: <uuid@notes.bulwark.invalid>
 *   X-Bulwark-Note-For: <Message-ID of that message>
 *   X-Bulwark-Note-Thread: <its thread id in the group account>
 *   X-Bulwark-Note-Kind: note | assigned | unassigned | done | reopened
 *   X-Bulwark-Note-Mentions: <principal ids, comma-separated>
 *   keywords $seen, $bulwark-note, and $bulwark-mention-<id> per mention
 *
 * The For header ties the note to its message by Message-ID, which survives
 * moves between folders and accounts; a message without one is keyed
 * `jmap:<accountId>/<emailId>`. The thread header only lets list rows count
 * their notes without loading the conversation. No In-Reply-To or References,
 * so the server never threads a note into the customer's conversation.
 * Timeline entries (assigned, done, ...) are notes of that kind with no text;
 * for `assigned` the mentions header names the assignee, but only kind
 * `note` ever notifies anyone.
 */

import { NOTE_KEYWORD } from './hidden-folders';

export type NoteKind = 'note' | 'assigned' | 'unassigned' | 'done' | 'reopened';
export const NOTE_KINDS: readonly NoteKind[] = ['note', 'assigned', 'unassigned', 'done', 'reopened'];

/** Longest note that can be written. Longer ones from other clients are shown cut. */
export const MAX_NOTE_CHARS = 4000;

/** The keyword a note carries for each member it mentions. */
export function mentionKeyword(principalId: string): string {
  return `$bulwark-mention-${principalId.toLowerCase()}`;
}

/** On a message that has notes (for the With notes filter). */
export const NOTES_KEYWORD = '$bulwark-notes';

const H_FOR = 'header:X-Bulwark-Note-For:asText';
const H_THREAD = 'header:X-Bulwark-Note-Thread:asText';
const H_KIND = 'header:X-Bulwark-Note-Kind:asText';
const H_MENTIONS = 'header:X-Bulwark-Note-Mentions:asText';

/** The note headers as Email/get properties (the push preview reads them without the rest). */
export const NOTE_HEADER_PROPERTIES = { for: H_FOR, thread: H_THREAD, kind: H_KIND, mentions: H_MENTIONS } as const;

/** What the index reads of a note: no body, no preview (megabytes for a big team). */
export const NOTE_INDEX_PROPERTIES = [
  'id', 'receivedAt', 'from', 'keywords', 'mailboxIds', 'messageId', 'subject', H_FOR, H_THREAD, H_KIND, H_MENTIONS,
] as const;

export interface NoteAuthor {
  name: string;
  email: string;
}

export interface NoteEntry {
  /** The note message's JMAP id in the group account. */
  id: string;
  /** Its own Message-ID (kept so Undo can bring it back the same). */
  messageId: string | null;
  /** Message-ID of the message it is about, or `jmap:<accountId>/<emailId>`. */
  key: string;
  /** Thread id of that message in the group account, when the writer knew it. */
  threadId: string | null;
  kind: NoteKind;
  author: NoteAuthor;
  /** When it was written (server receivedAt), ms. */
  at: number;
  /** Principal ids, lower case. */
  mentions: string[];
  /** The text, once loaded; '' for timeline entries. */
  text?: string;
  /** The note was longer than MAX_NOTE_CHARS and is shown cut. */
  truncated?: boolean;
  /** Subject of the message it is about (from "Note: <subject>"), kept for Undo. */
  subject?: string;
}

/** `<abc@x>` → `abc@x`; trims and drops one pair of brackets. */
export function stripAngles(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1).trim() : trimmed;
}

/**
 * The key notes about this message use: its Message-ID, or
 * `jmap:<accountId>/<emailId>` when it has none.
 */
export function noteKeyFor(email: { id: string; messageId?: readonly string[] | null }, accountId: string): string {
  const first = email.messageId?.find((id) => typeof id === 'string' && id.trim());
  return first ? stripAngles(first) : `jmap:${accountId}/${email.id}`;
}

/** "Note: <subject>", one line, at most 200 characters. */
export function noteSubject(subject: string | null | undefined): string {
  const line = (subject ?? '').replace(/\s+/g, ' ').trim();
  return `Note: ${line}`.slice(0, 200).trimEnd();
}

/** How a text fits the limit: characters left, or how many too many. */
export function noteLength(text: string): { left: number; over: number } {
  const length = [...text].length;
  return { left: Math.max(0, MAX_NOTE_CHARS - length), over: Math.max(0, length - MAX_NOTE_CHARS) };
}

function newMessageId(): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${random}@notes.bulwark.invalid`;
}

export interface NoteDraft {
  mailboxId: string;
  author: NoteAuthor;
  groupAddress: string;
  /** Subject of the message the note is about. */
  subject: string | null | undefined;
  key: string;
  threadId?: string | null;
  kind: NoteKind;
  /** Principal ids already checked against the team (mentions.ts). */
  mentions?: readonly string[];
  text?: string;
  /** Kept on Undo so the note comes back with the same key and time. */
  messageId?: string;
  receivedAt?: string;
}

/**
 * The Email/set create object for a note. Throws on text over the limit or a
 * kind that isn't known: the caller checks first, so this is a bug guard.
 */
export function buildNoteEmail(draft: NoteDraft): { email: Record<string, unknown>; messageId: string } {
  if (!NOTE_KINDS.includes(draft.kind)) throw new Error(`Unknown note kind ${draft.kind}`);
  const text = draft.kind === 'note' ? (draft.text ?? '').trim() : '';
  if (noteLength(text).over > 0) throw new Error('The note is too long');
  const messageId = draft.messageId ?? newMessageId();
  const mentions = [...new Set((draft.mentions ?? []).map((id) => id.toLowerCase()))];
  const keywords: Record<string, boolean> = { $seen: true, [NOTE_KEYWORD]: true };
  if (draft.kind === 'note') for (const id of mentions) keywords[mentionKeyword(id)] = true;
  const email: Record<string, unknown> = {
    mailboxIds: { [draft.mailboxId]: true },
    keywords,
    from: [{ name: draft.author.name || null, email: draft.author.email }],
    to: [{ name: null, email: draft.groupAddress }],
    subject: noteSubject(draft.subject),
    messageId: [messageId],
    [H_FOR]: `<${draft.key}>`,
    [H_KIND]: draft.kind,
    bodyStructure: { type: 'text/plain', partId: '1' },
    bodyValues: { '1': { value: text } },
  };
  if (draft.threadId) email[H_THREAD] = draft.threadId;
  if (mentions.length > 0) email[H_MENTIONS] = mentions.join(', ');
  if (draft.receivedAt) email.receivedAt = draft.receivedAt;
  return { email, messageId };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Ids from "cj, Mabel ,x" → ['cj', 'mabel', 'x']; anything that isn't an id is dropped. */
export function parseMentions(value: unknown): string[] {
  const raw = str(value);
  if (!raw) return [];
  return [...new Set(raw.split(/[\s,]+/).map((id) => id.trim().toLowerCase()).filter((id) => /^[a-z0-9][a-z0-9_.-]{0,100}$/.test(id)))];
}

/**
 * A note from an Email/get answer (NOTE_INDEX_PROPERTIES, plus bodyValues /
 * textBody when the text was asked for). Null when it isn't a usable note: no
 * For header, an unknown kind, or no sender.
 */
export function parseNote(raw: Record<string, unknown>): NoteEntry | null {
  const id = str(raw.id);
  const forValue = str(raw[H_FOR]);
  const kind = str(raw[H_KIND])?.toLowerCase() as NoteKind | undefined;
  if (!id || !forValue || !kind || !NOTE_KINDS.includes(kind)) return null;
  const key = stripAngles(forValue);
  if (!key) return null;
  const from = Array.isArray(raw.from) ? (raw.from[0] as { name?: unknown; email?: unknown } | undefined) : undefined;
  const authorEmail = str(from?.email);
  if (!authorEmail) return null;
  const at = Date.parse(String(raw.receivedAt ?? ''));
  const messageIds = Array.isArray(raw.messageId) ? raw.messageId : [];
  const entry: NoteEntry = {
    id,
    messageId: typeof messageIds[0] === 'string' ? stripAngles(messageIds[0]) : null,
    key,
    threadId: str(raw[H_THREAD]),
    kind,
    author: { name: str(from?.name) ?? '', email: authorEmail.toLowerCase() },
    at: Number.isFinite(at) ? at : 0,
    mentions: parseMentions(raw[H_MENTIONS]),
  };
  const subject = typeof raw.subject === 'string' ? raw.subject.replace(/^\s*Note:\s?/, '') : undefined;
  if (subject !== undefined) entry.subject = subject;
  const text = noteTextOf(raw);
  if (text !== undefined) {
    const chars = [...text];
    entry.truncated = chars.length > MAX_NOTE_CHARS;
    entry.text = entry.truncated ? `${chars.slice(0, MAX_NOTE_CHARS).join('')}…` : text;
  }
  if (kind !== 'note') entry.text = '';
  return entry;
}

/** The plain text of a note from bodyValues, if the answer carried it. */
function noteTextOf(raw: Record<string, unknown>): string | undefined {
  const values = raw.bodyValues as Record<string, { value?: unknown }> | undefined;
  if (!values) return undefined;
  const parts = Array.isArray(raw.textBody) ? (raw.textBody as Array<{ partId?: string }>) : [];
  const partId = parts.find((p) => p.partId && values[p.partId])?.partId ?? Object.keys(values)[0];
  const value = partId ? values[partId]?.value : undefined;
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : '';
}

/** Whether `author` wrote this note (the address decides, case-insensitive). */
export function isOwnNote(entry: Pick<NoteEntry, 'author'>, ownEmail: string | null | undefined): boolean {
  return !!ownEmail && entry.author.email === ownEmail.trim().toLowerCase();
}
