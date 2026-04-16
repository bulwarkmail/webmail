import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Email, Mailbox, StateChange, AccountStates, Thread, Identity, EmailAddress, ContactCard, AddressBook, VacationResponse, Calendar, CalendarEvent, CalendarEventFilter, CalendarTask, FileNode } from '@/lib/jmap/types';
import type { SieveScript, SieveCapabilities } from '@/lib/jmap/sieve-types';
import { getDemoData, type DemoData } from './demo-data';
import { generateDemoId } from './demo-utils';

/**
 * In-memory JMAP client for demo mode.
 * All data lives in memory - no network calls, no cookies.
 */
export class DemoJMAPClient implements IJMAPClient {
  private data: DemoData;
  private blobStore = new Map<string, Blob>();
  private connectionCallback: ((connected: boolean) => void) | null = null;
  private stateChangeCallback: ((change: StateChange) => void) | null = null;
  private lastStates: AccountStates = {};
  private incomingTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.data = getDemoData();
  }

  // ── Connection lifecycle ──────────────────────────────────────

  async connect(): Promise<void> {
    // Start simulated incoming email timer
    this.startIncomingEmailTimer();
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
  getAccountId(): string { return 'demo-account'; }
  getUsername(): string { return 'demo@example.com'; }

  // ── Capabilities ──────────────────────────────────────────────

  getCapabilities(): Record<string, unknown> {
    return {
      'urn:ietf:params:jmap:core': { maxSizeUpload: 50_000_000, maxCallsInRequest: 16, maxObjectsInGet: 500 },
      'urn:ietf:params:jmap:mail': {},
      'urn:ietf:params:jmap:submission': {},
      'urn:ietf:params:jmap:vacationresponse': {},
      'urn:ietf:params:jmap:contacts': {},
      'urn:ietf:params:jmap:calendars': {},
      'urn:ietf:params:jmap:sieve': {},
      'urn:ietf:params:jmap:quota': {},
      'urn:ietf:params:jmap:files': {},
    };
  }

  getMaxSizeUpload(): number { return 50_000_000; }
  getMaxCallsInRequest(): number { return 16; }
  getMaxObjectsInGet(): number { return 500; }
  getEventSourceUrl(): string | null { return null; }
  supportsEmailSubmission(): boolean { return true; }
  supportsQuota(): boolean { return true; }
  supportsVacationResponse(): boolean { return true; }
  supportsContacts(): boolean { return true; }
  supportsCalendars(): boolean { return true; }
  supportsSieve(): boolean { return true; }
  supportsFiles(): boolean { return true; }

  // ── Push / state ──────────────────────────────────────────────

  setupPushNotifications(): boolean { return true; }
  closePushNotifications(): void { /* no-op in demo */ }
  onConnectionChange(callback: (connected: boolean) => void): void { this.connectionCallback = callback; }
  onRateLimit(): void { /* no-op in demo */ }
  isRateLimited(): boolean { return false; }
  getRateLimitRemainingMs(): number { return 0; }
  onStateChange(callback: (change: StateChange) => void): void { this.stateChangeCallback = callback; }
  getLastStates(): AccountStates { return { ...this.lastStates }; }
  setLastStates(states: AccountStates): void { this.lastStates = { ...states }; }

  // ── Quota ─────────────────────────────────────────────────────

  async getQuota(): Promise<{ used: number; total: number } | null> {
    return { used: 245_366_784, total: 1_073_741_824 };
  }

  // ── Mailboxes ─────────────────────────────────────────────────

  async getMailboxes(): Promise<Mailbox[]> { return [...this.data.mailboxes]; }
  async getAllMailboxes(): Promise<Mailbox[]> { return [...this.data.mailboxes]; }

  async createMailbox(name: string, parentId?: string): Promise<Mailbox> {
    const mb: Mailbox = {
      id: generateDemoId('mailbox'),
      name,
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

  async updateMailbox(mailboxId: string, changes: { name?: string; parentId?: string | null; role?: string | null; sortOrder?: number }): Promise<void> {
    const mb = this.data.mailboxes.find(m => m.id === mailboxId);
    if (mb) Object.assign(mb, changes);
  }

  async deleteMailbox(mailboxId: string): Promise<void> {
    this.data.mailboxes = this.data.mailboxes.filter(m => m.id !== mailboxId);
    // Also remove emails in this mailbox
    this.data.emails = this.data.emails.filter(e => !e.mailboxIds[mailboxId]);
  }

  // ── Emails ────────────────────────────────────────────────────

  async getEmails(mailboxId?: string, _accountId?: string, limit: number = 50, position: number = 0): Promise<{ emails: Email[]; hasMore: boolean; total: number }> {
    let filtered = this.data.emails;
    if (mailboxId) {
      filtered = filtered.filter(e => e.mailboxIds[mailboxId]);
    }
    filtered.sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
    const total = filtered.length;
    const emails = filtered.slice(position, position + limit);
    return { emails, hasMore: position + limit < total, total };
  }

  async getEmailsInMailbox(mailboxId: string): Promise<Email[]> {
    return this.data.emails.filter(e => e.mailboxIds[mailboxId]);
  }

  async getEmail(emailId: string): Promise<Email | null> {
    return this.data.emails.find(e => e.id === emailId) ?? null;
  }

  async getTagCounts(tagIds: string[]): Promise<Record<string, { total: number; unread: number }>> {
    const result: Record<string, { total: number; unread: number }> = {};
    for (const tagId of tagIds) {
      const tagged = this.data.emails.filter(e => e.keywords[tagId]);
      result[tagId] = {
        total: tagged.length,
        unread: tagged.filter(e => !e.keywords.$seen).length,
      };
    }
    return result;
  }

  async searchEmails(query: string, mailboxId?: string, _accountId?: string, limit: number = 50, position: number = 0): Promise<{ emails: Email[]; hasMore: boolean; total: number }> {
    const q = query.toLowerCase();
    let filtered = this.data.emails.filter(e => {
      const text = [e.subject, e.preview, e.from?.[0]?.name, e.from?.[0]?.email].filter(Boolean).join(' ').toLowerCase();
      return text.includes(q);
    });
    if (mailboxId) filtered = filtered.filter(e => e.mailboxIds[mailboxId]);
    filtered.sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
    const total = filtered.length;
    const emails = filtered.slice(position, position + limit);
    return { emails, hasMore: position + limit < total, total };
  }

  async advancedSearchEmails(filter: Record<string, unknown>, _accountId?: string, limit: number = 50, position: number = 0): Promise<{ emails: Email[]; hasMore: boolean; total: number }> {
    // Simplified: just return all emails for any advanced filter
    let filtered = [...this.data.emails];
    if (filter.inMailbox) filtered = filtered.filter(e => e.mailboxIds[filter.inMailbox as string]);
    if (filter.text) {
      const q = (filter.text as string).toLowerCase();
      filtered = filtered.filter(e => [e.subject, e.preview].filter(Boolean).join(' ').toLowerCase().includes(q));
    }
    filtered.sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
    const total = filtered.length;
    const emails = filtered.slice(position, position + limit);
    return { emails, hasMore: position + limit < total, total };
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

  async batchMarkAsRead(emailIds: string[], read: boolean = true): Promise<void> {
    for (const id of emailIds) {
      const email = this.data.emails.find(e => e.id === id);
      if (email) {
        if (read) email.keywords.$seen = true;
        else delete email.keywords.$seen;
      }
    }
    this.recalcMailboxCounts();
  }

  async toggleStar(emailId: string, starred: boolean): Promise<void> {
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

  async migrateKeyword(oldKeyword: string, newKeyword: string): Promise<number> {
    let count = 0;
    for (const email of this.data.emails) {
      if (email.keywords[oldKeyword]) {
        delete email.keywords[oldKeyword];
        email.keywords[newKeyword] = true;
        count++;
      }
    }
    return count;
  }

  async deleteEmail(emailId: string): Promise<void> {
    this.data.emails = this.data.emails.filter(e => e.id !== emailId);
    this.recalcMailboxCounts();
  }

  async moveToTrash(emailId: string, trashMailboxId: string): Promise<void> {
    const email = this.data.emails.find(e => e.id === emailId);
    if (!email) return;
    email.mailboxIds = { [trashMailboxId]: true };
    this.recalcMailboxCounts();
  }

  async batchDeleteEmails(emailIds: string[]): Promise<void> {
    const idSet = new Set(emailIds);
    this.data.emails = this.data.emails.filter(e => !idSet.has(e.id));
    this.recalcMailboxCounts();
  }

  async batchMoveEmails(emailIds: string[], toMailboxId: string): Promise<void> {
    for (const id of emailIds) {
      const email = this.data.emails.find(e => e.id === id);
      if (email) email.mailboxIds = { [toMailboxId]: true };
    }
    this.recalcMailboxCounts();
  }

  async moveEmail(emailId: string, toMailboxId: string): Promise<void> {
    const email = this.data.emails.find(e => e.id === emailId);
    if (email) email.mailboxIds = { [toMailboxId]: true };
    this.recalcMailboxCounts();
  }

  async emptyMailbox(mailboxId: string): Promise<number> {
    const before = this.data.emails.length;
    this.data.emails = this.data.emails.filter(e => !e.mailboxIds[mailboxId]);
    const removed = before - this.data.emails.length;
    this.recalcMailboxCounts();
    return removed;
  }

  async markAsSpam(emailId: string): Promise<void> {
    const email = this.data.emails.find(e => e.id === emailId);
    const junkMb = this.data.mailboxes.find(m => m.role === 'junk');
    if (email && junkMb) email.mailboxIds = { [junkMb.id]: true };
    this.recalcMailboxCounts();
  }

  async undoSpam(emailId: string, originalMailboxId: string): Promise<void> {
    const email = this.data.emails.find(e => e.id === emailId);
    if (email) email.mailboxIds = { [originalMailboxId]: true };
    this.recalcMailboxCounts();
  }

  // ── Threads ───────────────────────────────────────────────────

  async getThread(threadId: string): Promise<Thread | null> {
    const emails = this.data.emails.filter(e => e.threadId === threadId);
    if (emails.length === 0) return null;
    return { id: threadId, emailIds: emails.map(e => e.id) };
  }

  async getThreadEmails(threadId: string): Promise<Email[]> {
    return this.data.emails
      .filter(e => e.threadId === threadId)
      .sort((a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime());
  }

  // ── Compose / Send ────────────────────────────────────────────

  async createDraft(
    to: string[],
    subject: string,
    body: string,
    cc?: string[],
    bcc?: string[],
    _identityId?: string,
    _fromEmail?: string,
    draftId?: string,
    attachments?: Array<{ blobId: string; name: string; type: string; size: number }>,
    _fromName?: string,
  ): Promise<string> {
    const draftsMb = this.data.mailboxes.find(m => m.role === 'drafts');
    const id = draftId || generateDemoId('email');
    const existing = draftId ? this.data.emails.findIndex(e => e.id === draftId) : -1;

    const email: Email = {
      id, threadId: generateDemoId('thread'),
      mailboxIds: { [draftsMb?.id || 'demo-mailbox-drafts']: true },
      keywords: { $seen: true, $draft: true },
      size: body.length,
      receivedAt: new Date().toISOString(),
      from: [{ name: 'Demo User', email: 'demo@example.com' }],
      to: to.map(e => ({ email: e })),
      cc: cc?.map(e => ({ email: e })),
      bcc: bcc?.map(e => ({ email: e })),
      subject,
      sentAt: new Date().toISOString(),
      preview: body.substring(0, 200),
      hasAttachment: !!attachments?.length,
      textBody: [{ partId: '1', blobId: generateDemoId('blob'), size: body.length, type: 'text/plain' }],
      htmlBody: [],
      bodyValues: { '1': { value: body } },
      attachments: attachments?.map(a => ({ ...a, partId: generateDemoId('part') })),
      messageId: `<${id}@demo.example.com>`,
    };

    if (existing >= 0) {
      this.data.emails[existing] = email;
    } else {
      this.data.emails.push(email);
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
    attachments?: Array<{ blobId: string; name: string; type: string; size: number }>,
  ): Promise<void> {
    // Remove draft if updating
    if (draftId) {
      this.data.emails = this.data.emails.filter(e => e.id !== draftId);
    }
    const sentMb = this.data.mailboxes.find(m => m.role === 'sent');
    const email: Email = {
      id: generateDemoId('email'), threadId: generateDemoId('thread'),
      mailboxIds: { [sentMb?.id || 'demo-mailbox-sent']: true },
      keywords: { $seen: true },
      size: body.length + (htmlBody?.length || 0),
      receivedAt: new Date().toISOString(),
      from: [{ name: 'Demo User', email: 'demo@example.com' }],
      to: to.map(e => ({ email: e })),
      cc: cc?.map(e => ({ email: e })),
      bcc: bcc?.map(e => ({ email: e })),
      subject,
      sentAt: new Date().toISOString(),
      preview: body.substring(0, 200),
      hasAttachment: !!attachments?.length,
      textBody: [{ partId: '1', blobId: generateDemoId('blob'), size: body.length, type: 'text/plain' }],
      htmlBody: htmlBody ? [{ partId: '2', blobId: generateDemoId('blob'), size: htmlBody.length, type: 'text/html' }] : [],
      bodyValues: htmlBody ? { '1': { value: body }, '2': { value: htmlBody } } : { '1': { value: body } },
      attachments: attachments?.map(a => ({ ...a, partId: generateDemoId('part') })),
      messageId: `<${generateDemoId('msg')}@demo.example.com>`,
    };
    this.data.emails.push(email);
    this.recalcMailboxCounts();
  }

  async sendImipReply(): Promise<void> { /* no-op in demo */ }
  async sendImipInvitation(): Promise<void> { /* no-op in demo */ }
  async sendImipCancellation(): Promise<void> { /* no-op in demo */ }

  // ── Blobs ─────────────────────────────────────────────────────

  async uploadBlob(file: File): Promise<{ blobId: string; size: number; type: string }> {
    const blobId = generateDemoId('blob');
    this.blobStore.set(blobId, file);
    return { blobId, size: file.size, type: file.type };
  }

  getBlobDownloadUrl(blobId: string): string {
    return `data:application/octet-stream;demo-blob=${blobId}`;
  }

  async fetchBlob(blobId: string): Promise<Blob> {
    return this.blobStore.get(blobId) ?? new Blob(['[Demo placeholder content]'], { type: 'text/plain' });
  }

  async fetchBlobAsObjectUrl(blobId: string): Promise<string> {
    const blob = await this.fetchBlob(blobId);
    return URL.createObjectURL(blob);
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
    htmlSignature?: string, textSignature?: string,
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

  async updateIdentity(identityId: string, updates: { name?: string; replyTo?: EmailAddress[] | null; bcc?: EmailAddress[] | null; htmlSignature?: string; textSignature?: string }): Promise<void> {
    const identity = this.data.identities.find(i => i.id === identityId);
    if (identity) Object.assign(identity, updates);
  }

  async deleteIdentity(identityId: string): Promise<void> {
    this.data.identities = this.data.identities.filter(i => i.id !== identityId);
  }

  // ── Vacation ──────────────────────────────────────────────────

  async getVacationResponse(): Promise<VacationResponse> { return { ...this.data.vacationResponse }; }

  async setVacationResponse(updates: Partial<VacationResponse>): Promise<void> {
    Object.assign(this.data.vacationResponse, updates);
  }

  // ── Contacts ──────────────────────────────────────────────────

  getContactsAccountId(): string { return 'demo-account'; }

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
      addressBookIds: contact.addressBookIds ?? { 'demo-addressbook-personal': true },
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

  getCalendarsAccountId(): string { return 'demo-account'; }

  async getCalendars(): Promise<Calendar[]> { return [...this.data.calendars]; }
  async getAllCalendars(): Promise<Calendar[]> { return [...this.data.calendars]; }

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
      myRights: { mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayWriteOwn: true, mayUpdatePrivate: true, mayRSVP: true, mayAdmin: true, mayDelete: true },
      ...calendar,
    } as Calendar;
    this.data.calendars.push(full);
    return full;
  }

  async updateCalendar(calendarId: string, updates: Partial<Calendar>): Promise<void> {
    const cal = this.data.calendars.find(c => c.id === calendarId);
    if (cal) Object.assign(cal, updates);
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
      calendarIds: event.calendarIds ?? { 'demo-calendar-personal': true },
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

  async batchCreateCalendarEvents(events: Partial<CalendarEvent>[]): Promise<{ created: CalendarEvent[]; failed: string[] }> {
    const created: CalendarEvent[] = [];
    for (const event of events) {
      const full = await this.createCalendarEvent(event);
      created.push(full);
    }
    return { created, failed: [] };
  }

  async updateCalendarEvent(eventId: string, updates: Partial<CalendarEvent>): Promise<void> {
    const event = this.data.calendarEvents.find(e => e.id === eventId);
    if (!event) throw new Error('Event not found');
    Object.assign(event, updates, { updated: new Date().toISOString() });
  }

  async deleteCalendarEvent(eventId: string): Promise<void> {
    this.data.calendarEvents = this.data.calendarEvents.filter(e => e.id !== eventId);
  }

  async batchDeleteCalendarEvents(eventIds: string[]): Promise<{ destroyed: string[]; notDestroyed: string[] }> {
    const idSet = new Set(eventIds);
    this.data.calendarEvents = this.data.calendarEvents.filter(e => !idSet.has(e.id));
    return { destroyed: eventIds, notDestroyed: [] };
  }

  async queryCalendarEvents(filter: CalendarEventFilter): Promise<CalendarEvent[]> {
    return this.data.calendarEvents.filter(e => {
      if (filter.after && e.start < filter.after) return false;
      if (filter.before && e.start > filter.before) return false;
      return true;
    });
  }

  async queryAllCalendarEvents(filter: CalendarEventFilter): Promise<CalendarEvent[]> {
    return this.queryCalendarEvents(filter);
  }

  async parseCalendarEvents(): Promise<Partial<CalendarEvent>[]> {
    return []; // no-op in demo
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

  async updateCalendarTask(taskId: string, updates: Partial<CalendarTask>): Promise<void> {
    const task = this.data.calendarTasks.find(t => t.id === taskId);
    if (task) Object.assign(task, updates, { updated: new Date().toISOString() });
  }

  async deleteCalendarTask(taskId: string): Promise<void> {
    this.data.calendarTasks = this.data.calendarTasks.filter(t => t.id !== taskId);
  }

  // ── Sieve / Filters ──────────────────────────────────────────

  getSieveAccountId(): string { return 'demo-account'; }

  getSieveCapabilities(): SieveCapabilities | null {
    return { ...this.data.sieveCapabilities };
  }

  async getSieveScripts(): Promise<SieveScript[]> { return [...this.data.sieveScripts]; }

  async getSieveScriptContent(blobId: string): Promise<string> {
    return this.data.sieveContent[blobId] ?? '';
  }

  async createSieveScript(name: string, content: string, activate?: boolean): Promise<SieveScript> {
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

  async updateSieveScript(scriptId: string, content: string, activate?: boolean): Promise<void> {
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

  async deleteSieveScript(scriptId: string): Promise<void> {
    this.data.sieveScripts = this.data.sieveScripts.filter(s => s.id !== scriptId);
  }

  async validateSieveScript(): Promise<{ isValid: boolean; errors?: string[] }> {
    return { isValid: true };
  }

  // ── Files (FileNode) ─────────────────────────────────────────

  getFilesAccountId(): string { return 'demo-account'; }

  async probeFileNodeSupport(): Promise<boolean> { return true; }

  async listFileNodes(parentId: string | null): Promise<FileNode[]> {
    return this.data.fileNodes.filter(n => n.parentId === parentId);
  }

  async getFileNodes(ids: string[] | null): Promise<FileNode[]> {
    if (ids === null) return [...this.data.fileNodes];
    return this.data.fileNodes.filter(n => ids.includes(n.id));
  }

  async createFileDirectory(name: string, parentId: string | null): Promise<FileNode> {
    const node: FileNode = {
      id: generateDemoId('file'),
      parentId, name, type: 'd', blobId: null, size: 0,
      created: new Date().toISOString(), updated: new Date().toISOString(),
    };
    this.data.fileNodes.push(node);
    return node;
  }

  async createFileNode(name: string, blobId: string, type: string, size: number, parentId: string | null): Promise<FileNode> {
    const node: FileNode = {
      id: generateDemoId('file'),
      parentId, name, type, blobId, size,
      created: new Date().toISOString(), updated: new Date().toISOString(),
    };
    this.data.fileNodes.push(node);
    return node;
  }

  async updateFileNode(id: string, updates: Partial<Pick<FileNode, 'name' | 'parentId'>>): Promise<void> {
    const node = this.data.fileNodes.find(n => n.id === id);
    if (node) Object.assign(node, updates, { updated: new Date().toISOString() });
  }

  async destroyFileNodes(ids: string[]): Promise<{ destroyed: string[]; notDestroyed: string[] }> {
    const idSet = new Set(ids);
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
  async submitEmail(): Promise<void> { /* no-op */ }
  async sendRawEmail(): Promise<void> { /* no-op */ }

  // ── Internal helpers ──────────────────────────────────────────

  private recalcMailboxCounts(): void {
    for (const mb of this.data.mailboxes) {
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
    const senders = [
      { name: 'Alice Johnson', email: 'alice.johnson@example.com' },
      { name: 'Bob Chen', email: 'bob.chen@example.com' },
      { name: 'Sarah Kim', email: 'sarah.kim@example.com' },
      { name: 'Carlos Rivera', email: 'carlos.rivera@example.com' },
    ];
    const subjects = [
      'Quick question about the project',
      'Meeting rescheduled to tomorrow',
      'FYI: Updated documentation',
      'Can you review this PR?',
      'Lunch today?',
      'Important: deadline reminder',
    ];

    const sender = senders[Math.floor(Math.random() * senders.length)];
    const subject = subjects[Math.floor(Math.random() * subjects.length)];
    const id = generateDemoId('email');

    const email: Email = {
      id, threadId: generateDemoId('thread'),
      mailboxIds: { 'demo-mailbox-inbox': true },
      keywords: {},
      size: 1800,
      receivedAt: new Date().toISOString(),
      from: [sender],
      to: [{ name: 'Demo User', email: 'demo@example.com' }],
      subject, sentAt: new Date().toISOString(),
      preview: `Hi, ${subject.toLowerCase()}. Let me know what you think.`,
      hasAttachment: false,
      textBody: [{ partId: '1', blobId: generateDemoId('blob'), size: 120, type: 'text/plain' }],
      bodyValues: {
        '1': { value: `Hi,\n\n${subject}. Let me know what you think.\n\nBest,\n${sender.name}` },
      },
      messageId: `<${id}@demo.example.com>`,
    };

    this.data.emails.unshift(email);
    this.recalcMailboxCounts();

    // Notify state change to trigger UI refresh
    this.stateChangeCallback?.({
      '@type': 'StateChange',
      changed: { 'demo-account': { Email: generateDemoId('state'), Mailbox: generateDemoId('state') } },
    });
  }
}
