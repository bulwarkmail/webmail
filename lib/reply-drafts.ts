import type { Email } from '@/lib/jmap/types';
import { stripMessageIdBrackets } from '@/lib/email-threading';

/**
 * A reply saved as a draft, found from the message it answers (compose-p2-6).
 * The reader marks that message with it, and Reply opens it again instead of
 * starting a second draft, as Gmail and Outlook do.
 */

/** The message's own Message-IDs, bare. JMAP sends a list; older code a string. */
function messageIdsOf(email: Pick<Email, 'messageId'>): string[] {
  const raw = email.messageId as unknown;
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  return list.filter((id): id is string => typeof id === 'string').map(stripMessageIdBrackets).filter(Boolean);
}

/** Whether `draft` is a reply to `email` (its In-Reply-To names it). */
export function answersMessage(draft: Pick<Email, 'inReplyTo' | 'keywords'>, email: Pick<Email, 'messageId'>): boolean {
  if (!draft.keywords?.$draft) return false;
  const ids = messageIdsOf(email);
  if (ids.length === 0) return false;
  return (draft.inReplyTo ?? []).some((id) => ids.includes(stripMessageIdBrackets(id)));
}

const newestFirst = (a: Pick<Email, 'receivedAt'>, b: Pick<Email, 'receivedAt'>) =>
  (b.receivedAt ?? '').localeCompare(a.receivedAt ?? '');

/**
 * The newest of a conversation's drafts that answers `email`, in full. List
 * rows carry no In-Reply-To, so a draft without it is read once more through
 * `getEmail`; one that has it (a full fetch) is taken as it is.
 */
export async function findReplyDraft(
  drafts: readonly Email[],
  email: Pick<Email, 'id' | 'messageId'>,
  getEmail: (id: string) => Promise<Email | null>,
): Promise<Email | null> {
  if (messageIdsOf(email).length === 0) return null;
  const candidates = drafts.filter((d) => d.id !== email.id && d.keywords?.$draft).sort(newestFirst);
  for (const candidate of candidates) {
    const full = candidate.inReplyTo !== undefined ? candidate : await getEmail(candidate.id).catch(() => null);
    if (full && answersMessage(full, email)) return full;
  }
  return null;
}

/** A conversation's drafts, read fresh (after a composer closed or a draft went). */
export async function threadDrafts(
  client: { getThread(threadId: string, accountId?: string): Promise<{ emailIds: string[] } | null>; getSomeEmails(ids: string[], accountId?: string): Promise<Email[]> },
  threadId: string,
  accountId: string | undefined,
): Promise<Email[]> {
  const thread = await client.getThread(threadId, accountId);
  const ids = thread?.emailIds ?? [];
  if (ids.length < 2) return [];
  const members = await client.getSomeEmails(ids, accountId);
  return members.filter((e) => e.keywords?.$draft);
}
