export interface EmailHeader {
  name: string;
  value: string;
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
}

export interface AuthenticationResults {
  spf?: {
    result: 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'temperror' | 'permerror';
    domain?: string;
    ip?: string;
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
  hasAttachment: boolean;    // Any email has attachment
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
}

// RFC 9553 JSContact / RFC 9610 JMAP for Contacts

export interface ContactCard {
  id: string;
  uid?: string;
  addressBookIds: Record<string, boolean>;
  kind?: 'individual' | 'group' | 'org' | 'location' | 'device' | 'application';
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
  components: NameComponent[];
  isOrdered?: boolean;
}

export interface NameComponent {
  kind: 'given' | 'surname' | 'prefix' | 'suffix' | 'additional' | 'separator' | 'credential';
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

export interface ContactAddress {
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

export interface ContactAnniversary {
  kind: 'birth' | 'death' | 'wedding' | 'other';
  date: string;
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
  name: string;
  description?: string | null;
  sortOrder?: number;
  isDefault?: boolean;
  isSubscribed?: boolean;
  myRights?: AddressBookRights;
}

export interface AddressBookRights {
  mayRead: boolean;
  mayWrite: boolean;
  mayShare: boolean;
  mayDelete: boolean;
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
}

export interface CalendarRights {
  mayReadFreeBusy: boolean;
  mayReadItems: boolean;
  mayWriteAll: boolean;
  mayWriteOwn: boolean;
  mayUpdatePrivate: boolean;
  mayRSVP: boolean;
  mayAdmin: boolean;
  mayDelete: boolean;
}

export interface CalendarEvent {
  id: string;
  calendarIds: Record<string, boolean>;
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
}

export interface FileNodeFilter {
  parentId?: string | null;
  name?: string;
  type?: string;
}