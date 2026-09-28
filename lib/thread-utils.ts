import type { Email, ThreadGroup } from "./jmap/types";
import { compareEmails, type SortLevel } from "./message-list-order";

/**
 * Client-side identity of a thread.
 *
 * JMAP thread ids are only unique within their account (Stalwart hands out
 * per-account counters such as "b", "c", …), so in views that merge several
 * accounts two unrelated conversations can share a `threadId`. Emails fetched
 * through the aggregate paths carry their source stamps; scoping the key by
 * them keeps those threads apart. Unstamped emails (single-account views) keep
 * the bare id, so nothing changes there. `ThreadGroup.threadId` stays the raw
 * id for JMAP calls - `threadIdFromKey` is the reverse mapping.
 */
export function threadKeyFor(
  email: Pick<Email, "threadId" | "sourceClientAccountId" | "sourceAccountId">,
): string {
  const scope = [email.sourceClientAccountId, email.sourceAccountId].filter(Boolean).join("/");
  return scope ? `${scope}:${email.threadId}` : email.threadId;
}

/**
 * The JMAP thread id behind a `threadKeyFor` key. JMAP ids never contain ":"
 * (RFC 8620 §1.2 limits them to the URL-safe base64 alphabet), so the last
 * separator always splits the scope from the id.
 */
export function threadIdFromKey(threadKey: string): string {
  const at = threadKey.lastIndexOf(":");
  return at === -1 ? threadKey : threadKey.slice(at + 1);
}

/**
 * Groups emails by their threadId and creates ThreadGroup objects for UI display.
 * Single-email threads are still returned as ThreadGroups with emailCount=1.
 * When disableThreading is true, each email is placed into its own group using
 * its message ID as the key, so the list shows individual messages.
 *
 * @param threadEmailCounts - Optional map of threadKey → total email count across
 *   all folders (from Thread/get). When provided, emailCount reflects the full
 *   thread size rather than just the emails in the current folder.
 */
export function groupEmailsByThread(
  emails: Email[],
  disableThreading = false,
  threadEmailCounts?: Map<string, number>,
): ThreadGroup[] {
  if (!emails || emails.length === 0) {
    return [];
  }

  // Group by the account-scoped thread key (or by message id when threading
  // is disabled): bare thread ids collide across accounts in aggregate views.
  const threadMap = new Map<string, Email[]>();

  for (const email of emails) {
    const key = disableThreading ? email.id : threadKeyFor(email);
    if (!threadMap.has(key)) {
      threadMap.set(key, []);
    }
    threadMap.get(key)!.push(email);
  }

  // Convert to ThreadGroup array
  const threadGroups: ThreadGroup[] = [];

  for (const [threadKey, threadEmails] of threadMap) {
    // Sort emails by receivedAt descending (newest first)
    const sortedEmails = [...threadEmails].sort(
      (a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()
    );

    const latestEmail = sortedEmails[0];

    // Collect unique participant names from all emails in thread
    const participantNames = getThreadParticipants(sortedEmails);

    // Check for unread, starred, pinned, and attachments
    const hasUnread = sortedEmails.some(e => !e.keywords?.$seen);
    const hasStarred = sortedEmails.some(e => e.keywords?.$flagged);
    const hasPinned = sortedEmails.some(e => e.keywords?.['$pinned']);
    const hasAttachment = sortedEmails.some(e => e.hasAttachment);
    const hasAnswered = sortedEmails.some(e => e.keywords?.$answered);
    const hasForwarded = sortedEmails.some(e => e.keywords?.$forwarded);

    threadGroups.push({
      // With threading off the "thread" is the single message, keyed by its id.
      threadId: disableThreading ? latestEmail.id : latestEmail.threadId,
      threadKey,
      emails: sortedEmails,
      latestEmail,
      participantNames,
      hasUnread,
      hasStarred,
      hasPinned,
      hasAttachment,
      hasAnswered,
      hasForwarded,
      emailCount: threadEmailCounts?.get(threadKey) ?? sortedEmails.length,
    });
  }

  return threadGroups;
}

/**
 * Sorts thread groups to mirror the order the email list was fetched in.
 * Threads containing a pinned email ($pinned keyword) stay on top, mirroring
 * the server-side pinned-first sort of the email list. Below that, each thread
 * takes the position of whichever of its emails sorts first under `order`
 * (RFC 8621 §4.4.3 thread collapsing semantics) - with the default order that
 * is the latest email's receivedAt date, newest first.
 */
export function sortThreadGroups(groups: ThreadGroup[], order: SortLevel[] = []): ThreadGroup[] {
  const compare = compareEmails(order);
  const representative = new Map<ThreadGroup, Email>();
  for (const group of groups) {
    representative.set(
      group,
      group.emails.reduce((best, email) => (compare(email, best) < 0 ? email : best), group.emails[0] ?? group.latestEmail),
    );
  }
  return [...groups].sort(
    (a, b) =>
      (b.hasPinned ? 1 : 0) - (a.hasPinned ? 1 : 0) ||
      compare(representative.get(a)!, representative.get(b)!)
  );
}

/**
 * Extracts unique participant names from a list of emails.
 * Includes both senders and recipients, limited to avoid UI overflow.
 */
export function getThreadParticipants(emails: Email[], maxNames: number = 4): string[] {
  const seen = new Set<string>();
  const names: string[] = [];

  for (const email of emails) {
    // Add sender
    if (email.from && email.from.length > 0) {
      const sender = email.from[0];
      const senderName = sender.name || sender.email.split('@')[0];
      const key = sender.email.toLowerCase();

      if (!seen.has(key)) {
        seen.add(key);
        names.push(senderName);
      }
    }

    // Stop if we have enough names
    if (names.length >= maxNames) break;
  }

  return names;
}

/**
 * Merges newly fetched thread emails into an existing thread group.
 * Used when expanding a thread to show all emails (some may not have been in the original list).
 */
export function mergeThreadEmails(
  existingGroup: ThreadGroup,
  fetchedEmails: Email[]
): ThreadGroup {
  // Create a map of existing emails by ID
  const emailMap = new Map<string, Email>();

  for (const email of existingGroup.emails) {
    emailMap.set(email.id, email);
  }

  // Add fetched emails that aren't already in the group
  for (const email of fetchedEmails) {
    if (!emailMap.has(email.id)) {
      emailMap.set(email.id, email);
    }
  }

  // Convert back to array and sort
  const mergedEmails = Array.from(emailMap.values()).sort(
    (a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()
  );

  const latestEmail = mergedEmails[0];
  const participantNames = getThreadParticipants(mergedEmails);
  const hasUnread = mergedEmails.some(e => !e.keywords?.$seen);
  const hasStarred = mergedEmails.some(e => e.keywords?.$flagged);
  const hasPinned = mergedEmails.some(e => e.keywords?.['$pinned']);
  const hasAttachment = mergedEmails.some(e => e.hasAttachment);
  const hasAnswered = mergedEmails.some(e => e.keywords?.$answered);
  const hasForwarded = mergedEmails.some(e => e.keywords?.$forwarded);

  return {
    threadId: existingGroup.threadId,
    threadKey: existingGroup.threadKey,
    emails: mergedEmails,
    latestEmail,
    participantNames,
    hasUnread,
    hasStarred,
    hasPinned,
    hasAttachment,
    hasAnswered,
    hasForwarded,
    emailCount: mergedEmails.length,
  };
}

/** Active prefix for new keyword tags written to JMAP */
export const KEYWORD_PREFIX = "$label:";
/** Legacy prefix still recognised when reading */
export const KEYWORD_PREFIX_LEGACY = "$color:";

/**
 * Gets every tag id set on a message.
 * Reads both the current $label: prefix and the legacy $color: prefix.
 * A tag written under both spellings is one tag, so it is returned once.
 */
export function getEmailTagIds(keywords: Record<string, boolean> | undefined): string[] {
  if (!keywords) return [];
  const tags = new Set<string>();
  for (const key of Object.keys(keywords)) {
    if ((key.startsWith(KEYWORD_PREFIX) || key.startsWith(KEYWORD_PREFIX_LEGACY)) && keywords[key] === true) {
      tags.add(
        key.startsWith(KEYWORD_PREFIX)
          ? key.slice(KEYWORD_PREFIX.length)
          : key.slice(KEYWORD_PREFIX_LEGACY.length)
      );
    }
  }
  return [...tags];
}

/**
 * Gets the first tag id set on a message, if any.
 * Reads both the current $label: prefix and the legacy $color: prefix.
 * @deprecated Use getEmailTagIds for multi-tag support.
 */
export function getEmailTagId(keywords: Record<string, boolean> | undefined): string | null {
  const tags = getEmailTagIds(keywords);
  return tags.length > 0 ? tags[0] : null;
}

/**
 * The first tag id found anywhere in a thread, if any.
 */
export function getThreadTagId(emails: Email[]): string | null {
  for (const email of emails) {
    const color = getEmailTagId(email.keywords);
    if (color) return color;
  }
  return null;
}

/**
 * Every tag anywhere in a thread, deduplicated.
 *
 * A collapsed thread row stands in for all its messages, so it has to account
 * for all their tags - showing only the first message's would hide the rest
 * with nothing to indicate they exist.
 */
export function getThreadTagIds(emails: Email[]): string[] {
  const tags = new Set<string>();
  for (const email of emails) {
    for (const tag of getEmailTagIds(email.keywords)) {
      tags.add(tag);
    }
  }
  return [...tags];
}
