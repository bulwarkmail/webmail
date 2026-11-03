import type { IJMAPClient, KeywordDiscoveryResult, KeywordMigration } from '@/lib/jmap/client-interface';
import type { AccountInfo, Email, Mailbox, StateChange, AccountStates, Thread, Identity, EmailAddress, ContactCard, AddressBook, AddressBookRights, VacationResponse, Calendar, CalendarEvent, CalendarEventFilter, CalendarRights, CalendarTask, BusyPeriod, FileNode, FileNodeRights, MailboxRights, Principal, PrincipalAvailability, PrincipalListing, ScheduledEmail, SendEmailResult, SharedAccount } from '@/lib/jmap/types';
import type { SieveScript, SieveCapabilities } from '@/lib/jmap/sieve-types';
import type { ShareChange, ShareChangeResult, ShareTarget } from '@/lib/jmap/share-batch';
import type { AnyRights, ShareKind } from '@/lib/jmap/share-rights';
import { createDemoPrincipals } from './fixtures/directory';
import { createDemoBusyBlocks } from './fixtures/availability';
import { expandRecurringEvents } from '@/lib/recurrence-expansion';
import { parseDurationSeconds } from '@/lib/calendar-event-normalization';
import { createDemoArchivedItems, type DemoArchivedItem } from './fixtures/archive';
import { createDemoSharedMetadata } from './fixtures/shared-metadata';
import {
  MAX_METADATA_ENTRY_BYTES, MetadataPatchError, MetadataTooLargeError, MetadataUnsupportedError, metadataValueBytes,
} from '@/lib/jmap/bulwark-metadata';
import {
  hasArchivedEmail as hasArchivedEmailIn, listArchivedEmailsPaged,
  type ArchiveIo, type ArchiveListResult, type ArchiveQueryPage, type RestoreResult,
} from '@/lib/recovery/archived-items';
import { getDemoData, demoSharedAccounts, type DemoData, type DemoProfile } from './demo-data';
import { generateDemoId } from './demo-utils';
import { DEMO_ASSETS } from './fixtures/assets';
import { GONOGO_INVITE_BLOB } from './fixtures/emails';
import { createGoNoGoInvitationIcs, GONOGO_EVENT_ID } from './fixtures/calendars';
import { createSpreehostInvoiceXml, INVOICE_BLOB } from './fixtures/invoice';
import { ALICE, BOB, SARAH, PRIYA, LISA } from './fixtures/people';
import { parseAuthenticationResults, parseSpamLLM, parseSpamScore } from '@/lib/email-headers';
import { compareEmails, type SortLevel } from '@/lib/message-list-order';
import { withBasePath } from '@/lib/browser-navigation';
import { toInertBlob } from '@/lib/file-preview';
import type { StorageQuota } from "@/lib/quota";
import { buildDemoEml, demoEmlBlobId, demoEmlEmailId } from './demo-eml';
import { stripMessageIdBrackets } from '@/lib/email-threading';

// Fixture blobs with real bytes behind them, served from public/demo/ (see
// fixtures/assets.ts for the list and the licences). Any other blob id falls
// back to a text placeholder.
const DEMO_BLOB_ASSETS: Record<string, string> = Object.fromEntries(
  Object.entries(DEMO_ASSETS).map(([blobId, asset]) => [blobId, asset.path]),
);

/** Gives a demo message a raw-message blob (see demo-eml.ts) unless it has one. */
function withEmlBlob(email: Email): Email {
  if (!email.blobId) email.blobId = demoEmlBlobId(email.id);
  return email;
}

/** localStorage key that switches the simulated incoming mail off (screenshot runs). */
export const DEMO_SIMULATE_KEY = 'bulwark-demo-simulate';

/**
 * In-memory JMAP client for demo mode.
 * All data lives in memory - no server calls, no cookies. Only the demo
 * images under public/demo are fetched, from the app's own origin.
 *
 * One instance per demo login: `new DemoJMAPClient('work')` is the primary
 * account (with the shared Support mailbox delegated to it), and
 * `new DemoJMAPClient('personal')` the second account, with mail and contacts.
 */
export class DemoJMAPClient implements IJMAPClient {
  private data: DemoData;
  private readonly profile: DemoProfile;
  /** The server's directory: the Meridian Labs cast for the work login, nobody for the personal one. */
  private readonly principals: Principal[];
  /** Mail deleted for good that the server still keeps (Recover deleted items). */
  private archive: DemoArchivedItem[];
  /** Bulwark's shared Inbox metadata by account and key; only accounts listed here have any. */
  private metadata: Record<string, Record<string, unknown>>;
  /** The same for each account's private metadata. */
  private ownMetadata: Record<string, Record<string, unknown>> = {};
  private blobStore = new Map<string, Blob>();
  private scheduledSubmissions = new Map<string, { id: string; emailId: string; identityId: string; sendAt: string; undoStatus: 'pending' | 'final' | 'canceled'; isSmime: boolean }>();
  private connectionCallback: ((connected: boolean) => void) | null = null;
  private stateChangeCallback: ((change: StateChange) => void) | null = null;
  private lastStates: AccountStates = {};
  private incomingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(profile: DemoProfile = 'work') {
    this.profile = profile;
    this.data = getDemoData(profile);
    this.principals = profile === 'personal' ? [] : createDemoPrincipals();
    this.archive = profile === 'personal' ? [] : createDemoArchivedItems(this.data.accountId);
    this.metadata = profile === 'personal' ? {} : createDemoSharedMetadata();
    // Fixtures carry raw headers the way a server sends them; derive the
    // parsed fields the viewer reads, as JMAPClient.parseEmailHeaders does.
    for (const email of this.data.emails) {
      this.deriveHeaderFields(email);
      withEmlBlob(email);
    }
    this.recalcMailboxCounts();
    for (const s of this.data.scheduled) {
      const id = generateDemoId('submission');
      this.scheduledSubmissions.set(id, { id, emailId: s.emailId, identityId: s.identityId, sendAt: s.sendAt, undoStatus: 'pending', isSmime: false });
    }
  }

  private deriveHeaderFields(email: Email): void {
    const headers = email.headers;
    if (!headers) return;
    const header = (name: string) => {
      const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
      return key ? headers[key] : undefined;
    };
    const auth = header('authentication-results');
    if (auth && !email.authenticationResults) email.authenticationResults = parseAuthenticationResults(auth);
    const spam = header('x-spam-score') ?? header('x-spam-status');
    if (typeof spam === 'string' && email.spamScore === undefined) {
      const parsed = parseSpamScore(spam);
      if (parsed) { email.spamScore = parsed.score; email.spamStatus = parsed.status; }
    }
    const llm = header('x-spam-llm');
    if (typeof llm === 'string' && !email.spamLLM) {
      const parsed = parseSpamLLM(llm);
      if (parsed) email.spamLLM = parsed;
    }
  }

  // ── Connection lifecycle ──────────────────────────────────────

  async connect(): Promise<void> {
    // Simulated incoming mail, unless a screenshot run switched it off.
    let simulate = true;
    try { simulate = typeof localStorage === 'undefined' || localStorage.getItem(DEMO_SIMULATE_KEY) !== 'off'; } catch { /* storage blocked */ }
    if (simulate) this.startIncomingEmailTimer();
  }

  disconnect(): void {
    this.stopIncomingEmailTimer();
    this.connectionCallback = null;
    this.stateChangeCallback = null;
  }

  async reconnect(): Promise<void> { /* no-op */ }
  async ping(): Promise<void> { /* no-op */ }

  // ── Session / auth accessors ──────────────────────────────────

  getServerUrl(): string { return 'https://demo.example.com'; }
  getAuthHeader(): string { return 'Bearer demo-token'; }
  updateAccessToken(): void { /* no-op */ }
  upgradeToBearer(): void { /* no-op */ }
  enableTotpReauth(): void { /* no-op */ }
  updateBasicAuth(): void { /* no-op */ }
  getAccountId(): string { return this.data.accountId; }
  getUsername(): string { return this.data.username; }

  // ── Capabilities ──────────────────────────────────────────────

  /** The personal login has mail and contacts; everything else lives in the work account. */
  private get isPersonal(): boolean { return this.profile === 'personal'; }

  hasAccountCapability(capability: string, _accountId?: string): boolean {
    return capability === 'urn:ietf:params:jmap:submission';
  }

  getAccountInfo(accountId: string): AccountInfo | null {
    if (accountId !== this.getAccountId()) return null;
    return {
      name: this.getUsername(),
      isPersonal: true,
      isReadOnly: false,
      accountCapabilities: { 'urn:ietf:params:jmap:submission': {} },
    };
  }

  getCapabilities(): Record<string, unknown> {
    return {
      'urn:ietf:params:jmap:core': { maxSizeUpload: 50_000_000, maxCallsInRequest: 16, maxObjectsInGet: 500, maxObjectsInSet: 500 },
      'urn:ietf:params:jmap:mail': {},
      'urn:ietf:params:jmap:submission': { maxDelayedSend: 30 * 24 * 60 * 60, submissionExtensions: { FUTURERELEASE: true } },
      'urn:ietf:params:jmap:vacationresponse': {},
      'urn:ietf:params:jmap:quota': {},
      'urn:ietf:params:jmap:contacts': {},
      ...(this.isPersonal ? {} : {
        'urn:ietf:params:jmap:calendars': {},
        'urn:ietf:params:jmap:sieve': {},
        'urn:ietf:params:jmap:files': {},
        'urn:ietf:params:jmap:principals': {},
        'urn:ietf:params:jmap:principals:availability': {},
        'urn:ietf:params:jmap:mail:share': {},
      }),
    };
  }

  getMaxSizeUpload(): number { return 50_000_000; }
  getMaxCallsInRequest(): number { return 16; }
  getMaxObjectsInGet(): number { return 500; }
  getMaxObjectsInSet(): number { return 500; }
  getMaxDelayedSend(): number { return 30 * 24 * 60 * 60; }
  hasDelayedSend(): boolean { return true; }
  getEventSourceUrl(): string | null { return null; }
  supportsEmailSubmission(): boolean { return true; }
  supportsQuota(): boolean { return true; }
  supportsVacationResponse(): boolean { return true; }
  accountSupports(): boolean { return true; }
  supportsContacts(): boolean { return true; }
  supportsCalendars(): boolean { return !this.isPersonal; }
  supportsSieve(): boolean { return !this.isPersonal; }
  supportsFiles(): boolean { return !this.isPersonal; }

  // ── Directory and sharing (RFC 9670 principals, mail:share) ───
  // The work login's server has a directory (fixtures/directory.ts) and
  // keeps `shareWith` on Nora's folders, calendars, address books and files.
  // The personal login's server has neither.

  supportsPrincipals(): boolean { return !this.isPersonal; }

  async getPrincipals(): Promise<Principal[]> {
    return this.principals.map((p) => ({ ...p }));
  }

  async listPrincipals(): Promise<PrincipalListing> {
    return { principals: await this.getPrincipals(), status: 'ok' };
  }

  /** "individual" or "group" by id, as Principal/get answers; Support is a group. */
  async getPrincipalTypes(ids: string[]): Promise<Record<string, string> | null> {
    if (!this.supportsPrincipals()) return ids.length === 0 ? {} : null;
    const wanted = new Set(ids);
    return Object.fromEntries(this.principals.filter((p) => wanted.has(p.id)).map((p) => [p.id, p.type]));
  }

  async findPrincipalByEmail(email: string): Promise<{ principal: Principal | null; status: 'ok' | 'forbidden' | 'error' }> {
    if (!this.supportsPrincipals()) return { principal: null, status: 'error' };
    const wanted = email.trim().toLowerCase();
    const principal = this.principals.find((p) => p.email?.toLowerCase() === wanted || p.name.toLowerCase() === wanted);
    return { principal: principal ? { ...principal } : null, status: 'ok' };
  }

  supportsMailboxSharing(accountId?: string): boolean {
    return this.supportsPrincipals() && (!accountId || accountId === this.data.accountId);
  }

  async getMailboxShareWith(mailboxId: string, accountId?: string): Promise<Record<string, MailboxRights> | null> {
    const mailbox = this.ownShareItem('mailbox', mailboxId, accountId);
    if (!mailbox) throw new Error('Folder not found');
    return mailbox.shareWith ? structuredClone(mailbox.shareWith) as Record<string, MailboxRights> : null;
  }

  async setMailboxShare(mailboxId: string, principalId: string, rights: MailboxRights | null, accountId?: string): Promise<void> {
    this.setShare('mailbox', mailboxId, principalId, rights, accountId);
  }

  async setCalendarShare(calendarId: string, principalId: string, rights: CalendarRights | null, targetAccountId?: string): Promise<void> {
    this.setShare('calendar', calendarId, principalId, rights, targetAccountId);
  }

  async setAddressBookShare(addressBookId: string, principalId: string, rights: AddressBookRights | null, targetAccountId?: string): Promise<void> {
    this.setShare('addressBook', addressBookId, principalId, rights, targetAccountId);
  }

  /** Every folder, calendar and address book of Nora's own account, and the files she shared. */
  async getShareTargets(include: { calendars?: boolean; contacts?: boolean; files?: boolean } = {}): Promise<{ targets: ShareTarget[]; failed: ShareKind[] }> {
    if (!this.supportsPrincipals()) return { targets: [], failed: [] };
    const accountId = this.data.accountId;
    const grants = (shareWith: Record<string, AnyRights> | null | undefined) => structuredClone(shareWith ?? {});
    const targets: ShareTarget[] = this.data.mailboxes.map((mb) => ({
      kind: 'mailbox', accountId, id: mb.id, name: mb.name, role: mb.role ?? null, parentId: mb.parentId ?? null, shareWith: grants(mb.shareWith),
    }));
    if (include.calendars !== false && this.supportsCalendars()) {
      for (const cal of this.data.calendars.filter((c) => !c.isShared)) {
        targets.push({ kind: 'calendar', accountId, id: cal.id, name: cal.name, isDefault: cal.isDefault, shareWith: grants(cal.shareWith) });
      }
    }
    if (include.contacts !== false && this.supportsContacts()) {
      for (const book of this.data.addressBooks.filter((b) => !b.isShared)) {
        targets.push({ kind: 'addressBook', accountId, id: book.id, name: book.name, isDefault: book.isDefault, shareWith: grants(book.shareWith) });
      }
    }
    if (include.files !== false && this.supportsFiles()) {
      for (const node of this.data.fileNodes.filter((n) => Object.keys(n.shareWith ?? {}).length > 0)) {
        targets.push({ kind: 'file', accountId, id: node.id, name: node.name, parentId: node.parentId ?? null, shareWith: grants(node.shareWith) });
      }
    }
    return { targets, failed: [] };
  }

  /** Grants and revokes, each with a result, as the server's /set answers would give them. */
  async applyShareChanges(changes: ShareChange[]): Promise<ShareChangeResult[]> {
    return changes.map((change) => {
      if (!this.ownShareItem(change.kind, change.id, change.accountId)) return { change, ok: false, error: 'notFound' };
      this.setShare(change.kind, change.id, change.principalId, change.rights, change.accountId);
      return { change, ok: true };
    });
  }

  // ── Free/busy (Principal/getAvailability) ─────────────────────

  supportsAvailability(): boolean { return this.supportsPrincipals(); }
  async mayGetAvailability(): Promise<boolean> { return this.supportsAvailability(); }

  async getPrincipalAvailability(principalId: string, utcStart: Date, utcEnd: Date): Promise<BusyPeriod[]> {
    const answer = (await this.getPrincipalsAvailability([principalId], utcStart, utcEnd))[principalId];
    if (!answer || 'error' in answer) throw Object.assign(new Error('Failed to query availability'), { type: answer?.error ?? 'notFound' });
    return answer.periods;
  }

  async getPrincipalsAvailability(principalIds: string[], utcStart: Date, utcEnd: Date): Promise<Record<string, PrincipalAvailability>> {
    const results: Record<string, PrincipalAvailability> = {};
    if (!this.supportsAvailability()) return results;
    for (const id of principalIds) {
      const principal = this.principals.find((p) => p.id === id);
      results[id] = principal ? { periods: this.busyPeriods(principal, utcStart, utcEnd) } : { error: 'notFound' };
    }
    return results;
  }

  /**
   * A principal's busy time in the window: the timed events on the demo
   * calendars they take part in (Nora: also those of her own calendars
   * without participants), unless declined or marked free, plus their
   * blocks in fixtures/availability.ts. No details, as with `showDetails: false`.
   */
  private busyPeriods(principal: Principal, utcStart: Date, utcEnd: Date): BusyPeriod[] {
    const email = principal.email?.toLowerCase();
    const isSelf = principal.id === this.data.accountId;
    const counting = new Set(this.data.calendars.filter((c) => c.includeInAvailability !== 'none').map((c) => c.id));
    const periods: BusyPeriod[] = [];
    for (const event of expandRecurringEvents(this.data.calendarEvents, utcStart.toISOString(), utcEnd.toISOString())) {
      if (event.showWithoutTime || event.freeBusyStatus === 'free' || event.status === 'cancelled') continue;
      if (!Object.keys(event.calendarIds).some((id) => counting.has(id))) continue;
      const me = Object.values(event.participants ?? {}).find((p) => p.email?.toLowerCase() === email);
      if (!me && !(isSelf && !event.participants)) continue;
      if (me?.participationStatus === 'declined') continue;
      const start = event.utcStart ?? new Date(event.start).toISOString();
      const end = event.utcEnd ?? new Date(new Date(start).getTime() + (parseDurationSeconds(event.duration) ?? 3600) * 1000).toISOString();
      const tentative = event.status === 'tentative' || me?.participationStatus === 'tentative' || me?.participationStatus === 'needs-action';
      periods.push({ utcStart: start, utcEnd: end, busyStatus: tentative ? 'tentative' : 'confirmed' });
    }
    periods.push(...createDemoBusyBlocks(principal.id));
    return periods
      .filter((p) => new Date(p.utcStart).getTime() < utcEnd.getTime() && new Date(p.utcEnd).getTime() > utcStart.getTime())
      .sort((a, b) => a.utcStart.localeCompare(b.utcStart));
  }

  // ── Bulwark data in Inbox metadata (urn:ietf:params:jmap:metadata) ──
  // Only the Support group keeps any (fixtures/shared-metadata.ts): its
  // shared tags and the team inbox plugin's names. Keys are without the
  // `org.bulwarkmail.` namespace, as JMAPClient hands them out.

  supportsBulwarkMetadata(accountId?: string): boolean {
    return !!accountId && Object.prototype.hasOwnProperty.call(this.metadata, accountId);
  }

  advertisesBulwarkMetadata(accountId?: string): boolean {
    return this.supportsBulwarkMetadata(accountId);
  }

  async getBulwarkMetadata(accountId?: string, options?: { private?: boolean }): Promise<Record<string, unknown> | null> {
    if (!this.supportsBulwarkMetadata(accountId)) return null;
    const store = options?.private ? this.ownMetadata : this.metadata;
    return structuredClone(store[accountId!] ?? {});
  }

  async setBulwarkMetadata(accountId: string | undefined, key: string, value: unknown, options?: { private?: boolean }): Promise<void> {
    if (!this.supportsBulwarkMetadata(accountId)) throw new MetadataUnsupportedError();
    if (value !== null && metadataValueBytes(value) > MAX_METADATA_ENTRY_BYTES) {
      throw new MetadataTooLargeError(`The entry is larger than ${MAX_METADATA_ENTRY_BYTES} bytes`);
    }
    const store = options?.private ? this.ownMetadata : this.metadata;
    const entries = (store[accountId!] ??= {});
    if (value === null) delete entries[key];
    else entries[key] = structuredClone(value);
    this.notifyMailboxChange(accountId!);
  }

  /** Sets (null: removes) values inside one entry; a path whose parent is missing fails as on Stalwart. */
  async patchBulwarkMetadata(accountId: string | undefined, key: string, patches: Array<{ path: string[]; value: unknown }>): Promise<{ newState?: string }> {
    if (!this.supportsBulwarkMetadata(accountId)) throw new MetadataUnsupportedError();
    const entries = this.metadata[accountId!];
    const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
    let result: unknown = structuredClone(entries[key]);
    for (const { path, value } of patches) {
      if (path.length === 0) { result = structuredClone(value); continue; }
      let node: unknown = result;
      for (const segment of path.slice(0, -1)) node = isObject(node) ? node[segment] : undefined;
      if (!isObject(node)) throw new MetadataPatchError('A parent of the patched value does not exist');
      const last = path[path.length - 1];
      if (value === null) delete node[last];
      else node[last] = structuredClone(value);
    }
    if (result !== null && result !== undefined && metadataValueBytes(result) > MAX_METADATA_ENTRY_BYTES) {
      throw new MetadataTooLargeError(`The entry is larger than ${MAX_METADATA_ENTRY_BYTES} bytes`);
    }
    if (result === null || result === undefined) delete entries[key];
    else entries[key] = result;
    return { newState: this.notifyMailboxChange(accountId!) };
  }

  /** A metadata change bumps the account's Mailbox state, as Stalwart does; returns the new state. */
  private notifyMailboxChange(accountId: string): string {
    const state = generateDemoId('state');
    this.stateChangeCallback?.({ '@type': 'StateChange', changed: { [accountId]: { Mailbox: state } } });
    return state;
  }

  /** One of Nora's own shareable items, or null (another account's, or unknown). */
  private ownShareItem(kind: ShareKind, id: string, accountId?: string): { shareWith?: Record<string, AnyRights> | null } | null {
    if (!this.supportsPrincipals() || (accountId && accountId !== this.data.accountId)) return null;
    const own = <T extends { id: string; originalId?: string; isShared?: boolean }>(list: T[]) =>
      list.find((item) => !item.isShared && (item.id === id || item.originalId === id)) ?? null;
    switch (kind) {
      case 'mailbox': return own(this.data.mailboxes);
      case 'calendar': return own(this.data.calendars);
      case 'addressBook': return own(this.data.addressBooks);
      case 'file': return this.data.fileNodes.find((n) => n.id === id) ?? null;
    }
  }

  private setShare(kind: ShareKind, id: string, principalId: string, rights: AnyRights | null, accountId?: string): void {
    const item = this.ownShareItem(kind, id, accountId);
    if (!item) throw new Error('Not found');
    const next = { ...(item.shareWith ?? {}) };
    if (rights) next[principalId] = { ...rights };
    else delete next[principalId];
    item.shareWith = Object.keys(next).length > 0 ? next : null;
  }

  // ── Push / state ──────────────────────────────────────────────

  setupPushNotifications(): boolean { return true; }
  closePushNotifications(): void { /* no-op in demo */ }
  // Demo changes arrive through the state-change callback, not a live stream.
  hasSSEStream(): boolean { return false; }
  onConnectionChange(callback: (connected: boolean) => void): void { this.connectionCallback = callback; }
  onRateLimit(): void { /* no-op in demo */ }
  isRateLimited(): boolean { return false; }
  getRateLimitRemainingMs(): number { return 0; }
  onStateChange(callback: (change: StateChange) => void): void { this.stateChangeCallback = callback; }
  getLastStates(): AccountStates { return { ...this.lastStates }; }
  setLastStates(states: AccountStates): void { this.lastStates = { ...states }; }

  // PushSubscription endpoints have no meaning in demo mode - the demo client
  // never makes real network calls so there's nothing for the relay to push to.
  async listPushSubscriptions() { return []; }
  async createPushSubscription(): Promise<string> {
    throw new Error('Push subscriptions are not available in demo mode');
  }
  async verifyPushSubscription(): Promise<void> {
    throw new Error('Push subscriptions are not available in demo mode');
  }
  async updatePushSubscription(): Promise<void> {
    throw new Error('Push subscriptions are not available in demo mode');
  }
  async destroyPushSubscription(): Promise<void> { /* no-op */ }

  // ── Quota ─────────────────────────────────────────────────────

  async getQuota(): Promise<StorageQuota | null> {
    return { ...this.data.quota };
  }

  // ── Mailboxes ─────────────────────────────────────────────────

  async getMailboxes(accountId?: string): Promise<Mailbox[]> {
    if (accountId && accountId !== this.data.accountId) {
      return [...(this.data.sharedMailboxes[accountId]?.mailboxes ?? [])];
    }
    return [...this.data.mailboxes];
  }

  /**
   * Own folders plus the folders of accounts shared with this login, the
   * latter namespaced `<ownerId>:<id>` and tagged `isShared`, as
   * JMAPClient.getAllMailboxes does. Mail keeps the bare ids in mailboxIds;
   * the store queries shared folders by `originalId` + owner `accountId`.
   */
  async getAllMailboxes(): Promise<Mailbox[]> {
    const shared = Object.entries(this.data.sharedMailboxes).flatMap(([accountId, { name, mailboxes }]) =>
      mailboxes.map((mb) => ({
        ...mb,
        id: `${accountId}:${mb.id}`,
        originalId: mb.id,
        parentId: mb.parentId ? `${accountId}:${mb.parentId}` : undefined,
        accountId,
        accountName: name,
        isShared: true,
      })),
    );
    return [...this.data.mailboxes, ...shared];
  }

  async createMailbox(name: string, parentId?: string, _accountId?: string, options?: { role?: string }): Promise<Mailbox> {
    const mb: Mailbox = {
      id: generateDemoId('mailbox'),
      name,
      role: options?.role,
      sortOrder: 100,
      totalEmails: 0,
      unreadEmails: 0,
      totalThreads: 0,
      unreadThreads: 0,
      parentId,
      isSubscribed: true,
      myRights: { mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true, mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true },
    };
    this.data.mailboxes.push(mb);
    return mb;
  }

  async updateMailbox(mailboxId: string, changes: { name?: string; parentId?: string | null; role?: string | null; sortOrder?: number }, _accountId?: string): Promise<void> {
    const mb = this.data.mailboxes.find(m => m.id === mailboxId);
    if (mb) Object.assign(mb, changes);
  }

  async updateMailboxes(updates: Record<string, { name?: string; parentId?: string | null; role?: string | null; sortOrder?: number }>, _accountId?: string): Promise<Record<string, string>> {
    const failed: Record<string, string> = {};
    for (const [id, changes] of Object.entries(updates)) {
      const mb = this.data.mailboxes.find(m => m.id === id);
      if (mb) Object.assign(mb, changes);
      else failed[id] = 'notFound';
    }
    return failed;
  }

  async deleteMailbox(mailboxId: string, _accountId?: string): Promise<void> {
    this.data.mailboxes = this.data.mailboxes.filter(m => m.id !== mailboxId);
    // Also remove emails in this mailbox
    this.data.emails = this.data.emails.filter(e => !e.mailboxIds[mailboxId]);
  }

  // ── Emails ────────────────────────────────────────────────────

  /**
   * Minimal JMAP filter evaluator for demo mode: supports the conditions the
   * message-list category tabs and the folder-less search scopes use
   * (hasKeyword / notKeyword / from / text / inMailbox / inMailboxOtherThan
   * and AND / OR / NOT operators). Unknown conditions are ignored.
   */
  private matchesFilter(e: Email, filter: Record<string, unknown>): boolean {
    if (typeof filter.operator === 'string') {
      const conditions = (Array.isArray(filter.conditions) ? filter.conditions : []) as Record<string, unknown>[];
      switch (filter.operator) {
        case 'AND': return conditions.every(c => this.matchesFilter(e, c));
        case 'OR': return conditions.some(c => this.matchesFilter(e, c));
        case 'NOT': return !conditions.some(c => this.matchesFilter(e, c));
        default: return false;
      }
    }
    if (typeof filter.hasKeyword === 'string' && !e.keywords[filter.hasKeyword]) return false;
    if (typeof filter.notKeyword === 'string' && e.keywords[filter.notKeyword]) return false;
    if (typeof filter.from === 'string') {
      const q = filter.from.toLowerCase();
      const match = (e.from || []).some(f =>
        (f.email || '').toLowerCase().includes(q) || (f.name || '').toLowerCase().includes(q));
      if (!match) return false;
    }
    const addressMatch = (list: EmailAddress[] | undefined, q: string) =>
      (list || []).some(a => (a.email || '').toLowerCase().includes(q) || (a.name || '').toLowerCase().includes(q));
    if (typeof filter.to === 'string' && !addressMatch(e.to, filter.to.toLowerCase())) return false;
    if (typeof filter.cc === 'string' && !addressMatch(e.cc, filter.cc.toLowerCase())) return false;
    if (typeof filter.bcc === 'string' && !addressMatch(e.bcc, filter.bcc.toLowerCase())) return false;
    if (typeof filter.subject === 'string' && !(e.subject || '').toLowerCase().includes(filter.subject.toLowerCase())) return false;
    if (typeof filter.hasAttachment === 'boolean' && e.hasAttachment !== filter.hasAttachment) return false;
    if (typeof filter.before === 'string' && e.receivedAt >= filter.before) return false;
    if (typeof filter.after === 'string' && e.receivedAt < filter.after) return false;
    if (typeof filter.text === 'string') {
      const q = filter.text.toLowerCase();
      const bodyText = Object.values(e.bodyValues || {}).map(v => v.value).join(' ');
      const text = [e.subject, e.preview, e.from?.[0]?.name, e.from?.[0]?.email, bodyText].filter(Boolean).join(' ').toLowerCase();
      if (!text.includes(q)) return false;
    }
    if (typeof filter.body === 'string') {
      const q = filter.body.toLowerCase();
      const bodyText = Object.values(e.bodyValues || {}).map(v => v.value).join(' ').toLowerCase();
      if (!bodyText.includes(q)) return false;
    }
    if (typeof filter.inMailbox === 'string' && !e.mailboxIds[filter.inMailbox]) return false;
    if (Array.isArray(filter.inMailboxOtherThan)) {
      const excluded = new Set(filter.inMailboxOtherThan as string[]);
      if (!Object.keys(e.mailboxIds).some(id => e.mailboxIds[id] && !excluded.has(id))) return false;
    }
    return true;
  }

  /**
   * The mail one JMAP account holds. Shared accounts (the Support mailbox)
   * own the mail in their folders; the primary account owns the rest. The
   * unified views query each account in turn, so a query without this scope
   * would hand the same mail back twice.
   */
  private inAccount(accountId: string | undefined): (e: Email) => boolean {
    const shared = this.data.sharedMailboxes;
    if (accountId && accountId !== this.data.accountId && shared[accountId]) {
      const ids = new Set(shared[accountId].mailboxes.map((m) => m.id));
      return (e) => Object.keys(e.mailboxIds).some((id) => e.mailboxIds[id] && ids.has(id));
    }
    const sharedIds = new Set(Object.values(shared).flatMap((s) => s.mailboxes.map((m) => m.id)));
    return (e) => Object.keys(e.mailboxIds).some((id) => e.mailboxIds[id] && !sharedIds.has(id));
  }

  async getEmails(mailboxId?: string, accountId?: string, limit: number = 50, position: number = 0, hasKeyword?: string, pinnedFirst?: boolean, extraFilter?: Record<string, unknown>, order: SortLevel[] = []): Promise<{ emails: Email[]; hasMore: boolean; total: number }> {
    let filtered = this.data.emails.filter(this.inAccount(accountId));
    if (mailboxId) {
      filtered = filtered.filter(e => e.mailboxIds[mailboxId]);
    }
    if (hasKeyword) {
      filtered = filtered.filter(e => e.keywords[hasKeyword]);
    }
    if (extraFilter) {
      filtered = filtered.filter(e => this.matchesFilter(e, extraFilter));
    }
    // Same order the JMAP client asks the server for (pinned first, then the
    // configured list order, then newest first).
    filtered.sort(compareEmails(order, { pinnedFirst }));
    const total = filtered.length;
    const emails = filtered.slice(position, position + limit);
    return { emails, hasMore: position + limit < total, total };
  }

  async getSomeEmails(emailsId: string[], _accountId?: string): Promise<Email[]> {
    if (!emailsId || emailsId.length === 0) {
      return [];
    }
    const filtered = this.data.emails.filter(e => emailsId.includes(e.id));

    filtered.sort((a, b) => 
      new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()
    );

    return filtered;
  }

  getEmailQuerySortOptions(_accountId?: string): string[] | null {
    // The demo sorts client-side and supports every criterion.
    return null;
  }

  async getEmailsInMailbox(mailboxId: string): Promise<Email[]> {
    return this.data.emails.filter(e => e.mailboxIds[mailboxId]);
  }

  async getEmail(emailId: string): Promise<Email | null> {
    // A copy, as a server sends: the app stamps what it opens (a scheduled
    // send's fields), which must not stick to the stored message.
    const email = this.data.emails.find(e => e.id === emailId);
    return email ? structuredClone(email) : null;
  }

  async getTagCounts(tagIds: string[], accountId?: string, excludeMailboxIds?: string[]): Promise<Record<string, { total: number; unread: number }>> {
    const result: Record<string, { total: number; unread: number }> = {};
    const exclusion = excludeMailboxIds?.length ? { inMailboxOtherThan: excludeMailboxIds } : null;
    const inAccount = this.inAccount(accountId);
    for (const tagId of tagIds) {
      const tagged = this.data.emails.filter(e => inAccount(e) && e.keywords[tagId] && (!exclusion || this.matchesFilter(e, exclusion)));
      result[tagId] = {
        total: tagged.length,
        unread: tagged.filter(e => !e.keywords.$seen).length,
      };
    }
    return result;
  }

  async discoverKeywords(options?: {
    limit?: number;
    onProgress?: (scanned: number, total: number) => void;
    signal?: AbortSignal;
    accountId?: string;
  }): Promise<{ keywords: Record<string, number>; scanned: number; total: number; complete: boolean }> {
    // One account's mail: the Support group's tags are not Nora's own.
    const emails = this.data.emails.filter(this.inAccount(options?.accountId));
    const total = emails.length;
    const scanned = Math.min(total, Math.max(0, options?.limit ?? total));
    const keywords: Record<string, number> = {};
    for (const email of emails.slice(0, scanned)) {
      for (const [keyword, isSet] of Object.entries(email.keywords || {})) {
        if (isSet) keywords[keyword] = (keywords[keyword] ?? 0) + 1;
      }
    }
    options?.onProgress?.(scanned, total);
    return { keywords, scanned, total, complete: scanned >= total };
  }

  async getKeywords(options?: {
    limit?: number;
    onProgress?: (scanned: number, total: number) => void;
    signal?: AbortSignal;
  }): Promise<KeywordDiscoveryResult> {
    const scan = await this.discoverKeywords(options);
    return {
      ...scan,
      labels: Object.entries(scan.keywords).map(([id, total]) => ({
        id,
        name: id.startsWith('$label:') ? id.slice('$label:'.length) : id,
        color: null,
        total,
        unread: 0,
        isProviderLabel: false,
        source: 'message' as const,
      })),
    };
  }

  async getCategoryUnreadCounts(mailboxId: string, tabs: Array<{ id: string; filter: Record<string, unknown> | null }>, _accountId?: string): Promise<Record<string, number>> {
    const inBox = this.data.emails.filter(e => e.mailboxIds[mailboxId] && !e.keywords.$seen);
    const result: Record<string, number> = {};
    for (const tab of tabs) {
      result[tab.id] = tab.filter
        ? inBox.filter(e => this.matchesFilter(e, tab.filter as Record<string, unknown>)).length
        : inBox.length;
    }
    return result;
  }

  async searchEmails(query: string, mailboxId?: string, accountId?: string, limit: number = 50, position: number = 0): Promise<{ emails: Email[]; hasMore: boolean; total: number }> {
    const q = query.toLowerCase();
    let filtered = this.data.emails.filter(this.inAccount(accountId)).filter(e => {
      const text = [e.subject, e.preview, e.from?.[0]?.name, e.from?.[0]?.email].filter(Boolean).join(' ').toLowerCase();
      return text.includes(q);
    });
    if (mailboxId) filtered = filtered.filter(e => e.mailboxIds[mailboxId]);
    filtered.sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
    const total = filtered.length;
    const emails = filtered.slice(position, position + limit);
    return { emails, hasMore: position + limit < total, total };
  }

  async advancedSearchEmails(filter: Record<string, unknown>, accountId?: string, limit: number = 50, position: number = 0): Promise<{ emails: Email[]; hasMore: boolean; total: number }> {
    const filtered = this.data.emails.filter(this.inAccount(accountId)).filter(e => this.matchesFilter(e, filter));
    filtered.sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
    const total = filtered.length;
    const emails = filtered.slice(position, position + limit);
    return { emails, hasMore: position + limit < total, total };
  }

  private pickEmailFields(email: Email, properties: string[]): Record<string, unknown> {
    const record: Record<string, unknown> = { id: email.id };
    for (const property of properties) {
      const header = /^header:([^:]+)(?::asText)?(:all)?$/.exec(property);
      if (header) {
        const wanted = header[1].toLowerCase();
        const values = Object.entries(email.headers ?? {})
          .filter(([name]) => name.toLowerCase() === wanted)
          .flatMap(([, value]) => (Array.isArray(value) ? value : [value]));
        record[property] = header[2] ? values : (values[0] ?? null);
      } else {
        record[property] = (email as unknown as Record<string, unknown>)[property];
      }
    }
    return record;
  }

  async getEmailFields(emailIds: string[], properties: string[]): Promise<Array<Record<string, unknown>>> {
    const wanted = new Set(emailIds);
    return this.data.emails.filter(e => wanted.has(e.id)).map(e => this.pickEmailFields(e, properties));
  }

  async queryEmailFields(filter: Record<string, unknown>, properties: string[], accountId?: string, limit: number = 10000): Promise<Array<Record<string, unknown>>> {
    const filtered = this.data.emails.filter(this.inAccount(accountId)).filter(e => this.matchesFilter(e, filter));
    filtered.sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
    return filtered.slice(0, limit).map(e => this.pickEmailFields(e, properties));
  }

  async searchSentRecipients(query: string, _sentMailboxId: string, _accountId?: string, _limit: number = 60): Promise<Array<{ name: string; email: string }>> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const byEmail = new Map<string, { name: string; email: string }>();
    for (const email of this.data.emails) {
      for (const r of [...(email.to || []), ...(email.cc || [])]) {
        if (!r.email) continue;
        const key = r.email.toLowerCase();
        if (byEmail.has(key)) continue;
        if (key.includes(q) || (r.name && r.name.toLowerCase().includes(q))) {
          byEmail.set(key, { name: r.name || '', email: r.email });
        }
      }
    }
    return Array.from(byEmail.values());
  }

  // ── Email mutations ───────────────────────────────────────────

  async markAsRead(emailId: string, read: boolean = true): Promise<void> {
    const email = this.data.emails.find(e => e.id === emailId);
    if (!email) return;
    if (read) {
      email.keywords.$seen = true;
    } else {
      delete email.keywords.$seen;
    }
    this.recalcMailboxCounts();
  }

  async batchMarkAsRead(emailIds: string[], read: boolean = true, _accountId?: string): Promise<void> {
    for (const id of emailIds) {
      const email = this.data.emails.find(e => e.id === id);
      if (email) {
        if (read) email.keywords.$seen = true;
        else delete email.keywords.$seen;
      }
    }
    this.recalcMailboxCounts();
  }

  async toggleStar(emailId: string, starred: boolean, _accountId?: string): Promise<void> {
    const email = this.data.emails.find(e => e.id === emailId);
    if (!email) return;
    if (starred) email.keywords.$flagged = true;
    else delete email.keywords.$flagged;
  }

  async updateEmailKeywords(emailId: string, keywords: Record<string, boolean>): Promise<void> {
    const email = this.data.emails.find(e => e.id === emailId);
    if (email) email.keywords = { ...email.keywords, ...keywords };
  }

  async setKeyword(emailId: string, keyword: string): Promise<void> {
    const email = this.data.emails.find(e => e.id === emailId);
    if (email) email.keywords[keyword] = true;
  }

  async removeKeyword(emailId: string, keyword: string): Promise<void> {
    const email = this.data.emails.find(e => e.id === emailId);
    if (email) delete email.keywords[keyword];
  }

  async batchUpdateKeywords(emailIds: string[], patch: Record<string, boolean | null>): Promise<void> {
    for (const id of emailIds) {
      const email = this.data.emails.find(e => e.id === id);
      if (!email) continue;
      for (const [pointer, value] of Object.entries(patch)) {
        const keyword = pointer.startsWith('keywords/') ? pointer.slice('keywords/'.length) : pointer;
        if (value === null || value === false) delete email.keywords[keyword];
        else email.keywords[keyword] = true;
      }
    }
  }

  async migrateKeyword(oldKeyword: string, newKeyword: string): Promise<KeywordMigration> {
    let migrated = 0;
    for (const email of this.data.emails) {
      if (email.keywords[oldKeyword]) {
        delete email.keywords[oldKeyword];
        email.keywords[newKeyword] = true;
        migrated++;
      }
    }
    return { migrated, refused: 0 };
  }

  async deleteEmail(emailId: string): Promise<void> {
    this.data.emails = this.data.emails.filter(e => e.id !== emailId);
    this.recalcMailboxCounts();
  }

  async moveToTrash(emailId: string, trashMailboxId: string, _accountId?: string, markAsRead?: boolean): Promise<void> {
    const email = this.data.emails.find(e => e.id === emailId);
    if (!email) return;
    email.mailboxIds = { [trashMailboxId]: true };
    if (markAsRead) email.keywords.$seen = true;
    this.recalcMailboxCounts();
  }

  async batchDeleteEmails(emailIds: string[], _accountId?: string): Promise<void> {
    const idSet = new Set(emailIds);
    this.data.emails = this.data.emails.filter(e => !idSet.has(e.id));
    this.recalcMailboxCounts();
  }

  async batchMoveEmails(emailIds: string[], toMailboxId: string, _accountId?: string, markAsRead?: boolean): Promise<void> {
    for (const id of emailIds) {
      const email = this.data.emails.find(e => e.id === id);
      if (email) {
        email.mailboxIds = { [toMailboxId]: true };
        if (markAsRead) email.keywords.$seen = true;
      }
    }
    this.recalcMailboxCounts();
  }

  async batchArchiveEmails(
    emails: Array<{ id: string; receivedAt: string }>,
    archiveMailboxId: string,
    mode: 'single' | 'year' | 'month',
    _existingMailboxes: Mailbox[],
    _accountId?: string,
  ): Promise<void> {
    if (emails.length === 0) return;
    if (mode === 'single') {
      await this.batchMoveEmails(emails.map(e => e.id), archiveMailboxId);
      return;
    }
    for (const { id, receivedAt } of emails) {
      const email = this.data.emails.find(e => e.id === id);
      if (!email) continue;
      const d = new Date(receivedAt);
      const year = d.getFullYear().toString();
      const month = (d.getMonth() + 1).toString().padStart(2, '0');
      let yearBox = this.data.mailboxes.find(m => m.name === year && m.parentId === archiveMailboxId);
      if (!yearBox) yearBox = await this.createMailbox(year, archiveMailboxId);
      let destId = yearBox.id;
      if (mode === 'month') {
        let monthBox = this.data.mailboxes.find(m => m.name === month && m.parentId === yearBox!.id);
        if (!monthBox) monthBox = await this.createMailbox(month, yearBox.id);
        destId = monthBox.id;
      }
      email.mailboxIds = { [destId]: true };
    }
    this.recalcMailboxCounts();
  }

  async moveEmail(emailId: string, toMailboxId: string): Promise<void> {
    const email = this.data.emails.find(e => e.id === emailId);
    if (email) email.mailboxIds = { [toMailboxId]: true };
    this.recalcMailboxCounts();
  }

  async removeEmailsFromMailbox(emailIds: string[], mailboxId: string): Promise<void> {
    for (const email of this.data.emails) {
      if (!emailIds.includes(email.id) || !email.mailboxIds[mailboxId]) continue;
      // A message has to stay in at least one mailbox.
      if (Object.keys(email.mailboxIds).filter(id => email.mailboxIds[id]).length < 2) continue;
      const { [mailboxId]: _removed, ...rest } = email.mailboxIds;
      email.mailboxIds = rest;
    }
    this.recalcMailboxCounts();
  }

  async restoreEmails(emails: Array<{ id: string; mailboxIds: Record<string, boolean>; seen?: boolean }>): Promise<void> {
    for (const { id, mailboxIds, seen } of emails) {
      const email = this.data.emails.find(e => e.id === id);
      if (!email) continue;
      email.mailboxIds = { ...mailboxIds };
      if (seen !== undefined) {
        if (seen) email.keywords.$seen = true;
        else delete email.keywords.$seen;
      }
    }
    this.recalcMailboxCounts();
  }

  async emptyMailbox(mailboxId: string, _accountId?: string): Promise<number> {
    const before = this.data.emails.length;
    this.data.emails = this.data.emails.filter(e => !e.mailboxIds[mailboxId]);
    const removed = before - this.data.emails.length;
    this.recalcMailboxCounts();
    return removed;
  }

  async moveMailboxContents(fromMailboxId: string, toMailboxId: string, _accountId?: string, markAsRead?: boolean): Promise<number> {
    let moved = 0;
    for (const email of this.data.emails) {
      if (!email.mailboxIds[fromMailboxId]) continue;
      email.mailboxIds = { [toMailboxId]: true };
      if (markAsRead) email.keywords.$seen = true;
      moved++;
    }
    this.recalcMailboxCounts();
    return moved;
  }

  async markMailboxAsRead(mailboxId: string): Promise<number> {
    let count = 0;
    for (const email of this.data.emails) {
      if (email.mailboxIds[mailboxId] && email.keywords.$seen !== true) {
        email.keywords.$seen = true;
        count++;
      }
    }
    this.recalcMailboxCounts();
    return count;
  }

  async markAllAsRead(excludeMailboxIds: string[] = []): Promise<number> {
    const excluded = new Set(excludeMailboxIds);
    let count = 0;
    for (const email of this.data.emails) {
      if (email.keywords.$seen === true) continue;
      const mbIds = Object.keys(email.mailboxIds);
      const onlyInExcluded = mbIds.length > 0 && mbIds.every(id => excluded.has(id));
      if (onlyInExcluded) continue;
      email.keywords.$seen = true;
      count++;
    }
    this.recalcMailboxCounts();
    return count;
  }

  async markAsSpam(emailId: string, _accountId?: string, markAsRead?: boolean): Promise<void> {
    const email = this.data.emails.find(e => e.id === emailId);
    const junkMb = this.data.mailboxes.find(m => m.role === 'junk');
    if (email && junkMb) {
      email.mailboxIds = { [junkMb.id]: true };
      email.keywords.$junk = true;
      delete email.keywords.$notjunk;
      if (markAsRead) email.keywords.$seen = true;
    }
    this.recalcMailboxCounts();
  }

  async undoSpam(emailId: string, originalMailboxId: string): Promise<void> {
    const email = this.data.emails.find(e => e.id === emailId);
    if (email) {
      email.mailboxIds = { [originalMailboxId]: true };
      delete email.keywords.$junk;
      email.keywords.$notjunk = true;
    }
    this.recalcMailboxCounts();
  }

  // ── Threads ───────────────────────────────────────────────────

  async getThread(threadId: string): Promise<Thread | null> {
    const emails = this.data.emails.filter(e => e.threadId === threadId);
    if (emails.length === 0) return null;
    return { id: threadId, emailIds: emails.map(e => e.id) };
  }

  async getThreads(threadIds: string[]): Promise<Thread[]> {
    return threadIds
      .map(tid => {
        const emails = this.data.emails.filter(e => e.threadId === tid);
        if (emails.length === 0) return null;
        return { id: tid, emailIds: emails.map(e => e.id) };
      })
      .filter((t): t is Thread => t !== null);
  }

  async getThreadEmails(threadId: string): Promise<Email[]> {
    return this.data.emails
      .filter(e => e.threadId === threadId)
      .sort((a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime());
  }

  // ── Compose / Send ────────────────────────────────────────────

  async resolveSendAccountId(_fromEmail?: string): Promise<string> {
    return this.getAccountId();
  }

  async createDraft(
    to: string[],
    subject: string,
    body: string,
    cc?: string[],
    bcc?: string[],
    _identityId?: string,
    _fromEmail?: string,
    draftId?: string,
    attachments?: Array<{ blobId: string; name: string; type: string; size: number; disposition?: 'attachment' | 'inline'; cid?: string }>,
    _fromName?: string,
    htmlBody?: string,
    inReplyTo?: string[],
    references?: string[],
  ): Promise<string> {
    const draftsMb = this.data.mailboxes.find(m => m.role === 'drafts');
    const id = draftId || generateDemoId('email');
    const existing = draftId ? this.data.emails.findIndex(e => e.id === draftId) : -1;

    const email: Email = {
      id, threadId: this.threadFor(inReplyTo, references),
      mailboxIds: { [draftsMb?.id || this.data.mailboxes[0].id]: true },
      keywords: { $seen: true, $draft: true },
      size: body.length,
      receivedAt: new Date().toISOString(),
      from: [this.fromAddress(_identityId, _fromEmail, _fromName)],
      to: to.map(e => ({ email: e })),
      cc: cc?.length ? cc.map(e => ({ email: e })) : undefined,
      bcc: bcc?.length ? bcc.map(e => ({ email: e })) : undefined,
      subject,
      sentAt: new Date().toISOString(),
      preview: body.substring(0, 200),
      hasAttachment: !!attachments?.length,
      textBody: [{ partId: htmlBody ? 'text' : '1', blobId: generateDemoId('blob'), size: body.length, type: 'text/plain' }],
      htmlBody: htmlBody
        ? [{ partId: 'html', blobId: generateDemoId('blob'), size: htmlBody.length, type: 'text/html' }]
        : [],
      bodyValues: htmlBody
        ? { text: { value: body }, html: { value: htmlBody } }
        : { '1': { value: body } },
      attachments: attachments?.map(a => ({ ...a, partId: generateDemoId('part') })),
      messageId: `<${id}@demo.example.com>`,
      inReplyTo: inReplyTo?.length ? inReplyTo : undefined,
      references: references?.length ? references : undefined,
    };

    if (existing >= 0) {
      this.data.emails[existing] = withEmlBlob(email);
    } else {
      this.data.emails.push(withEmlBlob(email));
    }
    this.recalcMailboxCounts();
    return id;
  }

  async sendEmail(
    to: string[],
    subject: string,
    body: string,
    cc?: string[],
    bcc?: string[],
    _identityId?: string,
    _fromEmail?: string,
    draftId?: string,
    _fromName?: string,
    htmlBody?: string,
    attachments?: Array<{ blobId: string; name: string; type: string; size: number; disposition?: 'attachment' | 'inline'; cid?: string }>,
    inReplyTo?: string[],
    references?: string[],
    delayedUntil?: string,
    _envelopeMailFrom?: string,
  ): Promise<SendEmailResult> {
    // Remove draft if updating
    if (draftId) {
      this.data.emails = this.data.emails.filter(e => e.id !== draftId);
    }
    const sentMb = this.data.mailboxes.find(m => m.role === 'sent');
    const email: Email = {
      id: generateDemoId('email'), threadId: this.threadFor(inReplyTo, references),
      mailboxIds: { [delayedUntil ? (this.data.mailboxes.find(m => m.role === 'drafts')?.id || this.data.mailboxes[0].id) : (sentMb?.id || this.data.mailboxes[0].id)]: true },
      keywords: delayedUntil ? { $seen: true, $draft: true } : { $seen: true },
      size: body.length + (htmlBody?.length || 0),
      receivedAt: new Date().toISOString(),
      from: [this.fromAddress(_identityId, _fromEmail, _fromName)],
      to: to.map(e => ({ email: e })),
      cc: cc?.length ? cc.map(e => ({ email: e })) : undefined,
      bcc: bcc?.length ? bcc.map(e => ({ email: e })) : undefined,
      subject,
      sentAt: new Date().toISOString(),
      preview: body.substring(0, 200),
      hasAttachment: !!attachments?.length,
      textBody: [{ partId: '1', blobId: generateDemoId('blob'), size: body.length, type: 'text/plain' }],
      htmlBody: htmlBody ? [{ partId: '2', blobId: generateDemoId('blob'), size: htmlBody.length, type: 'text/html' }] : [],
      bodyValues: htmlBody ? { '1': { value: body }, '2': { value: htmlBody } } : { '1': { value: body } },
      attachments: attachments?.map(a => ({ ...a, partId: generateDemoId('part') })),
      messageId: `<${generateDemoId('msg')}@demo.example.com>`,
      inReplyTo: inReplyTo?.length ? inReplyTo : undefined,
      references: references?.length ? references : undefined,
    };
    this.data.emails.push(withEmlBlob(email));
    let emailSubmissionId: string | undefined;
    if (delayedUntil) {
      emailSubmissionId = generateDemoId('submission');
      this.scheduledSubmissions.set(emailSubmissionId, {
        id: emailSubmissionId,
        emailId: email.id,
        identityId: _identityId || this.data.identities[0]?.id || 'demo-identity',
        sendAt: delayedUntil,
        undoStatus: 'pending',
        isSmime: false,
      });
    }
    this.recalcMailboxCounts();
    return delayedUntil
      ? { scheduled: true, emailId: email.id, emailSubmissionId, sendAt: delayedUntil }
      : { scheduled: false, emailId: email.id };
  }

  /**
   * The thread a new message joins. A server threads a reply by In-Reply-To
   * and References, so the reply shows up in the conversation it answers;
   * without a known parent the message starts a thread of its own.
   */
  private threadFor(inReplyTo?: string[], references?: string[]): string {
    const wanted = new Set([...(inReplyTo ?? []), ...(references ?? [])].map(stripMessageIdBrackets));
    const parent = wanted.size > 0
      ? this.data.emails.find(e => e.messageId && wanted.has(stripMessageIdBrackets(e.messageId)))
      : undefined;
    return parent?.threadId ?? generateDemoId('thread');
  }

  /** The From address of new mail: the chosen identity, else the account's own address. */
  private fromAddress(identityId?: string, fromEmail?: string, fromName?: string): EmailAddress {
    const identity = identityId ? this.data.identities.find(i => i.id === identityId) : undefined;
    if (identity) return { name: identity.name, email: identity.email };
    if (fromEmail) return { name: fromName || this.data.self.name, email: fromEmail };
    return { ...this.data.self };
  }

  async sendImipReply(): Promise<void> { /* no-op in demo */ }
  async sendImipInvitation(): Promise<void> { /* no-op in demo */ }
  async sendImipCancellation(): Promise<void> { /* no-op in demo */ }

  // ── Blobs ─────────────────────────────────────────────────────

  async uploadBlob(
    file: File,
    opts?: { onProgress?: (loaded: number, total: number) => void; signal?: AbortSignal },
  ): Promise<{ blobId: string; size: number; type: string }> {
    if (opts?.signal?.aborted) {
      throw new DOMException('Upload aborted', 'AbortError');
    }
    opts?.onProgress?.(0, file.size);
    const blobId = generateDemoId('blob');
    this.blobStore.set(blobId, file);
    opts?.onProgress?.(file.size, file.size);
    return { blobId, size: file.size, type: file.type };
  }

  async importEmail(): Promise<string | null> {
    return generateDemoId('email');
  }

  async sendReadReceipt(): Promise<void> {
    // Demo mode: no real network send.
  }

  getBlobDownloadUrl(blobId: string): string {
    return `data:application/octet-stream;demo-blob=${blobId}`;
  }

  async fetchBlob(blobId: string): Promise<Blob> {
    const stored = this.blobStore.get(blobId);
    if (stored) return stored;
    if (blobId === GONOGO_INVITE_BLOB) {
      return new Blob([createGoNoGoInvitationIcs()], { type: 'text/calendar; method=REQUEST' });
    }
    // Built on fetch so its dates follow the clock (fixtures/invoice.ts).
    if (blobId === INVOICE_BLOB) return new Blob([createSpreehostInvoiceXml()], { type: 'application/xml' });
    const emlOf = demoEmlEmailId(blobId);
    const emlEmail = emlOf ? this.data.emails.find((e) => e.id === emlOf) : undefined;
    if (emlEmail) return new Blob([buildDemoEml(emlEmail)], { type: 'message/rfc822' });
    const asset = DEMO_BLOB_ASSETS[blobId];
    if (asset) {
      try {
        const res = await fetch(withBasePath(asset));
        if (res.ok) {
          const blob = await res.blob();
          this.blobStore.set(blobId, blob);
          return blob;
        }
      } catch {
        // Fall through to the placeholder.
      }
    }
    return new Blob(['[Demo placeholder content]'], { type: 'text/plain' });
  }

  async fetchBlobAsObjectUrl(blobId: string): Promise<string> {
    const blob = await this.fetchBlob(blobId);
    return URL.createObjectURL(toInertBlob(blob));
  }

  async fetchBlobArrayBuffer(blobId: string): Promise<ArrayBuffer> {
    const blob = await this.fetchBlob(blobId);
    return blob.arrayBuffer();
  }

  async downloadBlob(blobId: string, name?: string): Promise<void> {
    const blob = await this.fetchBlob(blobId);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name || 'download';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ── Identities ────────────────────────────────────────────────

  async getIdentities(): Promise<Identity[]> { return [...this.data.identities]; }

  async createIdentity(
    name: string, email: string,
    replyTo?: EmailAddress[] | null, bcc?: EmailAddress[] | null,
    textSignature?: string | null, htmlSignature?: string | null,
  ): Promise<Identity> {
    const identity: Identity = {
      id: generateDemoId('identity'), name, email,
      replyTo: replyTo ?? undefined, bcc: bcc ?? undefined,
      htmlSignature: htmlSignature ?? '', textSignature: textSignature ?? '',
      mayDelete: true,
    };
    this.data.identities.push(identity);
    return identity;
  }

  async updateIdentity(identityId: string, updates: { name?: string | null; replyTo?: EmailAddress[] | null; bcc?: EmailAddress[] | null; textSignature?: string | null; htmlSignature?: string | null }): Promise<void> {
    const identity = this.data.identities.find(i => i.id === identityId);
    if (!identity) return;
    if (updates.name !== undefined) identity.name = updates.name ?? '';
    if (updates.replyTo !== undefined) identity.replyTo = updates.replyTo ?? undefined;
    if (updates.bcc !== undefined) identity.bcc = updates.bcc ?? undefined;
    if (updates.textSignature !== undefined) identity.textSignature = updates.textSignature ?? '';
    if (updates.htmlSignature !== undefined) identity.htmlSignature = updates.htmlSignature ?? '';
  }

  async deleteIdentity(identityId: string): Promise<void> {
    this.data.identities = this.data.identities.filter(i => i.id !== identityId);
  }

  // ── Vacation ──────────────────────────────────────────────────

  async getVacationResponse(_accountId?: string): Promise<VacationResponse> { return { ...this.data.vacationResponse }; }

  async setVacationResponse(updates: Partial<VacationResponse>, _accountId?: string): Promise<void> {
    Object.assign(this.data.vacationResponse, updates);
  }

  // ── Contacts ──────────────────────────────────────────────────

  getContactsAccountId(): string { return this.data.accountId; }

  async getAddressBooks(): Promise<AddressBook[]> { return [...this.data.addressBooks]; }
  async getAllAddressBooks(): Promise<AddressBook[]> { return [...this.data.addressBooks]; }

  async createAddressBook(name: string): Promise<AddressBook> {
    const book: AddressBook = { id: `demo-book-${Date.now()}`, name };
    this.data.addressBooks.push(book);
    return book;
  }

  async updateAddressBook(addressBookId: string, updates: Partial<AddressBook>): Promise<void> {
    const book = this.data.addressBooks.find(b => b.id === addressBookId);
    if (book) Object.assign(book, updates);
  }

  async setDefaultAddressBook(addressBookId: string): Promise<void> {
    for (const book of this.data.addressBooks) {
      book.isDefault = book.id === addressBookId;
    }
  }

  async deleteAddressBook(addressBookId: string): Promise<void> {
    this.data.addressBooks = this.data.addressBooks.filter(b => b.id !== addressBookId);
    this.data.contacts = this.data.contacts.filter(c => !c.addressBookIds?.[addressBookId]);
  }

  async getContacts(addressBookId?: string): Promise<ContactCard[]> {
    if (addressBookId) return this.data.contacts.filter(c => c.addressBookIds[addressBookId]);
    return [...this.data.contacts];
  }

  async getAllContacts(): Promise<ContactCard[]> { return [...this.data.contacts]; }

  async getContact(contactId: string): Promise<ContactCard | null> {
    return this.data.contacts.find(c => c.id === contactId) ?? null;
  }

  async createContact(contact: Partial<ContactCard>): Promise<ContactCard> {
    const full: ContactCard = {
      id: generateDemoId('contact'),
      addressBookIds: contact.addressBookIds ?? { [(this.data.addressBooks.find(b => b.isDefault) ?? this.data.addressBooks[0])?.id ?? 'demo-addressbook-personal']: true },
      ...contact,
    } as ContactCard;
    this.data.contacts.push(full);
    return full;
  }

  async updateContact(contactId: string, updates: Partial<ContactCard>): Promise<void> {
    const contact = this.data.contacts.find(c => c.id === contactId);
    if (contact) Object.assign(contact, updates);
  }

  async deleteContact(contactId: string): Promise<void> {
    this.data.contacts = this.data.contacts.filter(c => c.id !== contactId);
  }

  async searchContacts(query: string): Promise<ContactCard[]> {
    const q = query.toLowerCase();
    return this.data.contacts.filter(c => {
      const nameStr = c.name?.components?.map(nc => nc.value).join(' ').toLowerCase() ?? '';
      const emailStr = Object.values(c.emails ?? {}).map(e => e.address).join(' ').toLowerCase();
      return nameStr.includes(q) || emailStr.includes(q);
    });
  }

  // ── Calendars ─────────────────────────────────────────────────

  getCalendarsAccountId(): string { return this.data.accountId; }

  async getCalendars(): Promise<Calendar[]> { return [...this.data.calendars]; }
  async getAllCalendars(): Promise<Calendar[]> { return [...this.data.calendars]; }
  async getAllCalendarsWithFailures(): Promise<{ calendars: Calendar[]; failedAccountIds: string[] }> {
    return { calendars: [...this.data.calendars], failedAccountIds: [] };
  }

  async createCalendar(calendar: Partial<Calendar>): Promise<Calendar> {
    const full: Calendar = {
      id: generateDemoId('calendar'),
      name: calendar.name ?? 'New Calendar',
      description: calendar.description ?? null,
      color: calendar.color ?? '#6366f1',
      sortOrder: calendar.sortOrder ?? 99,
      isSubscribed: true, isVisible: true, isDefault: false,
      includeInAvailability: 'all',
      defaultAlertsWithTime: null, defaultAlertsWithoutTime: null,
      timeZone: null, shareWith: null,
      myRights: { mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayWriteOwn: true, mayUpdatePrivate: true, mayRSVP: true, mayShare: true, mayDelete: true },
      ...calendar,
    } as Calendar;
    this.data.calendars.push(full);
    return full;
  }

  async updateCalendar(calendarId: string, updates: Partial<Calendar>): Promise<void> {
    const cal = this.data.calendars.find(c => c.id === calendarId);
    if (cal) Object.assign(cal, updates);
  }

  async setDefaultCalendar(calendarId: string): Promise<void> {
    for (const cal of this.data.calendars) {
      cal.isDefault = cal.id === calendarId;
    }
  }

  async deleteCalendar(calendarId: string): Promise<void> {
    this.data.calendars = this.data.calendars.filter(c => c.id !== calendarId);
    this.data.calendarEvents = this.data.calendarEvents.filter(e => !e.calendarIds[calendarId]);
  }

  async getCalendarEvents(calendarIds?: string[]): Promise<CalendarEvent[]> {
    let events = [...this.data.calendarEvents];
    if (calendarIds?.length) {
      events = events.filter(e => calendarIds.some(cid => e.calendarIds[cid]));
    }
    return events;
  }

  async getCalendarEvent(id: string): Promise<CalendarEvent | null> {
    return this.data.calendarEvents.find(e => e.id === id) ?? null;
  }

  async createCalendarEvent(event: Partial<CalendarEvent>): Promise<CalendarEvent> {
    const full: CalendarEvent = {
      id: generateDemoId('event'),
      calendarIds: event.calendarIds ?? { [(this.data.calendars.find(c => c.isDefault) ?? this.data.calendars[0])?.id ?? 'demo-calendar-work']: true },
      '@type': 'Event',
      uid: generateDemoId('uid'),
      title: event.title ?? 'New Event',
      description: event.description ?? '',
      descriptionContentType: 'text/plain',
      isDraft: false, isOrigin: true,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      sequence: 0,
      start: event.start ?? new Date().toISOString(),
      duration: event.duration ?? 'PT1H',
      timeZone: event.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      utcStart: event.utcStart ?? null,
      utcEnd: event.utcEnd ?? null,
      showWithoutTime: event.showWithoutTime ?? false,
      status: 'confirmed', freeBusyStatus: 'busy', privacy: 'public',
      color: null, keywords: null, categories: null, locale: null,
      replyTo: null, organizerCalendarAddress: null, participants: null,
      mayInviteSelf: false, mayInviteOthers: false, hideAttendees: false,
      recurrenceId: null, recurrenceIdTimeZone: null, recurrenceRules: null,
      recurrenceOverrides: null, excludedRecurrenceRules: null,
      useDefaultAlerts: true, alerts: null, locations: null,
      virtualLocations: null, links: null, relatedTo: null,
      ...event,
    } as CalendarEvent;
    this.data.calendarEvents.push(full);
    return full;
  }

  async batchCreateCalendarEvents(events: Partial<CalendarEvent>[]): Promise<{ created: CalendarEvent[]; failed: string[]; notCreated: Record<string, { type?: string; description?: string }> }> {
    const created: CalendarEvent[] = [];
    for (const event of events) {
      const full = await this.createCalendarEvent(event);
      created.push(full);
    }
    return { created, failed: [], notCreated: {} };
  }

  /**
   * Applies a CalendarEvent/set patch. Keys may be JSON pointers
   * (`participants/p2/participationStatus`), which is how the store sends
   * an RSVP; plain keys replace the property.
   */
  async updateCalendarEvent(eventId: string, updates: Partial<CalendarEvent>): Promise<void> {
    const event = this.data.calendarEvents.find(e => e.id === eventId);
    if (!event) throw new Error('Event not found');
    const target = event as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(updates as Record<string, unknown>)) {
      if (!key.includes('/')) { target[key] = value; continue; }
      const path = key.split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
      let node = target;
      for (const segment of path.slice(0, -1)) {
        if (typeof node[segment] !== 'object' || node[segment] === null) node[segment] = {};
        node = node[segment] as Record<string, unknown>;
      }
      const last = path[path.length - 1];
      if (value === null) delete node[last]; else node[last] = value;
    }
    event.updated = new Date().toISOString();
  }

  async deleteCalendarEvent(eventId: string): Promise<void> {
    this.data.calendarEvents = this.data.calendarEvents.filter(e => e.id !== eventId);
  }

  async batchDeleteCalendarEvents(eventIds: string[]): Promise<{ destroyed: string[]; notDestroyed: Record<string, { type?: string; description?: string }> }> {
    const idSet = new Set(eventIds);
    this.data.calendarEvents = this.data.calendarEvents.filter(e => !idSet.has(e.id));
    return { destroyed: eventIds, notDestroyed: {} };
  }

  async queryCalendarEvents(filter: CalendarEventFilter): Promise<CalendarEvent[]> {
    return this.data.calendarEvents.filter(e => this.eventMatchesFilter(e, filter));
  }

  private eventMatchesFilter(e: CalendarEvent, filter: CalendarEventFilter): boolean {
    if (filter.operator) {
      const conditions = filter.conditions ?? [];
      switch (filter.operator) {
        case 'AND': return conditions.every(c => this.eventMatchesFilter(e, c));
        case 'OR': return conditions.some(c => this.eventMatchesFilter(e, c));
        case 'NOT': return !conditions.some(c => this.eventMatchesFilter(e, c));
      }
    }
    if (filter.uid && e.uid !== filter.uid) return false;
    if (filter.after && e.start < filter.after) return false;
    if (filter.before && e.start > filter.before) return false;
    // Global search sends a quoted phrase or a `word*` prefix as a text
    // condition of its own.
    const q = (filter.text ?? filter.title)?.replace(/^"([\s\S]*)"$/, '$1').replace(/\*$/, '').toLowerCase();
    if (q) {
      const locations = Object.values(e.locations ?? {}).map(l => l?.name ?? '').join(' ');
      if (!(e.title + ' ' + e.description + ' ' + locations).toLowerCase().includes(q)) return false;
    }
    return true;
  }

  async queryAllCalendarEvents(filter: CalendarEventFilter): Promise<CalendarEvent[]> {
    return this.queryCalendarEvents(filter);
  }

  /** Only the go/no-go invitation carries a parsable .ics in the demo. */
  async parseCalendarEvents(_accountId: string, blobId: string): Promise<Partial<CalendarEvent>[]> {
    if (blobId !== GONOGO_INVITE_BLOB) return [];
    const event = this.data.calendarEvents.find(e => e.id === GONOGO_EVENT_ID);
    return event ? [JSON.parse(JSON.stringify(event))] : [];
  }

  // ── Calendar Tasks ────────────────────────────────────────────

  async getCalendarTasks(calendarIds?: string[]): Promise<CalendarTask[]> {
    let tasks = this.data.calendarTasks || [];
    if (calendarIds) {
      tasks = tasks.filter(t => Object.keys(t.calendarIds).some(id => calendarIds.includes(id)));
    }
    return [...tasks];
  }

  async createCalendarTask(task: Partial<CalendarTask>): Promise<CalendarTask> {
    const full: CalendarTask = {
      id: generateDemoId('task'),
      uid: generateDemoId('task-uid'),
      '@type': 'Task',
      calendarIds: task.calendarIds || { [this.data.calendars[0]?.id || 'cal-1']: true },
      title: task.title || '',
      description: task.description || '',
      due: task.due || null,
      start: task.start || null,
      duration: task.duration || null,
      timeZone: task.timeZone || null,
      showWithoutTime: task.showWithoutTime ?? true,
      progress: task.progress || 'needs-action',
      progressUpdated: null,
      priority: task.priority || 0,
      privacy: task.privacy || 'public',
      keywords: task.keywords || null,
      categories: task.categories || null,
      color: task.color || null,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      recurrenceRules: task.recurrenceRules || null,
      alerts: task.alerts || null,
      relatedTo: task.relatedTo || null,
    };
    this.data.calendarTasks.push(full);
    return full;
  }

  async updateCalendarTask(taskId: string, updates: Partial<CalendarTask>): Promise<string> {
    const task = this.data.calendarTasks.find(t => t.id === taskId);
    if (task) Object.assign(task, updates, { updated: new Date().toISOString() });
    return taskId;
  }

  async deleteCalendarTask(taskId: string): Promise<void> {
    this.data.calendarTasks = this.data.calendarTasks.filter(t => t.id !== taskId);
  }

  // ── Sieve / Filters ──────────────────────────────────────────

  getSharedAccounts(): SharedAccount[] {
    return demoSharedAccounts(this.profile);
  }

  getSieveAccountId(): string { return this.data.accountId; }

  getSieveAccounts(): { id: string; name: string; isPrimary: boolean }[] {
    return this.getSharedAccounts()
      .filter((a) => a.isPrimary || a.capabilities.sieve)
      .map(({ id, name, isPrimary }) => ({ id, name, isPrimary }));
  }

  getSieveCapabilities(_accountId?: string): SieveCapabilities | null {
    return { ...this.data.sieveCapabilities };
  }

  async getSieveScripts(_accountId?: string): Promise<SieveScript[]> { return [...this.data.sieveScripts]; }

  async getSieveScriptContent(blobId: string, _accountId?: string): Promise<string> {
    return this.data.sieveContent[blobId] ?? '';
  }

  async createSieveScript(name: string, content: string, activate?: boolean, _accountId?: string): Promise<SieveScript> {
    const blobId = generateDemoId('sieve-blob');
    const script: SieveScript = { id: generateDemoId('sieve'), name, blobId, isActive: activate ?? false };
    this.data.sieveScripts.push(script);
    this.data.sieveContent[blobId] = content;
    if (activate) {
      for (const s of this.data.sieveScripts) {
        if (s.id !== script.id) s.isActive = false;
      }
    }
    return script;
  }

  async updateSieveScript(scriptId: string, content: string, activate?: boolean, _accountId?: string): Promise<void> {
    const script = this.data.sieveScripts.find(s => s.id === scriptId);
    if (!script) return;
    const blobId = generateDemoId('sieve-blob');
    this.data.sieveContent[blobId] = content;
    script.blobId = blobId;
    if (activate !== undefined) {
      script.isActive = activate;
      if (activate) {
        for (const s of this.data.sieveScripts) {
          if (s.id !== scriptId) s.isActive = false;
        }
      }
    }
  }

  async deleteSieveScript(scriptId: string, _accountId?: string): Promise<void> {
    this.data.sieveScripts = this.data.sieveScripts.filter(s => s.id !== scriptId);
  }

  async activateSieveScript(scriptId: string, _accountId?: string): Promise<void> {
    for (const s of this.data.sieveScripts) s.isActive = s.id === scriptId;
  }

  async deactivateSieveScript(_accountId?: string): Promise<void> {
    for (const s of this.data.sieveScripts) s.isActive = false;
  }

  async validateSieveScript(_content?: string, _accountId?: string): Promise<{ isValid: boolean; errors?: string[] }> {
    return { isValid: true };
  }

  // ── Files (FileNode) ─────────────────────────────────────────

  getFilesAccountId(): string { return this.data.accountId; }

  async probeFileNodeSupport(): Promise<boolean> { return true; }

  async listFileNodes(parentId: string | null): Promise<FileNode[]> {
    return this.data.fileNodes.filter(n => n.parentId === parentId);
  }

  async listAllFileNodes(): Promise<FileNode[]> {
    return [...this.data.fileNodes];
  }

  async listAllFileNodesAcrossAccounts(): Promise<FileNode[]> {
    return [...this.data.fileNodes];
  }

  async setFileNodeShare(fileNodeId: string, principalId: string, rights: FileNodeRights | null, targetAccountId?: string): Promise<void> {
    this.setShare('file', fileNodeId, principalId, rights, targetAccountId);
  }

  async getFileNodes(ids: string[] | null): Promise<FileNode[]> {
    if (ids === null) return [...this.data.fileNodes];
    return this.data.fileNodes.filter(n => ids.includes(n.id));
  }

  async createFileDirectory(name: string, parentId: string | null): Promise<FileNode> {
    const node: FileNode = {
      id: generateDemoId('file'),
      parentId, name, type: 'd', blobId: null, size: 0,
      created: new Date().toISOString(), modified: new Date().toISOString(),
    };
    this.data.fileNodes.push(node);
    return node;
  }

  async copyBlobs(_fromAccountId: string, blobIds: string[], _toAccountId: string): Promise<Record<string, string>> {
    // One demo store holds every account's blobs.
    return Object.fromEntries(blobIds.map((id) => [id, id]));
  }

  async createFileNode(name: string, blobId: string, type: string, size: number, parentId: string | null): Promise<FileNode> {
    const node: FileNode = {
      id: generateDemoId('file'),
      parentId, name, type, blobId, size,
      created: new Date().toISOString(), modified: new Date().toISOString(),
    };
    this.data.fileNodes.push(node);
    return node;
  }

  async updateFileNode(id: string, updates: Partial<Pick<FileNode, 'name' | 'parentId'>>): Promise<void> {
    // A rename or move leaves `modified` alone, as on Stalwart: it dates the
    // content, and a move or its Undo shouldn't make a file look edited.
    const node = this.data.fileNodes.find(n => n.id === id);
    if (node) Object.assign(node, updates);
  }

  async replaceFileNodeBlob(id: string, blobId: string): Promise<void> {
    const node = this.data.fileNodes.find(n => n.id === id);
    if (!node) throw new Error('No such file');
    const blob = this.blobStore.get(blobId);
    Object.assign(node, { blobId, ...(blob ? { size: blob.size } : {}), modified: new Date().toISOString() });
  }

  async updateFileNodes(updates: Record<string, Partial<Pick<FileNode, 'name' | 'parentId'>>>): Promise<{ updated: string[]; notUpdated: Record<string, string> }> {
    const updated: string[] = [];
    for (const [id, patch] of Object.entries(updates)) {
      const node = this.data.fileNodes.find(n => n.id === id);
      if (node) {
        Object.assign(node, patch);
        updated.push(id);
      }
    }
    return { updated, notUpdated: {} };
  }

  async destroyFileNodes(ids: string[]): Promise<{ destroyed: string[]; notDestroyed: string[] }> {
    // Like the server: a folder goes with everything in it (emptying the trash).
    const idSet = new Set(ids);
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of this.data.fileNodes) {
        if (n.parentId && idSet.has(n.parentId) && !idSet.has(n.id)) {
          idSet.add(n.id);
          grew = true;
        }
      }
    }
    this.data.fileNodes = this.data.fileNodes.filter(n => !idSet.has(n.id));
    return { destroyed: ids, notDestroyed: [] };
  }

  async copyFileNode(id: string, newName: string, parentId: string | null): Promise<FileNode> {
    const original = this.data.fileNodes.find(n => n.id === id);
    if (!original) throw new Error('File node not found');
    return this.createFileNode(newName, original.blobId ?? '', original.type, original.size, parentId);
  }

  // ── S/MIME raw-email helpers ──────────────────────────────────

  async importRawEmail(): Promise<string> { return generateDemoId('email'); }
  async copyEmailAcrossAccounts(): Promise<string> { return generateDemoId('email'); }
  async submitEmail(): Promise<void> { /* no-op */ }
  async submitRawEmail(blob: Blob,
    identityId: string,
    delayedUntil?: string,
    _envelopeRecipients?: string[],): Promise<SendEmailResult> {
    const emailId = generateDemoId('email');
    let emailSubmissionId: string | undefined;
    if (delayedUntil) {
      emailSubmissionId = generateDemoId('submission');
      this.scheduledSubmissions.set(emailSubmissionId, { id: emailSubmissionId, emailId, identityId, sendAt: delayedUntil, undoStatus: 'pending', isSmime: true });
    }
    return delayedUntil ? { scheduled: true, emailId, emailSubmissionId, sendAt: delayedUntil, isSmime: true } : { scheduled: false, emailId, isSmime: true };
  }
  async sendRawEmail(_blob?: Blob, identityId = 'demo-identity-primary', _sentMailboxId?: string, _draftMailboxId?: string, delayedUntil?: string, _envelopeRecipients?: string[]): Promise<SendEmailResult> {
    const emailId = generateDemoId('email');
    const draftsMailbox = this.data.mailboxes.find(m => m.role === 'drafts');
    const sentMailbox = this.data.mailboxes.find(m => m.role === 'sent');
    const email: Email = {
      id: emailId,
      threadId: generateDemoId('thread'),
      mailboxIds: { [(delayedUntil ? draftsMailbox?.id : sentMailbox?.id) || this.data.mailboxes[0].id]: true },
      keywords: delayedUntil ? { $seen: true, $draft: true } : { $seen: true },
      size: 1024,
      receivedAt: new Date().toISOString(),
      from: [this.fromAddress(identityId)],
      to: [],
      subject: 'S/MIME message',
      preview: 'Signed/encrypted demo message',
      hasAttachment: false,
    };
    this.data.emails.push(withEmlBlob(email));
    let emailSubmissionId: string | undefined;
    if (delayedUntil) {
      emailSubmissionId = generateDemoId('submission');
      this.scheduledSubmissions.set(emailSubmissionId, { id: emailSubmissionId, emailId, identityId, sendAt: delayedUntil, undoStatus: 'pending', isSmime: true });
    }
    this.recalcMailboxCounts();
    return delayedUntil ? { scheduled: true, emailId, emailSubmissionId, sendAt: delayedUntil, isSmime: true } : { scheduled: false, emailId, isSmime: true };
  }

  async getScheduledEmails(limit = 50, position = 0): Promise<{ emails: ScheduledEmail[]; hasMore: boolean; total: number; nextPosition: number }> {
    const pending = Array.from(this.scheduledSubmissions.values())
      .filter(s => s.undoStatus === 'pending')
      .sort((a, b) => new Date(a.sendAt).getTime() - new Date(b.sendAt).getTime());
    const page = pending.slice(position, position + limit);
    const emails = page.map((submission) => {
      const email = this.data.emails.find(e => e.id === submission.emailId);
      if (!email) return null;
      return {
        ...email,
        scheduledSendAt: submission.sendAt,
        emailSubmissionId: submission.id,
        scheduledIdentityId: submission.identityId,
        scheduledUndoStatus: submission.undoStatus,
        isScheduled: true,
        isSmimeScheduled: submission.isSmime,
      } satisfies ScheduledEmail;
    }).filter((email): email is ScheduledEmail => email !== null);
    const nextPosition = position + page.length;
    return { emails, hasMore: nextPosition < pending.length, total: pending.length, nextPosition };
  }

  async cancelEmailSubmission(submissionId: string): Promise<void> {
    const submission = this.scheduledSubmissions.get(submissionId);
    if (submission) submission.undoStatus = 'canceled';
  }

  async rescheduleEmailSubmission(submissionId: string, emailId: string, identityId: string, delayedUntil: string): Promise<SendEmailResult> {
    await this.cancelEmailSubmission(submissionId);
    const replacement = generateDemoId('submission');
    this.scheduledSubmissions.set(replacement, { id: replacement, emailId, identityId, sendAt: delayedUntil, undoStatus: 'pending', isSmime: false });
    return { scheduled: true, emailId, emailSubmissionId: replacement, sendAt: delayedUntil };
  }

  // The demo has no submission limit to keep under.
  async destroyEmailSubmissions(): Promise<string[]> { return []; }
  async pruneEmailSubmissions(): Promise<number> { return 0; }

  // Mirrors JMAPClient.restoreEmailToDraft: the third parameter is ignored and
  // the message ends up in Drafts only (full mailboxIds replacement).
  async restoreEmailToDraft(emailId: string, draftMailboxId: string, _sentMailboxId?: string): Promise<void> {
    const email = this.data.emails.find(e => e.id === emailId);
    if (!email) return;
    email.mailboxIds = { [draftMailboxId]: true };
    email.keywords.$draft = true;
    this.recalcMailboxCounts();
  }

  // ── Recover deleted items (x:ArchivedItem, lib/recovery/archived-items.ts) ──
  // As on Stalwart Enterprise with archiveDeletedItemsFor set: the work
  // account keeps what Nora deleted for good (fixtures/archive.ts).

  advertisesArchivedItems(accountId?: string): boolean {
    return !this.isPersonal && (!accountId || accountId === this.data.accountId);
  }

  /** x:ArchivedItem/query: newest first, paged; `total` with calculateTotal. */
  async queryArchivedItemIds(accountId?: string, options: { position?: number; limit?: number; calculateTotal?: boolean } = {}): Promise<ArchiveQueryPage> {
    const id = accountId || this.data.accountId;
    if (!this.advertisesArchivedItems(id)) {
      throw Object.assign(new Error('Archived items are not available for this account'), { type: 'forbidden' });
    }
    const ids = this.archive
      .filter((a) => a.item.accountId === id)
      .sort((a, b) => b.item.archivedAt.localeCompare(a.item.archivedAt))
      .map((a) => a.item.id);
    const position = options.position ?? 0;
    return {
      ids: ids.slice(position, options.limit ? position + options.limit : undefined),
      total: options.calculateTotal ? ids.length : null,
    };
  }

  private archiveIo(accountId: string): ArchiveIo {
    return {
      query: (position, limit) => this.queryArchivedItemIds(accountId, { position, limit, calculateTotal: true }),
      // x:ArchivedItem/get
      get: async (ids) => ids.flatMap((id) => {
        const found = this.archive.find((a) => a.item.id === id);
        return found ? [structuredClone(found.item)] : [];
      }),
    };
  }

  async listArchivedEmails(accountId?: string, options: { days?: number; startPosition?: number } = {}): Promise<ArchiveListResult> {
    const id = accountId || this.data.accountId;
    return listArchivedEmailsPaged(this.archiveIo(id), id, { days: options.days ?? 0, startPosition: options.startPosition });
  }

  async hasArchivedEmail(accountId?: string, options: { days?: number } = {}): Promise<boolean> {
    const id = accountId || this.data.accountId;
    return hasArchivedEmailIn(this.archiveIo(id), id, { days: options.days ?? 0 });
  }

  /**
   * x:ArchivedItem/set `{ status: "requestRestore" }`: the item leaves the
   * archive and the message is back in the Inbox, unread and without keywords.
   */
  async restoreArchivedItems(ids: string[], accountId?: string): Promise<RestoreResult[]> {
    const id = accountId || this.data.accountId;
    const results = ids.map((itemId): RestoreResult => {
      const index = this.archive.findIndex((a) => a.item.id === itemId && a.item.accountId === id);
      if (index < 0) return { id: itemId, ok: false, error: 'notFound', type: 'notFound' };
      const [{ email }] = this.archive.splice(index, 1);
      const restored = structuredClone(email);
      this.deriveHeaderFields(restored);
      this.data.emails.push(withEmlBlob(restored));
      return { id: itemId, ok: true };
    });
    if (results.some((r) => r.ok)) {
      this.recalcMailboxCounts();
      this.stateChangeCallback?.({
        '@type': 'StateChange',
        changed: { [this.data.accountId]: { Email: generateDemoId('state'), Mailbox: generateDemoId('state') } },
      });
    }
    return results;
  }

  // ── Internal helpers ──────────────────────────────────────────

  private recalcMailboxCounts(): void {
    const shared = Object.values(this.data.sharedMailboxes).flatMap((s) => s.mailboxes);
    for (const mb of [...this.data.mailboxes, ...shared]) {
      const inMb = this.data.emails.filter(e => e.mailboxIds[mb.id]);
      mb.totalEmails = inMb.length;
      mb.unreadEmails = inMb.filter(e => !e.keywords.$seen).length;
      mb.totalThreads = new Set(inMb.map(e => e.threadId)).size;
      mb.unreadThreads = new Set(inMb.filter(e => !e.keywords.$seen).map(e => e.threadId)).size;
    }
  }

  private startIncomingEmailTimer(): void {
    this.stopIncomingEmailTimer();

    const scheduleNext = () => {
      const delay = 60_000 + Math.random() * 60_000; // 60-120 seconds
      this.incomingTimer = setTimeout(() => {
        this.simulateIncomingEmail();
        scheduleNext();
      }, delay);
    };
    scheduleNext();
  }

  private stopIncomingEmailTimer(): void {
    if (this.incomingTimer) {
      clearTimeout(this.incomingTimer);
      this.incomingTimer = null;
    }
  }

  private simulateIncomingEmail(): void {
    const inbox = this.data.mailboxes.find(m => m.role === 'inbox');
    if (!inbox || this.profile !== 'work') return;
    const senders = [ALICE, BOB, SARAH, PRIYA, LISA].map(p => ({ name: p.name, email: p.email }));
    const subjects = [
      'Quick question about the canary list',
      'Go/no-go moved by 15 minutes',
      'FYI: runbook comments addressed',
      'Can you look at #1291 before lunch?',
      'Lunch today?',
      'Reminder: changelog quote',
    ];

    const sender = senders[Math.floor(Math.random() * senders.length)];
    const subject = subjects[Math.floor(Math.random() * subjects.length)];
    const id = generateDemoId('email');

    const email: Email = {
      id, threadId: generateDemoId('thread'),
      mailboxIds: { [inbox.id]: true },
      keywords: {},
      size: 1800,
      receivedAt: new Date().toISOString(),
      from: [sender],
      to: [{ ...this.data.self }],
      subject, sentAt: new Date().toISOString(),
      preview: `Hi, ${subject.toLowerCase()}. Let me know what you think.`,
      hasAttachment: false,
      textBody: [{ partId: '1', blobId: generateDemoId('blob'), size: 120, type: 'text/plain' }],
      bodyValues: {
        '1': { value: `Hi,\n\n${subject}. Let me know what you think.\n\nBest,\n${sender.name}` },
      },
      messageId: `<${id}@demo.example.com>`,
    };

    this.data.emails.unshift(withEmlBlob(email));
    this.recalcMailboxCounts();

    // Notify state change to trigger UI refresh
    this.stateChangeCallback?.({
      '@type': 'StateChange',
      changed: { [this.data.accountId]: { Email: generateDemoId('state'), Mailbox: generateDemoId('state') } },
    });
  }
}
