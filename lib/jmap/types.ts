export interface EmailHeader {
  name: string;
  value: string;
}

/**
 * A session-visible account (the user's own primary account plus any
 * shared/group accounts delegated to them), tagged with the capabilities it
 * advertises. Produced by client.getSharedAccounts(); drives the settings
 * "Shared with me" list and the scoped-settings tab gating.
 */
export interface SharedAccount {
  id: string;
  name: string;
  isPrimary: boolean;
  capabilities: {
    mail: boolean;
    sieve: boolean;
    calendars: boolean;
    contacts: boolean;
    filenode: boolean;
  };
}

export interface Email {
  id: string;
  threadId: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  size: number;
  receivedAt: string;
  from?: EmailAddress[];
  to?: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  replyTo?: EmailAddress[];
  subject?: string;
  sentAt?: string;
  preview?: string;
  textBody?: EmailBodyPart[];
  htmlBody?: EmailBodyPart[];
  bodyValues?: Record<string, EmailBodyValue>;
  attachments?: Attachment[];
  hasAttachment: boolean;
  // Extended header information
  messageId?: string;
  inReplyTo?: string[];
  references?: string[];
  headers?: Record<string, string | string[]>;
  // Security headers parsed
  authenticationResults?: AuthenticationResults;
  spamScore?: number;
  spamStatus?: string;
  spamLLM?: {
    verdict: string;
    explanation: string;
  };
  // S/MIME support
  blobId?: string;
  bodyStructure?: EmailBodyPart;
  // Unified mailbox support - set when displaying emails from multiple accounts.
  // `accountId` is a DISPLAY-only reference (avatar color / label / badge) and may
  // hold either an AccountEntry.id (personal) or the JMAP owner id (shared). For
  // resolving the client + JMAP routing use the two dedicated fields below, which
  // are always set on aggregated emails and unambiguous.
  accountId?: string;
  accountLabel?: string;
  // AccountEntry.id of the logged-in client through which this email is reachable.
  // Always a real login key → `useAuthStore.getClientForAccount(...)` resolves it.
  // For personal sources this equals the account itself; for shared/group sources
  // it is the delegating login (the shared account has no own login).
  sourceClientAccountId?: string;
  // JMAP account id of the email's owning account (personal: the client's primary;
  // shared/group: the owner account). Always safe to pass as the JMAP `accountId`
  // argument — equal to the client's primary for personal sources, so it is a no-op
  // there, and triggers owner-scoped routing + mailbox-id namespacing for shared.
  sourceAccountId?: string;
  // Name of the email's originating folder, stamped for the aggregate "All …"
  // views (All Mail, unified, cross-account) so the list can show where each
  // message lives. Transient/client-only, not part of the JMAP object.
  sourceFolder?: string;
  // Client-only scheduled-send metadata, populated from EmailSubmission/query.
  scheduledSendAt?: string;
  emailSubmissionId?: string;
  scheduledIdentityId?: string;
  scheduledUndoStatus?: 'pending' | 'final' | 'canceled';
  scheduledDeliveryStatus?: Record<string, DeliveryStatus>;
  isScheduled?: boolean;
  isSmimeScheduled?: boolean;
}

export interface SendEmailResult {
  scheduled: boolean;
  emailId?: string;
  emailSubmissionId?: string;
  sendAt?: string;
  isSmime?: boolean;
}

export interface ScheduledEmail extends Email {
  scheduledSendAt: string;
  emailSubmissionId: string;
  scheduledIdentityId: string;
  scheduledUndoStatus: 'pending' | 'final' | 'canceled';
  scheduledDeliveryStatus?: Record<string, DeliveryStatus>;
  isScheduled: true;
  isSmimeScheduled: boolean;
}

export interface AuthenticationResults {
  spf?: {
    result: 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'temperror' | 'permerror';
    domain?: string;
    ip?: string;
    /**
     * All SPF results when the server evaluated multiple identities (HELO and
     * MAIL FROM). Present only when more than one result was found; `result`
     * above is the most severe of these.
     */
    all?: Array<{
      result: 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'temperror' | 'permerror';
      domain?: string;
      identity?: 'helo' | 'mailfrom';
    }>;
  };
  dkim?: {
    result: 'pass' | 'fail' | 'policy' | 'neutral' | 'temperror' | 'permerror';
    domain?: string;
    selector?: string;
  };
  dmarc?: {
    result: 'pass' | 'fail' | 'none';
    policy?: 'reject' | 'quarantine' | 'none';
    domain?: string;
  };
  iprev?: {
    result: 'pass' | 'fail';
    ip?: string;
  };
}

export interface EmailBodyValue {
  value: string;
  isEncodingProblem?: boolean;
  isTruncated?: boolean;
}

export interface EmailAddress {
  name?: string;
  email: string;
}

export interface EmailBodyPart {
  partId: string;
  blobId: string;
  size: number;
  name?: string;
  type: string;
  charset?: string;
  disposition?: string;
  cid?: string;
  language?: string[];
  location?: string;
  subParts?: EmailBodyPart[];
}

export interface Attachment {
  partId: string;
  blobId: string;
  size: number;
  name?: string;
  type: string;
  charset?: string;
  cid?: string;
  disposition?: string;
}

export interface Mailbox {
  id: string;
  originalId?: string; // Original JMAP ID (for shared mailboxes)
  name: string;
  parentId?: string;
  role?: string;
  sortOrder: number;
  totalEmails: number;
  unreadEmails: number;
  totalThreads: number;
  unreadThreads: number;
  myRights: {
    mayReadItems: boolean;
    mayAddItems: boolean;
    mayRemoveItems: boolean;
    maySetSeen: boolean;
    maySetKeywords: boolean;
    mayCreateChild: boolean;
    mayRename: boolean;
    mayDelete: boolean;
    maySubmit: boolean;
  };
  isSubscribed: boolean;
  // Shared folder support
  accountId?: string;
  accountName?: string;
  isShared?: boolean;
}

export interface Thread {
  id: string;
  emailIds: string[];
}

// Thread grouping for UI display
export interface ThreadGroup {
  threadId: string;
  emails: Email[];           // Emails in this thread (sorted by receivedAt desc)
  latestEmail: Email;        // Most recent email
  participantNames: string[];// Unique participant names
  hasUnread: boolean;        // Any unread emails in thread
  hasStarred: boolean;       // Any starred emails in thread
  hasPinned: boolean;        // Any pinned emails in thread ($pinned keyword)
  hasAttachment: boolean;    // Any email has attachment
  hasAnswered: boolean;      // Any email has been replied to
  hasForwarded: boolean;     // Any email has been forwarded
  emailCount: number;        // Total emails in thread
}

export interface Identity {
  id: string;
  name: string;
  email: string;
  replyTo?: EmailAddress[];
  bcc?: EmailAddress[];
  textSignature?: string;
  htmlSignature?: string;
  mayDelete: boolean;
  // See `Calendar.localAccountId` - set when the Pro shell aggregates
  // identities from multiple connected accounts so we can route sends
  // back through the owning JMAP client. `accountName` is the
  // user-facing label for the dropdown's optgroup.
  localAccountId?: string;
  accountName?: string;
}

// RFC 9553 JSContact / RFC 9610 JMAP for Contacts

export interface ContactCard {
  id: string;
  originalId?: string;
  uid?: string;
  addressBookIds: Record<string, boolean>;
  kind?: 'individual' | 'group' | 'org' | 'location' | 'device' | 'application';
  accountId?: string;
  accountName?: string;
  isShared?: boolean;
  // Local account-store ID - set when the Pro shell aggregates contacts
  // from multiple connected accounts. See `Calendar.localAccountId`.
  localAccountId?: string;
  language?: string;
  name?: ContactName;
  nicknames?: Record<string, ContactNickname>;
  emails?: Record<string, ContactEmail>;
  phones?: Record<string, ContactPhone>;
  onlineServices?: Record<string, ContactOnlineService>;
  preferredLanguages?: Record<string, ContactLanguagePref>;
  organizations?: Record<string, ContactOrganization>;
  titles?: Record<string, ContactTitle>;
  addresses?: Record<string, ContactAddress>;
  anniversaries?: Record<string, ContactAnniversary>;
  personalInfo?: Record<string, ContactPersonalInfo>;
  notes?: Record<string, ContactNote>;
  media?: Record<string, ContactMedia>;
  cryptoKeys?: Record<string, ContactCryptoKey>;
  directories?: Record<string, ContactDirectory>;
  links?: Record<string, ContactLink>;
  relatedTo?: Record<string, ContactRelation>;
  keywords?: Record<string, boolean>;
  members?: Record<string, boolean>;
  speakToAs?: {
    grammaticalGender?: string;
    pronouns?: Record<string, { pronouns: string; pref?: number; contexts?: Record<string, boolean> }>;
  };
  calendarUri?: string;
  schedulingUri?: string;
  freeBusyUri?: string;
  source?: string;
  prodId?: string;
  created?: string;
  updated?: string;
}

export interface ContactName {
  components?: NameComponent[];
  isOrdered?: boolean;
  full?: string;
  defaultSeparator?: string;
}

export interface NameComponent {
  kind: 'given' | 'surname' | 'prefix' | 'suffix' | 'additional' | 'separator' | 'credential' | 'title' | 'middle' | 'given2' | 'surname2' | 'generation';
  value: string;
}

export interface ContactEmail {
  address: string;
  contexts?: Record<string, boolean>;
  label?: string;
  pref?: number;
}

export interface ContactPhone {
  number: string;
  contexts?: Record<string, boolean>;
  features?: Record<string, boolean>;
  label?: string;
  pref?: number;
}

export interface ContactOnlineService {
  service?: string;
  uri: string;
  user?: string;
  contexts?: Record<string, boolean>;
  label?: string;
  pref?: number;
}

export interface ContactLanguagePref {
  language: string;
  contexts?: Record<string, boolean>;
  pref?: number;
}

export interface ContactOrganization {
  name?: string;
  units?: Array<{ name: string }>;
  sortAs?: string;
}

export interface ContactTitle {
  name: string;
  kind?: 'title' | 'role';
  organizationId?: string;
}

// RFC 9553 AddressComponent
export interface AddressComponent {
  kind: 'room' | 'apartment' | 'floor' | 'building' | 'number' | 'name' | 'block' | 'subDistrict' | 'district' | 'locality' | 'region' | 'postcode' | 'country' | 'direction' | 'landmark' | 'postOfficeBox' | 'separator' | string;
  value: string;
  phonetic?: string;
}

export interface ContactAddress {
  // RFC 9553 format
  components?: AddressComponent[];
  full?: string;
  isOrdered?: boolean;
  defaultSeparator?: string;
  // Legacy flat fields (from vCard import)
  street?: string;
  locality?: string;
  region?: string;
  postcode?: string;
  country?: string;
  countryCode?: string;
  fullAddress?: string;
  coordinates?: string;
  timeZone?: string;
  contexts?: Record<string, boolean>;
  label?: string;
  pref?: number;
}

export interface ContactNickname {
  name: string;
  contexts?: Record<string, boolean>;
}

export interface ContactNote {
  note: string;
  created?: string;
  author?: { name?: string; uri?: string };
}

export interface ContactMedia {
  kind: 'photo' | 'sound' | 'logo';
  uri: string;
  mediaType?: string;
}

// RFC 9553 PartialDate
export interface PartialDate {
  '@type'?: 'PartialDate';
  year?: number;
  month?: number;
  day?: number;
  calendarScale?: string;
}

// RFC 9553 Timestamp
export interface Timestamp {
  '@type': 'Timestamp';
  utc: string;
}

export type AnniversaryDate = string | PartialDate | Timestamp;

export interface ContactAnniversary {
  '@type'?: 'Anniversary';
  kind: 'birth' | 'death' | 'wedding' | 'other';
  date: AnniversaryDate;
  place?: ContactAddress;
}

export interface ContactPersonalInfo {
  kind: 'expertise' | 'hobby' | 'interest' | 'other';
  value: string;
  level?: 'high' | 'medium' | 'low';
}

export interface ContactCryptoKey {
  uri: string;
  mediaType?: string;
  contexts?: Record<string, boolean>;
}

export interface ContactDirectory {
  uri: string;
  kind?: 'directory' | 'entry';
  mediaType?: string;
}

export interface ContactLink {
  uri: string;
  kind?: 'contact' | 'generic';
  mediaType?: string;
  contexts?: Record<string, boolean>;
  label?: string;
  pref?: number;
}

export interface ContactRelation {
  relation?: Record<string, boolean>;
}

export interface AddressBook {
  id: string;
  originalId?: string;
  name: string;
  description?: string | null;
  sortOrder?: number;
  isDefault?: boolean;
  isSubscribed?: boolean;
  myRights?: AddressBookRights;
  shareWith?: Record<string, AddressBookRights> | null;
  accountId?: string;
  accountName?: string;
  isShared?: boolean;
  // See `Calendar.localAccountId` - same purpose for address books.
  localAccountId?: string;
}

export interface AddressBookRights {
  mayRead: boolean;
  mayWrite: boolean;
  mayShare?: boolean;
  mayDelete: boolean;
}

// JMAP Principals (RFC 9670)
export interface Principal {
  id: string;
  type: 'individual' | 'group' | 'resource' | 'location' | 'other';
  name: string;
  description?: string | null;
  email?: string | null;
  timeZone?: string | null;
  capabilities?: Record<string, unknown>;
  accountId?: string;
}

export interface VacationResponse {
  id: string;
  isEnabled: boolean;
  fromDate: string | null;
  toDate: string | null;
  subject: string;
  textBody: string;
  htmlBody: string | null;
}

export interface EmailSubmission {
  id: string;
  identityId: string;
  emailId: string;
  threadId?: string;
  envelope: {
    mailFrom: EmailAddress;
    rcptTo: EmailAddress[];
  };
  sendAt?: string;
  undoStatus: "pending" | "final" | "canceled";
  deliveryStatus?: Record<string, DeliveryStatus>;
  dsnBlobIds?: string[];
  mdnBlobIds?: string[];
}

export interface DeliveryStatus {
  smtpReply: string;
  delivered: "queued" | "yes" | "no" | "unknown";
  displayed: "unknown" | "yes";
}

// JMAP Calendar Types (RFC 8984 JSCalendar + RFC 9553 JMAP Calendars)

export interface Calendar {
  id: string;
  originalId?: string;
  name: string;
  description: string | null;
  color: string | null;
  sortOrder: number;
  isSubscribed: boolean;
  isVisible: boolean;
  isDefault: boolean;
  includeInAvailability: 'all' | 'attending' | 'none';
  defaultAlertsWithTime: Record<string, CalendarEventAlert> | null;
  defaultAlertsWithoutTime: Record<string, CalendarEventAlert> | null;
  timeZone: string | null;
  shareWith: Record<string, CalendarRights> | null;
  myRights: CalendarRights;
  accountId?: string;
  accountName?: string;
  isShared?: boolean;
  // Local account-store ID (per JMAP server connection). Populated when the
  // Pro shell aggregates calendars from multiple connected accounts so we
  // can route mutations to the right client. Distinct from `accountId`
  // which is the JMAP server's own account UUID.
  localAccountId?: string;
  // Set when `color` has been replaced by the viewer's local override for a
  // shared calendar (see lib/shared-calendar-colors). When true, the override
  // wins over per-event colors so the whole shared calendar paints uniformly.
  colorIsLocalOverride?: boolean;
}

export interface CalendarRights {
  mayReadFreeBusy: boolean;
  mayReadItems: boolean;
  mayWriteAll: boolean;
  mayWriteOwn: boolean;
  mayUpdatePrivate: boolean;
  mayRSVP: boolean;
  mayShare: boolean;
  mayDelete: boolean;
}

export interface CalendarEvent {
  id: string;
  originalId?: string;
  calendarIds: Record<string, boolean>;
  originalCalendarIds?: Record<string, boolean>;
  accountId?: string;
  accountName?: string;
  isShared?: boolean;
  // See `Calendar.localAccountId` - same purpose for events.
  localAccountId?: string;
  isDraft: boolean;
  isOrigin: boolean;
  utcStart: string | null;
  utcEnd: string | null;
  '@type': 'Event';
  uid: string;
  title: string;
  description: string;
  descriptionContentType: string;
  created: string | null;
  updated: string;
  sequence: number;
  start: string;
  duration: string;
  timeZone: string | null;
  showWithoutTime: boolean;
  status: 'tentative' | 'confirmed' | 'cancelled';
  freeBusyStatus: 'free' | 'busy';
  privacy: 'public' | 'private' | 'secret';
  color: string | null;
  keywords: Record<string, boolean> | null;
  categories: Record<string, boolean> | null;
  locale: string | null;
  replyTo: Record<string, string> | null;
  organizerCalendarAddress: string | null;
  participants: Record<string, CalendarParticipant> | null;
  mayInviteSelf: boolean;
  mayInviteOthers: boolean;
  hideAttendees: boolean;
  recurrenceId: string | null;
  recurrenceIdTimeZone: string | null;
  recurrenceRules: CalendarRecurrenceRule[] | null;
  recurrenceOverrides: Record<string, Partial<CalendarEvent>> | null;
  excludedRecurrenceRules: CalendarRecurrenceRule[] | null;
  useDefaultAlerts: boolean;
  alerts: Record<string, CalendarEventAlert> | null;
  locations: Record<string, CalendarLocation> | null;
  virtualLocations: Record<string, CalendarVirtualLocation> | null;
  links: Record<string, CalendarLink> | null;
  relatedTo: Record<string, CalendarRelation> | null;
}

export interface CalendarParticipant {
  '@type': 'Participant';
  name: string;
  email: string;
  calendarAddress: string | null;
  description: string | null;
  sendTo: Record<string, string> | null;
  kind: 'individual' | 'group' | 'location' | 'resource';
  roles: Record<string, boolean>;
  participationStatus: 'accepted' | 'declined' | 'tentative' | 'delegated' | 'needs-action';
  participationComment: string | null;
  expectReply: boolean;
  scheduleAgent: 'server' | 'client' | 'none';
  scheduleForceSend: boolean;
  scheduleId: string | null;
  scheduleSequence: number;
  scheduleStatus: string[] | null;
  scheduleUpdated: string | null;
  invitedBy: string | null;
  delegatedTo: Record<string, boolean> | null;
  delegatedFrom: Record<string, boolean> | null;
  memberOf: Record<string, boolean> | null;
  locationId: string | null;
  language: string | null;
  links: Record<string, CalendarLink> | null;
}

export interface CalendarRecurrenceRule {
  '@type': 'RecurrenceRule';
  frequency: 'yearly' | 'monthly' | 'weekly' | 'daily' | 'hourly' | 'minutely' | 'secondly';
  interval: number;
  rscale: string;
  skip: 'omit' | 'backward' | 'forward';
  firstDayOfWeek: 'mo' | 'tu' | 'we' | 'th' | 'fr' | 'sa' | 'su';
  byDay: CalendarNDay[] | null;
  byMonthDay: number[] | null;
  byMonth: string[] | null;
  byYearDay: number[] | null;
  byWeekNo: number[] | null;
  byHour: number[] | null;
  byMinute: number[] | null;
  bySecond: number[] | null;
  bySetPosition: number[] | null;
  count: number | null;
  until: string | null;
}

export interface CalendarNDay {
  day: string;
  nthOfPeriod?: number;
}

export interface CalendarEventAlert {
  '@type': 'Alert';
  trigger: CalendarOffsetTrigger | CalendarAbsoluteTrigger;
  action: 'display' | 'email';
  acknowledged: string | null;
  relatedTo: Record<string, CalendarRelation> | null;
}

export interface CalendarOffsetTrigger {
  '@type': 'OffsetTrigger';
  offset: string;
  relativeTo: 'start' | 'end';
}

export interface CalendarAbsoluteTrigger {
  '@type': 'AbsoluteTrigger';
  when: string;
}

export interface CalendarLocation {
  '@type': 'Location';
  name: string;
  description: string | null;
  locationTypes: Record<string, boolean> | null;
  coordinates: string | null;
  timeZone: string | null;
  links: Record<string, CalendarLink> | null;
  relativeTo: 'start' | 'end' | null;
}

export interface CalendarVirtualLocation {
  '@type': 'VirtualLocation';
  name: string | null;
  description: string | null;
  uri: string;
  features: Record<string, boolean> | null;
}

export interface CalendarLink {
  '@type': 'Link';
  href: string;
  cid: string | null;
  contentType: string | null;
  size: number | null;
  rel: string | null;
  display: string | null;
  title: string | null;
}

export interface CalendarRelation {
  '@type': 'Relation';
  relation: Record<string, boolean> | null;
}

export interface CalendarTask {
  id: string;
  calendarIds: Record<string, boolean>;
  '@type': 'Task';
  uid: string;
  title: string;
  description: string;
  due: string | null;
  start: string | null;
  duration: string | null;
  timeZone: string | null;
  showWithoutTime: boolean;
  progress: 'needs-action' | 'in-process' | 'completed' | 'cancelled';
  progressUpdated: string | null;
  priority: number;
  privacy: 'public' | 'private' | 'secret';
  keywords: Record<string, boolean> | null;
  categories: Record<string, boolean> | null;
  color: string | null;
  created: string | null;
  updated: string;
  recurrenceRules: CalendarRecurrenceRule[] | null;
  alerts: Record<string, CalendarEventAlert> | null;
  relatedTo: Record<string, CalendarRelation> | null;
}

export interface CalendarParticipantIdentity {
  id: string;
  name: string;
  scheduleId: string;
  sendTo: Record<string, string>;
  isDefault: boolean;
}

export interface CalendarEventNotification {
  id: string;
  created: string;
  changedBy: {
    name: string;
    email: string;
    principalId: string | null;
    scheduleId: string | null;
  };
  comment: string | null;
  type: 'created' | 'updated' | 'destroyed';
  calendarEventId: string;
  isDraft: boolean;
  event?: CalendarEvent;
  eventPatch?: Record<string, unknown>;
}

export interface CalendarEventFilter {
  inCalendars?: string[];
  after?: string;
  before?: string;
  text?: string;
  title?: string;
  description?: string;
  location?: string;
  owner?: string;
  attendee?: string;
  participationStatus?: string;
  uid?: string;
  types?: string[];
}

// JMAP Push Notification Types (RFC 8620 Section 7)

export interface StateChange {
  '@type': 'StateChange';
  changed: {
    [accountId: string]: {
      Email?: string;
      Mailbox?: string;
      Thread?: string;
      EmailDelivery?: string;
      EmailSubmission?: string;
      Identity?: string;
      ContactCard?: string;
      AddressBook?: string;
      Calendar?: string;
      CalendarEvent?: string;
      SieveScript?: string;
    };
  };
}

export interface PushSubscription {
  id: string;
  deviceClientId: string;
  url: string;
  keys: {
    p256dh: string;
    auth: string;
  } | null;
  expires: string | null;
  types: string[] | null;
}

// For tracking last known states
export interface AccountStates {
  [accountId: string]: {
    Email?: string;
    Mailbox?: string;
    Thread?: string;
  };
}

// JMAP FileNode types (draft-ietf-jmap-filenode / Stalwart implementation)

export interface FileNode {
  id: string;
  parentId: string | null;
  name: string;
  type: string; // "d" for directory, MIME type for files
  blobId: string | null;
  size: number;
  created: string;
  updated: string;
  // JMAP Sharing (RFC 9670). Populated only when the server advertises the
  // filenode capability and the properties are explicitly requested. A node is
  // shared-out when `shareWith` has entries; `myRights` describes what the
  // viewer may do (always full rights on owned nodes).
  myRights?: FileNodeRights;
  shareWith?: Record<string, FileNodeRights> | null;
  // True when this node was fetched from another principal's account that was
  // shared with the logged-in user (mirrors Calendar.isShared / AddressBook.isShared).
  isShared?: boolean;
  // Owning account's JMAP id and display name, set when aggregating nodes
  // across connected/shared accounts so mutations route to the right account.
  accountId?: string;
  accountName?: string;
  // Local account-store id (per JMAP connection) in multi-account contexts.
  // See Calendar.localAccountId.
  localAccountId?: string;
}

// FileNode rights as defined by Stalwart's JmapSharedObject implementation.
export interface FileNodeRights {
  mayRead: boolean;
  mayAddChildren: boolean;
  mayRename: boolean;
  mayDelete: boolean;
  mayModifyContent: boolean;
  mayShare: boolean;
}

export interface FileNodeFilter {
  parentId?: string | null;
  name?: string;
  type?: string;
}

// Unified mailbox virtual IDs and types
export const UNIFIED_INBOX = '__unified_inbox__';
export const UNIFIED_SENT = '__unified_sent__';
export const UNIFIED_DRAFTS = '__unified_drafts__';
export const UNIFIED_TRASH = '__unified_trash__';
export const UNIFIED_ARCHIVE = '__unified_archive__';
export const UNIFIED_JUNK = '__unified_junk__';

export type UnifiedMailboxRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'archive' | 'junk';

export const UNIFIED_MAILBOX_IDS: Record<UnifiedMailboxRole, string> = {
  inbox: UNIFIED_INBOX,
  sent: UNIFIED_SENT,
  drafts: UNIFIED_DRAFTS,
  trash: UNIFIED_TRASH,
  archive: UNIFIED_ARCHIVE,
  junk: UNIFIED_JUNK,
};

export const UNIFIED_ROLE_BY_ID: Record<string, UnifiedMailboxRole> = Object.fromEntries(
  Object.entries(UNIFIED_MAILBOX_IDS).map(([role, id]) => [id, role as UnifiedMailboxRole])
) as Record<string, UnifiedMailboxRole>;

export function isUnifiedMailboxId(id: string): boolean {
  return id in UNIFIED_ROLE_BY_ID;
}

/**
 * Virtual mailbox id for the gated "All Mail" view: every folder of a single
 * account merged into one date-sorted list. Distinct from the unified mailbox
 * ids above, which merge one role across multiple accounts. Which folders are
 * included is a per-user setting (see `allMailFolderIds`).
 */
export const ALL_MAIL_MAILBOX_ID = '__all_mail__';

/**
 * Cross-account "All …" views shown in the unified ("All accounts") section.
 * Each merges messages across EVERY account (including shared/group folders),
 * spanning all folders except junk/spam, sent, archive, trash and drafts, in
 * one date-sorted list. Distinct from the per-role unified ids (one role across
 * accounts) and from ALL_MAIL_MAILBOX_ID (all folders of a single account).
 */
export const CROSS_UNREAD = '__cross_unread__';
export const CROSS_STARRED = '__cross_starred__';
export const CROSS_ALL = '__cross_all__';

export type CrossView = 'unread' | 'starred' | 'all';

export const CROSS_VIEW_IDS: Record<CrossView, string> = {
  unread: CROSS_UNREAD,
  starred: CROSS_STARRED,
  all: CROSS_ALL,
};

export const CROSS_VIEW_BY_ID: Record<string, CrossView> = Object.fromEntries(
  Object.entries(CROSS_VIEW_IDS).map(([view, id]) => [id, view as CrossView])
) as Record<string, CrossView>;

export function isCrossViewId(id: string): boolean {
  return id in CROSS_VIEW_BY_ID;
}

/**
 * Mailbox roles excluded from the cross-account views. Everything else (inbox
 * and custom/no-role folders) is included.
 */
export const CROSS_EXCLUDED_ROLES: ReadonlySet<string> = new Set([
  'junk', 'sent', 'archive', 'trash', 'drafts',
]);
