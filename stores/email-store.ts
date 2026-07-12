import { create } from "zustand";
import { Email, Mailbox, StateChange, ScheduledEmail, SendEmailResult, ALL_MAIL_MAILBOX_ID, isUnifiedMailboxId, isCrossViewId } from "@/lib/jmap/types";
import type { UnifiedMailboxRole, CrossView } from "@/lib/jmap/types";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import { useSettingsStore } from "@/stores/settings-store";
import { useCalendarStore } from "@/stores/calendar-store";
import { SearchFilters, DEFAULT_SEARCH_FILTERS, buildJMAPFilter, isFilterEmpty } from "@/lib/jmap/search-utils";
import { emailHooks } from "@/lib/plugin-hooks";
import type { ExternalSearchResult } from "@/lib/plugin-types";
import { fetchUnifiedEmails, fetchUnifiedMailboxCounts, searchUnifiedEmails, advancedSearchUnifiedEmails, fetchCrossViewEmails, searchCrossViewEmails, getCrossUnreadTotal, resolveSourceFolderName, type UnifiedAccountClient, type UnifiedMailboxCounts } from "@/lib/unified-mailbox";
import { useAuthStore } from "@/stores/auth-store";
import { useAccountStore } from "@/stores/account-store";

type ScheduledSubmissionMetadata = {
  submissionId: string;
  sendAt: string;
  identityId: string;
  undoStatus: 'pending' | 'final' | 'canceled';
};

const VIRTUAL_SCHEDULED_MAILBOX_ID = '__scheduled__';

type PendingUndoSend = { submissionId: string; emailId?: string; sendAt: string; isSmime: boolean };

interface EmailStore {
  emails: Email[];
  mailboxes: Mailbox[];
  /**
   * Mailbox caches keyed by accountId. Populated for every connected account
   * when the Pro shell is active so the sidebar can render per-account groups
   * Thunderbird-style. The active account's mailboxes still live in
   * `mailboxes` for back-compat with the single-account view.
   */
  accountMailboxes: Record<string, Mailbox[]>;
  /**
   * When set, the mail view is reading from this account instead of the
   * global active one. `null` means "use the global active account" - i.e.
   * the standard single-account behavior. Selecting a folder under a
   * non-active account in the Pro sidebar updates this without changing
   * `useAuthStore.activeAccountId`.
   */
  viewingAccountId: string | null;
  selectedEmail: Email | null;
  selectedMailbox: string;
  isLoading: boolean;
  isLoadingEmail: boolean; // Track when a full email is being fetched
  isLoadingMore: boolean; // Track when loading more emails (pagination)
  error: string | null;
  searchQuery: string;
  quota: { used: number; total: number } | null;
  processingReadStatus: Set<string>; // Track emails being marked as read/unread
  selectedEmailIds: Set<string>; // Track selected emails for batch operations
  hasMoreEmails: boolean; // Track if more emails are available to load
  totalEmails: number; // Total number of emails in the current mailbox/query
  isPushConnected: boolean; // Track if push notifications are connected
  lastPushUpdate: number | null; // Timestamp of last push update
  newEmailNotification: Email | null; // New email notification for toast

  // Thread expansion state
  expandedThreadIds: Set<string>;
  threadEmailsCache: Map<string, Email[]>;
  isLoadingThread: string | null;
  // Full thread email counts (from Thread/get across all folders)
  threadEmailCounts: Map<string, number>;

  // Keyword/tag filter
  selectedKeyword: string | null;
  tagCounts: Record<string, { total: number; unread: number }>;

  // Advanced search state
  searchFilters: SearchFilters;
  isAdvancedSearchOpen: boolean;
  searchAbortController: AbortController | null;
  /** Plugin-contributed search results (CRM hits, Slack messages, etc.) populated by emailHooks.onProvideSearchResults. */
  externalSearchResults: ExternalSearchResult[];

  // Unified mailbox state
  isUnifiedView: boolean;
  unifiedRole: UnifiedMailboxRole | null;
  // Cross-account view ('unread' | 'starred' | 'all') when active; null for the
  // per-role unified views. Mutually exclusive with unifiedRole; both run under
  // isUnifiedView.
  crossView: CrossView | null;
  unifiedErrors: Map<string, string>; // accountId -> error message
  unifiedCounts: UnifiedMailboxCounts[];
  // Unread total across the cross-view included folders (badge for unread/all).
  crossUnreadCount: number;

  // Scheduled send state
  scheduledEmails: ScheduledEmail[];
  scheduledEmailIds: Set<string>;
  scheduledSubmissionByEmailId: Map<string, ScheduledSubmissionMetadata>;
  scheduledTotal: number;
  scheduledHasMore: boolean;
  scheduledNextPosition: number;
  isLoadingScheduled: boolean;
  isScheduledView: boolean;
  pendingUndoSend: PendingUndoSend | null;

  setEmails: (emails: Email[]) => void;
  setMailboxes: (mailboxes: Mailbox[]) => void;
  /** Cache or update the mailbox list for a specific account. */
  setAccountMailboxes: (accountId: string, mailboxes: Mailbox[]) => void;
  /** Wipe the per-account mailbox cache (e.g. on logout). */
  clearAccountMailboxes: () => void;
  setViewingAccount: (accountId: string | null) => void;
  /**
   * Atomic version of (setViewingAccount + selectMailbox). Pass `null` for
   * the active account; pass an accountId to view a non-active account's
   * folder without changing the global active account.
   */
  selectAccountMailbox: (accountId: string | null, mailboxId: string) => void;
  /**
   * Fetch mailboxes via the supplied client and store them under
   * `accountMailboxes[accountId]`. Used by the Pro shell to populate the
   * sidebar's per-account groups for every connected account.
   */
  fetchAccountMailboxes: (client: IJMAPClient, accountId: string) => Promise<void>;
  selectEmail: (email: Email | null) => void;
  selectMailbox: (mailboxId: string) => void;
  setLoading: (loading: boolean) => void;
  setLoadingEmail: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setSearchQuery: (query: string) => void;
  setQuota: (quota: { used: number; total: number } | null) => void;
  selectKeyword: (keyword: string | null) => void;
  fetchTagCounts: (client: IJMAPClient) => Promise<void>;
  toggleEmailSelection: (emailId: string) => void;
  selectRangeEmails: (targetEmailId: string) => void;
  lastSelectedEmailId: string | null;
  selectAllEmails: () => void;
  clearSelection: () => void;

  // JMAP operations
  fetchMailboxes: (client: IJMAPClient) => Promise<void>;
  fetchEmails: (client: IJMAPClient, mailboxId?: string) => Promise<void>;
  // Eager post-login bootstrap: fires mailboxes/quota/emails so the round-trips
  // overlap with Next's soft-nav + home-page hydration. Safe to call multiple
  // times; later calls are no-ops while a prior one is in flight.
  prefetchInitialData: (client: IJMAPClient) => Promise<void>;
  loadMoreEmails: (client: IJMAPClient) => Promise<void>;
  fetchEmailContent: (client: IJMAPClient, emailId: string) => Promise<Email | null>;
  fetchQuota: (client: IJMAPClient) => Promise<void>;
  sendEmail: (client: IJMAPClient, to: string[], subject: string, body: string, cc?: string[], bcc?: string[], identityId?: string, fromEmail?: string, draftId?: string, fromName?: string, htmlBody?: string, attachments?: Array<{ blobId: string; name: string; type: string; size: number; disposition?: 'attachment' | 'inline'; cid?: string }>, inReplyTo?: string[], references?: string[], delayedUntil?: string, envelopeMailFrom?: string, options?: { requestReadReceipt?: boolean }) => Promise<SendEmailResult>;
  sendRawEmail: (client: IJMAPClient, rawMimeBlob: Blob, identityId: string, delayedUntil?: string, envelopeRecipients?: string[]) => Promise<SendEmailResult>;
  deleteEmail: (client: IJMAPClient, emailId: string, forceDelete?: boolean) => Promise<void>;
  markAsRead: (client: IJMAPClient, emailId: string, read: boolean) => Promise<void>;
  moveToMailbox: (client: IJMAPClient, emailId: string, mailboxId: string) => Promise<void>;
  moveEmailsToMailbox: (client: IJMAPClient, emailIds: string[], mailboxId: string) => Promise<void>;
  moveThreadToMailbox: (client: IJMAPClient, emailId: string, mailboxId: string) => Promise<void>;
  /**
   * Move emails across JMAP accounts. JMAP has no native cross-account move,
   * so for each email we fetch the source's raw RFC822 blob, import it into
   * the destination account's target mailbox, then delete the original.
   * `emailIdsBySource` maps each source accountId to the emails it owns;
   * pass the active account's id explicitly (no `__default__` sentinel).
   * `destMailboxId` is the raw JMAP id on the destination server (not the
   * `accountId:mailboxId` namespace used for shared folders).
   * `destJmapAccountId` overrides the destination client's primary account
   * for the import — used when dropping into a delegated/shared mailbox that
   * is owned by a different JMAP account but accessed through the same
   * client (i.e. there is no separate connected client for the owner).
   * `sourceJmapAccountId` is the mirror image for the source side: when the
   * emails live in a delegated/shared mailbox accessed through the source
   * client, the copy/delete must target the owner's JMAP account rather than
   * the source client's primary one.
   */
  crossAccountMoveEmails: (
    emailIdsBySource: Map<string, string[]>,
    destAccountId: string,
    destMailboxId: string,
    destJmapAccountId?: string,
    sourceJmapAccountId?: string,
  ) => Promise<void>;
  searchEmails: (client: IJMAPClient, query: string) => Promise<void>;
  advancedSearch: (client: IJMAPClient) => Promise<void>;
  setSearchFilters: (filters: Partial<SearchFilters>) => void;
  clearSearchFilters: () => void;
  toggleAdvancedSearch: () => void;
  toggleStar: (client: IJMAPClient, emailId: string) => Promise<void>;
  setEmailKeywordsLocal: (emailId: string, keywords: Record<string, boolean>) => void;

  // Batch operations
  batchMarkAsRead: (client: IJMAPClient, read: boolean) => Promise<void>;
  batchDelete: (client: IJMAPClient, permanent?: boolean) => Promise<void>;
  batchMoveToMailbox: (client: IJMAPClient, mailboxId: string) => Promise<void>;
  batchArchive: (client: IJMAPClient) => Promise<void>;

  // Spam operations
  // For unified-view emails the undo must hit the same account: `accountId` is the
  // owning JMAP account (passed to JMAP), `sourceClientAccountId` is the login the
  // email is reachable through (used to pick the right client). (#281)
  spamUndoCache: Map<string, { emailId: string; originalMailboxId: string; accountId?: string; sourceClientAccountId?: string }>;
  markAsSpam: (client: IJMAPClient, emailId: string) => Promise<void>;
  undoSpam: (client: IJMAPClient, emailId: string) => Promise<void>;
  batchMarkAsSpam: (client: IJMAPClient, emailIds: string[]) => Promise<void>;
  batchUndoSpam: (client: IJMAPClient, emailIds: string[]) => Promise<void>;

  // Push notification handlers
  setPushConnected: (connected: boolean) => void;
  handleStateChange: (change: StateChange, client: IJMAPClient) => Promise<void>;
  refreshCurrentMailbox: (client: IJMAPClient) => Promise<void>;
  handleNewEmailNotification: (email: Email) => void;
  clearNewEmailNotification: () => void;

  // Thread expansion actions
  toggleThreadExpansion: (threadId: string) => void;
  fetchThreadEmails: (client: IJMAPClient, threadId: string) => Promise<Email[]>;
  collapseAllThreads: () => void;
  updateThreadCache: (threadId: string, emails: Email[]) => void;
  fetchThreadEmailCounts: (client: IJMAPClient) => Promise<void>;
  markThreadAsRead: (client: IJMAPClient, threadId: string) => Promise<void>;

  // Mailbox management
  createMailbox: (client: IJMAPClient, name: string, parentId?: string) => Promise<void>;
  renameMailbox: (client: IJMAPClient, mailboxId: string, name: string) => Promise<void>;
  deleteMailbox: (client: IJMAPClient, mailboxId: string) => Promise<void>;
  setMailboxRole: (client: IJMAPClient, mailboxId: string, role: string | null) => Promise<void>;
  emptyMailbox: (client: IJMAPClient, mailboxId: string) => Promise<void>;
  markMailboxAsRead: (client: IJMAPClient, mailboxId: string) => Promise<number>;

  // Unified mailbox operations
  fetchUnifiedEmails: (accounts: UnifiedAccountClient[], role: UnifiedMailboxRole) => Promise<void>;
  loadMoreUnifiedEmails: (accounts: UnifiedAccountClient[]) => Promise<void>;
  refreshUnifiedCounts: (accounts: UnifiedAccountClient[]) => Promise<void>;
  exitUnifiedView: () => void;
  // Cross-account view operations (unread / starred / all)
  fetchCrossView: (accounts: UnifiedAccountClient[], view: CrossView) => Promise<void>;
  refreshCrossCounts: (accounts: UnifiedAccountClient[]) => void;

  fetchScheduledEmails: (client: IJMAPClient) => Promise<void>;
  loadMoreScheduledEmails: (client: IJMAPClient) => Promise<void>;
  cancelScheduledEmail: (client: IJMAPClient, submissionId: string, emailId?: string) => Promise<void>;
  cancelScheduledEmailForEdit: (client: IJMAPClient, email: ScheduledEmail | Email) => Promise<Email | null>;
  rescheduleScheduledEmail: (client: IJMAPClient, submissionId: string, emailId: string, identityId: string, delayedUntil: string) => Promise<SendEmailResult>;
  cancelUndoSend: (client: IJMAPClient, pending: PendingUndoSend) => Promise<Email | null>;
  clearPendingUndoSend: () => void;
  refreshScheduledMetadata: (client: IJMAPClient) => Promise<void>;
  setScheduledView: (isScheduledView: boolean) => void;

  // Mock data for demo
  loadMockData: () => void;
}

// Helper: compute the next email to select when removing one from the list
function getNextSelectedEmailAfterRemoval(state: { emails: Email[]; selectedEmail: Email | null }, removedEmailIds: Set<string>): Email | null {
  if (!state.selectedEmail || !removedEmailIds.has(state.selectedEmail.id)) {
    return state.selectedEmail;
  }

  const idx = state.emails.findIndex(e => e.id === state.selectedEmail?.id);
  if (idx === -1) return null;

  for (let nextIndex = idx + 1; nextIndex < state.emails.length; nextIndex++) {
    const candidate = state.emails[nextIndex];
    if (!removedEmailIds.has(candidate.id)) {
      return candidate;
    }
  }

  for (let prevIndex = idx - 1; prevIndex >= 0; prevIndex--) {
    const candidate = state.emails[prevIndex];
    if (!removedEmailIds.has(candidate.id)) {
      return candidate;
    }
  }

  return null;
}

function getNextSelectedEmail(state: { emails: Email[]; selectedEmail: Email | null }, removedEmailId: string): Email | null {
  return getNextSelectedEmailAfterRemoval(state, new Set([removedEmailId]));
}

function annotateScheduledEmails(
  emails: Email[],
  scheduledSubmissionByEmailId: Map<string, ScheduledSubmissionMetadata>
): Email[] {
  if (scheduledSubmissionByEmailId.size === 0) return emails;
  return emails.map(email => annotateScheduledEmail(email, scheduledSubmissionByEmailId));
}

function annotateScheduledEmail(
  email: Email,
  scheduledSubmissionByEmailId: Map<string, ScheduledSubmissionMetadata>
): Email {
  const scheduled = scheduledSubmissionByEmailId.get(email.id);
  if (!scheduled) return email;
  return {
    ...email,
    scheduledSendAt: scheduled.sendAt,
    emailSubmissionId: scheduled.submissionId,
    scheduledIdentityId: scheduled.identityId,
    scheduledUndoStatus: scheduled.undoStatus,
    isScheduled: true,
  };
}

function shouldClearPendingUndoSend(pending: PendingUndoSend | null, scheduledEmails: ScheduledEmail[]): boolean {
  if (!pending) return false;
  const pendingSendTime = new Date(pending.sendAt).getTime();
  if (Number.isFinite(pendingSendTime) && pendingSendTime <= Date.now()) return true;
  const scheduledEmail = scheduledEmails.find(email => email.emailSubmissionId === pending.submissionId);
  return scheduledEmail?.scheduledUndoStatus !== undefined && scheduledEmail.scheduledUndoStatus !== 'pending';
}

/**
 * When the mail view is showing a non-active account (Pro shell's
 * Thunderbird-style sidebar), redirect read/write operations to that
 * account's JMAP client and mailbox cache. Returns the passed-in values
 * unchanged for the standard single-account flow.
 *
 * Compose/send still routes through the caller's client (the active
 * account), since identity binding for cross-account sending is a separate
 * concern.
 */
function resolveActionClient(passedClient: IJMAPClient): IJMAPClient {
  const viewingId = useEmailStore.getState().viewingAccountId;
  if (!viewingId) return passedClient;
  const c = useAuthStore.getState().getClientForAccount(viewingId);
  return c ?? passedClient;
}

function resolveActionMailboxes(): Mailbox[] {
  const state = useEmailStore.getState();
  if (state.viewingAccountId) {
    return state.accountMailboxes[state.viewingAccountId] ?? state.mailboxes;
  }
  return state.mailboxes;
}

/**
 * Resolves the JMAP mailbox ids that make up the gated "All Mail" view for the
 * active/viewing account. Honors that account's `allMailFolderIds` entry; when
 * not configured it defaults to every non-special (no-role) folder. Shared
 * folders are excluded - All Mail is scoped to a single account. Returns
 * JMAP-side ids (originalId for namespaced mailboxes).
 */
function resolveAllMailJmapIds(): string[] {
  const mailboxes = resolveActionMailboxes().filter((mb) => !mb.isShared);
  // Per-account selection: read the entry for the account the view is scoped to
  // (the Pro viewing override, else the global active account). A missing entry
  // = "not configured" -> all no-role folders; an explicit [] = no folders.
  const accountId = useEmailStore.getState().viewingAccountId ?? useAuthStore.getState().activeAccountId;
  const configured = accountId ? useSettingsStore.getState().allMailFolderIds[accountId] : undefined;
  const selected = configured === undefined
    ? mailboxes.filter((mb) => !mb.role)
    : mailboxes.filter((mb) => configured.includes(mb.id));
  return selected.map((mb) => mb.originalId || mb.id);
}

/**
 * Builds the JMAP Email/query filter for the All Mail view from a set of
 * mailbox ids - an OR of `inMailbox` conditions (or a single condition).
 */
function buildAllMailFilter(jmapMailboxIds: string[]): Record<string, unknown> {
  if (jmapMailboxIds.length === 1) {
    return { inMailbox: jmapMailboxIds[0] };
  }
  return { operator: 'OR', conditions: jmapMailboxIds.map((id) => ({ inMailbox: id })) };
}

/**
 * Resolves the JMAP client, mailbox list, and JMAP accountId to use for a
 * single-email action.
 *
 * In aggregate views each email is decorated with its source reference:
 * `sourceClientAccountId` (the logged-in client it is reachable through) and
 * `sourceAccountId` (the owning JMAP account). The mutation must be routed to
 * that client/account, or it is sent to the active account whose server doesn't
 * know the id, so JMAP `Email/set` silently returns `notUpdated` and the change
 * is lost on the next reload (issue #281). We always pass `sourceAccountId` as
 * the JMAP accountId: for personal sources it equals the client's primary (a
 * no-op, no namespacing), for shared/group sources it targets the owner. The
 * owner's mailbox list (cached by `buildUnifiedAccountClients` under that JMAP
 * id) resolves role-based destinations like trash/archive.
 *
 * For the normal single-account / viewing-account flow this preserves the
 * existing behavior exactly: the active/viewing client, its mailbox list, and
 * the shared-mailbox accountId derived from the currently selected mailbox.
 */
function resolveEmailActionContext(
  email: { sourceClientAccountId?: string; sourceAccountId?: string },
  passedClient: IJMAPClient,
): { client: IJMAPClient; mailboxes: Mailbox[]; accountId: string | undefined } {
  const state = useEmailStore.getState();
  // In aggregate views every email is decorated with its source reference:
  // `sourceClientAccountId` (the login client it is reachable through) and
  // `sourceAccountId` (the owning JMAP account). These are unambiguous across
  // personal and shared/group sources, so resolution is the same three lines for
  // both - no id-space guessing, no capability scan. For personal sources
  // `sourceAccountId` equals the client's primary, so passing it to JMAP is a
  // no-op (matches the previous `accountId: undefined` behavior exactly).
  if (state.isUnifiedView && email.sourceClientAccountId && email.sourceAccountId) {
    return {
      client: useAuthStore.getState().getClientForAccount(email.sourceClientAccountId) ?? resolveActionClient(passedClient),
      mailboxes: state.accountMailboxes[email.sourceAccountId] ?? state.mailboxes,
      accountId: email.sourceAccountId,
    };
  }
  const mailboxes = resolveActionMailboxes();
  const currentMailbox = mailboxes.find((mb) => mb.id === state.selectedMailbox);
  return {
    client: resolveActionClient(passedClient),
    mailboxes,
    accountId: currentMailbox?.isShared ? currentMailbox.accountId : undefined,
  };
}

/**
 * Builds the `UnifiedAccountClient[]` list used by every unified fan-out
 * action (browse, load-more, search). Each entry has a JMAP client plus a
 * fresh mailbox list so the helpers can resolve the role mailbox per account.
 * Accounts whose mailbox fetch fails are skipped - the unified result will
 * surface that in its per-account error map.
 *
 * When `includeGroup` is true, also emits one synthetic entry per shared
 * owner account reachable through each logged-in client. The shared entries
 * are flagged with `isShared: true` so `lib/unified-mailbox.ts` routes JMAP
 * requests via `originalId` + owner accountId.
 */
export async function buildUnifiedAccountClients(
  opts: { includeGroup?: boolean } = {},
): Promise<UnifiedAccountClient[]> {
  const { includeGroup = false } = opts;
  const authAccounts = useAccountStore.getState().accounts.filter((a) => a.isConnected);
  const allClients = useAuthStore.getState().getAllConnectedClients();
  const built: UnifiedAccountClient[] = [];
  // Per-account mailbox lists gathered here are cached into `accountMailboxes`
  // after the fan-out so single-email actions can resolve role-based
  // destinations (trash/archive) in the email's own account (issue #281).
  const fetchedMailboxes: Record<string, Mailbox[]> = {};
  for (const a of authAccounts) {
    const c = allClients.get(a.id);
    if (!c) continue;
    try {
      const mailboxes = includeGroup ? await c.getAllMailboxes() : await c.getMailboxes();
      const ownMailboxes = includeGroup
        ? mailboxes.filter((m) => !m.isShared)
        : mailboxes;
      // Primary JMAP account id of this login. Stamped onto personal emails as
      // `sourceAccountId`; equals the client's primary so passing it to JMAP is a
      // no-op (no namespacing) — keeps personal behavior identical while making
      // resolution branch-free against shared sources.
      const primaryJmapId = c.getAccountId();
      built.push({ accountId: a.id, accountLabel: a.label || a.email, client: c, mailboxes: ownMailboxes, clientAccountId: a.id, jmapAccountId: primaryJmapId, isShared: false });
      fetchedMailboxes[a.id] = ownMailboxes;
      // Also cache under the JMAP id so `accountMailboxes[email.sourceAccountId]`
      // resolves uniformly for personal and shared sources alike.
      fetchedMailboxes[primaryJmapId] = ownMailboxes;

      if (includeGroup) {
        const sharedByOwner = new Map<string, Mailbox[]>();
        for (const m of mailboxes) {
          if (!m.isShared || !m.accountId || m.accountId === a.id) continue;
          const list = sharedByOwner.get(m.accountId) ?? [];
          list.push(m);
          sharedByOwner.set(m.accountId, list);
        }
        for (const [ownerId, ownerMailboxes] of sharedByOwner) {
          const label = ownerMailboxes.find((m) => m.accountName)?.accountName || ownerId;
          built.push({
            accountId: ownerId,
            accountLabel: label,
            client: c,
            mailboxes: ownerMailboxes,
            clientAccountId: a.id,
            jmapAccountId: ownerId,
            isShared: true,
          });
          // Cache the owner's mailbox list keyed by its JMAP id so single-email
          // and batch actions can resolve role-based destinations (trash/archive)
          // in the owner account instead of falling back to the active account.
          fetchedMailboxes[ownerId] = ownerMailboxes;
        }
      }
    } catch {
      /* skip account on mailbox fetch failure */
    }
  }
  if (Object.keys(fetchedMailboxes).length > 0) {
    useEmailStore.setState((state) => ({
      accountMailboxes: { ...state.accountMailboxes, ...fetchedMailboxes },
    }));
  }
  return built;
}

/**
 * After a mailbox-list mutation (create/rename/delete/etc.), refresh the
 * cache for whichever account we're operating on. Writes the result to the
 * standard `mailboxes` slot for the active account, or the per-account
 * cache for non-active accounts so the Pro sidebar stays in sync.
 */
async function refreshMailboxesForViewingAccount(fallbackClient: IJMAPClient): Promise<void> {
  const viewingId = useEmailStore.getState().viewingAccountId;
  const client = resolveActionClient(fallbackClient);
  try {
    const mailboxes = await client.getMailboxes();
    if (viewingId) {
      useEmailStore.setState((state) => ({
        accountMailboxes: { ...state.accountMailboxes, [viewingId]: mailboxes },
      }));
    } else {
      useEmailStore.setState({ mailboxes });
    }
  } catch (error) {
    console.error('Failed to refresh mailboxes after mutation:', error);
  }
}

// Whether an email belongs to a given mailbox, for local counter math.
// Shared/group-account emails carry NAMESPACED mailboxIds (`${ownerId}:${origId}`,
// which equals the shared mailbox's `id`), while own-account emails carry bare ids
// (equal to both `id` and `originalId`). Matching `mailbox.id` covers both; the
// `originalId` fallback is restricted to non-shared mailboxes so a bare own-account
// id can't collide with another account's shared folder. (#281)
function emailInMailbox(
  email: { mailboxIds?: Record<string, boolean> },
  mailbox: Mailbox,
): boolean {
  const ids = email.mailboxIds;
  if (!ids) return false;
  if (ids[mailbox.id]) return true;
  if (!mailbox.isShared && mailbox.originalId) return !!ids[mailbox.originalId];
  return false;
}

// Apply a per-mailbox counter adjustment to the mailbox list that actually holds
// the email's folders, and return the matching `set()` partial.
//
// In aggregate views an email may belong to another logged-in account. The
// sidebar shows the active account's folders from `mailboxes` (its
// getAllMailboxes, incl. its delegated shared folders) and every *other*
// account's folders from `accountMailboxes[<AccountEntry.id>]`. Updating the
// wrong list silently corrupts counters - and because JMAP mailbox ids can
// collide across accounts, blindly matching `mailboxes` would even decrement the
// *active* account's folder for a different account's email. So route by the
// email's source login: a different account → its `accountMailboxes` entry,
// otherwise (active account, its shared folders, or a non-aggregate view) →
// `mailboxes`. (#281)
function applyMailboxCounterUpdate(
  state: { mailboxes: Mailbox[]; accountMailboxes: Record<string, Mailbox[]> },
  email: { sourceClientAccountId?: string },
  adjust: (mb: Mailbox) => Mailbox,
): { mailboxes?: Mailbox[]; accountMailboxes?: Record<string, Mailbox[]> } {
  const srcClient = email.sourceClientAccountId;
  const activeId = useAuthStore.getState().activeAccountId;
  if (srcClient && srcClient !== activeId) {
    const list = state.accountMailboxes[srcClient];
    if (!list) return {};
    return { accountMailboxes: { ...state.accountMailboxes, [srcClient]: list.map(adjust) } };
  }
  return { mailboxes: state.mailboxes.map(adjust) };
}

// Batch variant of applyMailboxCounterUpdate: a set of emails may span accounts,
// so group them by the list that holds them and run `mapMailbox` per list using
// only that group's emails. Each account's counters are adjusted in its own list
// (active account → `mailboxes`, others → `accountMailboxes[sourceClientAccountId]`),
// avoiding cross-account id collisions. (#281)
function applyBatchMailboxCounterUpdate(
  state: { mailboxes: Mailbox[]; accountMailboxes: Record<string, Mailbox[]> },
  emails: Array<{ sourceClientAccountId?: string }>,
  mapMailbox: (mb: Mailbox, emailsForList: Array<{ sourceClientAccountId?: string }>) => Mailbox,
): { mailboxes: Mailbox[]; accountMailboxes: Record<string, Mailbox[]> } {
  const activeId = useAuthStore.getState().activeAccountId;
  const ACTIVE = '__active__';
  const groups = new Map<string, Array<{ sourceClientAccountId?: string }>>();
  for (const e of emails) {
    const k = e.sourceClientAccountId && e.sourceClientAccountId !== activeId ? e.sourceClientAccountId : ACTIVE;
    const g = groups.get(k);
    if (g) g.push(e); else groups.set(k, [e]);
  }
  let mailboxes = state.mailboxes;
  const accountMailboxes = { ...state.accountMailboxes };
  for (const [k, es] of groups) {
    if (k === ACTIVE) {
      mailboxes = mailboxes.map((mb) => mapMailbox(mb, es));
    } else if (accountMailboxes[k]) {
      accountMailboxes[k] = accountMailboxes[k].map((mb) => mapMailbox(mb, es));
    }
  }
  return { mailboxes, accountMailboxes };
}

// Per-mailbox counter map (for applyBatchMailboxCounterUpdate) for removing a
// group of emails from a folder: decrement total (and unread for unseen) for
// each group email that lives in the mailbox.
function applyDeleteCounters(
  mailbox: Mailbox,
  group: Array<{ sourceClientAccountId?: string }>,
): Mailbox {
  let dTotal = 0;
  let dUnread = 0;
  for (const email of group as Email[]) {
    if (emailInMailbox(email, mailbox)) {
      dTotal--;
      if (!email.keywords?.$seen) dUnread--;
    }
  }
  return dTotal === 0 && dUnread === 0 ? mailbox : {
    ...mailbox,
    totalEmails: Math.max(0, mailbox.totalEmails + dTotal),
    unreadEmails: Math.max(0, mailbox.unreadEmails + dUnread),
    totalThreads: Math.max(0, mailbox.totalThreads + dTotal),
    unreadThreads: Math.max(0, mailbox.unreadThreads + dUnread),
  };
}

// Find the trash mailbox for a given account scope. Prefers JMAP role, but
// falls back to name matching ("trash" / "deleted") so users with custom or
// pre-existing folders (e.g. "Deleted Items") aren't silently destroyed.
function findTrashMailbox(
  mailboxes: Mailbox[],
  scope: { accountId?: string; isShared?: boolean }
): Mailbox | undefined {
  const matchesScope = (mb: Mailbox): boolean => {
    if (scope.accountId) return mb.accountId === scope.accountId;
    return !mb.isShared;
  };

  const byRole = mailboxes.find(mb => mb.role === 'trash' && matchesScope(mb));
  if (byRole) return byRole;

  return mailboxes.find(mb => {
    if (!matchesScope(mb)) return false;
    const lower = mb.name.toLowerCase();
    return lower.includes('trash') || lower.includes('deleted');
  });
}

export const useEmailStore = create<EmailStore>((set, get) => ({
  emails: [],
  mailboxes: [],
  accountMailboxes: {},
  viewingAccountId: null,
  selectedEmail: null,
  selectedMailbox: "",
  isLoading: false,
  isLoadingEmail: false,
  isLoadingMore: false,
  error: null,
  searchQuery: "",
  quota: null,
  processingReadStatus: new Set(),
  selectedEmailIds: new Set(),
  lastSelectedEmailId: null,
  hasMoreEmails: false,
  totalEmails: 0,
  isPushConnected: false,
  lastPushUpdate: null,
  newEmailNotification: null,

  // Thread expansion state
  expandedThreadIds: new Set(),
  threadEmailsCache: new Map(),
  isLoadingThread: null,
  threadEmailCounts: new Map(),

  // Keyword/tag filter
  selectedKeyword: null,
  tagCounts: {},

  // Advanced search state
  searchFilters: { ...DEFAULT_SEARCH_FILTERS },
  isAdvancedSearchOpen: false,
  searchAbortController: null,
  externalSearchResults: [],

  // Unified mailbox state
  isUnifiedView: false,
  unifiedRole: null,
  crossView: null,
  unifiedErrors: new Map(),
  unifiedCounts: [],
  crossUnreadCount: 0,

  // Scheduled send state
  scheduledEmails: [],
  scheduledEmailIds: new Set(),
  scheduledSubmissionByEmailId: new Map(),
  scheduledTotal: 0,
  scheduledHasMore: false,
  scheduledNextPosition: 0,
  isLoadingScheduled: false,
  isScheduledView: false,
  pendingUndoSend: null,

  // Spam undo cache
  spamUndoCache: new Map(),

  setEmails: (emails) => set({ emails }),
  setMailboxes: (mailboxes) => set({ mailboxes }),
  setAccountMailboxes: (accountId, mailboxes) => set((state) => ({
    accountMailboxes: { ...state.accountMailboxes, [accountId]: mailboxes },
  })),
  clearAccountMailboxes: () => set({ accountMailboxes: {} }),
  setViewingAccount: (accountId) => set({ viewingAccountId: accountId }),
  selectAccountMailbox: (accountId, mailboxId) => set({
    viewingAccountId: accountId,
    selectedMailbox: mailboxId,
    selectedEmail: null,
    selectedEmailIds: new Set(),
    selectedKeyword: null,
    expandedThreadIds: new Set(),
    threadEmailsCache: new Map(),
    threadEmailCounts: new Map(),
    isLoadingThread: null,
  }),
  fetchAccountMailboxes: async (client, accountId) => {
    try {
      // `accountId` is overloaded across callers:
      //  - a real login (AccountEntry.id, e.g. per-account sidebar / cross-account
      //    move) → `client` is that account's own login; getMailboxes() returns the
      //    right list.
      //  - a JMAP account id with no own login (a shared/group owner, used by the
      //    unified archive refresh) → must fetch by that JMAP id through the
      //    delegating client, else we'd cache the delegating account's own folders
      //    under the owner key.
      // Distinguish by whether a directly-logged-in client exists for the id.
      const hasOwnLogin = !!useAuthStore.getState().getClientForAccount(accountId);
      const mailboxes = hasOwnLogin
        ? await client.getMailboxes()
        : await client.getMailboxes(accountId);
      // Re-check the cache after the await to avoid stomping a more recent
      // fetch that finished while this one was in flight.
      set((state) => ({
        accountMailboxes: { ...state.accountMailboxes, [accountId]: mailboxes },
      }));
    } catch (error) {
      console.error(`Failed to fetch mailboxes for account ${accountId}:`, error);
    }
  },
  selectEmail: (email) => {
    const prev = get().selectedEmail;
    set({ selectedEmail: email, lastSelectedEmailId: email?.id ?? get().lastSelectedEmailId });
    if (prev && (!email || email.id !== prev.id)) {
      emailHooks.onEmailClose.emitSync(prev);
    }
    if (email && (!prev || email.id !== prev.id)) {
      emailHooks.onEmailOpen.emitSync(email);
    }
  },
  selectKeyword: (keyword) => set({
    selectedKeyword: keyword,
    selectedEmail: null,
    selectedEmailIds: new Set(),
    expandedThreadIds: new Set(),
    threadEmailsCache: new Map(),
    threadEmailCounts: new Map(),
  }),
  fetchTagCounts: async (client) => {
    try {
      const keywords = useSettingsStore.getState().emailKeywords;
      if (keywords.length === 0) {
        set({ tagCounts: {} });
        return;
      }
      const tagIds = keywords.map(k => k.id);
      const counts = await resolveActionClient(client).getTagCounts(tagIds);
      set({ tagCounts: counts });
    } catch (error) {
      console.error('Failed to fetch tag counts:', error);
    }
  },
  selectMailbox: (mailboxId) => set({
    selectedMailbox: mailboxId,
    selectedEmail: null,
    selectedEmailIds: new Set(),
    selectedKeyword: null,
    expandedThreadIds: new Set(),
    threadEmailsCache: new Map(),
    threadEmailCounts: new Map(),
    isLoadingThread: null,
  }),
  setLoading: (loading) => set({ isLoading: loading }),
  setLoadingEmail: (loading) => set({ isLoadingEmail: loading }),
  setError: (error) => set({ error }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setQuota: (quota) => set({ quota }),

  toggleEmailSelection: (emailId) => {
    const { selectedEmailIds } = get();
    const newSelection = new Set(selectedEmailIds);
    if (newSelection.has(emailId)) {
      newSelection.delete(emailId);
    } else {
      newSelection.add(emailId);
    }
    set({ selectedEmailIds: newSelection, lastSelectedEmailId: emailId });
  },

  selectRangeEmails: (targetEmailId) => {
    const { emails, lastSelectedEmailId, selectedEmailIds } = get();
    const anchorId = lastSelectedEmailId || emails[0]?.id;
    if (!anchorId) return;
    const anchorIndex = emails.findIndex(e => e.id === anchorId);
    const targetIndex = emails.findIndex(e => e.id === targetEmailId);
    if (anchorIndex === -1 || targetIndex === -1) return;
    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    const newSelection = new Set(selectedEmailIds);
    for (let i = start; i <= end; i++) {
      newSelection.add(emails[i].id);
    }
    set({ selectedEmailIds: newSelection });
  },

  selectAllEmails: () => {
    const { emails } = get();
    const allIds = new Set(emails.map(e => e.id));
    set({ selectedEmailIds: allIds });
  },

  clearSelection: () => {
    set({ selectedEmailIds: new Set(), lastSelectedEmailId: null });
  },

  // JMAP operations
  fetchMailboxes: async (client) => {
    // Only toggle the email list's isLoading on the initial load. Background
    // refreshes (after a move/archive that may have created new folders) must
    // not flash the list's loading state, which hides the results-count bar
    // and dims the list while folders re-fetch.
    const isInitialLoad = get().mailboxes.length === 0;
    if (isInitialLoad) set({ isLoading: true, error: null });
    try {
      const mailboxes = await client.getAllMailboxes();

      // Guard against a transient fetch returning an empty list (e.g. a server
      // concurrent-request limit hit during a burst of deletes). Replacing a
      // populated folder list with [] leaves the sidebar stuck on "Loading
      // mailboxes..." until the next successful refetch. Keep what we have.
      if (mailboxes.length === 0 && !isInitialLoad) {
        return;
      }

      // Auto-select inbox if no mailbox is selected or the current selection
      // doesn't exist in the fetched list (e.g. after an account switch)
      const currentSelectedMailbox = get().selectedMailbox;
      const selectionValid = currentSelectedMailbox === VIRTUAL_SCHEDULED_MAILBOX_ID
        || currentSelectedMailbox === ALL_MAIL_MAILBOX_ID
        // Unified per-role views (All Inbox/Drafts/Junk/…) and cross-account views
        // (All unread/starred/all) use a virtual id not present in the fetched
        // list. A background refresh after a delete must not clobber it and jump
        // the user back to the inbox.
        || isUnifiedMailboxId(currentSelectedMailbox)
        || isCrossViewId(currentSelectedMailbox)
        || (currentSelectedMailbox && mailboxes.some(m => m.id === currentSelectedMailbox));
      const loadingPatch = isInitialLoad ? { isLoading: false } : {};
      if (!selectionValid) {
        // Find inbox from PRIMARY account (not shared accounts)
        const inboxMailbox = mailboxes.find(m => m.role === 'inbox' && !m.isShared);
        if (inboxMailbox) {
          set({ mailboxes, selectedMailbox: inboxMailbox.id, ...loadingPatch });
        } else {
          set({ mailboxes, selectedMailbox: '', ...loadingPatch });
        }
      } else {
        set({ mailboxes, ...loadingPatch });
      }
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to fetch mailboxes",
        ...(isInitialLoad ? { isLoading: false } : {})
      });
    }
  },

  prefetchInitialData: async (client) => {
    // Coalesce overlapping callers (e.g. login() and a slow home-page useEffect
    // racing for the same fetch). The promise is stashed on the client so we
    // don't need a separate keyed map and stale entries can't outlive the client.
    const target = client as IJMAPClient & { __prefetchPromise?: Promise<void> };
    if (target.__prefetchPromise) return target.__prefetchPromise;
    target.__prefetchPromise = (async () => {
      try {
        await Promise.all([
          get().fetchMailboxes(client),
          get().fetchQuota(client),
        ]);
        const { selectedMailbox } = get();
        if (selectedMailbox) {
          await get().fetchEmails(client, selectedMailbox);
        } else {
          await get().fetchEmails(client);
        }
        // Tag counts can finish whenever; don't block the prefetch on them.
        void get().fetchTagCounts(client);
      } finally {
        delete target.__prefetchPromise;
      }
    })();
    return target.__prefetchPromise;
  },

  fetchEmails: async (client, mailboxId) => {
    set({ isLoading: true, error: null }); // Keep previous emails visible during transition
    try {
      const targetMailboxId = mailboxId || get().selectedMailbox;
      if (targetMailboxId === VIRTUAL_SCHEDULED_MAILBOX_ID) {
        set({ isLoading: false, emails: [], hasMoreEmails: false, totalEmails: 0 });
        await get().fetchScheduledEmails(client);
        return;
      }
      if (targetMailboxId === ALL_MAIL_MAILBOX_ID) {
        const jmapIds = resolveAllMailJmapIds();
        if (jmapIds.length === 0) {
          set({ emails: [], hasMoreEmails: false, totalEmails: 0, isLoading: false });
          return;
        }
        const emailsPerPage = useSettingsStore.getState().emailsPerPage;
        const result = await resolveActionClient(client).advancedSearchEmails(
          buildAllMailFilter(jmapIds), undefined, emailsPerPage, 0,
        );
        const allMailMailboxes = resolveActionMailboxes();
        for (const email of result.emails) {
          email.sourceFolder = resolveSourceFolderName(email, allMailMailboxes);
        }
        const enrichedEmails = await emailHooks.onEmailsFetched.transform(result.emails);
        set({
          emails: annotateScheduledEmails(enrichedEmails, get().scheduledSubmissionByEmailId),
          hasMoreEmails: result.hasMore,
          totalEmails: result.total,
          isLoading: false,
        });
        return;
      }
      const effectiveClient = resolveActionClient(client);

      // Find the mailbox to get its accountId (for shared folder support)
      const mailboxes = resolveActionMailboxes();
      const mailbox = mailboxes.find(mb => mb.id === targetMailboxId);
      // Only pass accountId for shared mailboxes, not for primary account
      const accountId = mailbox?.isShared ? mailbox.accountId : undefined;
      // Use originalId for JMAP queries (shared mailboxes use namespaced IDs in the store)
      const jmapMailboxId = mailbox?.originalId || targetMailboxId;

      // Get emails per page from settings
      const emailsPerPage = useSettingsStore.getState().emailsPerPage;

      // Build keyword filter if a tag is selected
      const { selectedKeyword } = get();
      const keywordFilter = selectedKeyword ? `$label:${selectedKeyword}` : undefined;

      // When filtering by tag, omit the mailbox constraint so emails across
      // all folders that carry the tag are returned.
      const result = await effectiveClient.getEmails(selectedKeyword ? undefined : jmapMailboxId, accountId, emailsPerPage, 0, keywordFilter, true);
      const enrichedEmails = await emailHooks.onEmailsFetched.transform(result.emails);
      set({
        emails: annotateScheduledEmails(enrichedEmails, get().scheduledSubmissionByEmailId),
        hasMoreEmails: result.hasMore,
        totalEmails: result.total,
        // Clear thread caches since the email list was fully replaced
        threadEmailsCache: new Map(),
        expandedThreadIds: new Set(),
        isLoadingThread: null,
        isLoading: false
      });
      // Fetch full thread counts in the background (non-blocking)
      void get().fetchThreadEmailCounts(client);
    } catch (error) {
      console.error('Failed to fetch emails:', error);
      set({
        error: error instanceof Error ? error.message : "Failed to fetch emails",
        isLoading: false,
        emails: [],
        hasMoreEmails: false,
        totalEmails: 0
      });
    }
  },

  loadMoreEmails: async (client) => {
    const { isLoadingMore, hasMoreEmails, emails, selectedMailbox, searchQuery, selectedKeyword, isUnifiedView, unifiedRole, crossView } = get();

    // Don't load if already loading or no more emails
    if (isLoadingMore || !hasMoreEmails) return;

    // Cross-account views fan out across all accounts' included folders. Paginate
    // via the cross-view loader (search-aware), mirroring the unified branch.
    if (isUnifiedView && crossView) {
      set({ isLoadingMore: true, error: null });
      try {
        const emailsPerPage = useSettingsStore.getState().emailsPerPage;
        const includeGroup = useSettingsStore.getState().includeGroupInUnified;
        const position = emails.length;
        const built = await buildUnifiedAccountClients({ includeGroup });
        const result = searchQuery
          ? await searchCrossViewEmails(built, crossView, searchQuery, emailsPerPage, position)
          : await fetchCrossViewEmails(built, crossView, emailsPerPage, position);
        const currentEmails = get().emails;
        const existingIds = new Set(currentEmails.map(e => e.id));
        const newEmails = result.emails.filter(e => !existingIds.has(e.id));
        const enrichedNewEmails = await emailHooks.onEmailsFetched.transform(newEmails);
        set({
          emails: [...currentEmails, ...enrichedNewEmails],
          hasMoreEmails: result.hasMore,
          totalEmails: result.total,
          isLoadingMore: false,
          unifiedErrors: result.errors,
        });
      } catch (error) {
        console.error('Failed to load more cross-account emails:', error);
        set({
          error: error instanceof Error ? error.message : "Failed to load more emails",
          isLoadingMore: false,
        });
      }
      return;
    }

    // Unified view uses a different fan-out loader. When a search query or
    // advanced filter is active we paginate the unified search instead of the
    // unified browse, so "load more" matches what's on screen.
    if (isUnifiedView && unifiedRole) {
      set({ isLoadingMore: true, error: null });
      try {
        const emailsPerPage = useSettingsStore.getState().emailsPerPage;
        const includeGroup = useSettingsStore.getState().includeGroupInUnified;
        const position = emails.length;
        const built = await buildUnifiedAccountClients({ includeGroup });
        const { searchFilters } = get();
        const hasFilters = !isFilterEmpty(searchFilters);
        const result = hasFilters
          ? await advancedSearchUnifiedEmails(
              built,
              unifiedRole,
              (mailboxId) => buildJMAPFilter(searchQuery, searchFilters, mailboxId),
              emailsPerPage,
              position,
            )
          : searchQuery
            ? await searchUnifiedEmails(built, unifiedRole, searchQuery, emailsPerPage, position)
            : await fetchUnifiedEmails(built, unifiedRole, emailsPerPage, position);
        const currentEmails = get().emails;
        const existingIds = new Set(currentEmails.map(e => e.id));
        const newEmails = result.emails.filter(e => !existingIds.has(e.id));
        const enrichedNewEmails = await emailHooks.onEmailsFetched.transform(newEmails);
        set({
          emails: [...currentEmails, ...enrichedNewEmails],
          hasMoreEmails: result.hasMore,
          totalEmails: result.total,
          isLoadingMore: false,
          unifiedErrors: result.errors,
        });
      } catch (error) {
        console.error('Failed to load more unified emails:', error);
        set({
          error: error instanceof Error ? error.message : "Failed to load more emails",
          isLoadingMore: false,
        });
      }
      return;
    }

    set({ isLoadingMore: true, error: null });
    try {
      if (selectedMailbox === VIRTUAL_SCHEDULED_MAILBOX_ID) {
        set({ isLoadingMore: false });
        await get().loadMoreScheduledEmails(client);
        return;
      }

      const effectiveClient = resolveActionClient(client);
      // Get emails per page from settings
      const emailsPerPage = useSettingsStore.getState().emailsPerPage;

      // Capture position from current email count before the async call
      const position = emails.length;

      let result;

      const { searchFilters } = get();
      const hasFilters = !isFilterEmpty(searchFilters);

      if (selectedMailbox === ALL_MAIL_MAILBOX_ID) {
        if (searchQuery || hasFilters) {
          // Search within All Mail spans the whole account (no inMailbox).
          result = hasFilters
            ? await effectiveClient.advancedSearchEmails(buildJMAPFilter(searchQuery, searchFilters, undefined), undefined, emailsPerPage, position)
            : await effectiveClient.searchEmails(searchQuery, undefined, undefined, emailsPerPage, position);
        } else {
          const jmapIds = resolveAllMailJmapIds();
          if (jmapIds.length === 0) {
            set({ hasMoreEmails: false, isLoadingMore: false });
            return;
          }
          result = await effectiveClient.advancedSearchEmails(buildAllMailFilter(jmapIds), undefined, emailsPerPage, position);
        }
      } else if (searchQuery || hasFilters) {
        const mailboxes = resolveActionMailboxes();
        const mailbox = mailboxes.find(mb => mb.id === selectedMailbox);
        const jmapMailboxId = mailbox?.originalId || selectedMailbox;
        const accountId = mailbox?.isShared ? mailbox.accountId : undefined;

        if (hasFilters) {
          const filter = buildJMAPFilter(searchQuery, searchFilters, jmapMailboxId);
          result = await effectiveClient.advancedSearchEmails(filter, accountId, emailsPerPage, position);
        } else {
          result = await effectiveClient.searchEmails(searchQuery, jmapMailboxId, accountId, emailsPerPage, position);
        }
      } else {
        // Load more from mailbox
        // Find the mailbox to get its accountId (for shared folder support)
        const mailboxes = resolveActionMailboxes();
        const mailbox = mailboxes.find(mb => mb.id === selectedMailbox);
        // Only pass accountId for shared mailboxes, not for primary account
        const accountId = mailbox?.isShared ? mailbox.accountId : undefined;
        // Use originalId for JMAP queries (shared mailboxes use namespaced IDs in the store)
        const jmapMailboxId = mailbox?.originalId || selectedMailbox;

        // When filtering by tag, omit the mailbox constraint (same rationale as fetchEmails).
        result = await effectiveClient.getEmails(selectedKeyword ? undefined : jmapMailboxId, accountId, emailsPerPage, position, selectedKeyword ? `$label:${selectedKeyword}` : undefined, true);
      }

      if (selectedMailbox === ALL_MAIL_MAILBOX_ID) {
        const allMailMailboxes = resolveActionMailboxes();
        for (const email of result.emails) {
          email.sourceFolder = resolveSourceFolderName(email, allMailMailboxes);
        }
      }

      // Use fresh state when merging to avoid overwriting concurrent updates
      // (e.g. refreshCurrentMailbox running during the load)
      const currentEmails = get().emails;

      // Deduplicate: the server may return overlapping results if new emails
      // arrived between paginated requests and shifted positions.
      const existingIds = new Set(currentEmails.map(e => e.id));
      const newEmails = annotateScheduledEmails(result.emails, get().scheduledSubmissionByEmailId).filter((e: Email) => !existingIds.has(e.id));

      const enrichedNewEmails = await emailHooks.onEmailsFetched.transform(newEmails);
      set({
        emails: [...currentEmails, ...enrichedNewEmails],
        hasMoreEmails: result.hasMore,
        totalEmails: result.total,
        isLoadingMore: false
      });
      // Fetch full thread counts for newly loaded threads in the background
      if (enrichedNewEmails.length > 0) {
        void get().fetchThreadEmailCounts(client);
      }
    } catch (error) {
      console.error('Failed to load more emails:', error);
      set({
        error: error instanceof Error ? error.message : "Failed to load more emails",
        isLoadingMore: false
      });
    }
  },

  fetchEmailContent: async (client, emailId) => {
    try {
      // Route to the owning account. In aggregate views (All Mail, unified,
      // cross-account) the selected mailbox is virtual, so derive the client +
      // accountId from the email itself (handles shared/group accounts); fall
      // back to the selected-mailbox shared-folder logic for normal views.
      const listEmail = get().emails.find(e => e.id === emailId);
      let actionClient: IJMAPClient;
      let accountId: string | undefined;
      if (listEmail) {
        ({ client: actionClient, accountId } = resolveEmailActionContext(listEmail, client));
      } else {
        const mailbox = resolveActionMailboxes().find(mb => mb.id === get().selectedMailbox);
        actionClient = resolveActionClient(client);
        accountId = mailbox?.isShared ? mailbox.accountId : undefined;
      }

      const email = await actionClient.getEmail(emailId, accountId);

      if (email) {
        const annotatedEmail = annotateScheduledEmail(email, get().scheduledSubmissionByEmailId);
        set({ selectedEmail: annotatedEmail });
        return annotatedEmail;
      }
      return email;
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to fetch email content"
      });
      return null;
    }
  },

  fetchQuota: async (client) => {
    try {
      const quota = await resolveActionClient(client).getQuota();
      set({ quota });
    } catch {
      // Don't set error state as quota is optional
    }
  },

  sendEmail: async (client, to, subject, body, cc, bcc, identityId, fromEmail, draftId, fromName, htmlBody, attachments, inReplyTo, references, delayedUntil, envelopeMailFrom, options) => {
    set({ isLoading: true, error: null });
    try {
      const result = await client.sendEmail(to, subject, body, cc, bcc, identityId, fromEmail, draftId, fromName, htmlBody, attachments, inReplyTo, references, delayedUntil, envelopeMailFrom, options);
      // Refresh handled by UI layer for immediate feedback
      set({
        isLoading: false,
        pendingUndoSend: result.scheduled && result.emailSubmissionId && result.sendAt
          ? { submissionId: result.emailSubmissionId, emailId: result.emailId, sendAt: result.sendAt, isSmime: false }
          : get().pendingUndoSend,
      });
      return result;
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to send email",
        isLoading: false
      });
      throw error;
    }
  },

  sendRawEmail: async (client, rawMimeBlob, identityId, delayedUntil, envelopeRecipients) => {
    set({ isLoading: true, error: null });
    try {
      const mailboxes = await client.getMailboxes();
      const sentMailbox = mailboxes.find(mb => mb.role === 'sent');
      if (!sentMailbox) throw new Error('No sent mailbox found');
      const draftsMailbox = mailboxes.find(mb => mb.role === 'drafts');
      const result = await client.sendRawEmail(rawMimeBlob, identityId, sentMailbox.id, draftsMailbox?.id, delayedUntil, envelopeRecipients);
      set({
        isLoading: false,
        pendingUndoSend: result.scheduled && result.emailSubmissionId && result.sendAt
          ? { submissionId: result.emailSubmissionId, emailId: result.emailId, sendAt: result.sendAt, isSmime: true }
          : get().pendingUndoSend,
      });
      return result;
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to send email",
        isLoading: false,
      });
      throw error;
    }
  },

  deleteEmail: async (client, emailId, forceDelete) => {
    try {
      // Get the email to check if it's unread and which mailboxes it belongs to
      const email = get().emails.find(e => e.id === emailId);
      if (!email) return;

      const isUnread = !email.keywords?.$seen;
      // In unified view route to the email's own account (client + that
      // account's mailbox list); otherwise the active/viewing context. (#281)
      const { client: effectiveClient, mailboxes, accountId } = resolveEmailActionContext(email, client);

      // Get delete action preference from settings
      const deleteAction = useSettingsStore.getState().deleteAction;
      const permanentlyDeleteJunk = useSettingsStore.getState().permanentlyDeleteJunk;

      // The email's current mailbox drives the junk auto-permanent-delete rule.
      // In unified view it comes from the email's own folders (matching the
      // unified role), not the active account's selected mailbox.
      const currentMailbox = get().isUnifiedView
        ? (mailboxes.find(mb => emailInMailbox(email, mb) && mb.role === get().unifiedRole)
            ?? mailboxes.find(mb => emailInMailbox(email, mb)))
        : mailboxes.find(mb => mb.id === get().selectedMailbox);

      // If in junk folder and setting is enabled, permanently delete
      const isInJunk = currentMailbox?.role === 'junk';
      if (isInJunk && permanentlyDeleteJunk) {
        forceDelete = true;
      }

      // If deleteAction is 'trash' or 'trash-and-read' and not forced permanent delete, try to move to trash mailbox
      if ((deleteAction === 'trash' || deleteAction === 'trash-and-read') && !forceDelete) {
        const trashMailbox = findTrashMailbox(mailboxes, { accountId });
        const alsoMarkRead = deleteAction === 'trash-and-read' && isUnread;

        if (trashMailbox) {
          // Use originalId for shared mailboxes if available
          const trashId = trashMailbox.originalId || trashMailbox.id;
          await effectiveClient.moveToTrash(emailId, trashId, accountId, alsoMarkRead);

          // After marking read in the same request, the email arrives in trash as read.
          const arrivesUnread = isUnread && !alsoMarkRead;

          // Remove from local state (email moved to trash, not in current view).
          // Counter changes go to the email's own account list (#281). Source and
          // trash live in the same account.
          set((state) => {
            const mailboxPatch = email.mailboxIds
              ? applyMailboxCounterUpdate(state, email, (mailbox) => {
                  if (emailInMailbox(email, mailbox)) {
                    return {
                      ...mailbox,
                      totalEmails: Math.max(0, mailbox.totalEmails - 1),
                      unreadEmails: isUnread ? Math.max(0, mailbox.unreadEmails - 1) : mailbox.unreadEmails,
                      totalThreads: Math.max(0, mailbox.totalThreads - 1),
                      unreadThreads: isUnread ? Math.max(0, mailbox.unreadThreads - 1) : mailbox.unreadThreads,
                    };
                  }
                  if (mailbox.id === trashMailbox.id) {
                    return {
                      ...mailbox,
                      totalEmails: mailbox.totalEmails + 1,
                      unreadEmails: arrivesUnread ? mailbox.unreadEmails + 1 : mailbox.unreadEmails,
                      totalThreads: mailbox.totalThreads + 1,
                      unreadThreads: arrivesUnread ? mailbox.unreadThreads + 1 : mailbox.unreadThreads,
                    };
                  }
                  return mailbox;
                })
              : {};

            return {
              emails: state.emails.filter(e => e.id !== emailId),
              selectedEmail: getNextSelectedEmail(state, emailId),
              ...mailboxPatch,
            };
          });
          return;
        }
        // No trash folder found in this account. Surface the failure rather
        // than silently destroying the email - the user asked to move it to
        // trash, not to permanently delete it.
        throw new Error('Trash mailbox not found - cannot move email to trash');
      }

      // Permanent delete
      await effectiveClient.deleteEmail(emailId);

      // Remove from local state and update mailbox counters (in the email's own
      // account list). Unread emails also decrement the unread counters. (#281)
      set((state) => {
        const mailboxPatch = email.mailboxIds
          ? applyMailboxCounterUpdate(state, email, (mailbox) =>
              emailInMailbox(email, mailbox)
                ? {
                    ...mailbox,
                    totalEmails: Math.max(0, mailbox.totalEmails - 1),
                    unreadEmails: isUnread ? Math.max(0, mailbox.unreadEmails - 1) : mailbox.unreadEmails,
                    totalThreads: Math.max(0, mailbox.totalThreads - 1),
                    unreadThreads: isUnread ? Math.max(0, mailbox.unreadThreads - 1) : mailbox.unreadThreads,
                  }
                : mailbox)
          : {};

        return {
          emails: state.emails.filter(e => e.id !== emailId),
          selectedEmail: getNextSelectedEmail(state, emailId),
          ...mailboxPatch,
        };
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to delete email"
      });
      throw error;
    }
  },

  markAsRead: async (client, emailId, read) => {
    try {
      // Check if this email is already being processed
      const processingKey = `${emailId}-${read}`;
      const currentProcessing = get().processingReadStatus;
      if (currentProcessing.has(processingKey)) {
        return; // Already being processed
      }

      // Get the email to check its current state and mailboxes
      const email = get().emails.find(e => e.id === emailId);
      if (!email) return;

      // Check if already in the desired state
      const isCurrentlyRead = email.keywords?.$seen;
      if (isCurrentlyRead === read) {
        return; // Already in desired state
      }

      // Add to processing set
      set((state) => ({
        processingReadStatus: new Set([...state.processingReadStatus, processingKey])
      }));

      // In unified view route to the email's own account client; otherwise use
      // the active/viewing client and the shared-folder accountId. (#281)
      const { client: actionClient, accountId } = resolveEmailActionContext(email, client);

      await actionClient.markAsRead(emailId, read, accountId);

      // Update local state including mailbox counters
      set((state) => {
        // Remove from processing set
        const newProcessingSet = new Set(state.processingReadStatus);
        newProcessingSet.delete(processingKey);

        // Only update counters if the state is actually changing
        const emailInState = state.emails.find(e => e.id === emailId);
        if (!emailInState) return { processingReadStatus: newProcessingSet };

        const wasRead = emailInState.keywords?.$seen;
        if (wasRead === read) {
          return { processingReadStatus: newProcessingSet }; // State unchanged, skip counter update
        }

        // Adjust the unread counter on the folder(s) holding this email, in the
        // email's *own* account's mailbox list (#281). -1 marking read, +1 unread.
        const delta = read ? -1 : 1;
        const mailboxPatch = applyMailboxCounterUpdate(state, emailInState, (mailbox) =>
          emailInMailbox(emailInState, mailbox)
            ? {
                ...mailbox,
                unreadEmails: Math.max(0, mailbox.unreadEmails + delta),
                unreadThreads: Math.max(0, mailbox.unreadThreads + delta),
              }
            : mailbox,
        );

        return {
          emails: state.emails.map(e =>
            e.id === emailId ? { ...e, keywords: { ...e.keywords, $seen: read } } : e
          ),
          selectedEmail: state.selectedEmail?.id === emailId
            ? { ...state.selectedEmail, keywords: { ...state.selectedEmail.keywords, $seen: read } }
            : state.selectedEmail,
          ...mailboxPatch,
          processingReadStatus: newProcessingSet,
          // Also update threadEmailsCache so expanded dropdowns reflect the change
          threadEmailsCache: (() => {
            let updated = false;
            const newCache = new Map(state.threadEmailsCache);
            for (const [tid, cachedEmails] of newCache) {
              const idx = cachedEmails.findIndex(e => e.id === emailId);
              if (idx !== -1) {
                newCache.set(tid, cachedEmails.map((e, i) =>
                  i === idx ? { ...e, keywords: { ...e.keywords, $seen: read } } : e
                ));
                updated = true;
                break;
              }
            }
            return updated ? newCache : state.threadEmailsCache;
          })(),
        };
      });
    } catch (error) {
      // Remove from processing set on error
      set((state) => {
        const newProcessingSet = new Set(state.processingReadStatus);
        newProcessingSet.delete(`${emailId}-${read}`);
        return {
          processingReadStatus: newProcessingSet,
          error: error instanceof Error ? error.message : "Failed to update email"
        };
      });
      throw error;
    }
  },

  moveToMailbox: async (client, emailId, destinationMailboxId) => {
    try {
      const email = get().emails.find(e => e.id === emailId);
      if (!email) return;

      const isUnread = !email.keywords?.$seen;

      // In unified view route to the email's own account (client + that
      // account's mailbox list, where the destination id lives); otherwise the
      // active/viewing context. (#281)
      const { client: actionClient, mailboxes, accountId } = resolveEmailActionContext(email, client);

      const destMailbox = mailboxes.find(mb => mb.id === destinationMailboxId);
      const jmapDestId = destMailbox?.originalId || destinationMailboxId;

      await actionClient.moveEmail(emailId, jmapDestId, accountId);

      set((state) => {
        // Counter changes go to the email's own account list; source and
        // destination live in the same account. (#281)
        const mailboxPatch = applyMailboxCounterUpdate(state, email, (mailbox) => {
          if (emailInMailbox(email, mailbox)) {
            return {
              ...mailbox,
              totalEmails: Math.max(0, mailbox.totalEmails - 1),
              unreadEmails: isUnread ? Math.max(0, mailbox.unreadEmails - 1) : mailbox.unreadEmails,
              totalThreads: Math.max(0, mailbox.totalThreads - 1),
              unreadThreads: isUnread ? Math.max(0, mailbox.unreadThreads - 1) : mailbox.unreadThreads,
            };
          }
          if (mailbox.id === destinationMailboxId) {
            return {
              ...mailbox,
              totalEmails: mailbox.totalEmails + 1,
              unreadEmails: isUnread ? mailbox.unreadEmails + 1 : mailbox.unreadEmails,
              totalThreads: mailbox.totalThreads + 1,
              unreadThreads: isUnread ? mailbox.unreadThreads + 1 : mailbox.unreadThreads,
            };
          }
          return mailbox;
        });

        return {
          emails: state.emails.filter(e => e.id !== emailId),
          selectedEmail: getNextSelectedEmail(state, emailId),
          ...mailboxPatch,
        };
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to move email"
      });
      throw error;
    }
  },

  moveEmailsToMailbox: async (client, emailIds, destinationMailboxId) => {
    if (emailIds.length === 0) return;
    if (emailIds.length === 1) {
      await get().moveToMailbox(client, emailIds[0], destinationMailboxId);
      return;
    }

    try {
      const { emails, selectedMailbox, isUnifiedView } = get();
      const mailboxes = resolveActionMailboxes();
      const destMailbox = mailboxes.find(mb => mb.id === destinationMailboxId);
      const jmapDestId = destMailbox?.originalId || destinationMailboxId;
      const idSet = new Set(emailIds);
      const affected = emails.filter(e => idSet.has(e.id));

      if (isUnifiedView) {
        // In unified view, emails may span accounts – group by owning JMAP account
        // and dispatch through the login client that can reach each one. The login
        // client is keyed by `sourceClientAccountId` (a real AccountEntry.id); the
        // owning account is `sourceAccountId` (passed for owner-scoped routing).
        const bySource = new Map<string, { clientAccountId?: string; ids: string[] }>();
        for (const e of affected) {
          const key = e.sourceAccountId || '__default__';
          if (!bySource.has(key)) bySource.set(key, { clientAccountId: e.sourceClientAccountId, ids: [] });
          bySource.get(key)!.ids.push(e.id);
        }
        await Promise.all(Array.from(bySource.entries()).map(async ([sourceAccountId, { clientAccountId, ids }]) => {
          const acctClient = sourceAccountId === '__default__'
            ? resolveActionClient(client)
            : (clientAccountId ? useAuthStore.getState().getClientForAccount(clientAccountId) : undefined);
          if (!acctClient) return;
          const jmapAccountId = sourceAccountId === '__default__' ? undefined : sourceAccountId;
          await acctClient.batchMoveEmails(ids, jmapDestId, jmapAccountId);
        }));
      } else {
        const currentMailbox = mailboxes.find(mb => mb.id === selectedMailbox);
        const accountId = currentMailbox?.isShared ? currentMailbox.accountId : undefined;
        await resolveActionClient(client).batchMoveEmails(emailIds, jmapDestId, accountId);
      }

      // Adjust counters and drop moved emails from the current view.
      let unreadDelta = 0;
      for (const e of affected) {
        if (!e.keywords?.$seen) unreadDelta += 1;
      }
      const movedCount = affected.length;

      set((state) => {
        // Decrement source folders per the email's own account list (#281).
        const patch = applyBatchMailboxCounterUpdate(state, affected, (mb, group) => {
          let dTotal = 0;
          let dUnread = 0;
          for (const e of group as Email[]) {
            if (emailInMailbox(e, mb)) {
              dTotal--;
              if (!e.keywords?.$seen) dUnread--;
            }
          }
          return dTotal === 0 && dUnread === 0 ? mb : {
            ...mb,
            totalEmails: Math.max(0, mb.totalEmails + dTotal),
            unreadEmails: Math.max(0, mb.unreadEmails + dUnread),
          };
        });
        // The destination folder (picked from the active/viewing list) gains them.
        patch.mailboxes = patch.mailboxes.map(mb => mb.id === destinationMailboxId
          ? { ...mb, totalEmails: mb.totalEmails + movedCount, unreadEmails: mb.unreadEmails + unreadDelta }
          : mb);
        return {
          emails: state.emails.filter(e => !idSet.has(e.id)),
          selectedEmail: state.selectedEmail && idSet.has(state.selectedEmail.id) ? null : state.selectedEmail,
          selectedEmailIds: (() => {
            const next = new Set(state.selectedEmailIds);
            for (const id of idSet) next.delete(id);
            return next;
          })(),
          ...patch,
        };
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to move emails' });
      throw error;
    }
  },

  crossAccountMoveEmails: async (emailIdsBySource, destAccountId, destMailboxId, destJmapAccountId, sourceJmapAccountId) => {
    if (emailIdsBySource.size === 0) return;
    set({ isLoading: true, error: null });
    try {
      const destClient = useAuthStore.getState().getClientForAccount(destAccountId);
      if (!destClient) {
        throw new Error('Destination account is not connected');
      }

      const movedIds: string[] = [];
      const failures: Array<{ emailId: string; error: string }> = [];

      for (const [sourceAccountId, emailIds] of emailIdsBySource.entries()) {
        const sourceClient = useAuthStore.getState().getClientForAccount(sourceAccountId);
        if (!sourceClient) {
          for (const emailId of emailIds) {
            failures.push({ emailId, error: 'Source account not connected' });
          }
          continue;
        }

        // Fan the per-email copy/import/delete pipeline out in parallel.
        // JMAP has no atomic cross-account move, so we accept that a crash
        // mid-flight could leave a duplicate; the delete on success keeps
        // the source clean in the happy path.
        const results = await Promise.allSettled(
          emailIds.map(async (emailId) => {
            // When the source is a delegated/shared mailbox, the email,
            // its blob, and the destroy all live in the owner's JMAP
            // account, not the source client's primary one.
            const full = await sourceClient.getEmail(emailId, sourceJmapAccountId);
            if (!full?.blobId) {
              throw new Error('Source email has no raw blob to copy');
            }
            const blob = await sourceClient.fetchBlob(full.blobId, undefined, undefined, sourceJmapAccountId);
            const keywords: Record<string, boolean> = { ...(full.keywords ?? {}) };
            await destClient.importRawEmail(blob, { [destMailboxId]: true }, keywords, destJmapAccountId);
            await sourceClient.deleteEmail(emailId, sourceJmapAccountId);
            return emailId;
          }),
        );

        results.forEach((outcome, i) => {
          const emailId = emailIds[i];
          if (outcome.status === 'fulfilled') {
            movedIds.push(emailId);
          } else {
            const err = outcome.reason;
            failures.push({
              emailId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        });
      }

      // Drop the moved emails from the current view and clear stale selection
      // entries. Counter accuracy comes from the mailbox refresh below.
      const movedSet = new Set(movedIds);
      set((state) => ({
        emails: state.emails.filter((e) => !movedSet.has(e.id)),
        selectedEmail:
          state.selectedEmail && movedSet.has(state.selectedEmail.id)
            ? null
            : state.selectedEmail,
        selectedEmailIds: (() => {
          const next = new Set(state.selectedEmailIds);
          for (const id of movedIds) next.delete(id);
          return next;
        })(),
        isLoading: false,
      }));

      // Refresh mailbox folder lists/counters for every account we touched.
      // Background-only so the move feels instant - counters will catch up.
      const activeAccountId = useAuthStore.getState().activeAccountId;
      const touched = new Set<string>([destAccountId, ...emailIdsBySource.keys()]);
      for (const acctId of touched) {
        const c = useAuthStore.getState().getClientForAccount(acctId);
        if (!c) continue;
        if (acctId === activeAccountId) {
          void get().fetchMailboxes(c);
        } else {
          void get().fetchAccountMailboxes(c, acctId);
        }
      }

      if (failures.length > 0) {
        const first = failures[0];
        throw new Error(
          failures.length === 1
            ? `Failed to move email: ${first.error}`
            : `Failed to move ${failures.length} email(s); first error: ${first.error}`,
        );
      }
    } catch (error) {
      set({
        isLoading: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to move emails between accounts',
      });
      throw error;
    }
  },

  moveThreadToMailbox: async (client, emailId, destinationMailboxId) => {
    try {
      const state = get();
      const email = state.emails.find(e => e.id === emailId)
        ?? (state.selectedEmail?.id === emailId ? state.selectedEmail : null);

      if (!email?.threadId) {
        await get().moveToMailbox(client, emailId, destinationMailboxId);
        return;
      }

      // In unified view route to the email's own account (client + that
      // account's mailbox list); otherwise the active/viewing context. (#281)
      const { client: effectiveClient, mailboxes, accountId } = resolveEmailActionContext(email, client);
      const destMailbox = mailboxes.find(mb => mb.id === destinationMailboxId);
      const jmapDestId = destMailbox?.originalId || destinationMailboxId;

      const thread = await effectiveClient.getThread(email.threadId, accountId);
      const threadEmailIds = thread?.emailIds?.length ? thread.emailIds : [emailId];

      if (threadEmailIds.length <= 1) {
        await get().moveToMailbox(client, emailId, destinationMailboxId);
        return;
      }

      await effectiveClient.batchMoveEmails(threadEmailIds, jmapDestId, accountId);

      const removedEmailIds = new Set(threadEmailIds);
      set((currentState) => {
        const nextSelectedEmail = getNextSelectedEmailAfterRemoval(currentState, removedEmailIds);
        const nextSelectedEmailIds = new Set(
          Array.from(currentState.selectedEmailIds).filter(id => !removedEmailIds.has(id))
        );
        const nextExpandedThreadIds = new Set(currentState.expandedThreadIds);
        nextExpandedThreadIds.delete(email.threadId);
        const nextThreadEmailsCache = new Map(currentState.threadEmailsCache);
        nextThreadEmailsCache.delete(email.threadId);

        return {
          emails: currentState.emails.filter(currentEmail => !removedEmailIds.has(currentEmail.id)),
          selectedEmail: nextSelectedEmail,
          selectedEmailIds: nextSelectedEmailIds,
          expandedThreadIds: nextExpandedThreadIds,
          threadEmailsCache: nextThreadEmailsCache,
        };
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to move email thread"
      });
      throw error;
    }
  },

  searchEmails: async (client, query) => {
    set({ isLoading: true, error: null, searchQuery: query, emails: [], hasMoreEmails: false, totalEmails: 0 }); // Clear emails for loading state
    try {
      const { isUnifiedView, unifiedRole, crossView, selectedMailbox, searchFilters } = get();
      const emailsPerPage = useSettingsStore.getState().emailsPerPage;

      let result;
      let accountId;
      let unifiedErrors;

      if (isUnifiedView && crossView) {
        const includeGroup = useSettingsStore.getState().includeGroupInUnified;
        const built = await buildUnifiedAccountClients({ includeGroup });
        result = await searchCrossViewEmails(built, crossView, query, emailsPerPage, 0);
        unifiedErrors = result.errors;
        
      } else if (isUnifiedView && unifiedRole) {
        const includeGroup = useSettingsStore.getState().includeGroupInUnified;
        const built = await buildUnifiedAccountClients({ includeGroup });
        result = await searchUnifiedEmails(built, unifiedRole, query, emailsPerPage, 0);
        unifiedErrors = result.errors;

      } else {
        // Get the current mailbox to scope the search. In the All Mail view the
        // search spans every folder of the account (no inMailbox constraint).
        const isAllMail = selectedMailbox === ALL_MAIL_MAILBOX_ID;
        const mailboxes = resolveActionMailboxes();
        const mailbox = mailboxes.find(mb => mb.id === selectedMailbox);
        // Use originalId for shared mailboxes
        const jmapMailboxId = isAllMail ? undefined : (mailbox?.originalId || selectedMailbox);
        // Only pass accountId for shared mailboxes, not for primary account
        accountId = isAllMail ? undefined : (mailbox?.isShared ? mailbox.accountId : undefined);

        result = await resolveActionClient(client).searchEmails(query, jmapMailboxId, accountId, emailsPerPage, 0);
      }

      const hookEdit = await emailHooks.onSearchResults.transform({ 
        newEmailIds: [] as string[], 
        result: result, 
        query: query, 
        filters: searchFilters 
      });

      result = hookEdit.result;
      if (hookEdit.newEmailIds.length > 0) {
        // in unified, accountId will be undefined and we will use the default.
        const newEmails = await resolveActionClient(client).getSomeEmails(hookEdit.newEmailIds, accountId);
        result.emails.push(...newEmails);
        result.total += newEmails.length;
      }

      const externals = await emailHooks.onProvideSearchResults.transform([] as ExternalSearchResult[], { 
        query, 
        filters: searchFilters 
      });
      result.emails = await emailHooks.onEmailsFetched.transform(result.emails);
      set({
        emails: annotateScheduledEmails(result.emails, get().scheduledSubmissionByEmailId),
        externalSearchResults: externals,
        hasMoreEmails: result.hasMore,
        totalEmails: result.total,
        isLoading: false,
        ...(unifiedErrors ? { unifiedErrors } : {}) 
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to search emails",
        isLoading: false,
        emails: [],
        externalSearchResults: [],
        hasMoreEmails: false,
        totalEmails: 0
      });
    }
  },

  advancedSearch: async (client) => {
    const { searchQuery, searchFilters, selectedMailbox, searchAbortController, isUnifiedView, unifiedRole, crossView } = get();
    const mailboxes = resolveActionMailboxes();

    if (searchAbortController) {
      searchAbortController.abort();
    }

    const controller = new AbortController();
    set({
      isLoading: true,
      error: null,
      emails: [],
      hasMoreEmails: false,
      totalEmails: 0,
      searchAbortController: controller,
    });

    try {
      const emailsPerPage = useSettingsStore.getState().emailsPerPage;
      let result;
      let accountId;
      let unifiedErrors;

      if (isUnifiedView && crossView) {
        const includeGroup = useSettingsStore.getState().includeGroupInUnified;
        const built = await buildUnifiedAccountClients({ includeGroup });
        result = await searchCrossViewEmails(built, crossView, searchQuery, emailsPerPage, 0);
        unifiedErrors = result.errors;

      } else if (isUnifiedView && unifiedRole) {
        const includeGroup = useSettingsStore.getState().includeGroupInUnified;
        const built = await buildUnifiedAccountClients({ includeGroup });
        result = await advancedSearchUnifiedEmails(
          built,
          unifiedRole,
          (mailboxId) => buildJMAPFilter(searchQuery, searchFilters, mailboxId),
          emailsPerPage,
          0,
        );
        unifiedErrors = result.errors;

      } else {
        const isAllMail = selectedMailbox === ALL_MAIL_MAILBOX_ID;
        const mailbox = mailboxes.find(mb => mb.id === selectedMailbox);
        const jmapMailboxId = isAllMail ? undefined : (mailbox?.originalId || selectedMailbox);
        accountId = isAllMail ? undefined : (mailbox?.isShared ? mailbox.accountId : undefined);

        const filter = buildJMAPFilter(searchQuery, searchFilters, jmapMailboxId);
        result = await resolveActionClient(client).advancedSearchEmails(filter, accountId, emailsPerPage, 0);
      }

      if (controller.signal.aborted) return;

      const hookEdit = await emailHooks.onSearchResults.transform({ 
        newEmailIds: [] as string[], 
        result: result, 
        query: searchQuery, 
        filters: searchFilters 
      });

      result = hookEdit.result;

      if (hookEdit.newEmailIds.length > 0) {
        const newEmails = await resolveActionClient(client).getSomeEmails(hookEdit.newEmailIds, accountId);
        result.emails.push(...newEmails);
        result.total += newEmails.length;
      }

      if (controller.signal.aborted) return;

      const externals = await emailHooks.onProvideSearchResults.transform([] as ExternalSearchResult[], { 
        query: searchQuery, 
        filters: searchFilters 
      });

      if (controller.signal.aborted) return;
      result.emails = await emailHooks.onEmailsFetched.transform(result.emails);
      set({
        emails: annotateScheduledEmails(result.emails, get().scheduledSubmissionByEmailId),
        externalSearchResults: externals,
        hasMoreEmails: result.hasMore,
        totalEmails: result.total,
        isLoading: false,
        searchAbortController: null,
        ...(unifiedErrors ? { unifiedErrors } : {})
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      set({
        error: error instanceof Error ? error.message : "Failed to search emails",
        isLoading: false,
        emails: [],
        externalSearchResults: [],
        hasMoreEmails: false,
        totalEmails: 0,
        searchAbortController: null,
      });
    }
  },

  setSearchFilters: (filters) => {
    set((state) => ({
      searchFilters: { ...state.searchFilters, ...filters },
    }));
  },

  clearSearchFilters: () => {
    set({ searchFilters: { ...DEFAULT_SEARCH_FILTERS } });
  },

  toggleAdvancedSearch: () => {
    set((state) => ({ isAdvancedSearchOpen: !state.isAdvancedSearchOpen }));
  },

  toggleStar: async (client, emailId) => {
    try {
      const email = get().emails.find(e => e.id === emailId);
      if (!email) return;

      const isFlagged = email.keywords.$flagged || false;
      // In unified view route to the email's own account client + owner accountId
      // (the reaching client's primary is not the owner for shared sources). (#281)
      const { client: actionClient, accountId } = resolveEmailActionContext(email, client);
      await actionClient.toggleStar(emailId, !isFlagged, accountId);

      // Update local state
      set((state) => ({
        emails: state.emails.map(e =>
          e.id === emailId ? { ...e, keywords: { ...e.keywords, $flagged: !isFlagged } } : e
        ),
        selectedEmail: state.selectedEmail?.id === emailId
          ? { ...state.selectedEmail, keywords: { ...state.selectedEmail.keywords, $flagged: !isFlagged } }
          : state.selectedEmail
      }));
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to update star"
      });
      throw error;
    }
  },

  setEmailKeywordsLocal: (emailId, keywords) => {
    set((state) => ({
      emails: state.emails.map(e =>
        e.id === emailId ? { ...e, keywords: { ...keywords } } : e
      ),
      selectedEmail: state.selectedEmail?.id === emailId
        ? { ...state.selectedEmail, keywords: { ...keywords } }
        : state.selectedEmail,
    }));
  },

  // Batch operations
  batchMarkAsRead: async (client, read) => {
    const { selectedEmailIds, emails } = get();
    if (selectedEmailIds.size === 0) return;

    set({ isLoading: true, error: null });
    try {
      const emailIdsArray = Array.from(selectedEmailIds);

      if (get().isUnifiedView) {
        // Group by owning JMAP account; dispatch through the reaching login client.
        const bySource = new Map<string, { clientAccountId?: string; ids: string[] }>();
        for (const emailId of emailIdsArray) {
          const email = emails.find(e => e.id === emailId);
          const key = email?.sourceAccountId || '__default__';
          if (!bySource.has(key)) bySource.set(key, { clientAccountId: email?.sourceClientAccountId, ids: [] });
          bySource.get(key)!.ids.push(emailId);
        }

        const promises = Array.from(bySource.entries()).map(async ([sourceAccountId, { clientAccountId, ids }]) => {
          const acctClient = sourceAccountId === '__default__'
            ? resolveActionClient(client)
            : (clientAccountId ? useAuthStore.getState().getClientForAccount(clientAccountId) : undefined);
          if (!acctClient) return;
          const jmapAccountId = sourceAccountId === '__default__' ? undefined : sourceAccountId;
          await acctClient.batchMarkAsRead(ids, read, jmapAccountId);
        });
        await Promise.allSettled(promises);
      } else {
        await resolveActionClient(client).batchMarkAsRead(emailIdsArray, read);
      }

      // Update local state
      const updatedEmails = emails.map(email =>
        selectedEmailIds.has(email.id)
          ? { ...email, keywords: { ...email.keywords, $seen: read } }
          : email
      );

      // Update mailbox counters per the email's own account list (#281).
      const affectedEmails = emails.filter(e => selectedEmailIds.has(e.id));
      const mailboxPatch = applyBatchMailboxCounterUpdate(get(), affectedEmails, (mailbox, group) => {
        let deltaUnread = 0;
        for (const email of group as Email[]) {
          if (emailInMailbox(email, mailbox) && (email.keywords?.$seen ?? false) !== read) {
            deltaUnread += read ? -1 : 1;
          }
        }
        return deltaUnread === 0 ? mailbox : {
          ...mailbox,
          unreadEmails: Math.max(0, mailbox.unreadEmails + deltaUnread),
          unreadThreads: Math.max(0, mailbox.unreadThreads + deltaUnread),
        };
      });

      set({
        emails: updatedEmails,
        ...mailboxPatch,
        selectedEmailIds: new Set(),
        isLoading: false
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to update emails",
        isLoading: false
      });
    }
  },

  batchDelete: async (client, permanent = false) => {
    const { selectedEmailIds, emails, selectedMailbox } = get();
    const mailboxes = resolveActionMailboxes();
    if (selectedEmailIds.size === 0) return;

    set({ isLoading: true, error: null });
    try {
      const emailIdsArray = Array.from(selectedEmailIds);

      // Determine if the current folder forces permanent deletion.
      const currentMailbox = mailboxes.find(m => m.id === selectedMailbox);
      const isInTrash = currentMailbox?.role === 'trash';
      const permanentlyDeleteJunk = useSettingsStore.getState().permanentlyDeleteJunk;
      const isInJunk = currentMailbox?.role === 'junk';
      const forceDestroy = permanent || isInTrash || (isInJunk && permanentlyDeleteJunk);
      const alsoMarkRead = useSettingsStore.getState().deleteAction === 'trash-and-read';

      // Group emails by owning JMAP account (handles unified view and search results
      // spanning accounts). Each group resolves the reaching login client via
      // `sourceClientAccountId` and routes JMAP via `sourceAccountId`. Undecorated
      // emails (normal single-mailbox view) fall into '__default__' = active client.
      const accountMailboxes = get().accountMailboxes;
      const bySource = new Map<string, { clientAccountId?: string; ids: string[] }>();
      for (const emailId of emailIdsArray) {
        const email = emails.find(e => e.id === emailId);
        const key = email?.sourceAccountId || '__default__';
        if (!bySource.has(key)) bySource.set(key, { clientAccountId: email?.sourceClientAccountId, ids: [] });
        bySource.get(key)!.ids.push(emailId);
      }

      const getClient = (sourceAccountId: string, clientAccountId?: string) =>
        sourceAccountId === '__default__'
          ? resolveActionClient(client)
          : (clientAccountId ? useAuthStore.getState().getClientForAccount(clientAccountId) : undefined);
      const mailboxesFor = (sourceAccountId: string) =>
        sourceAccountId === '__default__' ? mailboxes : (accountMailboxes[sourceAccountId] ?? mailboxes);
      const jmapIdFor = (sourceAccountId: string) =>
        sourceAccountId === '__default__' ? undefined : sourceAccountId;

      if (forceDestroy) {
        const promises = Array.from(bySource.entries()).map(async ([sourceAccountId, { clientAccountId, ids }]) => {
          const acctClient = getClient(sourceAccountId, clientAccountId);
          if (!acctClient) return;
          await acctClient.batchDeleteEmails(ids, jmapIdFor(sourceAccountId));
        });
        await Promise.allSettled(promises);
      } else {
        // Move to trash per account.
        const failedAccounts: string[] = [];
        const movedEmailIds = new Set<string>();
        const promises = Array.from(bySource.entries()).map(async ([sourceAccountId, { clientAccountId, ids }]) => {
          const acctClient = getClient(sourceAccountId, clientAccountId);
          if (!acctClient) {
            failedAccounts.push(sourceAccountId);
            return;
          }
          const trashMailbox = findTrashMailbox(mailboxesFor(sourceAccountId), {
            accountId: jmapIdFor(sourceAccountId),
          });
          if (!trashMailbox) {
            // No trash for this account: skip rather than silently destroying.
            // The user asked to move to trash, not permanently delete.
            failedAccounts.push(sourceAccountId);
            return;
          }
          const trashId = trashMailbox.originalId || trashMailbox.id;
          await acctClient.batchMoveEmails(ids, trashId, jmapIdFor(sourceAccountId), alsoMarkRead);
          ids.forEach(id => movedEmailIds.add(id));
        });
        await Promise.allSettled(promises);

        if (failedAccounts.length > 0 && movedEmailIds.size === 0) {
          // Nothing moved - bail out so the UI doesn't drop the emails from view.
          throw new Error('Trash mailbox not found - cannot move emails to trash');
        }

        // Only remove successfully moved emails from local state.
        if (movedEmailIds.size < emailIdsArray.length) {
          const deletedEmails = emails.filter(e => movedEmailIds.has(e.id));
          const remainingEmails = emails.filter(e => !movedEmailIds.has(e.id));
          const mailboxPatch = applyBatchMailboxCounterUpdate(get(), deletedEmails, applyDeleteCounters);
          set({
            emails: remainingEmails,
            ...mailboxPatch,
            selectedEmailIds: new Set(),
            selectedEmail: null,
            isLoading: false,
            error: 'Some emails could not be moved: trash folder missing for one or more accounts',
          });
          return;
        }
      }

      // Remove deleted emails from local state
      const remainingEmails = emails.filter(e => !selectedEmailIds.has(e.id));

      // Update mailbox counters per the email's own account list (#281).
      const deletedEmails = emails.filter(e => selectedEmailIds.has(e.id));
      const mailboxPatch = applyBatchMailboxCounterUpdate(get(), deletedEmails, applyDeleteCounters);

      set({
        emails: remainingEmails,
        ...mailboxPatch,
        selectedEmailIds: new Set(),
        selectedEmail: null,
        isLoading: false
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to delete emails",
        isLoading: false
      });
    }
  },

  batchMoveToMailbox: async (client, toMailboxId) => {
    const { selectedEmailIds, emails } = get();
    if (selectedEmailIds.size === 0) return;

    set({ isLoading: true, error: null });
    try {
      const emailIdsArray = Array.from(selectedEmailIds);

      if (get().isUnifiedView) {
        // Group by owning JMAP account; dispatch through the reaching login client.
        const destMailbox = resolveActionMailboxes().find(mb => mb.id === toMailboxId);
        const jmapDestId = destMailbox?.originalId || toMailboxId;
        const bySource = new Map<string, { clientAccountId?: string; ids: string[] }>();
        for (const emailId of emailIdsArray) {
          const email = emails.find(e => e.id === emailId);
          const key = email?.sourceAccountId || '__default__';
          if (!bySource.has(key)) bySource.set(key, { clientAccountId: email?.sourceClientAccountId, ids: [] });
          bySource.get(key)!.ids.push(emailId);
        }

        const promises = Array.from(bySource.entries()).map(async ([sourceAccountId, { clientAccountId, ids }]) => {
          const acctClient = sourceAccountId === '__default__'
            ? resolveActionClient(client)
            : (clientAccountId ? useAuthStore.getState().getClientForAccount(clientAccountId) : undefined);
          if (!acctClient) return;
          const jmapAccountId = sourceAccountId === '__default__' ? undefined : sourceAccountId;
          await acctClient.batchMoveEmails(ids, jmapDestId, jmapAccountId);
        });
        await Promise.allSettled(promises);
      } else {
        await resolveActionClient(client).batchMoveEmails(emailIdsArray, toMailboxId);
      }

      // Update local state - remove from current view since they moved
      const remainingEmails = emails.filter(e => !selectedEmailIds.has(e.id));

      set({
        emails: remainingEmails,
        selectedEmailIds: new Set(),
        isLoading: false
      });

      // Refresh emails to get updated list (honors active search/filters)
      if (!get().isUnifiedView) {
        await get().refreshCurrentMailbox(client);
      }
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to move emails",
        isLoading: false
      });
    }
  },

  batchArchive: async (client) => {
    const { selectedEmailIds, emails } = get();
    const mailboxes = resolveActionMailboxes();
    if (selectedEmailIds.size === 0) return;

    const archiveMailbox = mailboxes.find(m => m.role === 'archive' || m.name.toLowerCase() === 'archive');
    if (!archiveMailbox) return;

    const mode = useSettingsStore.getState().archiveMode;
    const archiveId = archiveMailbox.originalId || archiveMailbox.id;

    const selected = emails.filter(e => selectedEmailIds.has(e.id));
    if (selected.length === 0) return;

    set({ isLoading: true, error: null });
    try {
      await resolveActionClient(client).batchArchiveEmails(
        selected.map(e => ({ id: e.id, receivedAt: e.receivedAt })),
        archiveId,
        mode,
        mailboxes,
        archiveMailbox.accountId,
      );

      const remaining = emails.filter(e => !selectedEmailIds.has(e.id));
      set({ emails: remaining, selectedEmailIds: new Set(), isLoading: false });

      // Refresh the active or viewed account's mailbox cache after the
      // archive (a year/month archive can create new sub-folders).
      await refreshMailboxesForViewingAccount(client);
      await get().refreshCurrentMailbox(client);
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to archive emails',
        isLoading: false,
      });
      throw error;
    }
  },

  // Spam operations
  markAsSpam: async (client, emailId) => {
    const email = get().emails.find(e => e.id === emailId);
    if (!email) return;

    // In unified view route to the email's own account (client + that account's
    // mailbox list); otherwise the active/viewing context. (#281)
    const { client: actionClient, mailboxes, accountId } = resolveEmailActionContext(email, client);

    // The email's current mailbox is what undo restores it to. In unified view
    // derive it from the email's own folders (preferring the unified role),
    // otherwise the active account's selected mailbox.
    const currentMailbox = get().isUnifiedView
      ? (mailboxes.find(mb => emailInMailbox(email, mb) && mb.role === get().unifiedRole)
          ?? mailboxes.find(mb => emailInMailbox(email, mb)))
      : mailboxes.find(m => m.id === get().selectedMailbox);
    if (!currentMailbox) return;

    get().spamUndoCache.set(emailId, {
      emailId,
      originalMailboxId: currentMailbox.originalId || currentMailbox.id,
      accountId,
      sourceClientAccountId: get().isUnifiedView ? email.sourceClientAccountId : undefined,
    });

    try {
      const isUnread = !email.keywords?.$seen;
      const alsoMarkRead = useSettingsStore.getState().deleteAction === 'trash-and-read' && isUnread;
      await actionClient.markAsSpam(emailId, accountId, alsoMarkRead);

      // Same junk resolution the client used for the move itself.
      const junkMailbox = mailboxes.find(m =>
        accountId ? (m.role === 'junk' && m.accountId === accountId) : (m.role === 'junk' && !m.isShared)
      );
      // After marking read in the same request, the email arrives in junk as read.
      const arrivesUnread = isUnread && !alsoMarkRead;

      set(state => {
        // Counter changes go to the email's own account list; source and junk
        // live in the same account. (#281)
        const mailboxPatch = applyMailboxCounterUpdate(state, email, (mailbox) => {
          if (emailInMailbox(email, mailbox)) {
            return {
              ...mailbox,
              totalEmails: Math.max(0, mailbox.totalEmails - 1),
              unreadEmails: isUnread ? Math.max(0, mailbox.unreadEmails - 1) : mailbox.unreadEmails,
              totalThreads: Math.max(0, mailbox.totalThreads - 1),
              unreadThreads: isUnread ? Math.max(0, mailbox.unreadThreads - 1) : mailbox.unreadThreads,
            };
          }
          if (junkMailbox && mailbox.id === junkMailbox.id) {
            return {
              ...mailbox,
              totalEmails: mailbox.totalEmails + 1,
              unreadEmails: arrivesUnread ? mailbox.unreadEmails + 1 : mailbox.unreadEmails,
              totalThreads: mailbox.totalThreads + 1,
              unreadThreads: arrivesUnread ? mailbox.unreadThreads + 1 : mailbox.unreadThreads,
            };
          }
          return mailbox;
        });

        return {
          emails: state.emails.filter(e => e.id !== emailId),
          selectedEmail: getNextSelectedEmail(state, emailId),
          ...mailboxPatch,
        };
      });
    } catch (error) {
      console.error('Failed to mark as spam:', error);
      throw error;
    }
  },

  undoSpam: async (client, emailId) => {
    const { selectedMailbox } = get();
    const mailboxes = resolveActionMailboxes();

    // Try cache first (preserves exact original mailbox for toast undo)
    const cachedData = get().spamUndoCache.get(emailId);

    let targetMailboxId: string;
    let accountId: string | undefined;
    // In unified view the cache records the email's owning account so the undo
    // is routed to that account's client, not the active one. (#281)
    let undoClient: IJMAPClient = resolveActionClient(client);

    if (cachedData) {
      // Use cached original mailbox (more accurate for immediate undo)
      targetMailboxId = cachedData.originalMailboxId;
      accountId = cachedData.accountId;
      if (cachedData.sourceClientAccountId) {
        undoClient = useAuthStore.getState().getClientForAccount(cachedData.sourceClientAccountId) ?? undoClient;
      }
      get().spamUndoCache.delete(emailId);
    } else {
      // Generic "not spam" (button/menu, no undo cache). In aggregate views
      // (e.g. "All Junk") route to the email's own account so shared/group
      // messages move back to *their* inbox via *their* client, not the active
      // account's. (#281)
      const listEmail = get().emails.find(e => e.id === emailId);
      let inboxMailboxes = mailboxes;
      if (get().isUnifiedView && listEmail?.sourceClientAccountId && listEmail?.sourceAccountId) {
        undoClient = useAuthStore.getState().getClientForAccount(listEmail.sourceClientAccountId) ?? undoClient;
        accountId = listEmail.sourceAccountId;
        inboxMailboxes = get().accountMailboxes[listEmail.sourceAccountId] ?? mailboxes;
      } else {
        const currentMailbox = mailboxes.find(m => m.id === selectedMailbox);
        accountId = currentMailbox?.accountId;
      }

      // Find inbox in same account
      const inboxMailbox = inboxMailboxes.find(m =>
        m.role === 'inbox' &&
        (accountId ? m.accountId === accountId : !m.accountId)
      );

      if (!inboxMailbox) {
        throw new Error('Inbox not found');
      }

      targetMailboxId = inboxMailbox.originalId || inboxMailbox.id;
    }

    try {
      await undoClient.undoSpam(emailId, targetMailboxId, accountId);

      // Drop the restored mail from the current junk view and advance the open
      // message to the next one, mirroring markAsSpam. Without this the viewer
      // stays stuck on the mail that just left the folder.
      set(state => ({
        emails: state.emails.filter(e => e.id !== emailId),
        selectedEmail: getNextSelectedEmail(state, emailId),
      }));

      // Refresh the view the user is actually looking at.
      if (get().isUnifiedView && get().crossView) {
        const includeGroup = useSettingsStore.getState().includeGroupInUnified;
        const accounts = await buildUnifiedAccountClients({ includeGroup });
        await get().fetchCrossView(accounts, get().crossView!);
      } else if (get().isUnifiedView && get().unifiedRole) {
        const includeGroup = useSettingsStore.getState().includeGroupInUnified;
        const accounts = await buildUnifiedAccountClients({ includeGroup });
        await get().fetchUnifiedEmails(accounts, get().unifiedRole!);
      } else {
        await get().fetchEmails(client, selectedMailbox);
      }

      // Folder counts don't move on their own without a reliable JMAP push
      // (often absent on subpath/cross-origin deploys), so refresh them here so
      // the junk folder's badge drops right away.
      void get().fetchMailboxes(client);
    } catch (error) {
      console.error('Failed to restore email:', error);
      throw error;
    }
  },

  batchMarkAsSpam: async (client, emailIds) => {
    const { selectedMailbox, emails } = get();
    const mailboxes = resolveActionMailboxes();
    const effectiveClient = resolveActionClient(client);

    const currentMailbox = mailboxes.find(m => m.id === selectedMailbox);
    if (!currentMailbox) return;

    const alsoMarkRead = useSettingsStore.getState().deleteAction === 'trash-and-read';

    try {
      for (const emailId of emailIds) {
        const email = emails.find(e => e.id === emailId);
        const markRead = alsoMarkRead && !!email && !email.keywords?.$seen;
        await effectiveClient.markAsSpam(emailId, currentMailbox.accountId, markRead);
      }

      // Adjust counters and drop the emails from the current view. Junk is
      // resolved the same way the client did for the move itself.
      const affected = emails.filter(e => emailIds.includes(e.id));
      const junkMailbox = mailboxes.find(m =>
        currentMailbox.accountId
          ? (m.role === 'junk' && m.accountId === currentMailbox.accountId)
          : (m.role === 'junk' && !m.isShared)
      );
      let junkTotal = 0;
      let junkUnread = 0;
      for (const e of affected) {
        junkTotal += 1;
        // After marking read in the same request, the email arrives in junk as read.
        if (!e.keywords?.$seen && !alsoMarkRead) junkUnread += 1;
      }

      set(state => {
        // Decrement source folders per the email's own account list (#281).
        const patch = applyBatchMailboxCounterUpdate(state, affected, (mb, group) => {
          let dTotal = 0;
          let dUnread = 0;
          for (const e of group as Email[]) {
            if (emailInMailbox(e, mb)) {
              dTotal--;
              if (!e.keywords?.$seen) dUnread--;
            }
          }
          return dTotal === 0 && dUnread === 0 ? mb : {
            ...mb,
            totalEmails: Math.max(0, mb.totalEmails + dTotal),
            unreadEmails: Math.max(0, mb.unreadEmails + dUnread),
          };
        });
        // The junk folder (picked from the active/viewing list) gains them.
        if (junkMailbox) {
          patch.mailboxes = patch.mailboxes.map(mb => mb.id === junkMailbox.id
            ? { ...mb, totalEmails: mb.totalEmails + junkTotal, unreadEmails: mb.unreadEmails + junkUnread }
            : mb);
        }
        return {
          emails: state.emails.filter(e => !emailIds.includes(e.id)),
          selectedEmail: emailIds.includes(state.selectedEmail?.id || '') ? null : state.selectedEmail,
          selectedEmailIds: new Set(),
          ...patch,
        };
      });
    } catch (error) {
      console.error('Failed to batch mark as spam:', error);
      throw error;
    }
  },

  batchUndoSpam: async (client: IJMAPClient, emailIds: string[]) => {
    const { selectedMailbox } = get();
    const mailboxes = resolveActionMailboxes();
    const effectiveClient = resolveActionClient(client);

    // Find inbox (batch operations don't preserve original mailboxes)
    const currentMailbox = mailboxes.find(m => m.id === selectedMailbox);
    const accountId = currentMailbox?.accountId;

    const inboxMailbox = mailboxes.find(m =>
      m.role === 'inbox' &&
      (accountId ? m.accountId === accountId : !m.accountId)
    );

    if (!inboxMailbox) {
      throw new Error('Inbox not found');
    }

    try {
      for (const emailId of emailIds) {
        await effectiveClient.undoSpam(emailId, inboxMailbox.originalId || inboxMailbox.id, accountId);
      }

      // Adjust counters and drop the restored emails from the junk view.
      const affected = get().emails.filter(e => emailIds.includes(e.id));
      let unreadDelta = 0;
      for (const e of affected) {
        if (!e.keywords?.$seen) unreadDelta += 1;
      }

      set(state => {
        // Decrement source folders per the email's own account list (#281).
        const patch = applyBatchMailboxCounterUpdate(state, affected, (mb, group) => {
          let dTotal = 0;
          let dUnread = 0;
          for (const e of group as Email[]) {
            if (emailInMailbox(e, mb)) {
              dTotal--;
              if (!e.keywords?.$seen) dUnread--;
            }
          }
          return dTotal === 0 && dUnread === 0 ? mb : {
            ...mb,
            totalEmails: Math.max(0, mb.totalEmails + dTotal),
            unreadEmails: Math.max(0, mb.unreadEmails + dUnread),
          };
        });
        // The inbox (picked from the active/viewing list) gains them.
        patch.mailboxes = patch.mailboxes.map(mb => mb.id === inboxMailbox.id
          ? { ...mb, totalEmails: mb.totalEmails + affected.length, unreadEmails: mb.unreadEmails + unreadDelta }
          : mb);
        return {
          emails: state.emails.filter(e => !emailIds.includes(e.id)),
          selectedEmail: emailIds.includes(state.selectedEmail?.id || '') ? null : state.selectedEmail,
          selectedEmailIds: new Set(),
          ...patch,
        };
      });
    } catch (error) {
      console.error('Failed to batch restore emails:', error);
      throw error;
    }
  },

  // Push notification handlers
  setPushConnected: (connected) => {
    set({ isPushConnected: connected });
  },

  handleStateChange: async (change, client) => {
    try {
      // Update last push update timestamp
      set({ lastPushUpdate: Date.now() });

      // Get the current account ID from the client (assuming primary account)
      const accountId = client.getAccountId();

      // Check if there are changes for this account
      const accountChanges = change.changed[accountId];
      if (!accountChanges) return;

      // Handle Email state changes - refresh current mailbox
      if (accountChanges.Email) {
        await get().refreshCurrentMailbox(client);
        get().fetchTagCounts(client);
      }

      if (accountChanges.EmailSubmission) {
        await get().refreshScheduledMetadata(client);
        if (get().isScheduledView) {
          await get().fetchScheduledEmails(client);
        }
      }

      // Handle Mailbox state changes - refresh mailbox list
      if (accountChanges.Mailbox) {
        await get().fetchMailboxes(client);
      }

      // Handle Calendar/CalendarEvent state changes - refresh calendar data
      if (accountChanges.Calendar || accountChanges.CalendarEvent) {
        const calendarStore = useCalendarStore.getState();
        if (calendarStore.supportsCalendar) {
          calendarStore.fetchCalendars(client);
          const { dateRange, selectedCalendarIds } = calendarStore;
          if (dateRange && selectedCalendarIds.length > 0) {
            calendarStore.fetchEvents(client, dateRange.start, dateRange.end);
          }
          // Refresh tasks when calendar events change (e.g. task created via CalDAV)
          const { useTaskStore } = await import('./task-store');
          const taskStore = useTaskStore.getState();
          if (taskStore.tasks.length > 0 || calendarStore.viewMode === 'tasks') {
            taskStore.fetchTasks(client);
          }
        }
      }

      // Handle SieveScript state changes - refresh filter rules
      if (accountChanges.SieveScript) {
        const { useFilterStore } = await import('./filter-store');
        const filterStore = useFilterStore.getState();
        if (filterStore.isSupported) {
          filterStore.fetchFilters(client).catch((err) => {
            console.error('Failed to refresh filters:', err);
          });
        }
      }
    } catch (error) {
      console.error('Failed to handle state change:', error);
      set({
        error: error instanceof Error ? error.message : "Failed to handle push notification"
      });
    }
  },

  refreshCurrentMailbox: async (client) => {
    const { selectedMailbox } = get();

    // Only refresh if a mailbox is currently selected
    if (!selectedMailbox) return;

    if (selectedMailbox === VIRTUAL_SCHEDULED_MAILBOX_ID) {
      await get().fetchScheduledEmails(client);
      return;
    }

    try {
      // Fetch emails for the current mailbox without clearing the list first
      // This provides a smoother update experience
      const mailboxes = resolveActionMailboxes();
      const effectiveClient = resolveActionClient(client);
      const mailbox = mailboxes.find(mb => mb.id === selectedMailbox);
      const accountId = mailbox?.isShared ? mailbox.accountId : undefined;
      const jmapMailboxId = mailbox?.originalId || selectedMailbox;

      // Get emails per page from settings
      const emailsPerPage = useSettingsStore.getState().emailsPerPage;

      // Respect active search filters / query so that a push-triggered refresh
      // does not silently replace a filtered list with an unfiltered one.
      const { searchQuery, searchFilters } = get();
      const hasFilters = !isFilterEmpty(searchFilters);

      let result;
      if (hasFilters || searchQuery) {
        const filter = buildJMAPFilter(searchQuery, searchFilters, jmapMailboxId);
        result = await effectiveClient.advancedSearchEmails(filter, accountId, emailsPerPage, 0);
      } else {
        result = await effectiveClient.getEmails(jmapMailboxId, accountId, emailsPerPage, 0, undefined, true);
      }

      const currentEmails = get().emails;
      const previousTotal = get().totalEmails;

      // Only notify for genuinely new incoming mail in the Inbox.
      // Without these guards the toast/sound also fires when sending,
      // saving drafts, or moving/deleting the top message in any mailbox,
      // because all of those change the first-email id of the current view.
      // Pinned mails sit above the date order, so the newest mail is the
      // first NON-pinned entry (a just-arrived mail cannot be pinned yet).
      const newFirst = result.emails.find(e => !e.keywords?.['$pinned']) ?? result.emails[0];
      if (
        newFirst &&
        mailbox?.role === 'inbox' &&
        !currentEmails.some(e => e.id === newFirst.id)
      ) {
        get().handleNewEmailNotification(newFirst);
      }

      // Merge the refreshed first page with the existing loaded emails.
      // This avoids discarding already-loaded pages which would cause the
      // virtual list to shrink and then rapidly re-load (scroll bounce).
      const refreshedEmails = annotateScheduledEmails(result.emails, get().scheduledSubmissionByEmailId);

      // Build the merged list: start with the fresh first page, then append
      // existing emails beyond that page (if any), skipping duplicates. Do not
      // append the whole previous list: drafts are saved as destroy+create, so
      // the old draft can disappear from the refreshed first page and must not
      // be reintroduced from stale local state.
      const merged: Email[] = [...refreshedEmails];
      const mergedIds = new Set(refreshedEmails.map((e: Email) => e.id));
      const insertedCount = Math.max((result.total || 0) - previousTotal, 0);
      const appendFromIndex = Math.max(refreshedEmails.length - insertedCount, 0);

      for (const email of currentEmails.slice(appendFromIndex)) {
        if (!mergedIds.has(email.id)) {
          merged.push(email);
          mergedIds.add(email.id);
        }
      }

      // Check if anything actually changed to avoid unnecessary re-renders
      const hasChanged =
        currentEmails.length !== merged.length ||
        merged.some((email, i) => {
          const curr = currentEmails[i];
          if (!curr) return true;
          return (
            curr.id !== email.id ||
            curr.threadId !== email.threadId ||
            JSON.stringify(curr.keywords) !== JSON.stringify(email.keywords)
          );
        });

      if (hasChanged) {
        // hasMore should reflect whether there are still more emails beyond
        // what we have loaded, using the fresh total from the server.
        const hasMore = merged.length < (result.total || 0);

        // Invalidate thread email caches for threads whose composition changed
        // so expanded threads pick up new/removed emails.
        const prevThreadIds = new Set(currentEmails.map(e => e.threadId));
        const nextThreadIds = new Set(merged.map(e => e.threadId));
        const changedThreadIds = new Set<string>();
        for (const tid of prevThreadIds) {
          if (!nextThreadIds.has(tid)) changedThreadIds.add(tid);
        }
        for (const tid of nextThreadIds) {
          if (!prevThreadIds.has(tid)) changedThreadIds.add(tid);
        }
        // Also check threads where the set of email IDs changed
        const prevEmailsByThread = new Map<string, Set<string>>();
        for (const e of currentEmails) {
          if (!prevEmailsByThread.has(e.threadId)) prevEmailsByThread.set(e.threadId, new Set());
          prevEmailsByThread.get(e.threadId)!.add(e.id);
        }
        const nextEmailsByThread = new Map<string, Set<string>>();
        for (const e of merged) {
          if (!nextEmailsByThread.has(e.threadId)) nextEmailsByThread.set(e.threadId, new Set());
          nextEmailsByThread.get(e.threadId)!.add(e.id);
        }
        for (const [tid, nextIds] of nextEmailsByThread) {
          const prevIds = prevEmailsByThread.get(tid);
          if (!prevIds || prevIds.size !== nextIds.size) {
            changedThreadIds.add(tid);
          } else {
            for (const id of nextIds) {
              if (!prevIds.has(id)) { changedThreadIds.add(tid); break; }
            }
          }
        }

        set((state) => {
          const newCache = new Map(state.threadEmailsCache);
          for (const tid of changedThreadIds) {
            newCache.delete(tid);
          }
          return {
            emails: merged,
            hasMoreEmails: hasMore,
            totalEmails: result.total,
            threadEmailsCache: newCache,
          };
        });

        // Re-fetch cross-folder thread data for any currently expanded threads
        // so they show the complete conversation (not just current-folder emails).
        const expandedNow = get().expandedThreadIds;
        if (expandedNow.size > 0) {
          const effectiveClient2 = resolveActionClient(client);
          const accountId = effectiveClient2.getAccountId();
          for (const tid of expandedNow) {
            void effectiveClient2.getThreadEmails(tid, accountId).then((fullEmails) => {
              if (fullEmails.length > 0) {
                set((state) => {
                  const c = new Map(state.threadEmailsCache);
                  c.set(tid, fullEmails);
                  return { threadEmailsCache: c };
                });
              }
            });
          }
        }

        // Fetch full thread counts in the background (non-blocking)
        void get().fetchThreadEmailCounts(client);
      }
    } catch (error) {
      console.error('Failed to refresh current mailbox:', error);
      // Don't set error state for background refreshes to avoid disrupting the UI
    }
  },

  handleNewEmailNotification: (email) => {
    // Set the new email notification state
    // This can be consumed by a toast component
    set({ newEmailNotification: email });
  },

  clearNewEmailNotification: () => {
    set({ newEmailNotification: null });
  },

  // Thread expansion actions
  toggleThreadExpansion: (threadId) => {
    const { expandedThreadIds } = get();
    const newExpandedThreadIds = new Set(expandedThreadIds);

    if (newExpandedThreadIds.has(threadId)) {
      newExpandedThreadIds.delete(threadId);
    } else {
      newExpandedThreadIds.add(threadId);
    }

    set({ expandedThreadIds: newExpandedThreadIds });
  },

  fetchThreadEmails: async (client, threadId) => {
    const { threadEmailsCache, selectedMailbox } = get();
    const mailboxes = resolveActionMailboxes();

    // Check if we already have this thread cached
    const cachedEmails = threadEmailsCache.get(threadId);
    if (cachedEmails && cachedEmails.length > 0) {
      return cachedEmails;
    }

    // Set loading state
    set({ isLoadingThread: threadId });

    try {
      // Route to the thread's own account. In aggregate views `selectedMailbox`
      // is virtual, so derive the client + accountId from a list email of this
      // thread (handles shared/group accounts); otherwise fall back to the
      // selected-mailbox shared-folder logic. (#281)
      const threadEmail = get().emails.find(e => e.threadId === threadId);
      let actionClient = resolveActionClient(client);
      let accountId: string | undefined;
      if (get().isUnifiedView && threadEmail?.sourceClientAccountId && threadEmail?.sourceAccountId) {
        actionClient = useAuthStore.getState().getClientForAccount(threadEmail.sourceClientAccountId) ?? actionClient;
        accountId = threadEmail.sourceAccountId;
      } else {
        const mailbox = mailboxes.find(mb => mb.id === selectedMailbox);
        accountId = mailbox?.isShared ? mailbox.accountId : undefined;
      }

      // Fetch all emails in the thread
      const emails = await actionClient.getThreadEmails(threadId, accountId);

      // Re-stamp the source reference so actions on thread emails resolve to the
      // right account (the fetched objects don't carry it).
      if (get().isUnifiedView && threadEmail) {
        for (const e of emails) {
          e.accountId = threadEmail.accountId;
          e.accountLabel = threadEmail.accountLabel;
          e.sourceClientAccountId = threadEmail.sourceClientAccountId;
          e.sourceAccountId = threadEmail.sourceAccountId;
        }
      }

      // Update cache
      const newCache = new Map(get().threadEmailsCache);
      newCache.set(threadId, emails);

      set({
        threadEmailsCache: newCache,
        isLoadingThread: null
      });

      return emails;
    } catch (error) {
      console.error('Failed to fetch thread emails:', error);
      set({ isLoadingThread: null });
      return [];
    }
  },

  markThreadAsRead: async (client, threadId) => {
    const state = get();
    const threadEmails = state.threadEmailsCache.get(threadId) ?? [];
    const mainEmails = state.emails.filter(e => e.threadId === threadId);

    // Combine unique emails from both sources
    const allEmailMap = new Map<string, Email>();
    for (const e of mainEmails) allEmailMap.set(e.id, e);
    for (const e of threadEmails) allEmailMap.set(e.id, e);

    const unreadIds = Array.from(allEmailMap.values())
      .filter(e => !e.keywords?.$seen)
      .map(e => e.id);

    if (unreadIds.length === 0) return;

    // Group by account for unified view support
    const emailsById = new Map<string, Email>();
    for (const e of allEmailMap.values()) emailsById.set(e.id, e);

    // Group unread IDs by account client
    const groups = new Map<IJMAPClient, string[]>();
    for (const id of unreadIds) {
      const email = emailsById.get(id)!;
      const { client: actionClient } = resolveEmailActionContext(email, client);
      if (!groups.has(actionClient)) groups.set(actionClient, []);
      groups.get(actionClient)!.push(id);
    }

    // Mark all as read on the server
    try {
      await Promise.all(
        Array.from(groups.entries()).map(([actionClient, emailIds]) =>
          actionClient.batchMarkAsRead(emailIds, true)
        )
      );
    } catch (error) {
      console.error('Failed to mark thread as read:', error);
      return;
    }

    // Update local state
    set((state) => {
      const unreadSet = new Set(unreadIds);

      const updatedEmails = state.emails.map(e =>
        unreadSet.has(e.id) ? { ...e, keywords: { ...e.keywords, $seen: true } } : e
      );

      // Update threadEmailsCache
      const newCache = new Map(state.threadEmailsCache);
      const cached = newCache.get(threadId);
      if (cached) {
        newCache.set(threadId, cached.map(e =>
          unreadSet.has(e.id) ? { ...e, keywords: { ...e.keywords, $seen: true } } : e
        ));
      }

      // Update mailbox unread counters in the thread's own account list (#281).
      const affectedEmails = state.emails.filter(e => unreadSet.has(e.id));
      const mailboxPatch = applyBatchMailboxCounterUpdate(state, affectedEmails, (mailbox, group) => {
        let delta = 0;
        for (const email of group as Email[]) {
          if (emailInMailbox(email, mailbox)) delta -= 1;
        }
        return delta === 0 ? mailbox : {
          ...mailbox,
          unreadEmails: Math.max(0, mailbox.unreadEmails + delta),
          unreadThreads: Math.max(0, mailbox.unreadThreads + delta),
        };
      });

      return {
        emails: updatedEmails,
        threadEmailsCache: newCache,
        ...mailboxPatch,
        selectedEmail: state.selectedEmail && unreadSet.has(state.selectedEmail.id)
          ? { ...state.selectedEmail, keywords: { ...state.selectedEmail.keywords, $seen: true } }
          : state.selectedEmail,
      };
    });
  },

  collapseAllThreads: () => {
    set({
      expandedThreadIds: new Set(),
      isLoadingThread: null
    });
  },

  updateThreadCache: (threadId, emails) => {
    const newCache = new Map(get().threadEmailsCache);
    newCache.set(threadId, emails);
    set({ threadEmailsCache: newCache });
  },

  fetchThreadEmailCounts: async (client) => {
    const { emails } = get();
    if (emails.length === 0) return;

    const uniqueThreadIds = [...new Set(emails.map(e => e.threadId).filter(Boolean))];
    if (uniqueThreadIds.length === 0) return;

    try {
      const effectiveClient = resolveActionClient(client);
      const threads = await effectiveClient.getThreads(uniqueThreadIds);

      const newCounts = new Map(get().threadEmailCounts);
      for (const thread of threads) {
        newCounts.set(thread.id, thread.emailIds?.length ?? 0);
      }
      set({ threadEmailCounts: newCounts });
    } catch {
      // Non-critical — fall back to inbox-only counts
    }
  },

  // Mailbox management
  createMailbox: async (client, name, parentId) => {
    try {
      await resolveActionClient(client).createMailbox(name, parentId);
      if (get().viewingAccountId) {
        await refreshMailboxesForViewingAccount(client);
      } else {
        await get().fetchMailboxes(client);
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to create folder' });
      throw error;
    }
  },

  renameMailbox: async (client, mailboxId, name) => {
    try {
      await resolveActionClient(client).updateMailbox(mailboxId, { name });
      const viewingId = get().viewingAccountId;
      if (viewingId) {
        set((state) => ({
          accountMailboxes: {
            ...state.accountMailboxes,
            [viewingId]: (state.accountMailboxes[viewingId] ?? []).map(mb =>
              mb.id === mailboxId ? { ...mb, name } : mb
            ),
          },
        }));
      } else {
        set({
          mailboxes: get().mailboxes.map(mb =>
            mb.id === mailboxId ? { ...mb, name } : mb
          ),
        });
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to rename folder' });
      throw error;
    }
  },

  deleteMailbox: async (client, mailboxId) => {
    try {
      await resolveActionClient(client).deleteMailbox(mailboxId);
      const { selectedMailbox, viewingAccountId: viewingId } = get();
      if (viewingId) {
        const updatedList = (get().accountMailboxes[viewingId] ?? []).filter(mb => mb.id !== mailboxId);
        const patch: Partial<EmailStore> = {
          accountMailboxes: { ...get().accountMailboxes, [viewingId]: updatedList },
        };
        if (selectedMailbox === mailboxId) {
          const inbox = updatedList.find(mb => mb.role === 'inbox' && !mb.isShared);
          if (inbox) patch.selectedMailbox = inbox.id;
        }
        set(patch);
      } else {
        const newMailboxes = get().mailboxes.filter(mb => mb.id !== mailboxId);
        const updates: Partial<EmailStore> = { mailboxes: newMailboxes };
        if (selectedMailbox === mailboxId) {
          const inbox = newMailboxes.find(mb => mb.role === 'inbox' && !mb.isShared);
          if (inbox) updates.selectedMailbox = inbox.id;
        }
        set(updates);
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to delete folder' });
      throw error;
    }
  },

  setMailboxRole: async (client, mailboxId, role) => {
    try {
      const effectiveClient = resolveActionClient(client);
      // If assigning a role, first clear that role from ALL other mailboxes that have it
      if (role) {
        const existingMailboxes = resolveActionMailboxes().filter(mb => mb.role === role && !mb.isShared && mb.id !== mailboxId);
        for (const existing of existingMailboxes) {
          await effectiveClient.updateMailbox(existing.id, { role: null });
        }
      }
      await effectiveClient.updateMailbox(mailboxId, { role });
      if (get().viewingAccountId) {
        await refreshMailboxesForViewingAccount(client);
      } else {
        await get().fetchMailboxes(client);
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to update folder role' });
      throw error;
    }
  },

  emptyMailbox: async (client, mailboxId) => {
    try {
      set({ isLoading: true, error: null });
      const mailbox = resolveActionMailboxes().find(mb => mb.id === mailboxId);
      const accountId = mailbox?.isShared ? mailbox.accountId : undefined;
      const jmapMailboxId = mailbox?.originalId || mailboxId;
      await resolveActionClient(client).emptyMailbox(jmapMailboxId, accountId);

      // Clear emails from local state if we're viewing this mailbox
      const currentMailbox = get().selectedMailbox;
      if (currentMailbox === mailboxId) {
        set({ emails: [], selectedEmail: null });
      }

      const viewingId = get().viewingAccountId;
      if (viewingId) {
        set((state) => ({
          accountMailboxes: {
            ...state.accountMailboxes,
            [viewingId]: (state.accountMailboxes[viewingId] ?? []).map(mb =>
              mb.id === mailboxId
                ? { ...mb, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0 }
                : mb
            ),
          },
        }));
      } else {
        set({
          mailboxes: get().mailboxes.map(mb =>
            mb.id === mailboxId
              ? { ...mb, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0 }
              : mb
          ),
        });
      }
      set({ isLoading: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to empty folder',
        isLoading: false,
      });
      throw error;
    }
  },

  markMailboxAsRead: async (client, mailboxId) => {
    try {
      const mailbox = resolveActionMailboxes().find(mb => mb.id === mailboxId);
      const accountId = mailbox?.isShared ? mailbox.accountId : undefined;
      const jmapMailboxId = mailbox?.originalId || mailboxId;

      const count = await resolveActionClient(client).markMailboxAsRead(jmapMailboxId, accountId);

      // Update local state: mark all emails currently visible in this mailbox as read,
      // and zero-out the mailbox unread counter.
      set((state) => ({
        emails: state.emails.map(e =>
          e.mailboxIds && e.mailboxIds[mailboxId]
            ? { ...e, keywords: { ...e.keywords, $seen: true } }
            : e
        ),
        selectedEmail: state.selectedEmail && state.selectedEmail.mailboxIds?.[mailboxId]
          ? { ...state.selectedEmail, keywords: { ...state.selectedEmail.keywords, $seen: true } }
          : state.selectedEmail,
        mailboxes: state.mailboxes.map(mb =>
          mb.id === mailboxId
            ? { ...mb, unreadEmails: 0, unreadThreads: 0 }
            : mb
        ),
      }));

      return count;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to mark folder as read' });
      throw error;
    }
  },

  // Unified mailbox operations
  fetchUnifiedEmails: async (accounts, role) => {
    set({
      isLoading: true,
      error: null,
      isUnifiedView: true,
      unifiedRole: role,
      crossView: null,
      selectedKeyword: null,
    });
    try {
      const emailsPerPage = useSettingsStore.getState().emailsPerPage;
      const result = await fetchUnifiedEmails(accounts, role, emailsPerPage, 0);
      set({
        emails: result.emails,
        hasMoreEmails: result.hasMore,
        totalEmails: result.total,
        isLoading: false,
        unifiedErrors: result.errors,
      });
    } catch (error) {
      console.error('Failed to fetch unified emails:', error);
      set({
        error: error instanceof Error ? error.message : "Failed to fetch unified emails",
        isLoading: false,
        emails: [],
        hasMoreEmails: false,
        totalEmails: 0,
      });
    }
  },

  loadMoreUnifiedEmails: async (accounts) => {
    const { isLoadingMore, hasMoreEmails, emails, unifiedRole } = get();
    if (isLoadingMore || !hasMoreEmails || !unifiedRole) return;

    set({ isLoadingMore: true, error: null });
    try {
      const emailsPerPage = useSettingsStore.getState().emailsPerPage;
      const position = emails.length;
      const result = await fetchUnifiedEmails(accounts, unifiedRole, emailsPerPage, position);

      const currentEmails = get().emails;
      const existingIds = new Set(currentEmails.map(e => e.id));
      const newEmails = result.emails.filter(e => !existingIds.has(e.id));

      set({
        emails: [...currentEmails, ...newEmails],
        hasMoreEmails: result.hasMore,
        totalEmails: result.total,
        isLoadingMore: false,
        unifiedErrors: result.errors,
      });
    } catch (error) {
      console.error('Failed to load more unified emails:', error);
      set({
        error: error instanceof Error ? error.message : "Failed to load more unified emails",
        isLoadingMore: false,
      });
    }
  },

  refreshUnifiedCounts: async (accounts) => {
    try {
      const counts = fetchUnifiedMailboxCounts(accounts);
      set({ unifiedCounts: counts });
    } catch (error) {
      console.error('Failed to refresh unified counts:', error);
    }
  },

  fetchCrossView: async (accounts, view) => {
    set({
      isLoading: true,
      error: null,
      isUnifiedView: true,
      unifiedRole: null,
      crossView: view,
      selectedKeyword: null,
    });
    try {
      const emailsPerPage = useSettingsStore.getState().emailsPerPage;
      const result = await fetchCrossViewEmails(accounts, view, emailsPerPage, 0);
      set({
        emails: result.emails,
        hasMoreEmails: result.hasMore,
        totalEmails: result.total,
        isLoading: false,
        unifiedErrors: result.errors,
      });
    } catch (error) {
      console.error('Failed to fetch cross-account view:', error);
      set({
        error: error instanceof Error ? error.message : "Failed to fetch cross-account view",
        isLoading: false,
        emails: [],
        hasMoreEmails: false,
        totalEmails: 0,
      });
    }
  },

  refreshCrossCounts: (accounts) => {
    try {
      set({ crossUnreadCount: getCrossUnreadTotal(accounts) });
    } catch (error) {
      console.error('Failed to refresh cross-account counts:', error);
    }
  },

  exitUnifiedView: () => {
    set({
      isUnifiedView: false,
      unifiedRole: null,
      crossView: null,
      unifiedErrors: new Map(),
    });
  },

  setScheduledView: (isScheduledView) => set(state => {
    const leavingScheduled = !isScheduledView && state.selectedMailbox === VIRTUAL_SCHEDULED_MAILBOX_ID;
    return {
      isScheduledView,
      selectedMailbox: isScheduledView ? VIRTUAL_SCHEDULED_MAILBOX_ID : leavingScheduled ? "" : state.selectedMailbox,
      selectedEmail: leavingScheduled ? null : state.selectedEmail,
      selectedEmailIds: leavingScheduled ? new Set<string>() : state.selectedEmailIds,
    };
  }),
  clearPendingUndoSend: () => set({ pendingUndoSend: null }),

  fetchScheduledEmails: async (client) => {
    set({ isLoadingScheduled: true, error: null });
    try {
      const emailsPerPage = useSettingsStore.getState().emailsPerPage;
      const result = await client.getScheduledEmails(emailsPerPage, 0);
      result.emails = await emailHooks.onEmailsFetched.transform(result.emails);
      const scheduledEmailIds = new Set(result.emails.map(email => email.id));
      const scheduledSubmissionByEmailId = new Map(result.emails.map(email => [email.id, {
        submissionId: email.emailSubmissionId,
        sendAt: email.scheduledSendAt,
        identityId: email.scheduledIdentityId,
        undoStatus: email.scheduledUndoStatus,
      }]));
      const pendingUndoSend = get().pendingUndoSend;
      set({
        scheduledEmails: result.emails,
        scheduledEmailIds,
        scheduledSubmissionByEmailId,
        scheduledTotal: result.total,
        scheduledHasMore: result.hasMore,
        scheduledNextPosition: result.nextPosition,
        isLoadingScheduled: false,
        pendingUndoSend: shouldClearPendingUndoSend(pendingUndoSend, result.emails) ? null : pendingUndoSend,
      });
    } catch (error) {
      console.error('Failed to fetch scheduled emails:', error);
      set({
        error: error instanceof Error ? error.message : 'Failed to fetch scheduled emails',
        scheduledEmails: [],
        scheduledEmailIds: new Set(),
        scheduledSubmissionByEmailId: new Map(),
        scheduledTotal: 0,
        scheduledHasMore: false,
        scheduledNextPosition: 0,
        isLoadingScheduled: false,
      });
    }
  },

  loadMoreScheduledEmails: async (client) => {
    const { isLoadingScheduled, scheduledHasMore, scheduledEmails, scheduledNextPosition } = get();
    if (isLoadingScheduled || !scheduledHasMore) return;
    set({ isLoadingScheduled: true, error: null });
    try {
      const emailsPerPage = useSettingsStore.getState().emailsPerPage;
      const result = await client.getScheduledEmails(emailsPerPage, scheduledNextPosition);
      result.emails = await emailHooks.onEmailsFetched.transform(result.emails);
      const merged = [...scheduledEmails, ...result.emails.filter(email => !scheduledEmails.some(existing => existing.id === email.id))];
      const pendingUndoSend = get().pendingUndoSend;
      set({
        scheduledEmails: merged,
        scheduledEmailIds: new Set(merged.map(email => email.id)),
        scheduledSubmissionByEmailId: new Map(merged.map(email => [email.id, {
          submissionId: email.emailSubmissionId,
          sendAt: email.scheduledSendAt,
          identityId: email.scheduledIdentityId,
          undoStatus: email.scheduledUndoStatus,
        }])),
        scheduledTotal: result.total,
        scheduledHasMore: result.hasMore,
        scheduledNextPosition: result.nextPosition,
        isLoadingScheduled: false,
        pendingUndoSend: shouldClearPendingUndoSend(pendingUndoSend, merged) ? null : pendingUndoSend,
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to load scheduled emails', isLoadingScheduled: false });
    }
  },

  refreshScheduledMetadata: async (client) => {
    try {
      const emailsPerPage = useSettingsStore.getState().emailsPerPage;
      const allEmails: ScheduledEmail[] = [];
      let position = 0;
      let hasMore = true;
      let total = 0;
      while (hasMore) {
        const page = await client.getScheduledEmails(emailsPerPage, position);
        allEmails.push(...page.emails.filter(email => !allEmails.some(existing => existing.id === email.id)));
        total = page.total;
        hasMore = page.hasMore && page.nextPosition > position;
        position = page.nextPosition;
      }
      const pendingUndoSend = get().pendingUndoSend;
      set({
        scheduledEmails: get().isScheduledView ? allEmails : get().scheduledEmails,
        scheduledEmailIds: new Set(allEmails.map(email => email.id)),
        scheduledSubmissionByEmailId: new Map(allEmails.map(email => [email.id, {
          submissionId: email.emailSubmissionId,
          sendAt: email.scheduledSendAt,
          identityId: email.scheduledIdentityId,
          undoStatus: email.scheduledUndoStatus,
        }])),
        scheduledTotal: total,
        scheduledHasMore: false,
        scheduledNextPosition: position,
        pendingUndoSend: shouldClearPendingUndoSend(pendingUndoSend, allEmails) ? null : pendingUndoSend,
      });
    } catch (error) {
      console.error('Failed to refresh scheduled metadata:', error);
    }
  },

  cancelScheduledEmail: async (client, submissionId, emailId) => {
    await client.cancelEmailSubmission(submissionId);
    if (emailId) {
      await client.deleteEmail(emailId);
      set(state => ({
        selectedEmail: state.selectedEmail?.id === emailId ? null : state.selectedEmail,
        selectedEmailIds: new Set(Array.from(state.selectedEmailIds).filter(id => id !== emailId)),
      }));
    }
    if (get().pendingUndoSend?.submissionId === submissionId) {
      set({ pendingUndoSend: null });
    }
    await get().fetchScheduledEmails(client);
  },

  cancelScheduledEmailForEdit: async (client, email) => {
    const submissionId = email.emailSubmissionId;
    if (!submissionId) return null;
    await client.cancelEmailSubmission(submissionId);
    if (get().pendingUndoSend?.submissionId === submissionId) {
      set({ pendingUndoSend: null });
    }
    if (email.isSmimeScheduled) {
      await client.deleteEmail(email.id);
      set(state => ({
        selectedEmail: state.selectedEmail?.id === email.id ? null : state.selectedEmail,
        selectedEmailIds: new Set(Array.from(state.selectedEmailIds).filter(id => id !== email.id)),
      }));
      await get().fetchScheduledEmails(client);
      return null;
    }
    const mailboxes = get().mailboxes.length > 0 ? get().mailboxes : await client.getMailboxes();
    const draftsMailbox = mailboxes.find(mb => mb.role === 'drafts');
    const sentMailbox = mailboxes.find(mb => mb.role === 'sent');
    if (draftsMailbox) {
      await client.restoreEmailToDraft(email.id, draftsMailbox.originalId || draftsMailbox.id, sentMailbox?.originalId || sentMailbox?.id);
    }
    await get().fetchScheduledEmails(client);
    const restored = await client.getEmail(email.id);
    return restored;
  },

  rescheduleScheduledEmail: async (client, submissionId, emailId, identityId, delayedUntil) => {
    let result: SendEmailResult | undefined;
    try {
      result = await client.rescheduleEmailSubmission(submissionId, emailId, identityId, delayedUntil);
      const pendingUndoSend = get().pendingUndoSend;
      if (pendingUndoSend?.submissionId === submissionId) {
        set({ pendingUndoSend: { ...pendingUndoSend, submissionId: result.emailSubmissionId || submissionId, sendAt: result.sendAt || delayedUntil } });
      }
      return result;
    } finally {
      await get().fetchScheduledEmails(client);
      if (result && get().selectedEmail?.id === emailId) {
        const refreshed = get().scheduledEmails.find(email => email.id === emailId);
        set(state => ({
          selectedEmail: refreshed || (state.selectedEmail ? {
            ...state.selectedEmail,
            emailSubmissionId: result?.emailSubmissionId || submissionId,
            scheduledSendAt: result?.sendAt || delayedUntil,
            scheduledIdentityId: identityId,
            scheduledUndoStatus: 'pending' as const,
            isScheduled: true,
          } : state.selectedEmail),
        }));
      }
    }
  },

  cancelUndoSend: async (client, pending) => {
    await client.cancelEmailSubmission(pending.submissionId);
    if (pending.emailId && pending.isSmime) {
      await client.deleteEmail(pending.emailId);
      set(state => ({
        selectedEmail: state.selectedEmail?.id === pending.emailId ? null : state.selectedEmail,
        selectedEmailIds: new Set(Array.from(state.selectedEmailIds).filter(id => id !== pending.emailId)),
      }));
    } else if (pending.emailId) {
      const mailboxes = get().mailboxes.length > 0 ? get().mailboxes : await client.getMailboxes();
      const draftsMailbox = mailboxes.find(mb => mb.role === 'drafts');
      const sentMailbox = mailboxes.find(mb => mb.role === 'sent');
      if (draftsMailbox) {
        await client.restoreEmailToDraft(pending.emailId, draftsMailbox.originalId || draftsMailbox.id, sentMailbox?.originalId || sentMailbox?.id);
      }
    }
    await get().refreshScheduledMetadata(client);
    set({ pendingUndoSend: null });
    return pending.emailId && !pending.isSmime ? client.getEmail(pending.emailId) : null;
  },

  loadMockData: () => {
    const mockEmails: Email[] = [
      {
        id: "1",
        threadId: "thread-1",
        mailboxIds: { inbox: true },
        keywords: { $seen: false },
        size: 1024,
        receivedAt: new Date().toISOString(),
        from: [{ name: "GitHub", email: "notifications@github.com" }],
        to: [{ email: "you@example.com" }],
        subject: "[bulwark-webmail] New pull request #42: Add OAuth2 module",
        preview: "dependabot[bot] opened a pull request in bulwarkmail/webmail. This PR adds a comprehensive authentication module with OAuth2 PKCE support...",
        hasAttachment: false,
      },
      {
        id: "2",
        threadId: "thread-2",
        mailboxIds: { inbox: true },
        keywords: { $seen: true, $flagged: true },
        size: 512,
        receivedAt: new Date(Date.now() - 3600000).toISOString(),
        from: [{ name: "Emily Chen", email: "emily.chen@gmail.com" }],
        to: [{ email: "you@example.com" }],
        subject: "Re: Dashboard Redesign v2 - feedback",
        preview: "Hey! I just pushed the updated mockups to Figma. I incorporated all the feedback from last week's meeting. Let me know what you think about the new nav...",
        hasAttachment: true,
      },
      {
        id: "3",
        threadId: "thread-3",
        mailboxIds: { inbox: true },
        keywords: { $seen: false },
        size: 2048,
        receivedAt: new Date(Date.now() - 7200000).toISOString(),
        from: [{ name: "Slack", email: "notifications@slack.com" }],
        to: [{ email: "you@example.com" }],
        subject: "3 new messages in #engineering",
        preview: "Marcus: Hey team, the CI pipeline is green again. Sarah: Great, merging the feature branch now. Alex: Let's do a quick sync at 3 PM...",
        hasAttachment: false,
      },
      {
        id: "4",
        threadId: "thread-4",
        mailboxIds: { inbox: true },
        keywords: { $seen: true },
        size: 768,
        receivedAt: new Date(Date.now() - 14400000).toISOString(),
        from: [{ name: "Marcus Rivera", email: "marcus.rivera@outlook.com" }],
        to: [{ email: "you@example.com" }],
        subject: "Quick question about the API rate limits",
        preview: "Hey, I was looking at the JMAP spec and I'm not sure how we should handle rate limiting on the server side. Do you have any thoughts on...",
        hasAttachment: false,
      },
      {
        id: "5",
        threadId: "thread-5",
        mailboxIds: { inbox: true },
        keywords: { $seen: true },
        size: 1536,
        receivedAt: new Date(Date.now() - 86400000).toISOString(),
        from: [{ name: "Stripe", email: "receipts@stripe.com" }],
        to: [{ email: "you@example.com" }],
        subject: "Your invoice from Acme Corp is ready",
        preview: "Invoice #INV-2026-0312 for $49.00 has been paid. Thank you for your payment. View your receipt and download your invoice...",
        hasAttachment: true,
      },
      {
        id: "6",
        threadId: "thread-6",
        mailboxIds: { inbox: true },
        keywords: { $seen: false },
        size: 3072,
        receivedAt: new Date(Date.now() - 108000000).toISOString(),
        from: [{ name: "Sarah Kim", email: "sarah.kim@proton.me" }],
        to: [{ email: "you@example.com" }],
        subject: "Conference talk proposal - need your review",
        preview: "I'm submitting a talk to ReactConf about our email client architecture. Could you take a look at my abstract before the deadline on Friday?...",
        hasAttachment: true,
      },
      {
        id: "7",
        threadId: "thread-7",
        mailboxIds: { inbox: true },
        keywords: { $seen: true, $flagged: true },
        size: 4096,
        receivedAt: new Date(Date.now() - 172800000).toISOString(),
        from: [{ name: "Vercel", email: "notifications@vercel.com" }],
        to: [{ email: "you@example.com" }],
        subject: "Deployment successful: bulwark-webmail \u2192 Production",
        preview: "Your project bulwark-webmail has been deployed to production. Build completed in 47s. All checks passed. Preview: https://bulwark-webmail.vercel.app...",
        hasAttachment: false,
      },
      {
        id: "8",
        threadId: "thread-8",
        mailboxIds: { inbox: true },
        keywords: { $seen: true },
        size: 2560,
        receivedAt: new Date(Date.now() - 259200000).toISOString(),
        from: [{ name: "Alex Petrov", email: "alex.petrov@fastmail.com" }],
        to: [{ email: "you@example.com" }],
        subject: "Meeting notes from yesterday's standup",
        preview: "Here are the action items from yesterday. 1) Finish the drag-and-drop implementation by Wednesday. 2) Review the accessibility audit results...",
        hasAttachment: false,
      },
      {
        id: "9",
        threadId: "thread-9",
        mailboxIds: { inbox: true },
        keywords: { $seen: false },
        size: 1280,
        receivedAt: new Date(Date.now() - 345600000).toISOString(),
        from: [{ name: "Linear", email: "notifications@linear.app" }],
        to: [{ email: "you@example.com" }],
        subject: "ENG-384: Implement email threading view \u2014 moved to In Progress",
        preview: "Alice Johnson moved ENG-384 to In Progress. This issue covers implementing the conversation thread view for the email client...",
        hasAttachment: false,
      },
      {
        id: "10",
        threadId: "thread-10",
        mailboxIds: { inbox: true },
        keywords: { $seen: true },
        size: 896,
        receivedAt: new Date(Date.now() - 432000000).toISOString(),
        from: [{ name: "Priya Sharma", email: "priya.sharma@icloud.com" }],
        to: [{ email: "you@example.com" }],
        subject: "Re: Onboarding docs for new contributors",
        preview: "Thanks for putting this together! I added a section on setting up the dev environment. Also linked the architecture diagram from our wiki...",
        hasAttachment: false,
      },
      {
        id: "11",
        threadId: "thread-11",
        mailboxIds: { inbox: true },
        keywords: { $seen: true },
        size: 5120,
        receivedAt: new Date(Date.now() - 518400000).toISOString(),
        from: [{ name: "LaunchWeekly", email: "newsletter@launchweekly.com" }],
        to: [{ email: "you@example.com" }],
        subject: "\uD83D\uDE80 This week in tech: AI agents, new frameworks, and more",
        preview: "Happy Monday! Here's your weekly roundup of the most interesting launches, open-source projects, and developer tools you might have missed...",
        hasAttachment: false,
      },
    ];

    const mockMailboxes: Mailbox[] = [
      {
        id: "inbox",
        name: "Inbox",
        role: "inbox",
        sortOrder: 1,
        totalEmails: 11,
        unreadEmails: 4,
        totalThreads: 11,
        unreadThreads: 4,
        myRights: {
          mayReadItems: true,
          mayAddItems: true,
          mayRemoveItems: true,
          maySetSeen: true,
          maySetKeywords: true,
          mayCreateChild: true,
          mayRename: true,
          mayDelete: true,
          maySubmit: true,
        },
        isSubscribed: true,
      },
    ];

    set({
      emails: mockEmails,
      mailboxes: mockMailboxes,
    });
  },
}));
