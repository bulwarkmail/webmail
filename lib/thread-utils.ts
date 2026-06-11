import type { Email, ThreadGroup } from "./jmap/types";

/**
 * Groups emails by their threadId and creates ThreadGroup objects for UI display.
 * Single-email threads are still returned as ThreadGroups with emailCount=1.
 * When disableThreading is true, each email is placed into its own group using
 * its message ID as the key, so the list shows individual messages.
 *
 * @param threadEmailCounts - Optional map of threadId → total email count across
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

  // Group emails by threadId (or by message ID when threading is disabled)
  const threadMap = new Map<string, Email[]>();

  for (const email of emails) {
    const threadId = disableThreading ? email.id : email.threadId;
    if (!threadMap.has(threadId)) {
      threadMap.set(threadId, []);
    }
    threadMap.get(threadId)!.push(email);
  }

  // Convert to ThreadGroup array
  const threadGroups: ThreadGroup[] = [];

  for (const [threadId, threadEmails] of threadMap) {
    // Sort emails by receivedAt descending (newest first)
    const sortedEmails = [...threadEmails].sort(
      (a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()
    );

    const latestEmail = sortedEmails[0];

    // Collect unique participant names from all emails in thread
    const participantNames = getThreadParticipants(sortedEmails);

    // Check for unread, starred, and attachments
    const hasUnread = sortedEmails.some(e => !e.keywords?.$seen);
    const hasStarred = sortedEmails.some(e => e.keywords?.$flagged);
    const hasAttachment = sortedEmails.some(e => e.hasAttachment);
    const hasAnswered = sortedEmails.some(e => e.keywords?.$answered);
    const hasForwarded = sortedEmails.some(e => e.keywords?.$forwarded);

    threadGroups.push({
      threadId,
      emails: sortedEmails,
      latestEmail,
      participantNames,
      hasUnread,
      hasStarred,
      hasAttachment,
      hasAnswered,
      hasForwarded,
      emailCount: threadEmailCounts?.get(threadId) ?? sortedEmails.length,
    });
  }

  return threadGroups;
}

/**
 * Sorts thread groups by their latest email's receivedAt date (newest first).
 */
export function sortThreadGroups(groups: ThreadGroup[]): ThreadGroup[] {
  return [...groups].sort(
    (a, b) => new Date(b.latestEmail.receivedAt).getTime() - new Date(a.latestEmail.receivedAt).getTime()
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
  const hasAttachment = mergedEmails.some(e => e.hasAttachment);
  const hasAnswered = mergedEmails.some(e => e.keywords?.$answered);
  const hasForwarded = mergedEmails.some(e => e.keywords?.$forwarded);

  return {
    threadId: existingGroup.threadId,
    emails: mergedEmails,
    latestEmail,
    participantNames,
    hasUnread,
    hasStarred,
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
 * Gets all active label/color tag IDs from email keywords.
 * Reads both the current $label: prefix and the legacy $color: prefix.
 */
export function getEmailColorTags(keywords: Record<string, boolean> | undefined): string[] {
  if (!keywords) return [];
  const tags: string[] = [];
  for (const key of Object.keys(keywords)) {
    if ((key.startsWith(KEYWORD_PREFIX) || key.startsWith(KEYWORD_PREFIX_LEGACY)) && keywords[key] === true) {
      tags.push(
        key.startsWith(KEYWORD_PREFIX)
          ? key.slice(KEYWORD_PREFIX.length)
          : key.slice(KEYWORD_PREFIX_LEGACY.length)
      );
    }
  }
  return tags;
}

/**
 * Gets label/color tag from email keywords (if any).
 * Reads both the current $label: prefix and the legacy $color: prefix.
 * @deprecated Use getEmailColorTags for multi-tag support.
 */
export function getEmailColorTag(keywords: Record<string, boolean> | undefined): string | null {
  const tags = getEmailColorTags(keywords);
  return tags.length > 0 ? tags[0] : null;
}

/**
 * Checks if a thread has any color tag (returns first found).
 */
export function getThreadColorTag(emails: Email[]): string | null {
  for (const email of emails) {
    const color = getEmailColorTag(email.keywords);
    if (color) return color;
  }
  return null;
}
