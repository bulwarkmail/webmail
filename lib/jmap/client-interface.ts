import type { Email, Mailbox, StateChange, AccountStates, Thread, Identity, EmailAddress, ContactCard, AddressBook, VacationResponse, Calendar, CalendarEvent, CalendarEventFilter, CalendarTask, FileNode } from "./types";
import type { SieveScript, SieveCapabilities } from "./sieve-types";

/**
 * Interface defining the public JMAP client contract.
 *
 * Both the real `JMAPClient` (network-backed) and `DemoJMAPClient`
 * (in-memory/browser-only) implement this interface so that stores
 * and UI code never need to know which one is active.
 */
export interface IJMAPClient {
  // ── Connection lifecycle ──────────────────────────────────────
  connect(): Promise<void>;
  disconnect(): void;
  reconnect(): Promise<void>;
  ping(): Promise<void>;

  // ── Session / auth accessors ──────────────────────────────────
  getServerUrl(): string;
  getAuthHeader(): string;
  updateAccessToken(token: string): void;
  upgradeToBearer(accessToken: string, onRefresh?: () => Promise<string | null>): void;
  enableTotpReauth(basePassword: string, callback: () => Promise<string | null>): void;
  updateBasicAuth(newPassword: string): void;
  getAccountId(): string;
  getUsername(): string;

  // ── Capabilities ──────────────────────────────────────────────
  getCapabilities(): Record<string, unknown>;
  hasAccountCapability(capability: string, accountId?: string): boolean;
  getMaxSizeUpload(): number;
  getMaxCallsInRequest(): number;
  getMaxObjectsInGet(): number;
  getEventSourceUrl(): string | null;
  supportsEmailSubmission(): boolean;
  supportsQuota(): boolean;
  supportsVacationResponse(): boolean;
  supportsContacts(): boolean;
  supportsCalendars(): boolean;
  supportsSieve(): boolean;
  supportsFiles(): boolean;

  // ── Push / state ──────────────────────────────────────────────
  setupPushNotifications(): boolean;
  closePushNotifications(): void;
  onConnectionChange(callback: (connected: boolean) => void): void;
  onRateLimit(callback: (rateLimited: boolean, retryAfterMs: number) => void): void;
  isRateLimited(): boolean;
  getRateLimitRemainingMs(): number;
  onStateChange(callback: (change: StateChange) => void): void;
  getLastStates(): AccountStates;
  setLastStates(states: AccountStates): void;

  // ── Quota ─────────────────────────────────────────────────────
  getQuota(): Promise<{ used: number; total: number } | null>;

  // ── Mailboxes ─────────────────────────────────────────────────
  getMailboxes(): Promise<Mailbox[]>;
  getAllMailboxes(): Promise<Mailbox[]>;
  createMailbox(name: string, parentId?: string): Promise<Mailbox>;
  updateMailbox(mailboxId: string, changes: { name?: string; parentId?: string | null; role?: string | null; sortOrder?: number }): Promise<void>;
  deleteMailbox(mailboxId: string): Promise<void>;

  // ── Emails ────────────────────────────────────────────────────
  getEmails(mailboxId?: string, accountId?: string, limit?: number, position?: number, hasKeyword?: string): Promise<{ emails: Email[]; hasMore: boolean; total: number }>;
  getEmailsInMailbox(mailboxId: string): Promise<Email[]>;
  getEmail(emailId: string, accountId?: string): Promise<Email | null>;
  getTagCounts(tagIds: string[]): Promise<Record<string, { total: number; unread: number }>>;
  searchEmails(query: string, mailboxId?: string, accountId?: string, limit?: number, position?: number): Promise<{ emails: Email[]; hasMore: boolean; total: number }>;
  advancedSearchEmails(
    filter: Record<string, unknown>,
    accountId?: string,
    limit?: number,
    position?: number,
  ): Promise<{ emails: Email[]; hasMore: boolean; total: number }>;

  // ── Email mutations ───────────────────────────────────────────
  markAsRead(emailId: string, read?: boolean, accountId?: string): Promise<void>;
  batchMarkAsRead(emailIds: string[], read?: boolean): Promise<void>;
  toggleStar(emailId: string, starred: boolean): Promise<void>;
  updateEmailKeywords(emailId: string, keywords: Record<string, boolean>): Promise<void>;
  setKeyword(emailId: string, keyword: string): Promise<void>;
  migrateKeyword(oldKeyword: string, newKeyword: string): Promise<number>;
  deleteEmail(emailId: string): Promise<void>;
  moveToTrash(emailId: string, trashMailboxId: string, accountId?: string): Promise<void>;
  batchDeleteEmails(emailIds: string[]): Promise<void>;
  batchMoveEmails(emailIds: string[], toMailboxId: string, accountId?: string): Promise<void>;
  moveEmail(emailId: string, toMailboxId: string, accountId?: string): Promise<void>;
  emptyMailbox(mailboxId: string): Promise<number>;
  markAsSpam(emailId: string, accountId?: string): Promise<void>;
  undoSpam(emailId: string, originalMailboxId: string, accountId?: string): Promise<void>;

  // ── Threads ───────────────────────────────────────────────────
  getThread(threadId: string, accountId?: string): Promise<Thread | null>;
  getThreadEmails(threadId: string, accountId?: string): Promise<Email[]>;

  // ── Compose / Send ────────────────────────────────────────────
  createDraft(
    to: string[],
    subject: string,
    body: string,
    cc?: string[],
    bcc?: string[],
    identityId?: string,
    fromEmail?: string,
    draftId?: string,
    attachments?: Array<{ blobId: string; name: string; type: string; size: number; disposition?: 'attachment' | 'inline'; cid?: string }>,
    fromName?: string,
  ): Promise<string>;

  sendEmail(
    to: string[],
    subject: string,
    body: string,
    cc?: string[],
    bcc?: string[],
    identityId?: string,
    fromEmail?: string,
    draftId?: string,
    fromName?: string,
    htmlBody?: string,
    attachments?: Array<{ blobId: string; name: string; type: string; size: number; disposition?: 'attachment' | 'inline'; cid?: string }>,
  ): Promise<void>;

  sendImipReply(opts: {
    organizerEmail: string;
    organizerName?: string;
    attendeeEmail: string;
    attendeeName?: string;
    uid: string;
    summary?: string;
    dtStart?: string;
    dtEnd?: string;
    timeZone?: string;
    isAllDay?: boolean;
    sequence?: number;
    status: 'ACCEPTED' | 'TENTATIVE' | 'DECLINED';
    identityId?: string;
  }): Promise<void>;

  sendImipInvitation(event: CalendarEvent): Promise<void>;
  sendImipCancellation(event: CalendarEvent): Promise<void>;

  // ── Blobs ─────────────────────────────────────────────────────
  uploadBlob(file: File): Promise<{ blobId: string; size: number; type: string }>;
  getBlobDownloadUrl(blobId: string, name?: string, type?: string): string;
  fetchBlob(blobId: string, name?: string, type?: string): Promise<Blob>;
  fetchBlobAsObjectUrl(blobId: string, name?: string, type?: string): Promise<string>;
  fetchBlobArrayBuffer(blobId: string, name?: string, type?: string): Promise<ArrayBuffer>;
  downloadBlob(blobId: string, name?: string, type?: string): Promise<void>;

  // ── Identities ────────────────────────────────────────────────
  getIdentities(): Promise<Identity[]>;
  createIdentity(
    name: string,
    email: string,
    replyTo?: EmailAddress[] | null,
    bcc?: EmailAddress[] | null,
    htmlSignature?: string,
    textSignature?: string,
  ): Promise<Identity>;
  updateIdentity(
    identityId: string,
    updates: {
      name?: string;
      replyTo?: EmailAddress[] | null;
      bcc?: EmailAddress[] | null;
      htmlSignature?: string;
      textSignature?: string;
    },
  ): Promise<void>;
  deleteIdentity(identityId: string): Promise<void>;

  // ── Vacation ──────────────────────────────────────────────────
  getVacationResponse(): Promise<VacationResponse>;
  setVacationResponse(updates: Partial<VacationResponse>): Promise<void>;

  // ── Contacts ──────────────────────────────────────────────────
  getContactsAccountId(): string;
  getAddressBooks(): Promise<AddressBook[]>;
  getAllAddressBooks(): Promise<AddressBook[]>;
  createAddressBook(name: string): Promise<AddressBook>;
  updateAddressBook(addressBookId: string, updates: Partial<AddressBook>, targetAccountId?: string): Promise<void>;
  getContacts(addressBookId?: string): Promise<ContactCard[]>;
  getAllContacts(): Promise<ContactCard[]>;
  getContact(contactId: string, accountId?: string): Promise<ContactCard | null>;
  createContact(contact: Partial<ContactCard>, targetAccountId?: string): Promise<ContactCard>;
  updateContact(contactId: string, updates: Partial<ContactCard>, targetAccountId?: string): Promise<void>;
  deleteContact(contactId: string, targetAccountId?: string): Promise<void>;
  searchContacts(query: string): Promise<ContactCard[]>;

  // ── Calendars ─────────────────────────────────────────────────
  getCalendarsAccountId(): string;
  getCalendars(): Promise<Calendar[]>;
  getAllCalendars(): Promise<Calendar[]>;
  createCalendar(calendar: Partial<Calendar>, targetAccountId?: string): Promise<Calendar>;
  updateCalendar(calendarId: string, updates: Partial<Calendar>, targetAccountId?: string): Promise<void>;
  deleteCalendar(calendarId: string, targetAccountId?: string): Promise<void>;
  getCalendarEvents(calendarIds?: string[], targetAccountId?: string): Promise<CalendarEvent[]>;
  getCalendarEvent(id: string, targetAccountId?: string): Promise<CalendarEvent | null>;
  createCalendarEvent(event: Partial<CalendarEvent>, sendSchedulingMessages?: boolean, targetAccountId?: string): Promise<CalendarEvent>;
  batchCreateCalendarEvents(events: Partial<CalendarEvent>[], targetAccountId?: string): Promise<{ created: CalendarEvent[]; failed: string[] }>;
  updateCalendarEvent(
    eventId: string,
    updates: Partial<CalendarEvent>,
    sendSchedulingMessages?: boolean,
    targetAccountId?: string,
  ): Promise<void>;
  deleteCalendarEvent(eventId: string, sendSchedulingMessages?: boolean, targetAccountId?: string): Promise<void>;
  batchDeleteCalendarEvents(eventIds: string[], targetAccountId?: string): Promise<{ destroyed: string[]; notDestroyed: string[] }>;
  queryCalendarEvents(filter: CalendarEventFilter, sort?: Array<{ property: string; isAscending: boolean }>, limit?: number, targetAccountId?: string): Promise<CalendarEvent[]>;
  queryAllCalendarEvents(filter: CalendarEventFilter, sort?: Array<{ property: string; isAscending: boolean }>, limit?: number): Promise<CalendarEvent[]>;
  parseCalendarEvents(accountId: string, blobId: string): Promise<Partial<CalendarEvent>[]>;

  // ── Calendar Tasks ────────────────────────────────────────────
  getCalendarTasks(calendarIds?: string[], targetAccountId?: string): Promise<CalendarTask[]>;
  createCalendarTask(task: Partial<CalendarTask>, targetAccountId?: string): Promise<CalendarTask>;
  updateCalendarTask(taskId: string, updates: Partial<CalendarTask>, targetAccountId?: string): Promise<void>;
  deleteCalendarTask(taskId: string, targetAccountId?: string): Promise<void>;

  // ── Sieve / Filters ──────────────────────────────────────────
  getSieveAccountId(): string;
  getSieveCapabilities(): SieveCapabilities | null;
  getSieveScripts(): Promise<SieveScript[]>;
  getSieveScriptContent(blobId: string): Promise<string>;
  createSieveScript(name: string, content: string, activate?: boolean): Promise<SieveScript>;
  updateSieveScript(scriptId: string, content: string, activate?: boolean): Promise<void>;
  deleteSieveScript(scriptId: string): Promise<void>;
  validateSieveScript(content: string): Promise<{ isValid: boolean; errors?: string[] }>;

  // ── Files (WebDAV / FileNode) ─────────────────────────────────
  getFilesAccountId(): string;
  probeFileNodeSupport(): Promise<boolean>;
  listFileNodes(parentId: string | null): Promise<FileNode[]>;
  getFileNodes(ids: string[] | null, properties?: string[]): Promise<FileNode[]>;
  createFileDirectory(name: string, parentId: string | null): Promise<FileNode>;
  createFileNode(name: string, blobId: string, type: string, size: number, parentId: string | null): Promise<FileNode>;
  updateFileNode(id: string, updates: Partial<Pick<FileNode, 'name' | 'parentId'>>): Promise<void>;
  destroyFileNodes(ids: string[]): Promise<{ destroyed: string[]; notDestroyed: string[] }>;
  copyFileNode(id: string, newName: string, parentId: string | null): Promise<FileNode>;

  // ── S/MIME raw-email helpers ──────────────────────────────────
  importRawEmail(blob: Blob, mailboxIds: Record<string, boolean>, keywords?: Record<string, boolean>): Promise<string>;
  submitEmail(emailId: string, identityId: string): Promise<void>;
  sendRawEmail(blob: Blob, identityId: string, sentMailboxId: string, draftMailboxId?: string): Promise<void>;
}
