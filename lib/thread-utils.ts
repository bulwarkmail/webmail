import type { Email, ThreadGroup } from "./jmap/types";
import { compareEmails, hasTextLevels, type HeldKeywords, type SortLevel } from "./message-list-order";

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
 * Client-side identity of a single message.
 *
 * Email ids are per-account too, so in a merged view two unrelated messages can
 * share an `id` - `eiaaaabc` exists in every account that got that far. Batch
 * selection is what makes that dangerous: keyed by the bare id, ticking one row
 * also ticks its namesake in another account, and delete, move or archive then
 * act on both. Same scoping as `threadKeyFor`; unstamped emails keep the bare
 * id, so single-account views are untouched.
 */
export function emailKeyFor(
  email: Pick<Email, "id" | "sourceClientAccountId" | "sourceAccountId">,
): string {
  const scope = [email.sourceClientAccountId, email.sourceAccountId].filter(Boolean).join("/");
  return scope ? `${scope}:${email.id}` : email.id;
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

  // Group by the account-scoped thread key (or message key when threading is
  // disabled): bare ids collide across accounts in aggregate views.
  const threadMap = new Map<string, Email[]>();

  for (const email of emails) {
    const key = disableThreading ? emailKeyFor(email) : threadKeyFor(email);
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
 * is the latest email's receivedAt date, newest first. `held` emails sort by
 * the keywords they had when their conversation was opened.
 *
 * A sender or subject order the list keeps as the server collated it
 * (`keepServerTextOrder`, Stalwart 1.0; see `hasTextLevels`) is not re-sorted.
 * The groups arrive in fetched order - groupEmailsByThread keeps the order in
 * which each thread first appears - so each thread already sits where its
 * first-ranked email does, and only pinned threads move.
 *
 * The third argument is either the held keywords or an options object
 * carrying them together with `keepServerTextOrder`.
 */
export function sortThreadGroups(
  groups: ThreadGroup[],
  order: SortLevel[] = [],
  heldOrOpts?: HeldKeywords | { keepServerTextOrder?: boolean; held?: HeldKeywords },
): ThreadGroup[] {
  const opts = heldOrOpts instanceof Map ? { held: heldOrOpts as HeldKeywords } : (heldOrOpts as { keepServerTextOrder?: boolean; held?: HeldKeywords } | undefined) ?? {};
  if (opts.keepServerTextOrder && hasTextLevels(order)) {
    return [...groups].sort((a, b) => (b.hasPinned ? 1 : 0) - (a.hasPinned ? 1 : 0));
  }
  const compare = compareEmails(order, { held: opts.held });
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
 * The complete keyword map after toggling one tag, or after clearing every tag
 * (`tagId` null), for writing as a whole. Every value in such a map must be
 * true (RFC 8621 section 4.1.1), so a tag comes off by leaving its key out,
 * and so do keywords the local copy only marks false (`$seen: false` after
 * marking a message unread). Both prefixes name the same tag, so taking a tag
 * off clears whichever spellings are set.
 */
export function toggleTagKeywords(
  keywords: Record<string, boolean> | undefined,
  tagId: string | null,
): Record<string, true> {
  const next: Record<string, true> = {};
  for (const [key, value] of Object.entries(keywords ?? {})) {
    if (value === true) next[key] = true;
  }
  if (tagId === null) {
    for (const key of Object.keys(next)) {
      if (key.startsWith(KEYWORD_PREFIX) || key.startsWith(KEYWORD_PREFIX_LEGACY)) delete next[key];
    }
    return next;
  }
  const activeKeys = [KEYWORD_PREFIX + tagId, KEYWORD_PREFIX_LEGACY + tagId].filter((key) => next[key]);
  if (activeKeys.length > 0) {
    for (const key of activeKeys) delete next[key];
  } else {
    next[KEYWORD_PREFIX + tagId] = true;
  }
  return next;
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
