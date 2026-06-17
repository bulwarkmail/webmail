import type { Email, Mailbox, UnifiedMailboxRole } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

export interface UnifiedAccountClient {
  accountId: string;
  accountLabel: string;
  client: IJMAPClient;
  mailboxes: Mailbox[];
  // When true, this entry represents a group/shared account owned by
  // `accountId` but accessed through someone else's `client`. JMAP requests
  // must use the mailbox's `originalId` and explicitly target this accountId
  // so the server routes to the owner's data.
  isShared?: boolean;
}

export interface UnifiedFetchResult {
  emails: Email[];
  total: number;
  hasMore: boolean;
  errors: Map<string, string>; // accountId -> error message
}

export interface UnifiedMailboxCounts {
  role: UnifiedMailboxRole;
  unreadEmails: number;
  totalEmails: number;
}

const ALL_UNIFIED_ROLES: UnifiedMailboxRole[] = [
  'inbox', 'sent', 'drafts', 'trash', 'archive', 'junk',
];

/**
 * Finds the first mailbox matching the given role.
 */
export function findMailboxByRole(
  mailboxes: Mailbox[],
  role: UnifiedMailboxRole,
): Mailbox | undefined {
  return mailboxes.find((m) => m.role === role);
}

/**
 * Fetches emails from all accounts for a given unified role, merges and sorts
 * them by receivedAt descending. Per-account failures are collected in the
 * errors map while successful results are still returned.
 */
export async function fetchUnifiedEmails(
  accounts: UnifiedAccountClient[],
  role: UnifiedMailboxRole,
  limit: number,
  position: number,
): Promise<UnifiedFetchResult> {
  const errors = new Map<string, string>();

  // Build one fetch task per account, wrapping each in a catch so we can
  // track per-account errors while still using Promise.allSettled.
  type AccountResult = {
    account: UnifiedAccountClient;
    result: { emails: Email[]; total: number; hasMore: boolean };
  } | null;

  const promises = accounts.map(
    async (account): Promise<AccountResult> => {
      const mailbox = findMailboxByRole(account.mailboxes, role);
      if (!mailbox) return null;

      const { jmapMailboxId, jmapAccountId } = resolveJmapTarget(account, mailbox);
      try {
        const result = await account.client.getEmails(
          jmapMailboxId,
          jmapAccountId,
          limit,
          position,
        );
        return { account, result };
      } catch (err) {
        errors.set(
          account.accountId,
          err instanceof Error ? err.message : String(err),
        );
        return null;
      }
    },
  );

  const results = await Promise.allSettled(promises);

  let mergedEmails: Email[] = [];
  let totalSum = 0;
  let anyHasMore = false;

  for (const outcome of results) {
    if (outcome.status !== 'fulfilled' || outcome.value === null) continue;

    const { account, result } = outcome.value;

    // Decorate each email with the source account info. Copy rather than
    // mutate the objects the client returned, so callers that retain those
    // references are not affected by this merge.
    const decorated = result.emails.map((email) => ({
      ...email,
      accountId: account.accountId,
      accountLabel: account.accountLabel,
    }));

    mergedEmails = mergedEmails.concat(decorated);
    totalSum += result.total;
    if (result.hasMore) {
      anyHasMore = true;
    }
  }

  // Sort merged emails by receivedAt descending.
  mergedEmails.sort((a, b) => {
    const dateA = new Date(a.receivedAt).getTime();
    const dateB = new Date(b.receivedAt).getTime();
    return dateB - dateA;
  });

  return {
    emails: mergedEmails,
    total: totalSum,
    hasMore: anyHasMore,
    errors,
  };
}

/**
 * Runs a text search across every account that has a mailbox for the given
 * unified role, merging and sorting the results by receivedAt descending. The
 * fan-out / error-collection shape mirrors `fetchUnifiedEmails` so the caller
 * sees consistent behavior between browse and search.
 */
export async function searchUnifiedEmails(
  accounts: UnifiedAccountClient[],
  role: UnifiedMailboxRole,
  query: string,
  limit: number,
  position: number,
): Promise<UnifiedFetchResult> {
  return fanOutUnifiedQuery(accounts, role, async (account, mailbox) => {
    const { jmapMailboxId, jmapAccountId } = resolveJmapTarget(account, mailbox);
    return account.client.searchEmails(query, jmapMailboxId, jmapAccountId, limit, position);
  });
}

/**
 * Like `searchUnifiedEmails`, but uses the JMAP advanced filter shape. The
 * caller supplies a `filterFor(mailboxId)` factory because each account's role
 * mailbox has a different id and the filter must include the right
 * `inMailbox` clause per request.
 */
export async function advancedSearchUnifiedEmails(
  accounts: UnifiedAccountClient[],
  role: UnifiedMailboxRole,
  filterFor: (mailboxId: string) => Record<string, unknown>,
  limit: number,
  position: number,
): Promise<UnifiedFetchResult> {
  return fanOutUnifiedQuery(accounts, role, async (account, mailbox) => {
    const { jmapMailboxId, jmapAccountId } = resolveJmapTarget(account, mailbox);
    return account.client.advancedSearchEmails(filterFor(jmapMailboxId), jmapAccountId, limit, position);
  });
}

/**
 * Resolves the JMAP-side mailbox id and accountId for a mailbox living inside
 * a UnifiedAccountClient. For personal-account entries we use the JMAP id as
 * returned by the primary client; for shared-owner entries the mailbox id is
 * namespaced (`${ownerId}:${origId}`) so we must use `originalId` and pass the
 * owner's accountId through the request.
 */
function resolveJmapTarget(
  account: UnifiedAccountClient,
  mailbox: Mailbox,
): { jmapMailboxId: string; jmapAccountId: string | undefined } {
  if (account.isShared) {
    return {
      jmapMailboxId: mailbox.originalId ?? mailbox.id,
      jmapAccountId: account.accountId,
    };
  }
  return { jmapMailboxId: mailbox.id, jmapAccountId: undefined };
}

async function fanOutUnifiedQuery(
  accounts: UnifiedAccountClient[],
  role: UnifiedMailboxRole,
  run: (
    account: UnifiedAccountClient,
    mailbox: Mailbox,
  ) => Promise<{ emails: Email[]; total: number; hasMore: boolean }>,
): Promise<UnifiedFetchResult> {
  const errors = new Map<string, string>();

  type AccountResult = {
    account: UnifiedAccountClient;
    result: { emails: Email[]; total: number; hasMore: boolean };
  } | null;

  const promises = accounts.map(async (account): Promise<AccountResult> => {
    const mailbox = findMailboxByRole(account.mailboxes, role);
    if (!mailbox) return null;
    try {
      const result = await run(account, mailbox);
      return { account, result };
    } catch (err) {
      errors.set(
        account.accountId,
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  });

  const results = await Promise.allSettled(promises);

  let mergedEmails: Email[] = [];
  let totalSum = 0;
  let anyHasMore = false;

  for (const outcome of results) {
    if (outcome.status !== 'fulfilled' || outcome.value === null) continue;
    const { account, result } = outcome.value;
    // Copy rather than mutate the client-returned objects (see fetchUnifiedEmails).
    const decorated = result.emails.map((email) => ({
      ...email,
      accountId: account.accountId,
      accountLabel: account.accountLabel,
    }));
    mergedEmails = mergedEmails.concat(decorated);
    totalSum += result.total;
    if (result.hasMore) anyHasMore = true;
  }

  mergedEmails.sort((a, b) => {
    const dateA = new Date(a.receivedAt).getTime();
    const dateB = new Date(b.receivedAt).getTime();
    return dateB - dateA;
  });

  return { emails: mergedEmails, total: totalSum, hasMore: anyHasMore, errors };
}

/**
 * Aggregates unread and total email counts across all accounts for each
 * unified mailbox role. Only includes roles that exist in at least one account.
 */
export function fetchUnifiedMailboxCounts(
  accounts: UnifiedAccountClient[],
): UnifiedMailboxCounts[] {
  const counts: UnifiedMailboxCounts[] = [];

  for (const role of ALL_UNIFIED_ROLES) {
    let unreadEmails = 0;
    let totalEmails = 0;
    let found = false;

    for (const account of accounts) {
      const mailbox = findMailboxByRole(account.mailboxes, role);
      if (mailbox) {
        found = true;
        unreadEmails += mailbox.unreadEmails;
        totalEmails += mailbox.totalEmails;
      }
    }

    if (found) {
      counts.push({ role, unreadEmails, totalEmails });
    }
  }

  return counts;
}

/**
 * Returns the list of unified roles that exist in at least one account's
 * mailboxes.
 */
export function getUnifiedRoles(
  accounts: UnifiedAccountClient[],
): UnifiedMailboxRole[] {
  const roles: UnifiedMailboxRole[] = [];

  for (const role of ALL_UNIFIED_ROLES) {
    for (const account of accounts) {
      if (findMailboxByRole(account.mailboxes, role)) {
        roles.push(role);
        break;
      }
    }
  }

  return roles;
}
