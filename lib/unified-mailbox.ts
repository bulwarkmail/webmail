import type { Email, Mailbox, UnifiedMailboxRole, CrossView } from '@/lib/jmap/types';
import { CROSS_EXCLUDED_ROLES } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

export interface UnifiedAccountClient {
  // Display reference (avatar color / label). For personal entries this is the
  // AccountEntry.id; for shared entries it is the JMAP owner id (see Email.accountId).
  accountId: string;
  accountLabel: string;
  client: IJMAPClient;
  mailboxes: Mailbox[];
  // AccountEntry.id of the logged-in client this entry uses (`getClientForAccount`
  // key). Stamped onto each email as `sourceClientAccountId` so single-email and
  // batch actions can resolve the reaching client without scanning capabilities.
  clientAccountId: string;
  // JMAP account id of the data this entry reads (personal: the client's primary;
  // shared: the owner id). Stamped onto each email as `sourceAccountId` and passed
  // as the JMAP `accountId` for owner-scoped routing + mailbox-id namespacing.
  jmapAccountId: string;
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
 * Resolves the display name of the folder an email lives in, for the aggregate
 * "All …" views. Matches the email's mailbox membership against the account's
 * mailbox list (originalId for shared/namespaced mailboxes). Returns the first
 * match, or undefined if none of the account's known folders contain it.
 */
export function resolveSourceFolderName(email: Email, mailboxes: Mailbox[]): string | undefined {
  for (const m of mailboxes) {
    if (email.mailboxIds?.[m.originalId ?? m.id]) return m.name;
  }
  return undefined;
}

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

    // Decorate each email with the source account info. The per-account client
    // returns shared object references; decorate shallow copies instead of
    // mutating them in place so retained callers/snapshots aren't corrupted.
    const decorated = result.emails.map((email) => ({
      ...email,
      accountId: account.accountId,
      accountLabel: account.accountLabel,
      sourceClientAccountId: account.clientAccountId,
      sourceAccountId: account.jmapAccountId,
      sourceFolder: resolveSourceFolderName(email, account.mailboxes),
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
    // Decorate shallow copies, not the shared client-returned objects.
    const decorated = result.emails.map((email) => ({
      ...email,
      accountId: account.accountId,
      accountLabel: account.accountLabel,
      sourceClientAccountId: account.clientAccountId,
      sourceAccountId: account.jmapAccountId,
      sourceFolder: resolveSourceFolderName(email, account.mailboxes),
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

// ─── Cross-account views (unread / starred / all) ─────────────────────────────
//
// These merge messages across EVERY account (including shared) and across all
// folders except the CROSS_EXCLUDED_ROLES (junk, sent, archive, trash, drafts),
// i.e. inbox + custom folders, into one date-sorted list. Unlike the per-role
// unified fan-out above, the query spans many mailboxes per account, so the
// filter is built from each account's included-mailbox ids.

/**
 * Mailboxes of an account included in the cross-account views: everything whose
 * role is not excluded (inbox + custom/no-role folders).
 */
export function getCrossIncludedMailboxes(account: UnifiedAccountClient): Mailbox[] {
  return account.mailboxes.filter((m) => !CROSS_EXCLUDED_ROLES.has(m.role ?? ''));
}

/**
 * Builds the JMAP Email/query filter for a cross-account view over the given
 * JMAP-side mailbox ids. `all` is just the mailbox membership; `unread` and
 * `starred` AND a keyword condition onto it.
 */
export function buildCrossFilter(
  view: CrossView,
  jmapMailboxIds: string[],
): Record<string, unknown> {
  const inAny: Record<string, unknown> = jmapMailboxIds.length === 1
    ? { inMailbox: jmapMailboxIds[0] }
    : { operator: 'OR', conditions: jmapMailboxIds.map((id) => ({ inMailbox: id })) };
  if (view === 'all') return inAny;
  const keyword = view === 'unread' ? { notKeyword: '$seen' } : { hasKeyword: '$flagged' };
  return { operator: 'AND', conditions: [inAny, keyword] };
}

/**
 * Total unread count across every account's included cross-view mailboxes. Used
 * for the unread badge on the "All unread" and "All mail" entries. Mirrors the
 * unified count behaviour (sum of per-mailbox unread metadata, no extra query).
 */
export function getCrossUnreadTotal(accounts: UnifiedAccountClient[]): number {
  let unread = 0;
  for (const account of accounts) {
    for (const m of getCrossIncludedMailboxes(account)) unread += m.unreadEmails;
  }
  return unread;
}

async function fanOutCrossQuery(
  accounts: UnifiedAccountClient[],
  run: (
    account: UnifiedAccountClient,
    jmapAccountId: string | undefined,
    includedJmapIds: string[],
  ) => Promise<{ emails: Email[]; total: number; hasMore: boolean }>,
): Promise<UnifiedFetchResult> {
  const errors = new Map<string, string>();

  type AccountResult = {
    account: UnifiedAccountClient;
    result: { emails: Email[]; total: number; hasMore: boolean };
  } | null;

  const promises = accounts.map(async (account): Promise<AccountResult> => {
    const included = getCrossIncludedMailboxes(account);
    if (included.length === 0) return null;
    const jmapAccountId = account.isShared ? account.accountId : undefined;
    const includedJmapIds = included.map((m) => account.isShared ? (m.originalId ?? m.id) : m.id);
    try {
      const result = await run(account, jmapAccountId, includedJmapIds);
      return { account, result };
    } catch (err) {
      errors.set(account.accountId, err instanceof Error ? err.message : String(err));
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
    // Decorate shallow copies, not the shared client-returned objects.
    const decorated = result.emails.map((email) => ({
      ...email,
      accountId: account.accountId,
      accountLabel: account.accountLabel,
      sourceClientAccountId: account.clientAccountId,
      sourceAccountId: account.jmapAccountId,
      sourceFolder: resolveSourceFolderName(email, account.mailboxes),
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
 * Fetches a cross-account view (browse), merging and date-sorting across all
 * accounts. Per-account failures are collected in the errors map.
 */
export async function fetchCrossViewEmails(
  accounts: UnifiedAccountClient[],
  view: CrossView,
  limit: number,
  position: number,
): Promise<UnifiedFetchResult> {
  return fanOutCrossQuery(accounts, (account, jmapAccountId, ids) =>
    account.client.advancedSearchEmails(buildCrossFilter(view, ids), jmapAccountId, limit, position));
}

/**
 * Text search within a cross-account view: the view filter AND a free-text
 * condition, fanned out across accounts.
 */
export async function searchCrossViewEmails(
  accounts: UnifiedAccountClient[],
  view: CrossView,
  query: string,
  limit: number,
  position: number,
): Promise<UnifiedFetchResult> {
  return fanOutCrossQuery(accounts, (account, jmapAccountId, ids) =>
    account.client.advancedSearchEmails(
      { operator: 'AND', conditions: [buildCrossFilter(view, ids), { text: query }] },
      jmapAccountId,
      limit,
      position,
    ));
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
