/**
 * The mailbox migration (#1760): one-time copy of a whole mailbox from an
 * old server (Open-Xchange, Kopano, Dovecot) into Stalwart. Mail over IMAP,
 * contacts over CardDAV, calendars over CalDAV and filters over
 * ManageSieve, run by the scheduler leader as the `mailbox-migration` job.
 *
 * The protocols sit behind the source interfaces below and the Stalwart
 * account behind MigrationTarget, so the engine runs against fakes in tests.
 */

// ─── Source servers ────────────────────────────────────────────────────────

export type ImapSecurity = 'tls' | 'starttls' | 'none';

/** Where a source's protocols live. Admin sources and the ones users type in share it. */
export interface SourceEndpoints {
  imap: { host: string; port: number; security: ImapSecurity };
  /** e.g. https://dav.example.com/caldav/ */
  caldavUrl?: string;
  carddavUrl?: string;
  /** ManageSieve, always with STARTTLS. */
  sieve?: { host: string; port: number };
}

/** An admin-defined source as stored: the admin password encrypted. */
export interface StoredSource extends SourceEndpoints {
  id: string;
  /** Shown to users, e.g. "Old mail server". */
  name: string;
  adminLogin?: {
    username: string;
    /** encryptSecret() of the password. */
    passwordEnc?: string;
    /** Login for IMAP and ManageSieve; `{user}` and `{admin}` are replaced. */
    format: string;
  };
  allowSelfService: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A source as the admin API returns it: never the password. */
export interface PublicSource extends SourceEndpoints {
  id: string;
  name: string;
  adminLogin?: { username: string; format: string; passwordSaved: boolean };
  allowSelfService: boolean;
}

export const DEFAULT_LOGIN_FORMAT = '{user}*{admin}';

export interface MigrationOptions {
  /** "Accounts copied at the same time", 1 to 10. */
  concurrency: number;
  /** "Forget source passwords after", in days since the last pass. */
  forgetAfterDays: number;
  /** "Let users enter any server". */
  allowUserServers: boolean;
}

export const DEFAULT_OPTIONS: MigrationOptions = { concurrency: 2, forgetAfterDays: 30, allowUserServers: false };

// ─── What a migration copies ───────────────────────────────────────────────

export interface CopyWhat {
  mail: boolean;
  contacts: boolean;
  calendars: boolean;
  filters: boolean;
}

export type AccountStatus =
  | 'queued'
  | 'mail'
  | 'contacts'
  | 'calendars'
  | 'filters'
  | 'paused'
  | 'done'
  | 'done_with_problems'
  | 'failed'
  | 'cancelled';

/** The phases in the order they run within one account. */
export const PHASES = ['mail', 'contacts', 'calendars', 'filters'] as const;
export type Phase = typeof PHASES[number];

export const RUNNING_STATUSES: readonly AccountStatus[] = ['queued', 'mail', 'contacts', 'calendars', 'filters', 'paused'];

export interface CountSet {
  copied: number;
  skipped: number;
  failed: number;
}

export type ReportKind = 'messages' | 'folders' | 'contacts' | 'events' | 'scripts';

export interface Problem {
  phase: Phase;
  /** What it is about: "INBOX UID 42", a script name. Never a subject or content. */
  item?: string;
  reason: string;
  /** Something to know rather than something that went wrong (no ManageSieve on the source). */
  note?: boolean;
}

export const MAX_PROBLEMS = 50;

export interface AccountReport {
  counts: Record<ReportKind, CountSet>;
  /** The first MAX_PROBLEMS problems. */
  problems: Problem[];
  /** How many there were in all, notes not counted. */
  problemCount: number;
}

// ─── Copy map: what earlier passes copied ─────────────────────────────────

export interface FolderCopyState {
  /** IMAP UIDVALIDITY as a decimal string (it can exceed 2^53 as a bigint in imapflow). */
  uidValidity: string;
  /** The highest UID copied. */
  lastUid: number;
  targetMailboxId?: string;
  /** Number of the hash chunks written for this folder (see the account store). */
  hashChunks?: number;
}

export interface DavCopyEntry {
  etag: string;
  targetId: string;
}

export interface CopyMap {
  /** Per source folder path. */
  folders: Record<string, FolderCopyState>;
  /** Per source script name: a content hash and the target script id. */
  scripts: Record<string, { hash: string; targetId: string }>;
}

// ─── Sources ───────────────────────────────────────────────────────────────

export interface SourceFolder {
  /** The full path as the server names it. */
  path: string;
  delimiter: string;
  /** `\Sent`, `\Drafts`, `\Trash`, `\Junk`, `\Archive`, `\Inbox`… */
  specialUse?: string;
  /** Has `\Noselect` (or `\NonExistent`): holds no messages. */
  noselect: boolean;
}

export interface FolderStatus {
  messages: number;
  uidValidity: string;
}

export interface MessageMeta {
  uid: number;
  /** IMAP flags and keywords as the server sent them. */
  flags: string[];
  internalDate: Date;
  size: number;
  /** The Message-ID header, without angle brackets; absent when the message has none. */
  messageId?: string;
}

/** IMAP, as the engine needs it. */
export interface MailSource {
  listFolders(): Promise<SourceFolder[]>;
  status(path: string): Promise<FolderStatus>;
  /** UIDs from `fromUid` up, ascending, and the folder's UIDVALIDITY. */
  listUids(path: string, fromUid: number): Promise<{ uidValidity: string; uids: number[] }>;
  fetchMeta(path: string, uids: number[]): Promise<MessageMeta[]>;
  /** The whole message (BODY.PEEK[]). */
  fetchSource(path: string, uid: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface DavCollection {
  href: string;
  name: string;
  /** CalDAV: #rrggbb when the server has one. */
  color?: string;
  /** CalDAV: the supported components (VEVENT, VTODO…); empty when the server didn't say. */
  components?: string[];
  /** CardDAV: whether this looks like the user's default book. */
  isDefault?: boolean;
}

export interface DavObjectRef {
  href: string;
  etag: string;
}

export interface DavObject extends DavObjectRef {
  /** The vCard or iCalendar text. */
  data: string;
}

/** CardDAV or CalDAV, as the engine needs it. */
export interface DavSource {
  listCollections(): Promise<DavCollection[]>;
  listObjects(collectionHref: string): Promise<DavObjectRef[]>;
  /** The objects at `hrefs` (multiget, GET per href where that fails). Missing ones are left out. */
  fetchObjects(collectionHref: string, hrefs: string[]): Promise<DavObject[]>;
}

export interface SieveScriptRef {
  name: string;
  active: boolean;
}

/** ManageSieve, as the engine needs it. */
export interface SieveSource {
  listScripts(): Promise<SieveScriptRef[]>;
  getScript(name: string): Promise<string>;
  close(): Promise<void>;
}

/** A source server that refused or couldn't be reached. `kind` decides retry and the report's words. */
export class SourceError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'tls' | 'auth' | 'blocked' | 'protocol',
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SourceError';
  }
}

// ─── Target ────────────────────────────────────────────────────────────────

export interface TargetMailbox {
  id: string;
  name: string;
  parentId: string | null;
  role: string | null;
}

export interface TargetCollection {
  id: string;
  name: string;
  isDefault?: boolean;
}

export interface TargetScript {
  id: string;
  name: string;
  isActive: boolean;
}

export interface EmailImportItem {
  blobId: string;
  mailboxId: string;
  keywords: Record<string, true>;
  receivedAt: string;
}

/** Created ids, or the server's reason, in the order given. */
export type SetOutcome = { id: string } | { error: string };

/** The Stalwart account, as the engine needs it. */
export interface MigrationTarget {
  /** maxSizeUpload from the session. */
  maxSizeUpload(): number;
  listMailboxes(): Promise<TargetMailbox[]>;
  createMailbox(name: string, parentId: string | null): Promise<string>;
  /** Upload to the account of the data's kind (mail by default). */
  uploadBlob(data: Uint8Array | string, type: string, kind?: 'mail' | 'calendars' | 'sieve'): Promise<string>;
  importEmails(items: EmailImportItem[]): Promise<SetOutcome[]>;
  /** Which of these Message-IDs are already in the mailbox. */
  findMessageIds(mailboxId: string, messageIds: string[]): Promise<Set<string>>;

  listAddressBooks(): Promise<TargetCollection[]>;
  createAddressBook(name: string): Promise<string>;
  /** Existing cards by UID. */
  findContactsByUid(uids: string[]): Promise<Map<string, string>>;
  /** Create (no id) or replace (id) cards; JMAP ContactCard objects. */
  saveContacts(cards: { id?: string; card: Record<string, unknown> }[]): Promise<SetOutcome[]>;

  listCalendars(): Promise<TargetCollection[]>;
  createCalendar(name: string, color?: string): Promise<string>;
  /** CalendarEvent/parse of an uploaded iCalendar blob. */
  parseEvents(blobId: string): Promise<Record<string, unknown>[]>;
  findEventsByUid(uids: string[]): Promise<Map<string, string>>;
  /** Create (no id) or replace (id) events, never sending scheduling messages. */
  saveEvents(events: { id?: string; event: Record<string, unknown> }[]): Promise<SetOutcome[]>;

  listSieveScripts(): Promise<TargetScript[]>;
  /** Create (no id) or update a script from an uploaded blob. */
  saveSieveScript(script: { id?: string; name: string; blobId: string; activate: boolean }): Promise<SetOutcome>;
}

/** Stalwart refused the credential (HTTP 401). */
export class TargetAuthError extends Error {
  constructor(message = 'The target server refused the credential') {
    super(message);
    this.name = 'TargetAuthError';
  }
}

/** Stalwart's upload or request limit (HTTP 429), with when it lets requests through again. */
export class TargetRateLimitError extends Error {
  constructor(readonly retryAfterMs: number | null) {
    super('The target server asked to slow down');
    this.name = 'TargetRateLimitError';
  }
}
