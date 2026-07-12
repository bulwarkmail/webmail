import type { Email, Mailbox, StateChange, AccountStates, Thread, Identity, EmailAddress, ContactCard, AddressBook, AddressBookRights, VacationResponse, Calendar, CalendarRights, CalendarEvent, CalendarEventFilter, CalendarTask, FileNode, FileNodeFilter, FileNodeRights, Principal, PushSubscription, EmailSubmission, ScheduledEmail, SendEmailResult, SharedAccount } from "./types";
import type { SieveScript, SieveCapabilities } from "./sieve-types";
import type { IJMAPClient } from "./client-interface";
import { toWildcardQuery } from "./search-utils";
import { debug } from "@/lib/debug";
import { normalizeCalendarEventLike } from "@/lib/calendar-event-normalization";

/** Parse a recipient string that may be "Name <email>" or bare "email" into { name?, email }. */
function parseRecipientString(s: string): { name?: string; email: string } {
  const trimmed = s.trim();
  const angleMatch = trimmed.match(/^(.+?)\s*<([^>]+)>$/);
  if (angleMatch) {
    return { name: angleMatch[1].trim(), email: angleMatch[2].trim() };
  }
  return { email: trimmed };
}

export class RateLimitError extends Error {
  retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super('Rate limited by server');
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

// JMAP protocol types - these are intentionally flexible due to server variations
interface JMAPSession {
  apiUrl: string;
  downloadUrl: string;
  uploadUrl?: string;
  eventSourceUrl?: string;
  primaryAccounts?: Record<string, string>;
  accounts?: Record<string, JMAPAccount>;
  capabilities?: Record<string, unknown>;
}

interface JMAPAccount {
  name?: string;
  isPersonal?: boolean;
  isReadOnly?: boolean;
  accountCapabilities?: Record<string, unknown>;
}

interface JMAPQuota {
  resourceType?: string;
  scope?: string;
  types?: string[];
  used?: number;
  hardLimit?: number;
  limit?: number;
}

interface JMAPMailbox {
  id: string;
  name: string;
  parentId?: string | null;
  role?: string | null;
  totalEmails?: number;
  unreadEmails?: number;
  totalThreads?: number;
  unreadThreads?: number;
  sortOrder?: number;
  isSubscribed?: boolean;
  myRights?: Record<string, boolean>;
}

interface JMAPEmailHeader {
  name: string;
  value: string;
}

type JMAPMethodCall = [string, Record<string, unknown>, string];

const SUBMISSION_USING = [
  'urn:ietf:params:jmap:core',
  'urn:ietf:params:jmap:mail',
  'urn:ietf:params:jmap:submission',
] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JMAPResponseResult = Record<string, any>;

interface JMAPResponse {
  methodResponses: Array<[string, JMAPResponseResult, string]>;
}

const DEFAULT_MAILBOX_RIGHTS = {
  mayReadItems: true,
  mayAddItems: true,
  mayRemoveItems: true,
  maySetSeen: true,
  maySetKeywords: true,
  mayCreateChild: true,
  mayRename: true,
  mayDelete: true,
  maySubmit: true,
} as const;

const EMAIL_LIST_PROPERTIES = [
  "id",
  "threadId",
  "mailboxIds",
  "keywords",
  "size",
  "receivedAt",
  "from",
  "to",
  "cc",
  "subject",
  "preview",
  "hasAttachment",
  // Needed so list rows can serve drag-out to the file system as .eml.
  "blobId",
] as const;

// Stalwart's default property list for Calendar/get omits shareWith, isVisible,
// includeInAvailability, and the default-alerts properties. Without an explicit
// `properties` list the share indicator and share dialog can't see existing
// shares after a fresh login (only the optimistic in-memory update from the
// share action would carry it). Always request the full set we render.
const CALENDAR_PROPERTIES = [
  "id",
  "name",
  "description",
  "color",
  "sortOrder",
  "isSubscribed",
  "isVisible",
  "isDefault",
  "includeInAvailability",
  "defaultAlertsWithTime",
  "defaultAlertsWithoutTime",
  "timeZone",
  "shareWith",
  "myRights",
] as const;

// Properties Stalwart's Calendar/set accepts in create/update. Anything else
// (id, isDefault, myRights, client-side bookkeeping fields) makes the whole
// update fail with invalidProperties ("Field could not be set").
const CALENDAR_SETTABLE_PROPERTIES = new Set([
  "name",
  "description",
  "color",
  "timeZone",
  "sortOrder",
  "isSubscribed",
  "isVisible",
  "includeInAvailability",
  "defaultAlertsWithTime",
  "defaultAlertsWithoutTime",
  "shareWith",
]);

// Stalwart's default property list for AddressBook/get omits shareWith, so
// existing shares would be invisible after a fresh login.
const ADDRESS_BOOK_PROPERTIES = [
  "id",
  "name",
  "description",
  "sortOrder",
  "isDefault",
  "isSubscribed",
  "shareWith",
  "myRights",
] as const;

/**
 * Detect whether a calendar object returned by the server is actually a
 * task (VTODO) rather than an event (VEVENT).  CalDAV clients like
 * Thunderbird create VTODOs that Stalwart exposes through the
 * CalendarEvent endpoints without a reliable `@type` discriminator.
 */
function isTaskObject(obj: { '@type'?: string; progress?: unknown; due?: unknown; percentComplete?: unknown }): boolean {
  const type = obj['@type'];
  if (typeof type === 'string' && type.toLowerCase() === 'task') return true;
  // CalDAV-created tasks may lack @type='Task' - detect by task-specific fields
  if (type !== 'Event' && (
    ('progress' in obj && typeof obj.progress === 'string') ||
    ('due' in obj && obj.due != null) ||
    ('percentComplete' in obj)
  )) return true;
  return false;
}

const CALENDAR_EVENT_PROPERTIES = [
  'id',
  '@type',
  'uid',
  'calendarIds',
  'title',
  'description',
  'descriptionContentType',
  'created',
  'updated',
  'sequence',
  'start',
  'duration',
  'timeZone',
  'showWithoutTime',
  'utcStart',
  'utcEnd',
  'status',
  'freeBusyStatus',
  'privacy',
  'color',
  'keywords',
  'categories',
  'locale',
  'replyTo',
  'organizerCalendarAddress',
  'participants',
  'mayInviteSelf',
  'mayInviteOthers',
  'hideAttendees',
  'recurrenceId',
  'recurrenceIdTimeZone',
  'recurrenceRule',
  'recurrenceOverrides',
  'excludedRecurrenceRule',
  'useDefaultAlerts',
  'alerts',
  'locations',
  'virtualLocations',
  'links',
  'relatedTo',
  'isDraft',
  'isOrigin',
] as const;

// Task-specific properties for CalendarEvent/get when fetching Task objects
const CALENDAR_TASK_PROPERTIES = [
  'id',
  '@type',
  'uid',
  'calendarIds',
  'title',
  'description',
  'descriptionContentType',
  'created',
  'updated',
  'start',
  'due',
  'duration',
  'timeZone',
  'showWithoutTime',
  'utcStart',
  'utcEnd',
  'progress',
  'progressUpdated',
  'priority',
  'privacy',
  'color',
  'keywords',
  'categories',
  'recurrenceRule',
  'recurrenceOverrides',
  'excludedRecurrenceRule',
  'useDefaultAlerts',
  'alerts',
  'relatedTo',
  'percentComplete',  // Task-only per RFC 8984 §5.2.4 - used in detection heuristic
] as const;

/**
 * IANA time zone of the browser, sent as the `timeZone` argument on
 * CalendarEvent/query and CalendarEvent/get. Stalwart interprets the
 * LocalDateTime `after`/`before` filter values and computes utcStart/utcEnd
 * for floating events in this zone, defaulting to UTC when absent - which
 * shifts range boundaries and floating-event times for any user not in UTC.
 * Stalwart ignores unparseable values, so sending it is always safe.
 */
function getUserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stalwart's calcard crate uses singular property names ("recurrenceRule")
 * instead of the RFC 8984 plural forms ("recurrenceRules").
 * JSCalendar 2.0 (jscalendarbis-15) defines recurrenceRule as a single object,
 * not an array. This function converts our internal array form to a single
 * object, cleans null values, and renames the properties.
 */
function cleanRecurrenceRules(event: Record<string, unknown>): void {
  const keyMap: Record<string, string> = {
    recurrenceRules: 'recurrenceRule',
    excludedRecurrenceRules: 'excludedRecurrenceRule',
  };
  for (const [pluralKey, singularKey] of Object.entries(keyMap)) {
    const rules = event[pluralKey];
    if (rules === undefined) continue;
    delete event[pluralKey];
    if (!Array.isArray(rules)) {
      // null means "remove recurrence" - pass through with the correct key
      event[singularKey] = rules;
      continue;
    }
    if (rules.length === 0) {
      event[singularKey] = null;
      continue;
    }
    // JSCalendar 2.0: recurrenceRule is a single object, use first rule
    const rule = rules[0] as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rule)) {
      if (v !== null) cleaned[k] = v;
    }
    event[singularKey] = cleaned;
  }
}

function getCalendarEventDebugSnapshot(event: Partial<CalendarEvent> | null | undefined): Record<string, unknown> | null {
  if (!event) {
    return null;
  }

  return {
    id: event.id,
    originalId: event.originalId,
    uid: event.uid,
    '@type': event['@type'],
    title: event.title,
    start: event.start,
    duration: event.duration,
    timeZone: event.timeZone,
    showWithoutTime: event.showWithoutTime,
    utcStart: event.utcStart,
    utcEnd: event.utcEnd,
    status: event.status,
    freeBusyStatus: event.freeBusyStatus,
    calendarIds: event.calendarIds,
    originalCalendarIds: event.originalCalendarIds,
    accountId: event.accountId,
    accountName: event.accountName,
    isShared: event.isShared,
    recurrenceId: event.recurrenceId,
    recurrenceRules: event.recurrenceRules,
    sequence: event.sequence,
    created: event.created,
    updated: event.updated,
  };
}

function namespaceMailboxIds(emails: Email[], accountId: string): void {
  for (const email of emails) {
    if (!email.mailboxIds) continue;
    const namespaced: Record<string, boolean> = {};
    for (const mbId of Object.keys(email.mailboxIds)) {
      namespaced[`${accountId}:${mbId}`] = email.mailboxIds[mbId];
    }
    email.mailboxIds = namespaced;
  }
}

function computeHasMore(position: number, emailCount: number, total: number, limit: number): boolean {
  if (total > 0) return (position + emailCount) < total;
  return emailCount === limit;
}

function hasSubmissionMethod(methodCalls: JMAPMethodCall[]): boolean {
  return methodCalls.some(([method]) => method.startsWith('Identity/') || method.startsWith('EmailSubmission/'));
}

function isSmimeEmail(email: Email): boolean {
  const types: string[] = [];
  const collect = (part: Email['bodyStructure']): void => {
    if (!part) return;
    if (part.type) types.push(part.type.toLowerCase());
    part.subParts?.forEach(collect);
  };
  collect(email.bodyStructure);
  email.attachments?.forEach(att => types.push((att.type || '').toLowerCase()));
  return types.some(type =>
    type.includes('pkcs7') ||
    type.includes('x-pkcs7') ||
    type === 'application/pkcs7-mime' ||
    type === 'application/pkcs7-signature'
  );
}

/**
 * Fold a single iCalendar content line per RFC 5545 §3.1.
 * Lines longer than 75 octets MUST be split with CRLF + a single linear white space character.
 * We fold at 74 characters to leave room for the leading space on continuation lines.
 * @see https://www.rfc-editor.org/rfc/rfc5545#section-3.1
 */
function foldIcsLine(line: string): string {
  const MAX = 74;
  if (line.length <= MAX) return line;
  const chunks: string[] = [];
  chunks.push(line.slice(0, MAX));
  let pos = MAX;
  while (pos < line.length) {
    chunks.push(' ' + line.slice(pos, pos + MAX - 1));
    pos += MAX - 1;
  }
  return chunks.join('\r\n');
}

/**
 * Escape a TEXT property value per RFC 5545 §3.3.11. Backslash, semicolon,
 * comma and newlines must be escaped - otherwise a title like "1,2;3" or a
 * multi-line description corrupts the component.
 * @see https://www.rfc-editor.org/rfc/rfc5545#section-3.3.11
 */
function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Encode a parameter value (e.g. CN=) per RFC 5545 §3.2: values containing
 * COLON, SEMICOLON or COMMA must be quoted; DQUOTE itself is not allowed in
 * parameter values, so replace it.
 */
function icsParamValue(value: string): string {
  const cleaned = value.replace(/[\r\n"]/g, "'");
  return /[;:,]/.test(cleaned) ? `"${cleaned}"` : cleaned;
}

// JMAP RFC 8621 stores Message-IDs without angle brackets. Strip any that
// snuck in (e.g. when echoing values that originated from RFC 5322 headers).
function stripMessageIdBrackets(id: string): string {
  return id.trim().replace(/^<+/, '').replace(/>+$/, '').trim();
}

/**
 * Build a CalendarEvent/query filter restricting results to the given
 * calendars. Stalwart implements the singular `inCalendar` condition (one
 * calendar id per condition), not the draft's plural `inCalendars` array -
 * sending the plural form fails the whole query with `unsupportedFilter`.
 * Multiple calendars are expressed as an OR of singular conditions.
 */
function buildInCalendarFilter(calendarIds: string[]): Record<string, unknown> {
  if (calendarIds.length === 1) {
    return { inCalendar: calendarIds[0] };
  }
  return {
    operator: 'OR',
    conditions: calendarIds.map((id) => ({ inCalendar: id })),
  };
}

// Some servers (notably Stalwart) return Identity.name in RFC 5322 mailbox
// form: `Display Name <addr@example.com>`. Re-emitting that as the JMAP
// from.name field produces a doubled From header (`"Name <addr>" <addr>`)
// whose display-name is invalid per RFC 5322 §3.4 and gets rejected by the
// submission validator - the email then sits forever in Drafts.
function sanitizeIdentityDisplayName(name: string | undefined | null): string {
  if (!name) return '';
  return name.replace(/\s*<[^>]*>\s*$/, '').trim();
}

function normalizeEnvelopeRecipients(recipients?: Array<string | EmailAddress>): Array<{ email: string }> {
  // The JMAP envelope rcptTo/mailFrom take a bare addr-spec, not an RFC 5322
  // mailbox. `to`/`cc`/`bcc` may arrive as "Name <addr>"; strip the display
  // name or the submission validator rejects the whole envelope (#…).
  return (recipients || [])
    .map((recipient) => typeof recipient === 'string' ? parseRecipientString(recipient).email : recipient.email)
    .map((email) => email.trim())
    .filter(Boolean)
    .map((email) => ({ email }));
}

function createDelayedSubmissionEnvelope(fromEmail: string, holdForSeconds?: number, recipients?: Array<string | EmailAddress>): Record<string, unknown> | undefined {
  if (!holdForSeconds) return undefined;
  const rcptTo = normalizeEnvelopeRecipients(recipients);
  return {
    mailFrom: {
      email: fromEmail,
      parameters: {
        HOLDFOR: String(holdForSeconds),
      },
    },
    rcptTo,
  };
}

type SubmissionCapability = {
  maxDelayedSend?: number;
  submissionExtensions?: unknown;
};

export class JMAPClient implements IJMAPClient {
  private static readonly RATE_LIMIT_TOAST_THROTTLE_MS = 10_000;

  private serverUrl: string;
  private username: string;
  private password: string;
  private basePassword: string = '';
  private authHeader: string;
  private authMode: 'basic' | 'bearer' = 'basic';
  private onTokenRefresh?: () => Promise<string | null>;
  private onTotpRequired?: () => Promise<string | null>;
  private apiUrl: string = "";
  private accountId: string = "";
  private downloadUrl: string = "";
  private capabilities: Record<string, unknown> = {};
  private session: JMAPSession | null = null;
  private lastPingTime: number = 0;
  private pingInterval: NodeJS.Timeout | null = null;
  // Set by disconnect() so async callbacks that were already in flight
  // (keep-alive ping, SSE error handlers) cannot revive timers or
  // reconnect after an intentional sign-out (#588).
  private intentionallyDisconnected = false;
  // Consecutive keep-alive failures; failed pings skip upcoming ticks
  // (30s -> 1m -> 2m -> ~5m) instead of hammering a down server (#588).
  private pingFailureCount = 0;
  private pingSkipRemaining = 0;
  private accounts: Record<string, JMAPAccount> = {};
  private eventSource: EventSource | null = null;
  private stateChangeCallback: ((change: StateChange) => void) | null = null;
  private lastStates: AccountStates = {};
  private reconnecting = false;
  private connectionChangeCallback: ((connected: boolean) => void) | null = null;
  private rateLimitedUntil: number = 0;
  private rateLimitCallback: ((rateLimited: boolean, retryAfterMs: number) => void) | null = null;
  private rateLimitTimeout: NodeJS.Timeout | null = null;
  private lastRateLimitNoticeAt: number = 0;

  constructor(serverUrl: string, username: string, password: string) {
    this.serverUrl = serverUrl.replace(/\/$/, '');
    this.username = username;
    this.password = password;
    this.authHeader = `Basic ${btoa(`${username}:${password}`)}`;
  }

  static withBearer(
    serverUrl: string,
    accessToken: string,
    username: string,
    onTokenRefresh?: () => Promise<string | null>,
  ): JMAPClient {
    const client = new JMAPClient(serverUrl, username, '');
    client.authMode = 'bearer';
    client.authHeader = `Bearer ${accessToken}`;
    client.onTokenRefresh = onTokenRefresh;
    return client;
  }

  updateAccessToken(token: string): void {
    this.authHeader = `Bearer ${token}`;
  }

  async getSomeEmails(emailsId: string[], accountId?: string): Promise<Email[]> {
    try {
      const targetAccountId = accountId || this.accountId;
      if (!emailsId || emailsId.length === 0) {
        return [];
      }

      const response = await this.request([
        ["Email/get", {
          accountId: targetAccountId,
          ids: emailsId,
          properties: [...EMAIL_LIST_PROPERTIES],
        }, "0"],
      ]);

      const getResponse = response.methodResponses?.[0]?.[1];

      if (response.methodResponses?.[0]?.[0] === "Email/get" && getResponse) {
        const emails = (getResponse.list || []) as Email[];

        emails.sort((a: Email, b: Email) =>
          new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()
        );

        if (accountId && accountId !== this.accountId) {
          namespaceMailboxIds(emails, accountId);
        }

        return emails;
      }

      return [];
    } catch (error) {
      console.error('Failed to get specific emails:', error);
      return [];
    }
  }
  /** Upgrade an existing basic-auth client to bearer-token auth (e.g. after TOTP token exchange). */
  upgradeToBearer(accessToken: string, onRefresh?: () => Promise<string | null>): void {
    this.authMode = 'bearer';
    this.authHeader = `Bearer ${accessToken}`;
    this.onTokenRefresh = onRefresh;
  }

  /**
   * Enable TOTP re-authentication for basic-auth sessions.
   * When a 401 is received, the callback is invoked to get a fresh TOTP code.
   * The base password (without TOTP) is stored so we can construct new credentials.
   */
  enableTotpReauth(basePassword: string, callback: () => Promise<string | null>): void {
    this.basePassword = basePassword;
    this.onTotpRequired = callback;
  }

  /** Update basic-auth credentials with a new password (e.g. password$newTotp). */
  updateBasicAuth(newPassword: string): void {
    this.password = newPassword;
    this.authHeader = `Basic ${btoa(`${this.username}:${newPassword}`)}`;
  }

  getAuthHeader(): string {
    return this.authHeader;
  }

  getServerUrl(): string {
    return this.serverUrl;
  }

  private async authenticatedFetch(url: string, init?: Parameters<typeof fetch>[1]): Promise<Response> {
    // Short-circuit: if rate-limited, reject immediately without sending a request
    if (this.isRateLimited()) {
      const remaining = this.rateLimitedUntil - Date.now();
      this.notifyRateLimitBlocked(remaining);
      throw new RateLimitError(remaining);
    }

    const headers = { ...init?.headers as Record<string, string>, 'Authorization': this.authHeader };
    let response: Response;

    try {
      response = await fetch(url, { ...init, headers });
    } catch (error) {
      // Network error: retry once after brief delay (transient proxy/connection issues)
      if (this.reconnecting) throw error;
      await new Promise(r => setTimeout(r, 1000));
      response = await fetch(url, { ...init, headers });
    }

    // Handle 429 rate limiting - stop immediately, do not retry
    if (response.status === 429) {
      const retryAfterMs = JMAPClient.parseRetryAfter(response);
      this.setRateLimited(retryAfterMs);
      throw new RateLimitError(retryAfterMs);
    }

    if (response.status === 401) {
      if (this.authMode === 'bearer' && this.onTokenRefresh) {
        const newToken = await this.onTokenRefresh();
        if (newToken) {
          this.updateAccessToken(newToken);
          const retryHeaders = { ...init?.headers as Record<string, string>, 'Authorization': this.authHeader };
          response = await fetch(url, { ...init, headers: retryHeaders });
        }
      } else if (this.authMode === 'basic' && !this.reconnecting && url !== `${this.serverUrl}/.well-known/jmap`) {
        // JMAP session may have expired - re-establish and retry once
        this.reconnecting = true;
        try {
          await this.refreshSession();
          this.connectionChangeCallback?.(true);
          const retryHeaders = { ...init?.headers as Record<string, string>, 'Authorization': this.authHeader };
          response = await fetch(url, { ...init, headers: retryHeaders });
        } catch {
          // Session refresh failed - if TOTP was used, try re-auth with fresh TOTP
          if (this.onTotpRequired && this.basePassword) {
            try {
              const newTotp = await this.onTotpRequired();
              if (newTotp) {
                this.updateBasicAuth(`${this.basePassword}$${newTotp}`);
                await this.refreshSession();
                this.connectionChangeCallback?.(true);
                const retryHeaders = { ...init?.headers as Record<string, string>, 'Authorization': this.authHeader };
                response = await fetch(url, { ...init, headers: retryHeaders });
              }
            } catch {
              // TOTP re-auth also failed - return original 401
            }
          }
        } finally {
          this.reconnecting = false;
        }
      }
    }

    return response;
  }

  /**
   * Fetch the JMAP session, transparently handling servers that redirect
   * /.well-known/jmap to a canonical session URL (e.g. Stalwart → /jmap/session).
   *
   * Safari strips the Authorization header on cross-origin redirects even when
   * the redirect destination is same-origin as the original request, and some
   * reverse-auth proxies (e.g. Pangolin) admit the redirected request via a
   * cookie without the Authorization header. Stalwart responds to an
   * unauthenticated /jmap/session with 200 + empty accounts rather than 401,
   * so the drop is silent and downstream parsing fails with "No mail account
   * found in session".
   *
   * Detect that case (response.redirected, empty accounts, empty username)
   * and retry directly against the final URL so we can re-send Authorization.
   */
  private async fetchSessionResponse(): Promise<Response> {
    const discoveryUrl = `${this.serverUrl}/.well-known/jmap`;
    const response = await this.authenticatedFetch(discoveryUrl, { method: 'GET' });
    if (!response.ok || !response.redirected) return response;

    const peek = await response.clone().json().catch(() => null);
    const hasAccounts = peek && Object.keys(peek.accounts || {}).length > 0;
    const hasUsername = typeof peek?.username === 'string' && peek.username.length > 0;
    if (hasAccounts || hasUsername) return response;

    return fetch(response.url, {
      method: 'GET',
      headers: { 'Authorization': this.authHeader },
    });
  }

  private async refreshSession(): Promise<void> {
    const response = await this.fetchSessionResponse();

    if (!response.ok) {
      throw new Error(`Session refresh failed: ${response.status}`);
    }

    const session = await response.json();
    this.rewriteSessionUrls(session);
    this.session = session;
    this.capabilities = session.capabilities || {};
    this.apiUrl = session.apiUrl;
    this.downloadUrl = session.downloadUrl;
    this.accounts = session.accounts || {};
  }

  async connect(): Promise<void> {
    this.intentionallyDisconnected = false;
    const sessionUrl = `${this.serverUrl}/.well-known/jmap`;

    try {
      const sessionResponse = await this.fetchSessionResponse();

      if (!sessionResponse.ok) {
        if (sessionResponse.status === 401) {
          throw new Error(this.authMode === 'bearer'
            ? 'Authentication failed - token may be expired'
            : 'Invalid username or password');
        }
        if (sessionResponse.status === 402) {
          try {
            const body = await sessionResponse.json();
            // Older Stalwart titled this "TOTP code required"; 0.16+ uses the
            // generic "MFA code required" - accept either to trigger the prompt.
            const title = body?.title?.toLowerCase() ?? '';
            if (title.includes('totp') || title.includes('mfa')) {
              throw new Error('TOTP_REQUIRED');
            }
          } catch (e) {
            if (e instanceof Error && e.message === 'TOTP_REQUIRED') throw e;
          }
        }
        throw new Error(`Failed to get session: ${sessionResponse.status}`);
      }

      const session = await sessionResponse.json();
      this.rewriteSessionUrls(session);

      this.session = session;
      this.capabilities = session.capabilities || {};
      this.apiUrl = session.apiUrl;
      this.downloadUrl = session.downloadUrl;
      this.accounts = session.accounts || {};

      const mailAccount = session.primaryAccounts?.["urn:ietf:params:jmap:mail"];
      const fallbackAccount = Object.keys(this.accounts)[0];
      this.accountId = mailAccount || fallbackAccount;

      if (!this.accountId) {
        throw new Error('No mail account found in session');
      }

      this.startKeepAlive();
    } catch (error) {
      if (error instanceof TypeError && (
        error.message === 'Failed to fetch' ||
        error.message.includes('NetworkError') ||
        error.message === 'Load failed' ||
        error.message === 'cancelled'
      )) {
        let serverReachable = false;
        try {
          await fetch(sessionUrl, { mode: 'no-cors' });
          serverReachable = true;
        } catch { /* genuinely unreachable */ }
        if (serverReachable) {
          throw new Error('CORS_ERROR');
        }
      }
      throw error;
    }
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();

    this.pingInterval = setInterval(async () => {
      if (this.intentionallyDisconnected) return;
      // Skip ping while rate-limited to avoid compounding auth failures
      if (this.isRateLimited()) return;
      // Back off while the server is down: each consecutive failure skips
      // more ticks (30s -> 1m -> 2m -> ~5m) instead of retrying flat-out.
      if (this.pingSkipRemaining > 0) {
        this.pingSkipRemaining--;
        return;
      }
      try {
        await this.ping();
        this.pingFailureCount = 0;
        this.connectionChangeCallback?.(true);
      } catch (error) {
        if (error instanceof RateLimitError) {
          return;
        }
        // A sign-out while the ping was in flight - stay down.
        if (this.intentionallyDisconnected) return;
        this.pingFailureCount++;
        this.pingSkipRemaining = Math.min(2 ** this.pingFailureCount, 10) - 1;
        console.error('Keep-alive ping failed:', error);
        this.connectionChangeCallback?.(false);
        try {
          await this.reconnect();
          this.pingFailureCount = 0;
          this.pingSkipRemaining = 0;
          this.connectionChangeCallback?.(true);
        } catch (reconnectError) {
          console.error('Reconnection failed:', reconnectError);
        }
      }
    }, 30_000);
  }

  private stopKeepAlive(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  async ping(): Promise<void> {
    if (!this.apiUrl) {
      throw new Error('Not connected');
    }

    const now = Date.now();
    const response = await this.request([
      ["Core/echo", { ping: "pong" }, "0"]
    ]);

    if (response.methodResponses?.[0]?.[0] !== "Core/echo") {
      throw new Error('Ping failed');
    }
    this.lastPingTime = now;
  }

  async reconnect(): Promise<void> {
    if (this.intentionallyDisconnected) return;
    await this.connect();
  }

  disconnect(): void {
    this.intentionallyDisconnected = true;
    this.stopKeepAlive();
    this.closePushNotifications();
    if (this.rateLimitTimeout) {
      clearTimeout(this.rateLimitTimeout);
      this.rateLimitTimeout = null;
    }
    this.apiUrl = "";
    this.accountId = "";
    this.session = null;
    this.capabilities = {};
  }

  private rewriteSessionUrl(url: string): string {
    try {
      const parsed = new URL(url);
      const server = new URL(this.serverUrl);
      if (parsed.origin === server.origin) return url;
      const pathAndRest = url.slice(url.indexOf('/', url.indexOf('//') + 2));
      return server.origin + pathAndRest;
    } catch {
      return url;
    }
  }

  private rewriteSessionUrls(session: JMAPSession): void {
    session.apiUrl = this.rewriteSessionUrl(session.apiUrl);
    session.downloadUrl = this.rewriteSessionUrl(session.downloadUrl);
    if (session.uploadUrl) {
      session.uploadUrl = this.rewriteSessionUrl(session.uploadUrl);
    }
    if (session.eventSourceUrl) {
      session.eventSourceUrl = this.rewriteSessionUrl(session.eventSourceUrl);
    }
  }

  private async request(methodCalls: JMAPMethodCall[], using?: string[]): Promise<JMAPResponse> {
    if (!this.apiUrl) {
      throw new Error('Not connected. Call connect() first.');
    }

    const requestBody = {
      using: using || (hasSubmissionMethod(methodCalls) ? [...SUBMISSION_USING] : ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"]),
      methodCalls,
    };

    const response = await this.authenticatedFetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    const responseText = await response.text();

    if (!response.ok) {
      console.error('Request failed:', response.status, responseText);
      throw new Error(`Request failed: ${response.status} - ${responseText.substring(0, 200)}`);
    }

    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      console.error('Failed to parse response:', responseText);
      throw new Error('Invalid JSON response from server');
    }

    return data;
  }

  async getQuota(): Promise<{ used: number; total: number } | null> {
    if (!this.supportsQuota()) return null;

    try {
      const response = await this.request([
        ["Quota/get", {
          accountId: this.accountId,
        }, "0"]
      ], ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:quota"]);

      if (response.methodResponses?.[0]?.[0] === "Quota/get") {
        const quotas = (response.methodResponses[0][1].list || []) as JMAPQuota[];
        const coversMail = (q: JMAPQuota) =>
          !q.types?.length || q.types.some((t) => t === "Email" || t === "Mail");
        // storage quotas use resourceType "octets" (e.g. Stalwart, with
        // scope "account"); fall back to the pre-RFC "mail" shape for older servers.
        const mailQuota =
          quotas.find((q) => q.resourceType === "octets" && coversMail(q)) ||
          quotas.find((q) => q.resourceType === "mail" || q.scope === "mail");

        if (mailQuota) {
          return {
            used: mailQuota.used ?? 0,
            total: mailQuota.hardLimit ?? mailQuota.limit ?? 0
          };
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  async getMailboxes(accountId?: string): Promise<Mailbox[]> {
    const acctId = accountId || this.accountId;
    try {
      const response = await this.request([
        ["Mailbox/get", { accountId: acctId }, "0"]
      ]);

      if (response.methodResponses?.[0]?.[0] === "Mailbox/get") {
        const rawMailboxes = (response.methodResponses[0][1].list || []) as JMAPMailbox[];

        debug.log('jmap', `[JMAP Mailbox] getMailboxes returned ${rawMailboxes.length} mailboxes for account ${acctId}`);

        // Warn if response might be truncated
        const maxObjects = this.getMaxObjectsInGet();
        if (rawMailboxes.length >= maxObjects) {
          debug.warn('jmap', 
            `[JMAP Mailbox] Response contains ${rawMailboxes.length} mailboxes which equals maxObjectsInGet (${maxObjects}). ` +
            `Some mailboxes may be missing - nested folders could appear orphaned at root level.`
          );
        }

        // Log parentId references to detect potential orphans
        const returnedIds = new Set(rawMailboxes.map(mb => mb.id));
        const missingParents = rawMailboxes.filter(mb => mb.parentId && !returnedIds.has(mb.parentId));
        if (missingParents.length > 0) {
          debug.warn('jmap', 
            `[JMAP Mailbox] ${missingParents.length} mailbox(es) reference parentId not in response (will be orphaned):`,
            missingParents.map(mb => ({ id: mb.id, name: mb.name, parentId: mb.parentId }))
          );
        }

        return rawMailboxes.map((mb) => ({
          id: mb.id,
          originalId: undefined,
          name: mb.name,
          parentId: mb.parentId || undefined,
          role: mb.role || undefined,
          sortOrder: mb.sortOrder ?? 0,
          totalEmails: mb.totalEmails ?? 0,
          unreadEmails: mb.unreadEmails ?? 0,
          totalThreads: mb.totalThreads ?? 0,
          unreadThreads: mb.unreadThreads ?? 0,
          myRights: mb.myRights || DEFAULT_MAILBOX_RIGHTS,
          isSubscribed: mb.isSubscribed ?? true,
          accountId: acctId,
          accountName: this.accounts[acctId]?.name || this.username,
          isShared: acctId !== this.accountId,
        }) as Mailbox);
      }

      throw new Error('Unexpected response format');
    } catch (error) {
      console.error('Failed to get mailboxes:', error);
      return [{
        id: 'INBOX',
        originalId: undefined,
        name: 'Inbox',
        role: 'inbox',
        sortOrder: 0,
        totalEmails: 0,
        unreadEmails: 0,
        totalThreads: 0,
        unreadThreads: 0,
        myRights: DEFAULT_MAILBOX_RIGHTS,
        isSubscribed: true,
        accountId: this.accountId,
        accountName: this.username,
        isShared: false,
      }] as Mailbox[];
    }
  }

  async getAllMailboxes(): Promise<Mailbox[]> {
    try {
      const allMailboxes: Mailbox[] = [];
      const accountIds = Object.keys(this.accounts);

      if (accountIds.length === 0) {
        return this.getMailboxes();
      }

      let fetchFailed = false;

      for (const accountId of accountIds) {
        const account = this.accounts[accountId];
        const isPrimary = accountId === this.accountId;

        try {
          const response = await this.request([
            ["Mailbox/get", {
              accountId: accountId,
            }, "0"]
          ]);

          if (response.methodResponses?.[0]?.[0] === "Mailbox/get") {
            const rawMailboxes = (response.methodResponses[0][1].list || []) as JMAPMailbox[];

            debug.log('jmap', `[JMAP Mailbox] getAllMailboxes: account ${accountId} returned ${rawMailboxes.length} mailboxes (isPrimary: ${isPrimary})`);

            // Warn if response might be truncated
            const maxObjects = this.getMaxObjectsInGet();
            if (rawMailboxes.length >= maxObjects) {
              debug.warn('jmap', 
                `[JMAP Mailbox] Account ${accountId}: response contains ${rawMailboxes.length} mailboxes which equals maxObjectsInGet (${maxObjects}). ` +
                `Some mailboxes may be missing.`
              );
            }

            const mailboxes = rawMailboxes.map((mb) => ({
              id: isPrimary ? mb.id : `${accountId}:${mb.id}`,
              originalId: mb.id,
              name: mb.name,
              parentId: mb.parentId ? (isPrimary ? mb.parentId : `${accountId}:${mb.parentId}`) : undefined,
              role: mb.role || undefined,
              sortOrder: mb.sortOrder ?? 0,
              totalEmails: mb.totalEmails ?? 0,
              unreadEmails: mb.unreadEmails ?? 0,
              totalThreads: mb.totalThreads ?? 0,
              unreadThreads: mb.unreadThreads ?? 0,
              myRights: mb.myRights || DEFAULT_MAILBOX_RIGHTS,
              isSubscribed: mb.isSubscribed ?? true,
              accountId,
              accountName: account?.name || (isPrimary ? this.username : accountId),
              isShared: !isPrimary,
            }) as Mailbox);

            allMailboxes.push(...mailboxes);
          }
        } catch (error) {
          fetchFailed = true;
          console.error(`Failed to fetch mailboxes for account ${accountId}:`, error);
        }
      }

      // If every account fetch failed (e.g. a transient maxConcurrentRequests
      // limit during a burst of deletes) we have an empty list that is NOT a
      // real "this account has no mailboxes" result. Throwing lets the caller's
      // catch preserve the existing folder list instead of clobbering it with
      // [] — which would leave the sidebar stuck on "Loading mailboxes...".
      if (allMailboxes.length === 0 && fetchFailed) {
        throw new Error('Failed to fetch mailboxes for all accounts');
      }

      return allMailboxes;
    } catch (error) {
      console.error("Failed to fetch all mailboxes:", error);
      return this.getMailboxes();
    }
  }

  async getEmails(mailboxId?: string, accountId?: string, limit: number = 50, position: number = 0, hasKeyword?: string, pinnedFirst?: boolean): Promise<{ emails: Email[], hasMore: boolean, total: number }> {
    try {
      const targetAccountId = accountId || this.accountId;
      const filter: { inMailbox?: string; hasKeyword?: string } = {};
      if (mailboxId) {
        filter.inMailbox = mailboxId;
      }
      if (hasKeyword) {
        filter.hasKeyword = hasKeyword;
      }
      // Pinned-first uses the hasKeyword sort comparator (RFC 8621 §4.4.2);
      // every page of a view must use the same sort or pagination tears.
      const sort = pinnedFirst
        ? [
            { property: "hasKeyword", keyword: "$pinned", isAscending: false },
            { property: "receivedAt", isAscending: false },
          ]
        : [{ property: "receivedAt", isAscending: false }];

      const response = await this.request([
        ["Email/query", {
          accountId: targetAccountId,
          filter,
          sort,
          limit,
          position,
          calculateTotal: true,
        }, "0"],
        ["Email/get", {
          accountId: targetAccountId,
          "#ids": { resultOf: "0", name: "Email/query", path: "/ids" },
          properties: [...EMAIL_LIST_PROPERTIES],
        }, "1"],
      ]);

      const queryResponse = response.methodResponses?.[0]?.[1];
      const getResponse = response.methodResponses?.[1]?.[1];

      if (response.methodResponses?.[1]?.[0] === "Email/get" && getResponse) {
        const emails = (getResponse.list || []) as Email[];
        // Sort client-side as safety net - some servers may not honour
        // the query sort for large mailboxes without additional filters.
        // Must mirror the query sort, or it would undo the pinned-first order.
        const pinRank = (e: Email) => (pinnedFirst && e.keywords?.['$pinned'] ? 1 : 0);
        emails.sort((a: Email, b: Email) =>
          pinRank(b) - pinRank(a) ||
          new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()
        );
        const total = queryResponse?.total || 0;
        const hasMore = computeHasMore(position, emails.length, total, limit);

        if (accountId && accountId !== this.accountId) {
          namespaceMailboxIds(emails, accountId);
        }

        return { emails, hasMore, total };
      }

      return { emails: [], hasMore: false, total: 0 };
    } catch (error) {
      console.error('Failed to get emails:', error);
      return { emails: [], hasMore: false, total: 0 };
    }
  }

  async getEmailsInMailbox(mailboxId: string): Promise<Email[]> {
    const allEmails: Email[] = [];
    let position = 0;
    const batchSize = 100;

    while (true) {
      const { emails, hasMore } = await this.getEmails(mailboxId, undefined, batchSize, position);
      allEmails.push(...emails);
      if (!hasMore || emails.length === 0) break;
      position += emails.length;
    }

    return allEmails;
  }

  async getTagCounts(tagIds: string[]): Promise<Record<string, { total: number; unread: number }>> {
    if (tagIds.length === 0) return {};
    try {
      const methodCalls: JMAPMethodCall[] = [];
      for (let i = 0; i < tagIds.length; i++) {
        const keyword = `$label:${tagIds[i]}`;
        // Total count for this tag
        methodCalls.push(["Email/query", {
          accountId: this.accountId,
          filter: { hasKeyword: keyword },
          limit: 0,
          calculateTotal: true,
        }, `total_${i}`]);
        // Unread count for this tag
        methodCalls.push(["Email/query", {
          accountId: this.accountId,
          filter: {
            operator: "AND",
            conditions: [
              { hasKeyword: keyword },
              { notKeyword: "$seen" },
            ],
          },
          limit: 0,
          calculateTotal: true,
        }, `unread_${i}`]);
      }

      const response = await this.request(methodCalls);
      const result: Record<string, { total: number; unread: number }> = {};

      for (let i = 0; i < tagIds.length; i++) {
        const totalResp = response.methodResponses?.[i * 2]?.[1];
        const unreadResp = response.methodResponses?.[i * 2 + 1]?.[1];
        result[tagIds[i]] = {
          total: totalResp?.total ?? 0,
          unread: unreadResp?.total ?? 0,
        };
      }

      return result;
    } catch (error) {
      console.error('Failed to get tag counts:', error);
      return {};
    }
  }

  async getEmail(emailId: string, accountId?: string): Promise<Email | null> {
    try {
      const targetAccountId = accountId || this.accountId;

      const response = await this.request([
        ["Email/get", {
          accountId: targetAccountId,
          ids: [emailId],
          properties: [
            "id", "threadId", "mailboxIds", "keywords", "size",
            "receivedAt", "sentAt", "from", "to", "cc", "bcc", "replyTo",
            "subject", "preview", "textBody", "htmlBody", "bodyValues",
            "hasAttachment", "attachments", "messageId", "inReplyTo",
            "references", "headers", "bodyStructure", "blobId",
          ],
          fetchTextBodyValues: true,
          fetchHTMLBodyValues: true,
          fetchAllBodyValues: true,
          maxBodyValueBytes: 256000,
        }, "0"],
      ]);

      if (response.methodResponses?.[0]?.[0] !== "Email/get") {
        return null;
      }

      const email = (response.methodResponses[0][1].list || [])[0];
      if (!email) return null;

      if (accountId && accountId !== this.accountId) {
        namespaceMailboxIds([email], accountId);
      }

      if (email.headers) {
        await this.parseEmailHeaders(email);
      }

      return email;
    } catch (error) {
      console.error('Failed to get email:', error);
      return null;
    }
  }

  private async parseEmailHeaders(email: Email): Promise<void> {
    const { parseAuthenticationResults, parseSpamScore, parseSpamLLM } = await import('@/lib/email-headers');

    let headersRecord: Record<string, string | string[]>;
    if (Array.isArray(email.headers)) {
      headersRecord = {};
      for (const header of email.headers as unknown as JMAPEmailHeader[]) {
        if (!header?.name || !header?.value) continue;
        const existing = headersRecord[header.name];
        if (existing) {
          headersRecord[header.name] = Array.isArray(existing)
            ? [...existing, header.value]
            : [existing, header.value];
        } else {
          headersRecord[header.name] = header.value;
        }
      }
      email.headers = headersRecord;
    } else {
      headersRecord = email.headers as Record<string, string | string[]>;
    }

    const authResultsHeader = headersRecord['Authentication-Results'];
    if (authResultsHeader) {
      // Multiple Authentication-Results headers (or multiple SPF identities in
      // one header) must all be considered so the most severe result wins.
      const value = Array.isArray(authResultsHeader) ? authResultsHeader.join('; ') : authResultsHeader;
      email.authenticationResults = parseAuthenticationResults(value);
    }

    for (const headerName of ['X-Spam-Score', 'X-Spam-Status', 'X-Spam-Result', 'X-Rspamd-Score']) {
      if (!headersRecord[headerName]) continue;
      const value = Array.isArray(headersRecord[headerName]) ? headersRecord[headerName][0] : headersRecord[headerName];
      const spamResult = parseSpamScore((value as string).trim());
      if (spamResult) {
        email.spamScore = spamResult.score;
        email.spamStatus = spamResult.status;
        break;
      }
    }

    const llmHeader = headersRecord['X-Spam-LLM'];
    if (llmHeader) {
      const value = Array.isArray(llmHeader) ? llmHeader[0] : llmHeader;
      const llmResult = parseSpamLLM(value as string);
      if (llmResult) {
        email.spamLLM = llmResult;
      }
    }
  }

  async markAsRead(emailId: string, read: boolean = true, accountId?: string): Promise<void> {
    const targetAccountId = accountId || this.accountId;

    await this.request([
      ["Email/set", {
        accountId: targetAccountId,
        update: {
          [emailId]: {
            "keywords/$seen": read,
          },
        },
      }, "0"],
    ]);
  }

  async batchMarkAsRead(emailIds: string[], read: boolean = true, accountId?: string): Promise<void> {
    if (emailIds.length === 0) return;

    const updates = Object.fromEntries(emailIds.map(id => [id, { "keywords/$seen": read }]));
    await this.request([
      ["Email/set", { accountId: accountId || this.accountId, update: updates }, "0"],
    ]);
  }

  async toggleStar(emailId: string, starred: boolean, accountId?: string): Promise<void> {
    await this.request([
      ["Email/set", {
        accountId: accountId || this.accountId,
        update: {
          [emailId]: {
            "keywords/$flagged": starred,
          },
        },
      }, "0"],
    ]);
  }

  async updateEmailKeywords(emailId: string, keywords: Record<string, boolean>, accountId?: string): Promise<void> {
    await this.request([
      ["Email/set", {
        accountId: accountId || this.accountId,
        update: {
          [emailId]: {
            keywords,
          },
        },
      }, "0"],
    ]);
  }

  async setKeyword(emailId: string, keyword: string, accountId?: string): Promise<void> {
    await this.request([
      ["Email/set", {
        accountId: accountId || this.accountId,
        update: {
          [emailId]: {
            [`keywords/${keyword}`]: true,
          },
        },
      }, "0"],
    ]);
  }

  async migrateKeyword(oldKeyword: string, newKeyword: string): Promise<number> {
    // Query all email IDs that have the old keyword
    const allIds: string[] = [];
    let position = 0;
    const batchSize = 100;

    while (true) {
      const response = await this.request([
        ["Email/query", {
          accountId: this.accountId,
          filter: { hasKeyword: oldKeyword },
          limit: batchSize,
          position,
        }, "0"],
      ]);

      const queryResult = response.methodResponses?.[0]?.[1];
      const ids: string[] = queryResult?.ids || [];
      allIds.push(...ids);

      if (ids.length < batchSize) break;
      position += ids.length;
    }

    if (allIds.length === 0) return 0;

    // Batch update: remove old keyword, add new keyword using per-property patches
    const updateBatchSize = 50;
    for (let i = 0; i < allIds.length; i += updateBatchSize) {
      const batch = allIds.slice(i, i + updateBatchSize);
      const update: Record<string, Record<string, boolean | null>> = {};
      for (const id of batch) {
        update[id] = {
          [`keywords/${oldKeyword}`]: null,
          [`keywords/${newKeyword}`]: true,
        };
      }

      await this.request([
        ["Email/set", {
          accountId: this.accountId,
          update,
        }, "0"],
      ]);
    }

    return allIds.length;
  }

  async deleteEmail(emailId: string, accountId?: string): Promise<void> {
    await this.request([
      ["Email/set", {
        accountId: accountId || this.accountId,
        destroy: [emailId],
      }, "0"],
    ]);
  }

  async moveToTrash(emailId: string, trashMailboxId: string, accountId?: string, markAsRead?: boolean): Promise<void> {
    const targetAccountId = accountId || this.accountId;
    const patch: Record<string, unknown> = { mailboxIds: { [trashMailboxId]: true } };
    if (markAsRead) patch["keywords/$seen"] = true;
    await this.request([
      ["Email/set", {
        accountId: targetAccountId,
        update: { [emailId]: patch },
      }, "0"],
    ]);
  }

  async batchDeleteEmails(emailIds: string[], accountId?: string): Promise<void> {
    if (emailIds.length === 0) return;

    await this.request([
      ["Email/set", {
        accountId: accountId || this.accountId,
        destroy: emailIds,
      }, "0"],
    ]);
  }

  async batchMoveEmails(emailIds: string[], toMailboxId: string, accountId?: string, markAsRead?: boolean): Promise<void> {
    if (emailIds.length === 0) return;

    const buildPatch = () => {
      const patch: Record<string, unknown> = { mailboxIds: { [toMailboxId]: true } };
      if (markAsRead) patch["keywords/$seen"] = true;
      return patch;
    };
    const updates = Object.fromEntries(emailIds.map(id => [id, buildPatch()]));
    await this.request([
      ["Email/set", { accountId: accountId || this.accountId, update: updates }, "0"],
    ]);
  }

  async batchArchiveEmails(
    emails: Array<{ id: string; receivedAt: string }>,
    archiveMailboxId: string,
    mode: 'single' | 'year' | 'month',
    existingMailboxes: Mailbox[],
    accountId?: string,
  ): Promise<void> {
    if (emails.length === 0) return;
    const targetAccountId = accountId || this.accountId;

    if (mode === 'single') {
      await this.batchMoveEmails(emails.map(e => e.id), archiveMailboxId, targetAccountId);
      return;
    }

    type Dest = { year: string; month?: string };
    const destFor = new Map<string, Dest>();
    for (const e of emails) {
      const d = new Date(e.receivedAt);
      const year = d.getFullYear().toString();
      const month = (d.getMonth() + 1).toString().padStart(2, '0');
      destFor.set(e.id, mode === 'year' ? { year } : { year, month });
    }

    // Resolve each destination folder to either an existing id or a creation-id reference ("#<cid>").
    const yearIdFor = new Map<string, string>();
    const monthIdFor = new Map<string, string>();
    const createEntries: Record<string, Record<string, unknown>> = {};

    const findExisting = (name: string, parentId: string) =>
      existingMailboxes.find(m =>
        m.accountId === targetAccountId &&
        m.name === name &&
        (m.parentId === parentId || m.parentId === (parentId.startsWith('#') ? undefined : parentId)),
      );

    for (const dest of destFor.values()) {
      if (!yearIdFor.has(dest.year)) {
        const existing = findExisting(dest.year, archiveMailboxId);
        if (existing) {
          yearIdFor.set(dest.year, existing.originalId || existing.id);
        } else {
          const cid = `year-${dest.year}`;
          createEntries[cid] = { name: dest.year, parentId: archiveMailboxId };
          yearIdFor.set(dest.year, `#${cid}`);
        }
      }

      if (mode === 'month' && dest.month) {
        const monthKey = `${dest.year}/${dest.month}`;
        if (!monthIdFor.has(monthKey)) {
          const yearRef = yearIdFor.get(dest.year)!;
          // Only look up existing month folders under real (non-creation-ref) year ids.
          const existingMonth = yearRef.startsWith('#')
            ? undefined
            : findExisting(dest.month, yearRef);
          if (existingMonth) {
            monthIdFor.set(monthKey, existingMonth.originalId || existingMonth.id);
          } else {
            const cid = `month-${dest.year}-${dest.month}`;
            createEntries[cid] = { name: dest.month, parentId: yearRef };
            monthIdFor.set(monthKey, `#${cid}`);
          }
        }
      }
    }

    const updates: Record<string, { mailboxIds: Record<string, true> }> = {};
    for (const [emailId, dest] of destFor.entries()) {
      const destId = mode === 'month' && dest.month
        ? monthIdFor.get(`${dest.year}/${dest.month}`)!
        : yearIdFor.get(dest.year)!;
      updates[emailId] = { mailboxIds: { [destId]: true } };
    }

    const methodCalls: JMAPMethodCall[] = [];
    const hasCreates = Object.keys(createEntries).length > 0;
    if (hasCreates) {
      methodCalls.push(['Mailbox/set', { accountId: targetAccountId, create: createEntries }, '0']);
    }
    methodCalls.push(['Email/set', { accountId: targetAccountId, update: updates }, String(methodCalls.length)]);

    const response = await this.request(methodCalls);

    if (hasCreates) {
      const mailboxResult = response.methodResponses?.[0]?.[1];
      const notCreated = mailboxResult?.notCreated as Record<string, { type?: string; properties?: string[]; description?: string }> | undefined;
      const failures = notCreated ? Object.entries(notCreated) : [];
      if (failures.length > 0) {
        const [cid, err] = failures[0];
        const parts = [err.type || 'unknown'];
        if (err.properties?.length) parts.push(`properties=[${err.properties.join(', ')}]`);
        if (err.description) parts.push(err.description);
        throw new Error(`Failed to create archive folder '${cid}': ${parts.join(' – ')}`);
      }
    }

    const emailIdx = hasCreates ? 1 : 0;
    const emailResult = response.methodResponses?.[emailIdx]?.[1];
    const notUpdated = emailResult?.notUpdated as Record<string, { type?: string; description?: string }> | undefined;
    const emailFailures = notUpdated ? Object.entries(notUpdated) : [];
    if (emailFailures.length > 0) {
      const [id, err] = emailFailures[0];
      throw new Error(`Failed to move ${emailFailures.length} email(s), first: ${id} – ${err.type || 'unknown'}${err.description ? ` (${err.description})` : ''}`);
    }
  }

  async moveEmail(emailId: string, toMailboxId: string, accountId?: string): Promise<void> {
    const targetAccountId = accountId || this.accountId;
    const response = await this.request([
      ["Email/set", {
        accountId: targetAccountId,
        update: {
          [emailId]: {
            mailboxIds: { [toMailboxId]: true },
          },
        },
      }, "0"],
    ]);

    const result = response.methodResponses?.[0]?.[1];
    if (result?.notUpdated?.[emailId]) {
      throw new Error(`Failed to move email: ${result.notUpdated[emailId].type || 'unknown error'}`);
    }
  }

  async emptyMailbox(mailboxId: string, accountId?: string): Promise<number> {
    const targetAccountId = accountId || this.accountId;
    let totalDestroyed = 0;
    let hasMore = true;

    while (hasMore) {
      const response = await this.request([
        ["Email/query", {
          accountId: targetAccountId,
          filter: { inMailbox: mailboxId },
          limit: 500,
        }, "0"],
        ["Email/set", {
          accountId: targetAccountId,
          "#destroy": { resultOf: "0", name: "Email/query", path: "/ids" },
        }, "1"],
      ]);

      const queryResult = response.methodResponses?.[0]?.[1];
      const setResult = response.methodResponses?.[1]?.[1];
      const destroyed = setResult?.destroyed?.length || 0;
      totalDestroyed += destroyed;

      hasMore = destroyed > 0 && (queryResult?.total || 0) > destroyed;
    }

    return totalDestroyed;
  }

  async markMailboxAsRead(mailboxId: string, accountId?: string): Promise<number> {
    const targetAccountId = accountId || this.accountId;
    let totalMarked = 0;
    let hasMore = true;

    while (hasMore) {
      const queryResponse = await this.request([
        ["Email/query", {
          accountId: targetAccountId,
          filter: {
            operator: "AND",
            conditions: [
              { inMailbox: mailboxId },
              { notKeyword: "$seen" },
            ],
          },
          limit: 500,
        }, "0"],
      ]);

      const ids: string[] = queryResponse.methodResponses?.[0]?.[1]?.ids || [];
      if (ids.length === 0) break;

      const updates = Object.fromEntries(
        ids.map((id) => [id, { "keywords/$seen": true }])
      );

      await this.request([
        ["Email/set", { accountId: targetAccountId, update: updates }, "0"],
      ]);

      totalMarked += ids.length;
      hasMore = ids.length === 500;
    }

    return totalMarked;
  }

  async markAllAsRead(excludeMailboxIds: string[] = [], accountId?: string): Promise<number> {
    const targetAccountId = accountId || this.accountId;
    const excludeSet = new Set(excludeMailboxIds);
    let totalMarked = 0;
    let hasMore = true;
    let position = 0;

    while (hasMore) {
      const response = await this.request([
        ["Email/query", {
          accountId: targetAccountId,
          filter: { notKeyword: "$seen" },
          limit: 500,
          position,
        }, "0"],
        ["Email/get", {
          accountId: targetAccountId,
          "#ids": { resultOf: "0", name: "Email/query", path: "/ids" },
          properties: ["id", "mailboxIds"],
        }, "1"],
      ]);

      const queryResult = response.methodResponses?.[0]?.[1];
      const getResult = response.methodResponses?.[1]?.[1];
      const ids: string[] = queryResult?.ids || [];
      const emails: Array<{ id: string; mailboxIds?: Record<string, boolean> }> = getResult?.list || [];

      if (ids.length === 0) break;

      const targetIds = excludeSet.size === 0
        ? ids
        : emails
            .filter(e => {
              const mbIds = e.mailboxIds ? Object.keys(e.mailboxIds) : [];
              return mbIds.some(id => !excludeSet.has(id));
            })
            .map(e => e.id);

      if (targetIds.length > 0) {
        const updates = Object.fromEntries(
          targetIds.map((id) => [id, { "keywords/$seen": true }])
        );
        await this.request([
          ["Email/set", { accountId: targetAccountId, update: updates }, "0"],
        ]);
        totalMarked += targetIds.length;
      }

      hasMore = ids.length === 500;
      position += ids.length;
    }

    return totalMarked;
  }

  async markAsSpam(emailId: string, accountId?: string, markAsRead?: boolean): Promise<void> {
    const targetAccountId = accountId || this.accountId;

    const mailboxes = await this.getMailboxes(accountId);
    const junkMailbox = mailboxes.find(m => {
      if (accountId) {
        return m.role === 'junk' && m.accountId === accountId;
      }
      return m.role === 'junk' && !m.isShared;
    });

    if (!junkMailbox) {
      throw new Error('Junk mailbox not found');
    }

    const mailboxId = accountId && junkMailbox.originalId
      ? junkMailbox.originalId
      : junkMailbox.id;

    const patch: Record<string, unknown> = { mailboxIds: { [mailboxId]: true } };
    if (markAsRead) patch["keywords/$seen"] = true;

    await this.request([
      ["Email/set", {
        accountId: targetAccountId,
        update: { [emailId]: patch },
      }, "0"],
    ]);
  }

  async undoSpam(emailId: string, originalMailboxId: string, accountId?: string): Promise<void> {
    const targetAccountId = accountId || this.accountId;

    await this.request([
      ["Email/set", {
        accountId: targetAccountId,
        update: {
          [emailId]: {
            mailboxIds: { [originalMailboxId]: true },
          },
        },
      }, "0"],
    ]);
  }

  async createMailbox(name: string, parentId?: string, accountId?: string): Promise<Mailbox> {
    const createId = `new-${Date.now()}`;
    const createData: Record<string, unknown> = { name };
    if (parentId) {
      createData.parentId = parentId;
    }

    const response = await this.request([
      ["Mailbox/set", {
        accountId: accountId || this.accountId,
        create: { [createId]: createData },
      }, "0"],
    ]);

    const result = response.methodResponses?.[0]?.[1];
    if (result?.notCreated?.[createId]) {
      const err = result.notCreated[createId];
      const details = [err.type || 'unknown error'];
      if (Array.isArray(err.properties) && err.properties.length > 0) {
        details.push(`properties=[${err.properties.join(', ')}]`);
      }
      if (err.description) details.push(err.description);
      throw new Error(`Failed to create mailbox: ${details.join(' – ')}`);
    }

    const created = result?.created?.[createId];
    if (!created?.id) {
      throw new Error('Failed to create mailbox: no ID returned');
    }

    return {
      id: created.id,
      name,
      parentId,
      sortOrder: 0,
      totalEmails: 0,
      unreadEmails: 0,
      totalThreads: 0,
      unreadThreads: 0,
      myRights: DEFAULT_MAILBOX_RIGHTS,
      isSubscribed: true,
      accountId: this.accountId,
      accountName: this.accounts[this.accountId]?.name || this.username,
      isShared: false,
    };
  }

  async updateMailbox(mailboxId: string, changes: { name?: string; parentId?: string | null; role?: string | null; sortOrder?: number }): Promise<void> {
    const response = await this.request([
      ["Mailbox/set", {
        accountId: this.accountId,
        update: { [mailboxId]: changes },
      }, "0"],
    ]);

    const result = response.methodResponses?.[0]?.[1];
    if (result?.notUpdated?.[mailboxId]) {
      throw new Error(`Failed to update mailbox: ${result.notUpdated[mailboxId].type || 'unknown error'}`);
    }
  }

  async deleteMailbox(mailboxId: string): Promise<void> {
    const response = await this.request([
      ["Mailbox/set", {
        accountId: this.accountId,
        destroy: [mailboxId],
      }, "0"],
    ]);

    const result = response.methodResponses?.[0]?.[1];
    if (result?.notDestroyed?.[mailboxId]) {
      const err = result.notDestroyed[mailboxId];
      const error = new Error(err.description || `Failed to delete mailbox: ${err.type || 'unknown error'}`);
      (error as Error & { jmapType?: string }).jmapType = err.type;
      throw error;
    }
  }

  async searchEmails(query: string, mailboxId?: string, accountId?: string, limit: number = 50, position: number = 0): Promise<{ emails: Email[], hasMore: boolean, total: number }> {
    try {
      const targetAccountId = accountId || this.accountId;

      // Use the JMAP "text" filter which searches across from, to, cc, bcc,
      // subject, and body. Stalwart's FTS engine supports wildcard prefix
      // matching (e.g. "pri*" matches "prime", "primary", "private", etc.)
      const wildcardQuery = toWildcardQuery(query);
      const textFilter: Record<string, unknown> = { text: wildcardQuery };

      let filter: Record<string, unknown>;
      if (mailboxId) {
        filter = {
          operator: "AND",
          conditions: [
            { inMailbox: mailboxId },
            textFilter,
          ],
        };
      } else {
        filter = textFilter;
      }

      const response = await this.request([
        ["Email/query", {
          accountId: targetAccountId,
          filter,
          sort: [{ property: "receivedAt", isAscending: false }],
          limit,
          position,
          calculateTotal: true,
        }, "0"],
        ["Email/get", {
          accountId: targetAccountId,
          "#ids": { resultOf: "0", name: "Email/query", path: "/ids" },
          properties: [...EMAIL_LIST_PROPERTIES],
        }, "1"],
      ]);

      const queryResponse = response.methodResponses?.[0]?.[1];
      const emails = (response.methodResponses?.[1]?.[1]?.list || []) as Email[];
      emails.sort((a: Email, b: Email) =>
        new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()
      );
      const total = queryResponse?.total || 0;
      const hasMore = computeHasMore(position, emails.length, total, limit);

      return { emails, hasMore, total };
    } catch (error) {
      console.error('Search failed:', error);
      return { emails: [], hasMore: false, total: 0 };
    }
  }

  async advancedSearchEmails(
    filter: Record<string, unknown>,
    accountId?: string,
    limit: number = 50,
    position: number = 0
  ): Promise<{ emails: Email[], hasMore: boolean, total: number }> {
    try {
      const targetAccountId = accountId || this.accountId;

      const response = await this.request([
        ["Email/query", {
          accountId: targetAccountId,
          filter,
          sort: [{ property: "receivedAt", isAscending: false }],
          limit,
          position,
          calculateTotal: true,
        }, "0"],
        ["Email/get", {
          accountId: targetAccountId,
          "#ids": { resultOf: "0", name: "Email/query", path: "/ids" },
          properties: [...EMAIL_LIST_PROPERTIES],
        }, "1"],
      ]);

      const queryResponse = response.methodResponses?.[0]?.[1];
      const emails = (response.methodResponses?.[1]?.[1]?.list || []) as Email[];
      emails.sort((a: Email, b: Email) =>
        new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()
      );
      const total = queryResponse?.total || 0;
      const hasMore = computeHasMore(position, emails.length, total, limit);

      return { emails, hasMore, total };
    } catch (error) {
      console.error('Advanced search failed:', error);
      throw error;
    }
  }

  async searchSentRecipients(query: string, sentMailboxId: string, accountId?: string, limit: number = 60): Promise<Array<{ name: string; email: string }>> {
    const q = query.trim();
    if (!q || !sentMailboxId) return [];
    try {
      const targetAccountId = accountId || this.accountId;
      const response = await this.request([
        ["Email/query", {
          accountId: targetAccountId,
          filter: {
            operator: "AND",
            conditions: [
              { inMailbox: sentMailboxId },
              { operator: "OR", conditions: [{ to: q }, { cc: q }] },
            ],
          },
          sort: [{ property: "receivedAt", isAscending: false }],
          limit,
        }, "0"],
        // Fetch ONLY the recipient fields - no subject/preview/body/attachments.
        ["Email/get", {
          accountId: targetAccountId,
          "#ids": { resultOf: "0", name: "Email/query", path: "/ids" },
          properties: ["to", "cc"],
        }, "1"],
      ]);
      const emails = (response.methodResponses?.[1]?.[1]?.list || []) as Email[];
      const lower = q.toLowerCase();
      const byEmail = new Map<string, { name: string; email: string }>();
      for (const email of emails) {
        for (const r of [...(email.to || []), ...(email.cc || [])]) {
          if (!r.email) continue;
          const key = r.email.toLowerCase().trim();
          if (!key || byEmail.has(key)) continue;
          // The query matched *some* recipient of the message; keep only the
          // addresses that actually match, not every co-recipient.
          if (key.includes(lower) || (r.name && r.name.toLowerCase().includes(lower))) {
            byEmail.set(key, { name: (r.name || "").trim(), email: r.email });
          }
        }
      }
      return Array.from(byEmail.values());
    } catch (error) {
      console.error('Recipient search failed:', error);
      return [];
    }
  }

  async getThread(threadId: string, accountId?: string): Promise<Thread | null> {
    try {
      const targetAccountId = accountId || this.accountId;

      const response = await this.request([
        ["Thread/get", {
          accountId: targetAccountId,
          ids: [threadId],
        }, "0"],
      ]);

      if (response.methodResponses?.[0]?.[0] === "Thread/get") {
        const threads = response.methodResponses[0][1].list || [];
        return threads[0] || null;
      }

      return null;
    } catch (error) {
      console.error('Failed to get thread:', error);
      return null;
    }
  }

  async getThreads(threadIds: string[], accountId?: string): Promise<Thread[]> {
    if (threadIds.length === 0) return [];
    try {
      const targetAccountId = accountId || this.accountId;
      const response = await this.request([
        ["Thread/get", { accountId: targetAccountId, ids: threadIds }, "0"],
      ]);

      if (response.methodResponses?.[0]?.[0] === "Thread/get") {
        return (response.methodResponses[0][1].list || []) as Thread[];
      }
      return [];
    } catch (error) {
      console.error('Failed to get threads:', error);
      return [];
    }
  }

  async getThreadEmails(threadId: string, accountId?: string): Promise<Email[]> {
    try {
      const targetAccountId = accountId || this.accountId;
      const thread = await this.getThread(threadId, accountId);
      if (!thread?.emailIds?.length) {
        return [];
      }

      const response = await this.request([
        ["Email/get", {
          accountId: targetAccountId,
          ids: thread.emailIds,
          properties: [
            ...EMAIL_LIST_PROPERTIES,
            "textBody", "htmlBody", "bodyValues",
            "attachments", "blobId", "sentAt", "bcc", "replyTo",
            "messageId", "inReplyTo", "references", "headers", "bodyStructure",
          ],
          fetchTextBodyValues: true,
          fetchHTMLBodyValues: true,
          fetchAllBodyValues: true,
          maxBodyValueBytes: 256000,
        }, "0"],
      ]);

      if (response.methodResponses?.[0]?.[0] === "Email/get") {
        const emails = response.methodResponses[0][1].list || [];

        if (accountId && accountId !== this.accountId) {
          namespaceMailboxIds(emails, accountId);
        }

        return emails.sort((a: Email, b: Email) =>
          new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()
        );
      }

      return [];
    } catch (error) {
      console.error('Failed to get thread emails:', error);
      return [];
    }
  }

  async getIdentities(): Promise<Identity[]> {
    try {
      const response = await this.request([
        ["Identity/get", {
          accountId: this.accountId,
        }, "0"]
      ]);

      if (response.methodResponses?.[0]?.[0] === "Identity/get") {
        const list = (response.methodResponses[0][1].list || []) as Identity[];
        return list.map((id) => ({ ...id, name: sanitizeIdentityDisplayName(id.name) }));
      }

      return [];
    } catch (error) {
      console.error('Failed to get identities:', error);
      return [];
    }
  }

  async createIdentity(
    name: string,
    email: string,
    replyTo?: EmailAddress[] | null,
    bcc?: EmailAddress[] | null,
    textSignature?: string | null,
    htmlSignature?: string | null
  ): Promise<Identity> {
    const response = await this.request([
      ["Identity/set", {
        accountId: this.accountId,
        create: {
          "new-identity": {
            name,
            email,
            replyTo,
            bcc,
            textSignature,
            htmlSignature,
          }
        }
      }, "0"]
    ]);

    if (response.methodResponses?.[0]?.[0] === "Identity/set") {
      const result = response.methodResponses[0][1];

      if (result.notCreated?.["new-identity"]) {
        const error = result.notCreated["new-identity"];
        if (error.type === "forbidden") {
          throw new Error("You are not authorized to send from this email address");
        }
        throw new Error(error.description || "Failed to create identity");
      }

      const createdId = result.created?.["new-identity"]?.id;
      if (createdId) {
        const identities = await this.getIdentities();
        const identity = identities.find(i => i.id === createdId);
        if (identity) return identity;
      }
    }

    throw new Error("Failed to create identity: Server response was unexpected. Check server logs.");
  }

  async updateIdentity(
    identityId: string,
    updates: {
      name?: string | null;
      replyTo?: EmailAddress[] | null;
      bcc?: EmailAddress[] | null;
      textSignature?: string | null;
      htmlSignature?: string | null;
    }
  ): Promise<void> {
    const response = await this.request([
      ["Identity/set", {
        accountId: this.accountId,
        update: {
          [identityId]: updates
        }
      }, "0"]
    ]);

    if (response.methodResponses?.[0]?.[0] === "Identity/set") {
      const result = response.methodResponses[0][1];

      if (result.notUpdated?.[identityId]) {
        const error = result.notUpdated[identityId];
        if (error.type === "notFound") {
          throw new Error("Identity not found (may have been deleted)");
        }
        if (error.type === "forbidden") {
          throw new Error("You are not authorized to modify this identity");
        }
        throw new Error(error.description || "Failed to update identity");
      }
      return;
    }

    throw new Error("Failed to update identity: Server response was unexpected. Check server logs.");
  }

  async deleteIdentity(identityId: string): Promise<void> {
    const response = await this.request([
      ["Identity/set", {
        accountId: this.accountId,
        destroy: [identityId]
      }, "0"]
    ]);

    if (response.methodResponses?.[0]?.[0] === "Identity/set") {
      const result = response.methodResponses[0][1];

      if (result.notDestroyed?.[identityId]) {
        const error = result.notDestroyed[identityId];
        if (error.type === "forbidden") {
          throw new Error("This identity cannot be deleted");
        }
        if (error.type === "notFound") {
          throw new Error("Identity not found (may already be deleted)");
        }
        throw new Error(error.description || "Failed to delete identity");
      }
      return;
    }

    throw new Error("Failed to delete identity: Server response was unexpected. Check server logs.");
  }

  private vacationUsing(): string[] {
    return ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:vacationresponse"];
  }

  async getVacationResponse(accountId?: string): Promise<VacationResponse> {
    const response = await this.request([
      ["VacationResponse/get", {
        accountId: accountId || this.accountId,
        ids: ["singleton"],
      }, "0"]
    ], this.vacationUsing());

    if (response.methodResponses?.[0]?.[0] === "VacationResponse/get") {
      const list = response.methodResponses[0][1].list || [];
      if (list.length > 0) {
        return list[0] as VacationResponse;
      }
      return {
        id: "singleton",
        isEnabled: false,
        fromDate: null,
        toDate: null,
        subject: "",
        textBody: "",
        htmlBody: null,
      };
    }

    throw new Error("Failed to fetch vacation response: unexpected server response");
  }

  async setVacationResponse(updates: Partial<VacationResponse>, accountId?: string): Promise<void> {
    const response = await this.request([
      ["VacationResponse/set", {
        accountId: accountId || this.accountId,
        update: {
          "singleton": updates,
        },
      }, "0"]
    ], this.vacationUsing());

    if (response.methodResponses?.[0]?.[0] === "VacationResponse/set") {
      const result = response.methodResponses[0][1];

      if (result.notUpdated?.["singleton"]) {
        const error = result.notUpdated["singleton"];
        throw new Error(error.description || "Failed to update vacation response");
      }
      return;
    }

    throw new Error("Failed to update vacation response");
  }

  async createDraft(
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
    htmlBody?: string
  ): Promise<string> {
    const mailboxes = await this.getMailboxes();
    const draftsMailbox = mailboxes.find(mb => mb.role === 'drafts');
    if (!draftsMailbox) {
      throw new Error('No drafts mailbox found');
    }

    const emailId = `draft-${Date.now()}`;

    interface EmailDraft {
      from: { name?: string; email: string }[];
      to: { email: string }[];
      cc?: { email: string }[];
      bcc?: { email: string }[];
      subject: string;
      keywords: Record<string, boolean>;
      mailboxIds: Record<string, boolean>;
      bodyValues: Record<string, { value: string }>;
      textBody: { partId: string; type?: string }[];
      htmlBody?: { partId: string; type: string }[];
      attachments?: { blobId: string; type: string; name: string; disposition: string; cid?: string }[];
    }

    const sanitizedFromName = sanitizeIdentityDisplayName(fromName);
    const emailData: EmailDraft = {
      from: [{ ...(sanitizedFromName ? { name: sanitizedFromName } : {}), email: fromEmail || this.username }],
      to: to.map(email => ({ email })),
      cc: cc?.length ? cc.map(email => ({ email })) : undefined,
      bcc: bcc?.length ? bcc.map(email => ({ email })) : undefined,
      subject,
      keywords: { "$seen": true, "$draft": true },
      mailboxIds: { [draftsMailbox.id]: true },
      bodyValues: htmlBody
        ? { "text": { value: body }, "html": { value: htmlBody } }
        : { "1": { value: body } },
      textBody: htmlBody
        ? [{ partId: "text", type: "text/plain" }]
        : [{ partId: "1" }],
      ...(htmlBody ? { htmlBody: [{ partId: "html", type: "text/html" }] } : {}),
    };

    if (attachments?.length) {
      emailData.attachments = attachments.map(att => ({
        blobId: att.blobId,
        type: att.type,
        name: att.name,
        disposition: att.disposition ?? "attachment",
        ...(att.cid ? { cid: att.cid } : {}),
      }));
    }

    // Use a single Email/set call with both destroy and create for atomicity
    const setArgs: Record<string, unknown> = {
      accountId: this.accountId,
      create: { [emailId]: emailData },
    };
    if (draftId) {
      setArgs.destroy = [draftId];
    }

    const methodCalls: JMAPMethodCall[] = [
      ["Email/set", setArgs, "0"],
    ];

    const response = await this.request(methodCalls);

    if (response.methodResponses?.[0]?.[0] === "Email/set") {
      const result = response.methodResponses[0][1];

      if (result.notCreated) {
        const errors = result.notCreated;
        const firstError = Object.values(errors)[0] as { description?: string; type?: string };
        console.error('Draft save error:', firstError);
        throw new Error(firstError?.description || firstError?.type || 'Failed to save draft');
      }

      if (draftId && result.notDestroyed) {
        console.warn('Failed to destroy old draft:', result.notDestroyed);
      }

      if (result.created?.[emailId]) {
        return result.created[emailId].id;
      }
    }

    console.error('Unexpected draft save response:', response);
    throw new Error('Failed to save draft');
  }

  async sendEmail(
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
    inReplyTo?: string[],
    references?: string[],
    delayedUntil?: string,
    envelopeMailFrom?: string,
    options?: { requestReadReceipt?: boolean }
  ): Promise<SendEmailResult> {
    const holdForSeconds = delayedUntil ? this.validateDelayedUntil(delayedUntil) : undefined;
    const emailId = `send-${Date.now()}`;
    const targetAccountId = (fromEmail && Object.keys(this.accounts).find(id =>
      this.accounts[id]?.name?.toLowerCase() === fromEmail.toLowerCase()
    )) || this.accountId;
    const mboxResp = await this.request([
      ["Mailbox/get", { accountId: targetAccountId }, "0"]
    ]);
    const mailboxes = (mboxResp.methodResponses?.[0]?.[1]?.list || []) as Mailbox[];
    const sentMailbox = mailboxes.find(mb => mb.role === 'sent');
    if (!sentMailbox) {
      throw new Error('No sent mailbox found');
    }
    const draftsMailbox = mailboxes.find(mb => mb.role === 'drafts');
    if (!draftsMailbox) {
      throw new Error('No drafts mailbox found');
    }

    let finalIdentityId = identityId;
    let identityReplyTo: EmailAddress[] | undefined;
    {
      const identityResponse = await this.request([
        ["Identity/get", { accountId: targetAccountId }, "0"]
      ]);

      if (!finalIdentityId) {
        finalIdentityId = targetAccountId;
      }
      if (identityResponse.methodResponses?.[0]?.[0] === "Identity/get") {
        const identities = (identityResponse.methodResponses[0][1].list || []) as Identity[];
        if (identities.length > 0) {
          let matchingIdentity = identityId
            ? identities.find((id) => id.id === identityId)
            : undefined;
          if (!matchingIdentity) {
            const target = fromEmail || this.username;
            matchingIdentity = identities.find((id) => id.email === target)
              || (!target.includes('@') ? identities.find((id) => id.email.split('@')[0] === target) : undefined);
          }
          finalIdentityId = matchingIdentity?.id || identities[0].id;
          identityReplyTo = matchingIdentity?.replyTo || identities[0].replyTo;
        }
      }
    }

    // Per RFC 8621 §4.1.2.3 inReplyTo/references are arrays of bare msg-ids
    // (no angle brackets). Stalwart may return them either way, so normalize.
    const normalizedInReplyTo = inReplyTo?.map(stripMessageIdBrackets).filter(Boolean);
    const normalizedReferences = references?.map(stripMessageIdBrackets).filter(Boolean);

    const sanitizedFromName = sanitizeIdentityDisplayName(fromName);
    // Always create a new email with the final body content
    const emailCreate: Record<string, unknown> = {
      from: [{ ...(sanitizedFromName ? { name: sanitizedFromName } : {}), email: fromEmail || this.username }],
      replyTo: identityReplyTo?.length ? identityReplyTo : undefined,
      to: to.map(parseRecipientString),
      // RFC 5322 §3.6.3: To/Cc carry an address-list (non-empty). Sending
      // cc:[] makes the server emit a literal `Cc:` header with no addresses,
      // which is malformed and a spam signal. Omit the field when empty.
      cc: cc?.length ? cc.map(parseRecipientString) : undefined,
      bcc: bcc?.length ? bcc.map(parseRecipientString) : undefined,
      subject,
      inReplyTo: normalizedInReplyTo?.length ? normalizedInReplyTo : undefined,
      references: normalizedReferences?.length ? normalizedReferences : undefined,
      keywords: { "$seen": true, "$draft": true },
      mailboxIds: { [draftsMailbox.id]: true },
    };

    if (options?.requestReadReceipt) {
      // RFC 8098: ask the recipient's client to return a Message Disposition
      // Notification to our address. JMAP lets us set the raw header on create
      // via the "header:<Name>:asText" property form.
      emailCreate["header:Disposition-Notification-To:asText"] = fromEmail || this.username;
    }

    if (htmlBody) {
      // Send as multipart/alternative with both text and HTML
      emailCreate.bodyValues = {
        "text": { value: body },
        "html": { value: htmlBody },
      };
      emailCreate.textBody = [{ partId: "text", type: "text/plain" }];
      emailCreate.htmlBody = [{ partId: "html", type: "text/html" }];
    } else {
      emailCreate.bodyValues = { "1": { value: body } };
      emailCreate.textBody = [{ partId: "1", type: "text/plain" }];
    }

    if (attachments?.length) {
      emailCreate.attachments = attachments.map(att => ({
        blobId: att.blobId,
        type: att.type,
        name: att.name,
        disposition: att.disposition ?? "attachment",
        ...(att.cid ? { cid: att.cid } : {}),
      }));
    }

    const methodCalls: JMAPMethodCall[] = [];

    // Use onSuccessUpdateEmail to move from Drafts to Sent after submission.
    // This ensures SMTP send happens before the email lands in Sent, avoiding
    // issues with servers that encrypt on append (e.g. Stalwart). See #188.
    const onSuccessUpdateEmail = {
      "#1": {
        [`mailboxIds/${draftsMailbox.id}`]: null,
        [`mailboxIds/${sentMailbox.id}`]: true,
        "keywords/$draft": null,
      },
    };

    // When an explicit envelope MAIL FROM is provided (header From ≠ envelope,
    // e.g. sending from a domain-catch-all alias without a dedicated Identity),
    // set the EmailSubmission envelope explicitly. JMAP §7.3: when `envelope`
    // is omitted the server derives mailFrom from the Identity.
    const buildSubmissionCreate = (submissionId: string): Record<string, unknown> => {
      const create: Record<string, unknown> = { emailId: `#${emailId}`, identityId: finalIdentityId };
      if (holdForSeconds || envelopeMailFrom) {
        const envelopeRecipients = normalizeEnvelopeRecipients([...to, ...(cc || []), ...(bcc || [])]);
        create.envelope = {
          mailFrom: {
            email: parseRecipientString(envelopeMailFrom || fromEmail || this.username).email,
            ...(holdForSeconds ? { parameters: { HOLDFOR: String(holdForSeconds) } } : {}),
          },
          rcptTo: envelopeRecipients,
        };
      }
      return { [submissionId]: create };
    };

    if (draftId) {
      // Destroy the old draft and create a new email with the final body
      methodCalls.push(["Email/set", {
        accountId: this.accountId,
        destroy: [draftId],
      }, "0"]);
      methodCalls.push(["Email/set", {
        accountId: targetAccountId,
        create: { [emailId]: emailCreate },
      }, "1"]);
      methodCalls.push(["EmailSubmission/set", {
        accountId: this.getSubmissionAccountId(targetAccountId),
        create: buildSubmissionCreate("1"),
        onSuccessUpdateEmail,
      }, "2"]);
    } else {
      methodCalls.push(["Email/set", {
        accountId: targetAccountId,
        create: { [emailId]: emailCreate },
      }, "0"]);
      methodCalls.push(["EmailSubmission/set", {
        accountId: this.getSubmissionAccountId(targetAccountId),
        create: buildSubmissionCreate("1"),
        onSuccessUpdateEmail,
      }, "1"]);
    }

    const response = await this.request(methodCalls);

    let createdEmailId: string | undefined;
    let emailSubmissionId: string | undefined;
    let serverSendAt: string | undefined;

    if (response.methodResponses) {
      for (const [methodName, result] of response.methodResponses) {
        if (methodName.endsWith('/error')) {
          console.error('[sendEmail] JMAP method error:', methodName, result);
          throw new Error(result.description || `Failed to send email: ${result.type}`);
        }

        if (result.notCreated) {
          // Include method name + full error object so it's clear whether the
          // failure came from Email/set (draft create) or EmailSubmission/set
          // (actual send) and which JMAP error type/properties were returned.
          // Without this the user sees a generic "Failed to send" toast and
          // the draft sits in Drafts with no indication of why (#303).
          const errors = result.notCreated as Record<string, {
            type?: string;
            description?: string;
            properties?: string[];
          }>;
          const firstError = Object.values(errors)[0];
          console.error(
            `[sendEmail] ${methodName} notCreated:`,
            JSON.stringify(errors, null, 2),
          );
          const propsHint = firstError?.properties?.length
            ? ` (properties: ${firstError.properties.join(', ')})`
            : '';
          const typeHint = firstError?.type ? ` [${firstError.type}]` : '';
          throw new Error(
            `${firstError?.description || firstError?.type || 'Failed to send email'}${typeHint}${propsHint}`,
          );
        }

        if (methodName === 'Email/set' && result.created?.[emailId]?.id) {
          createdEmailId = result.created[emailId].id;
        }
        if (methodName === 'EmailSubmission/set' && result.created?.['1']?.id) {
          emailSubmissionId = result.created['1'].id;
          serverSendAt = result.created['1'].sendAt;
        }
      }
    }

    if (delayedUntil && emailSubmissionId && !serverSendAt) {
      serverSendAt = await this.getEmailSubmissionSendAt(emailSubmissionId);
    }

    return delayedUntil
      ? { scheduled: true, emailId: createdEmailId, emailSubmissionId, sendAt: serverSendAt }
      : { scheduled: false, emailId: createdEmailId, emailSubmissionId };
  }

  /**
   * Send an iMIP (RFC 6047) REPLY email to the organizer after an RSVP.
   *
   * Fallback only: when `sendSchedulingMessages` is passed to the
   * CalendarEvent/set RSVP patch, the server sends the iTIP REPLY itself -
   * calling this in addition produces duplicate reply emails.
   */
  async sendImipReply(opts: {
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
  }): Promise<void> {
    if (!opts.uid) {
      debug.warn('calendar', '[iMIP] sendImipReply aborted: missing UID');
      return;
    }
    const mailboxes = await this.getMailboxes();
    const sentMailbox = mailboxes.find(mb => mb.role === 'sent');
    if (!sentMailbox) {
      throw new Error('No sent mailbox found');
    }
    const draftsMailbox = mailboxes.find(mb => mb.role === 'drafts');
    if (!draftsMailbox) {
      throw new Error('No drafts mailbox found');
    }

    let finalIdentityId = opts.identityId;
    if (!finalIdentityId) {
      const identityResponse = await this.request([
        ["Identity/get", { accountId: this.accountId }, "0"]
      ]);
      if (identityResponse.methodResponses?.[0]?.[0] === "Identity/get") {
        const identities = (identityResponse.methodResponses[0][1].list || []) as { id: string; email: string }[];
        const match = identities.find((id) => id.email === opts.attendeeEmail);
        finalIdentityId = match?.id || identities[0]?.id || this.accountId;
      } else {
        finalIdentityId = this.accountId;
      }
    }

    // Build iCalendar REPLY (RFC 5546 §3.2.3)
    const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

    // Format a JSCalendar date string into iCalendar format
    const formatIcalDate = (dateStr: string, tz?: string): string => {
      // If it's an ISO UTC string (ends with Z), convert to iCalendar UTC format
      if (dateStr.endsWith('Z')) {
        return dateStr.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      }
      // Local date-time: strip punctuation, keep as-is for TZID parameter
      const basic = dateStr.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      if (tz) {
        return `TZID=${tz}:${basic}`;
      }
      return basic;
    };

    const lines: string[] = [
      'BEGIN:VCALENDAR',
      'PRODID:-//JMAP-Webmail//EN',
      'VERSION:2.0',
      'CALSCALE:GREGORIAN',
      'METHOD:REPLY',
      'BEGIN:VEVENT',
      `UID:${opts.uid}`,
      `DTSTAMP:${now}`,
    ];
    if (opts.dtStart) {
      if (opts.isAllDay) {
        // RFC 5545 §3.3.4: all-day events use VALUE=DATE (date-only, no time)
        const dateOnly = opts.dtStart.replace(/[-]/g, '').substring(0, 8);
        lines.push(`DTSTART;VALUE=DATE:${dateOnly}`);
      } else {
        const formatted = formatIcalDate(opts.dtStart, opts.timeZone);
        if (formatted.startsWith('TZID=')) {
          lines.push(`DTSTART;${formatted}`);
        } else {
          lines.push(`DTSTART:${formatted}`);
        }
      }
    }
    if (opts.dtEnd) {
      if (opts.isAllDay) {
        const dateOnly = opts.dtEnd.replace(/[-]/g, '').substring(0, 8);
        lines.push(`DTEND;VALUE=DATE:${dateOnly}`);
      } else {
        const formatted = formatIcalDate(opts.dtEnd, opts.timeZone);
        if (formatted.startsWith('TZID=')) {
          lines.push(`DTEND;${formatted}`);
        } else {
          lines.push(`DTEND:${formatted}`);
        }
      }
    }
    if (opts.summary) {
      lines.push(`SUMMARY:${escapeIcsText(opts.summary)}`);
    }
    if (opts.sequence != null) {
      lines.push(`SEQUENCE:${opts.sequence}`);
    }
    const orgCn = opts.organizerName ? `;CN=${icsParamValue(opts.organizerName)}` : '';
    lines.push(`ORGANIZER${orgCn}:mailto:${opts.organizerEmail}`);
    const attCn = opts.attendeeName ? `;CN=${icsParamValue(opts.attendeeName)}` : '';
    lines.push(`ATTENDEE;PARTSTAT=${opts.status}${attCn}:mailto:${opts.attendeeEmail}`);
    lines.push('END:VEVENT');
    lines.push('END:VCALENDAR');
    const icsContent = lines.map(foldIcsLine).join('\r\n') + '\r\n';

    debug.log('calendar', '[iMIP] Generated ICS:\n' + icsContent);

    const statusLabels: Record<string, string> = {
      ACCEPTED: 'Accepted',
      TENTATIVE: 'Tentative',
      DECLINED: 'Declined',
    };
    const statusLabel = statusLabels[opts.status] || opts.status;
    const subject = `${statusLabel}: ${opts.summary || 'Event'}`;

    debug.log('calendar', '[iMIP] identityId:', finalIdentityId);

    const emailId = `imip-reply-${Date.now()}`;
    const emailCreate: Record<string, unknown> = {
      from: [{ name: opts.attendeeName || undefined, email: opts.attendeeEmail }],
      to: [{ name: opts.organizerName || undefined, email: opts.organizerEmail }],
      subject,
      keywords: { "$seen": true, "$draft": true },
      mailboxIds: { [draftsMailbox.id]: true },
      bodyStructure: {
        // RFC 6047 §3 requires multipart/mixed when a text/calendar part is present.
        // Using multipart/alternative causes most clients to ignore the iTIP method.
        // @see https://www.rfc-editor.org/rfc/rfc6047#section-3
        // @see https://devguide.calconnect.org/iMIP/iMIPBest-Practices/
        // Note: Gmail-to-Gmail events use Google's internal scheduling API, not iMIP.
        // This fix targets non-Gmail organizers and external CalDAV servers.
        type: 'multipart/mixed',
        subParts: [
          { partId: 'text', type: 'text/plain' },
          { partId: 'cal', type: 'text/calendar; method=REPLY; charset=UTF-8', disposition: 'inline', name: 'reply.ics' },
        ],
      },
      bodyValues: {
        text: { value: `${opts.attendeeName || opts.attendeeEmail} has ${statusLabel.toLowerCase()} the invitation to: ${opts.summary || 'Event'}` },
        cal: { value: icsContent },
      },
    };

    const methodCalls: JMAPMethodCall[] = [
      ["Email/set", {
        accountId: this.accountId,
        create: { [emailId]: emailCreate },
      }, "0"],
      ["EmailSubmission/set", {
        accountId: this.getSubmissionAccountId(),
        create: { "sub-1": { emailId: `#${emailId}`, identityId: finalIdentityId } },
        onSuccessUpdateEmail: {
          "#sub-1": {
            [`mailboxIds/${draftsMailbox.id}`]: null,
            [`mailboxIds/${sentMailbox.id}`]: true,
            "keywords/$draft": null,
          },
        },
      }, "1"],
    ];

    debug.log('calendar', '[iMIP] Sending JMAP request with', methodCalls.length, 'method calls');
    debug.log('calendar', '[iMIP] Email create payload:', JSON.stringify(emailCreate, null, 2));

    const response = await this.request(methodCalls);

    debug.log('calendar', '[iMIP] JMAP response:', JSON.stringify(response.methodResponses, null, 2));

    if (response.methodResponses) {
      for (const [methodName, result] of response.methodResponses) {
        if (methodName.endsWith('/error')) {
          debug.error('[iMIP] method error:', methodName, result);
          throw new Error(result.description || `iMIP reply failed: ${result.type}`);
        }
        if (result.notCreated) {
          const firstError = Object.values(result.notCreated)[0] as { description?: string; type?: string };
          debug.error('[iMIP] create error:', JSON.stringify(result.notCreated, null, 2));
          throw new Error(firstError?.description || firstError?.type || 'Failed to send iMIP reply');
        }
      }
    }
    debug.log('calendar', '[iMIP] sendImipReply completed successfully');
  }

  /**
   * Send an iMIP (RFC 6047) REQUEST email to all participants of a calendar event.
   *
   * Fallback only: when `sendSchedulingMessages` is passed to CalendarEvent/set,
   * the server (Stalwart) queues the iTIP messages itself - calling this in
   * addition produces duplicate invitation emails. Note the generated ICS is
   * a minimal snapshot (no RRULE/VTIMEZONE), so server-side scheduling should
   * always be preferred.
   */
  async sendImipInvitation(event: CalendarEvent): Promise<void> {
    if (!event.participants) return;
    if (!event.uid) {
      debug.warn('calendar', '[iMIP] sendImipInvitation aborted: event has no UID', { eventId: event.id });
      return;
    }

    const mailboxes = await this.getMailboxes();
    const sentMailbox = mailboxes.find(mb => mb.role === 'sent');
    if (!sentMailbox) {
      throw new Error('No sent mailbox found');
    }
    const draftsMailbox = mailboxes.find(mb => mb.role === 'drafts');
    if (!draftsMailbox) {
      throw new Error('No drafts mailbox found');
    }

    // Find the organizer participant
    const organizerEntry = Object.values(event.participants).find(p => p.roles?.owner);
    const organizerEmail = organizerEntry?.email || organizerEntry?.sendTo?.imip?.replace('mailto:', '') || this.username;
    const organizerName = organizerEntry?.name || '';

    // Resolve identity
    const identityResponse = await this.request([
      ["Identity/get", { accountId: this.accountId }, "0"]
    ]);
    let identityId = this.accountId;
    if (identityResponse.methodResponses?.[0]?.[0] === "Identity/get") {
      const identities = (identityResponse.methodResponses[0][1].list || []) as { id: string; email: string }[];
      const match = identities.find((id) => id.email === organizerEmail);
      identityId = match?.id || identities[0]?.id || this.accountId;
    }

    // Collect attendee participants (non-organizer)
    const attendees = Object.values(event.participants).filter(p => !p.roles?.owner);
    if (attendees.length === 0) return;

    const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

    const formatIcalDate = (dateStr: string, tz?: string | null): string => {
      if (dateStr.endsWith('Z')) {
        return dateStr.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      }
      const basic = dateStr.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      if (tz) return `TZID=${tz}:${basic}`;
      return basic;
    };

    const lines: string[] = [
      'BEGIN:VCALENDAR',
      'PRODID:-//JMAP-Webmail//EN',
      'VERSION:2.0',
      'CALSCALE:GREGORIAN',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      `UID:${event.uid}`,
      `DTSTAMP:${now}`,
    ];

    if (event.start) {
      if (event.showWithoutTime) {
        const dateOnly = event.start.replace(/[-]/g, '').substring(0, 8);
        lines.push(`DTSTART;VALUE=DATE:${dateOnly}`);
      } else {
        const formatted = formatIcalDate(event.start, event.timeZone);
        lines.push(formatted.startsWith('TZID=') ? `DTSTART;${formatted}` : `DTSTART:${formatted}`);
      }
    }

    // Prefer DURATION over DTEND (RFC 5545 §3.6.1): DTSTART above is a local
    // date-time (optionally with TZID) while event.utcEnd is a UTC instant -
    // emitting both mixed reference frames, and paired a floating DTSTART
    // with a UTC DTEND for events without a timezone.
    if (event.duration) {
      lines.push(`DURATION:${event.duration}`);
    } else if (event.utcEnd) {
      if (event.showWithoutTime) {
        const dateOnly = event.utcEnd.replace(/[-]/g, '').substring(0, 8);
        lines.push(`DTEND;VALUE=DATE:${dateOnly}`);
      } else {
        const formatted = formatIcalDate(event.utcEnd, event.timeZone);
        lines.push(formatted.startsWith('TZID=') ? `DTEND;${formatted}` : `DTEND:${formatted}`);
      }
    }

    if (event.title) lines.push(`SUMMARY:${escapeIcsText(event.title)}`);
    if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
    if (event.sequence != null) lines.push(`SEQUENCE:${event.sequence}`);
    if (event.status) lines.push(`STATUS:${event.status.toUpperCase()}`);

    const orgCn = organizerName ? `;CN=${icsParamValue(organizerName)}` : '';
    lines.push(`ORGANIZER${orgCn}:mailto:${organizerEmail}`);

    for (const attendee of attendees) {
      const email = attendee.email || attendee.sendTo?.imip?.replace('mailto:', '');
      if (!email) continue;
      const cn = attendee.name ? `;CN=${icsParamValue(attendee.name)}` : '';
      const partstat = attendee.participationStatus
        ? `;PARTSTAT=${attendee.participationStatus.toUpperCase()}`
        : ';PARTSTAT=NEEDS-ACTION';
      const rsvp = attendee.expectReply ? ';RSVP=TRUE' : '';
      lines.push(`ATTENDEE${cn}${partstat}${rsvp}:mailto:${email}`);
    }

    lines.push('END:VEVENT');
    lines.push('END:VCALENDAR');
    const icsContent = lines.map(foldIcsLine).join('\r\n') + '\r\n';

    const subject = `Invitation: ${event.title || 'Event'}`;
    const toAddresses = attendees
      .map(a => ({ name: a.name || undefined, email: a.email || a.sendTo?.imip?.replace('mailto:', '') || '' }))
      .filter(a => a.email);

    if (toAddresses.length === 0) return;

    const emailId = `imip-invite-${Date.now()}`;
    const emailCreate: Record<string, unknown> = {
      from: [{ name: organizerName || undefined, email: organizerEmail }],
      to: toAddresses,
      subject,
      keywords: { "$seen": true, "$draft": true },
      mailboxIds: { [draftsMailbox.id]: true },
      bodyStructure: {
        // See RFC 6047 §3: https://www.rfc-editor.org/rfc/rfc6047#section-3
        type: 'multipart/mixed',
        subParts: [
          { partId: 'text', type: 'text/plain' },
          { partId: 'cal', type: 'text/calendar; method=REQUEST; charset=UTF-8', disposition: 'inline', name: 'invite.ics' },
        ],
      },
      bodyValues: {
        text: { value: `You have been invited to: ${event.title || 'Event'}` },
        cal: { value: icsContent },
      },
    };

    const methodCalls: JMAPMethodCall[] = [
      ["Email/set", {
        accountId: this.accountId,
        create: { [emailId]: emailCreate },
      }, "0"],
      ["EmailSubmission/set", {
        accountId: this.getSubmissionAccountId(),
        create: { "sub-1": { emailId: `#${emailId}`, identityId } },
        onSuccessUpdateEmail: {
          "#sub-1": {
            [`mailboxIds/${draftsMailbox.id}`]: null,
            [`mailboxIds/${sentMailbox.id}`]: true,
            "keywords/$draft": null,
          },
        },
      }, "1"],
    ];

    const response = await this.request(methodCalls);

    if (response.methodResponses) {
      for (const [methodName, result] of response.methodResponses) {
        if (methodName.endsWith('/error')) {
          throw new Error(result.description || `iMIP invitation failed: ${result.type}`);
        }
        if (result.notCreated) {
          const firstError = Object.values(result.notCreated)[0] as { description?: string; type?: string };
          throw new Error(firstError?.description || firstError?.type || 'Failed to send iMIP invitation');
        }
      }
    }
  }

  /**
   * Send an iMIP (RFC 6047) CANCEL email to all participants of a calendar event.
   *
   * Fallback only: when `sendSchedulingMessages` is passed to the
   * CalendarEvent/set destroy, the server sends the iTIP CANCEL itself -
   * calling this in addition produces duplicate cancellation emails.
   */
  async sendImipCancellation(event: CalendarEvent): Promise<void> {
    if (!event.participants) return;
    if (!event.uid) {
      debug.warn('calendar', '[iMIP] sendImipCancellation aborted: event has no UID', { eventId: event.id });
      return;
    }
    if (event.status && event.status !== 'cancelled') {
      debug.warn('calendar', 'sendImipCancellation called on non-cancelled event, status:', event.status);
    }

    const mailboxes = await this.getMailboxes();
    const sentMailbox = mailboxes.find(mb => mb.role === 'sent');
    if (!sentMailbox) {
      throw new Error('No sent mailbox found');
    }
    const draftsMailbox = mailboxes.find(mb => mb.role === 'drafts');
    if (!draftsMailbox) {
      throw new Error('No drafts mailbox found');
    }

    const organizerEntry = Object.values(event.participants).find(p => p.roles?.owner);
    const organizerEmail = organizerEntry?.email || organizerEntry?.sendTo?.imip?.replace('mailto:', '') || this.username;
    const organizerName = organizerEntry?.name || '';

    const identityResponse = await this.request([
      ["Identity/get", { accountId: this.accountId }, "0"]
    ]);
    let identityId = this.accountId;
    if (identityResponse.methodResponses?.[0]?.[0] === "Identity/get") {
      const identities = (identityResponse.methodResponses[0][1].list || []) as { id: string; email: string }[];
      const match = identities.find((id) => id.email === organizerEmail);
      identityId = match?.id || identities[0]?.id || this.accountId;
    }

    const attendees = Object.values(event.participants).filter(p => !p.roles?.owner);
    if (attendees.length === 0) return;

    const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

    const formatIcalDate = (dateStr: string, tz?: string | null): string => {
      if (dateStr.endsWith('Z')) {
        return dateStr.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      }
      const basic = dateStr.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      if (tz) return `TZID=${tz}:${basic}`;
      return basic;
    };

    const lines: string[] = [
      'BEGIN:VCALENDAR',
      'PRODID:-//JMAP-Webmail//EN',
      'VERSION:2.0',
      'CALSCALE:GREGORIAN',
      'METHOD:CANCEL',
      'BEGIN:VEVENT',
      `UID:${event.uid}`,
      `DTSTAMP:${now}`,
      `STATUS:CANCELLED`,
    ];

    if (event.start) {
      if (event.showWithoutTime) {
        const dateOnly = event.start.replace(/[-]/g, '').substring(0, 8);
        lines.push(`DTSTART;VALUE=DATE:${dateOnly}`);
      } else {
        const formatted = formatIcalDate(event.start, event.timeZone);
        lines.push(formatted.startsWith('TZID=') ? `DTSTART;${formatted}` : `DTSTART:${formatted}`);
      }
    }

    if (event.title) lines.push(`SUMMARY:${escapeIcsText(event.title)}`);
    if (event.sequence != null) lines.push(`SEQUENCE:${event.sequence}`);

    const orgCn = organizerName ? `;CN=${icsParamValue(organizerName)}` : '';
    lines.push(`ORGANIZER${orgCn}:mailto:${organizerEmail}`);

    for (const attendee of attendees) {
      const email = attendee.email || attendee.sendTo?.imip?.replace('mailto:', '');
      if (!email) continue;
      const cn = attendee.name ? `;CN=${icsParamValue(attendee.name)}` : '';
      lines.push(`ATTENDEE${cn}:mailto:${email}`);
    }

    lines.push('END:VEVENT');
    lines.push('END:VCALENDAR');
    const icsContent = lines.map(foldIcsLine).join('\r\n') + '\r\n';

    const subject = `Cancelled: ${event.title || 'Event'}`;
    const toAddresses = attendees
      .map(a => ({ name: a.name || undefined, email: a.email || a.sendTo?.imip?.replace('mailto:', '') || '' }))
      .filter(a => a.email);

    if (toAddresses.length === 0) return;

    const emailId = `imip-cancel-${Date.now()}`;
    const emailCreate: Record<string, unknown> = {
      from: [{ name: organizerName || undefined, email: organizerEmail }],
      to: toAddresses,
      subject,
      keywords: { "$seen": true, "$draft": true },
      mailboxIds: { [draftsMailbox.id]: true },
      bodyStructure: {
        // See RFC 6047 §3: https://www.rfc-editor.org/rfc/rfc6047#section-3
        type: 'multipart/mixed',
        subParts: [
          { partId: 'text', type: 'text/plain' },
          { partId: 'cal', type: 'text/calendar; method=CANCEL; charset=UTF-8', disposition: 'inline', name: 'cancel.ics' },
        ],
      },
      bodyValues: {
        text: { value: `The event "${event.title || 'Event'}" has been cancelled.` },
        cal: { value: icsContent },
      },
    };

    const methodCalls: JMAPMethodCall[] = [
      ["Email/set", {
        accountId: this.accountId,
        create: { [emailId]: emailCreate },
      }, "0"],
      ["EmailSubmission/set", {
        accountId: this.getSubmissionAccountId(),
        create: { "sub-1": { emailId: `#${emailId}`, identityId } },
        onSuccessUpdateEmail: {
          "#sub-1": {
            [`mailboxIds/${draftsMailbox.id}`]: null,
            [`mailboxIds/${sentMailbox.id}`]: true,
            "keywords/$draft": null,
          },
        },
      }, "1"],
    ];

    const response = await this.request(methodCalls);

    if (response.methodResponses) {
      for (const [methodName, result] of response.methodResponses) {
        if (methodName.endsWith('/error')) {
          throw new Error(result.description || `iMIP cancellation failed: ${result.type}`);
        }
        if (result.notCreated) {
          const firstError = Object.values(result.notCreated)[0] as { description?: string; type?: string };
          throw new Error(firstError?.description || firstError?.type || 'Failed to send iMIP cancellation');
        }
      }
    }
  }

  private xhrUpload(
    url: string,
    file: File,
    onProgress?: (loaded: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('Upload aborted', 'AbortError'));
        return;
      }
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.setRequestHeader('Authorization', this.authHeader);
      xhr.responseType = 'text';

      const onAbort = () => xhr.abort();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => signal?.removeEventListener('abort', onAbort);

      if (onProgress) {
        // Fire 0% immediately so the UI leaves its initial state even
        // before the first network packet flushes.
        onProgress(0, file.size);
        xhr.upload.onprogress = (ev) => {
          // ev.total is only meaningful when lengthComputable; fall back
          // to file.size so callers always get a usable denominator.
          const total = ev.lengthComputable ? ev.total : file.size;
          onProgress(ev.loaded, total);
        };
      }

      xhr.onload = () => {
        cleanup();
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr.responseText);
        } else {
          reject(new Error(`Failed to upload file: ${xhr.status} - ${xhr.responseText}`));
        }
      };
      xhr.onerror = () => { cleanup(); reject(new Error('Upload network error')); };
      xhr.onabort = () => { cleanup(); reject(new DOMException('Upload aborted', 'AbortError')); };

      xhr.send(file);
    });
  }

  // Signature accepts either the legacy positional accountId string OR
  // the options bag introduced for progress / signal so existing
  // call-sites keep compiling without touching every plugin.
  async uploadBlob(
    file: File,
    optsOrAccountId?:
      | string
      | {
          accountId?: string;
          onProgress?: (loaded: number, total: number) => void;
          signal?: AbortSignal;
        },
  ): Promise<{ blobId: string; size: number; type: string }> {
    const opts =
      typeof optsOrAccountId === 'string'
        ? { accountId: optsOrAccountId }
        : optsOrAccountId ?? {};
    if (!this.session) {
      throw new Error('Not connected. Call connect() first.');
    }

    const uploadUrl = this.session.uploadUrl;
    if (!uploadUrl) {
      throw new Error('Upload URL not available');
    }

    const targetAccountId = opts.accountId || this.accountId;
    const finalUploadUrl = uploadUrl.replace('{accountId}', encodeURIComponent(targetAccountId));

    // XHR path: fetch() does not expose upload progress events, so when the
    // caller wants progress (or an AbortSignal) we use XMLHttpRequest. The
    // fetch path is kept for callers that don't need either, to preserve
    // existing 401/retry behaviour through authenticatedFetch().
    let responseText: string;
    if (opts.onProgress || opts.signal) {
      responseText = await this.xhrUpload(
        finalUploadUrl,
        file,
        opts.onProgress,
        opts.signal,
      );
    } else {
      const response = await this.authenticatedFetch(finalUploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to upload file: ${response.status} - ${errorText}`);
      }
      responseText = await response.text();
    }
    let result;
    try {
      result = JSON.parse(responseText);
    } catch {
      throw new Error('Invalid JSON response from upload');
    }

    // Direct format: { blobId, type, size }
    if (result.blobId) {
      return {
        blobId: result.blobId,
        size: result.size || file.size,
        type: result.type || file.type,
      };
    }

    // Nested format: { [accountId]: { blobId, type, size } }
    const blobInfo = result[targetAccountId];
    if (blobInfo?.blobId) {
      return {
        blobId: blobInfo.blobId,
        size: blobInfo.size || file.size,
        type: blobInfo.type || file.type,
      };
    }

    throw new Error('Invalid upload response: blobId not found');
  }

  /**
   * Import a raw RFC822 message (referenced by a previously-uploaded blob) into
   * one or more mailboxes. Returns the new email id. Used for sending MDNs,
   * where the exact MIME bytes must be preserved (Email/set can't express a
   * multipart/report report-type parameter reliably).
   */
  async importEmail(
    blobId: string,
    mailboxIds: Record<string, boolean>,
    keywords?: Record<string, boolean>,
    accountId?: string
  ): Promise<string | null> {
    const targetAccountId = accountId || this.accountId;
    const creationId = `imp-${Date.now()}`;
    const response = await this.request([
      ["Email/import", {
        accountId: targetAccountId,
        emails: {
          [creationId]: { blobId, mailboxIds, keywords: keywords || { "$seen": true } },
        },
      }, "0"],
    ]);
    const res = response.methodResponses?.[0];
    if (res?.[0] !== "Email/import") {
      console.error('Email/import: unexpected response', res);
      return null;
    }
    const payload = res[1] as {
      created?: Record<string, { id: string }>;
      notCreated?: Record<string, { type?: string; description?: string }>;
    };
    const created = payload?.created?.[creationId];
    if (!created) {
      const reason = payload?.notCreated?.[creationId];
      console.error('Email/import failed:', reason || payload);
      throw new Error(`Email/import: ${reason?.description || reason?.type || 'unknown error'}`);
    }
    return created.id;
  }

  /**
   * Send an RFC 8098 Message Disposition Notification (read receipt) in reply
   * to a message that carried a Disposition-Notification-To header. Builds the
   * multipart/report, uploads it as a blob, imports it into Sent, then submits
   * it with an explicit envelope (MAIL FROM = our identity, RCPT TO = the
   * requesting address).
   */
  async sendReadReceipt(params: {
    to: string;
    fromEmail: string;
    fromName?: string;
    identityId: string;
    originalMessageId?: string | string[];
    originalSubject?: string;
    originalRecipient?: string;
    automatic?: boolean;
    accountId?: string;
    subject?: string;
    humanText?: string;
  }): Promise<void> {
    const targetAccountId = params.accountId || this.accountId;
    const { buildMdnMessage } = await import("@/lib/mdn");
    const raw = buildMdnMessage(params);

    const file = new File([raw], "receipt.eml", { type: "message/rfc822" });
    const { blobId } = await this.uploadBlob(file);

    const mailboxes = await this.getMailboxes();
    const targetMailbox = mailboxes.find(mb => mb.role === 'sent') || mailboxes[0];
    if (!targetMailbox) throw new Error('No mailbox available for MDN import');

    const emailId = await this.importEmail(
      blobId,
      { [targetMailbox.id]: true },
      { "$seen": true },
      targetAccountId
    );
    if (!emailId) throw new Error('MDN import failed');

    const subId = `mdnsub-${Date.now()}`;
    const response = await this.request([
      ["EmailSubmission/set", {
        accountId: targetAccountId,
        create: {
          [subId]: {
            emailId,
            identityId: params.identityId,
            envelope: {
              mailFrom: { email: params.fromEmail },
              rcptTo: [{ email: params.to }],
            },
          },
        },
      }, "0"],
    ]);
    const subRes = response.methodResponses?.[0];
    const notCreated = (subRes?.[1] as { notCreated?: Record<string, { type?: string; description?: string }> })?.notCreated?.[subId];
    if (notCreated) {
      throw new Error(`MDN submission failed: ${notCreated.description || notCreated.type || 'unknown'}`);
    }
  }

  getBlobDownloadUrl(blobId: string, name?: string, type?: string, accountId?: string): string {
    if (!this.downloadUrl) {
      throw new Error('Download URL not available. Please reconnect.');
    }

    // RFC 6570 level 1 URI template expansion. Blobs are scoped per account,
    // so a caller fetching a blob from a delegated/shared account must pass
    // that owner's accountId rather than defaulting to the primary one.
    return this.downloadUrl
      .replace('{accountId}', encodeURIComponent(accountId || this.accountId))
      .replace('{blobId}', encodeURIComponent(blobId))
      .replace('{name}', encodeURIComponent(name || 'download'))
      .replace('{type}', encodeURIComponent(type || 'application/octet-stream'));
  }

  async fetchBlob(blobId: string, name?: string, type?: string, accountId?: string): Promise<Blob> {
    const url = this.getBlobDownloadUrl(blobId, name, type, accountId);
    const response = await this.authenticatedFetch(url, {});
    if (!response.ok) {
      throw new Error(`Failed to fetch blob: ${response.status}`);
    }
    return response.blob();
  }

  async fetchBlobAsObjectUrl(blobId: string, name?: string, type?: string): Promise<string> {
    const blob = await this.fetchBlob(blobId, name, type);
    return URL.createObjectURL(blob);
  }

  getCapabilities(): Record<string, unknown> {
    return this.capabilities;
  }

  hasCapability(capability: string): boolean {
    return capability in this.capabilities;
  }

  /** Check whether a capability is present on the primary account. */
  hasAccountCapability(capability: string, accountId?: string): boolean {
    const id = accountId || this.accountId;
    const caps = this.session?.accounts?.[id]?.accountCapabilities;
    return !!caps && capability in caps;
  }

  getMaxSizeUpload(): number {
    const coreCapability = this.capabilities["urn:ietf:params:jmap:core"] as { maxSizeUpload?: number } | undefined;
    return coreCapability?.maxSizeUpload || 0;
  }

  getMaxCallsInRequest(): number {
    const coreCapability = this.capabilities["urn:ietf:params:jmap:core"] as { maxCallsInRequest?: number } | undefined;
    return coreCapability?.maxCallsInRequest || 50;
  }

  getMaxObjectsInGet(): number {
    const coreCapability = this.capabilities["urn:ietf:params:jmap:core"] as { maxObjectsInGet?: number } | undefined;
    return coreCapability?.maxObjectsInGet || 500;
  }

  getMaxDelayedSend(accountId?: string): number {
    const maxDelayedSend = this.getSubmissionCapability(accountId)?.maxDelayedSend;
    return typeof maxDelayedSend === 'number' ? maxDelayedSend : 0;
  }

  hasDelayedSend(accountId?: string): boolean {
    const submissionCapability = this.getSubmissionCapability(accountId);
    const submissionExtensions = submissionCapability?.submissionExtensions;
    const hasFutureRelease = this.hasSubmissionExtension(submissionExtensions, 'FUTURERELEASE');

    return !!submissionCapability
      && hasFutureRelease
      && this.getMaxDelayedSend(accountId) > 0;
  }

  private validateDelayedUntil(delayedUntil: string, accountId?: string): number {
    const time = new Date(delayedUntil).getTime();
    if (!Number.isFinite(time)) {
      throw new Error('Scheduled send time is invalid');
    }
    const now = Date.now();
    if (time <= now) {
      throw new Error('Scheduled send time must be in the future');
    }
    const maxDelayedSend = this.getMaxDelayedSend(accountId);
    if (!this.hasDelayedSend(accountId) || maxDelayedSend <= 0) {
      throw new Error('Scheduled send is not supported for this account');
    }
    if (time > now + maxDelayedSend * 1000) {
      throw new Error('Scheduled send time is later than the server allows');
    }
    return Math.ceil((time - now) / 1000);
  }

  private async getEmailSubmissionSendAt(submissionId: string): Promise<string | undefined> {
    const response = await this.request([
      ['EmailSubmission/get', {
        accountId: this.getSubmissionAccountId(),
        ids: [submissionId],
        properties: ['sendAt', 'undoStatus'],
      }, '0'],
    ]);
    const submission = response.methodResponses?.[0]?.[1]?.list?.[0] as { sendAt?: string } | undefined;
    return submission?.sendAt;
  }

  private async getEmailSubmissionEnvelope(submissionId: string): Promise<{ rcptTo?: Array<{ email: string }> } | undefined> {
    const response = await this.request([
      ['EmailSubmission/get', {
        accountId: this.getSubmissionAccountId(),
        ids: [submissionId],
        properties: ['envelope'],
      }, '0'],
    ]);
    const submission = response.methodResponses?.[0]?.[1]?.list?.[0] as { envelope?: { rcptTo?: Array<{ email: string }> } } | undefined;
    return submission?.envelope;
  }

  private getSubmissionAccountId(accountId?: string): string {
    // The requested (mail) account may not host EmailSubmission objects — JMAP
    // allows submission to live in a separate account (session
    // primaryAccounts['…:submission']). Only honour the requested account when
    // it actually advertises the submission capability; otherwise fall back to
    // the account JMAP designates for submission.
    const submissionPrimary = this.session?.primaryAccounts?.['urn:ietf:params:jmap:submission'];
    if (accountId && this.session?.accounts?.[accountId]?.accountCapabilities?.['urn:ietf:params:jmap:submission']) {
      return accountId;
    }
    return submissionPrimary || accountId || this.accountId;
  }

  private getSubmissionCapability(accountId?: string): SubmissionCapability | undefined {
    const submissionAccountId = this.getSubmissionAccountId(accountId);
    return this.session?.accounts?.[submissionAccountId]?.accountCapabilities?.['urn:ietf:params:jmap:submission'] as SubmissionCapability | undefined;
  }

  private hasSubmissionExtension(submissionExtensions: unknown, extension: string): boolean {
    const target = extension.toUpperCase();
    if (Array.isArray(submissionExtensions)) {
      return submissionExtensions.some(item => typeof item === 'string' && item.toUpperCase() === target);
    }
    if (submissionExtensions && typeof submissionExtensions === 'object') {
      return Object.entries(submissionExtensions as Record<string, unknown>)
        .some(([key, value]) => key.toUpperCase() === target && value !== false && value != null);
    }
    return false;
  }

  getEventSourceUrl(): string | null {
    if (!this.session) return null;

    // RFC 8620: session root level, with fallback to capabilities for some servers
    const coreCapability = this.session.capabilities?.["urn:ietf:params:jmap:core"] as { eventSourceUrl?: string } | undefined;
    return this.session.eventSourceUrl || coreCapability?.eventSourceUrl || null;
  }

  getAccountId(): string {
    return this.accountId;
  }

  getUsername(): string {
    return this.username || this.session?.accounts?.[this.accountId]?.name || '';
  }

  supportsEmailSubmission(): boolean {
    return this.hasCapability("urn:ietf:params:jmap:submission");
  }

  supportsQuota(): boolean {
    return this.hasCapability("urn:ietf:params:jmap:quota");
  }

  supportsVacationResponse(): boolean {
    return this.hasCapability("urn:ietf:params:jmap:vacationresponse");
  }

  supportsContacts(): boolean {
    return this.hasCapability("urn:ietf:params:jmap:contacts");
  }

  supportsCalendars(): boolean {
    return this.hasCapability("urn:ietf:params:jmap:calendars");
  }

  supportsSieve(): boolean {
    return this.hasCapability("urn:ietf:params:jmap:sieve");
  }

  supportsPrincipals(): boolean {
    return this.hasCapability("urn:ietf:params:jmap:principals");
  }

  getSieveAccountId(): string {
    const sieveAccount = this.session?.primaryAccounts?.["urn:ietf:params:jmap:sieve"];
    return sieveAccount || this.accountId;
  }

  private sieveUsing(): string[] {
    return ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:sieve"];
  }

  /**
   * Accounts (primary + shared/group) visible in this session, each tagged with
   * the capabilities it advertises. Unifies the per-feature enumeration that
   * getCalendarCapableAccountIds()/getContactCapableAccountIds()/
   * getFilesCapableAccountIds() do: a non-primary account is included when it
   * advertises a capability OR is a non-personal (shared/group) account, since
   * Stalwart doesn't always advertise capabilities on those even when they
   * support the feature. Primary account first; name from the session account
   * (primary falls back to the username). Drives the settings "Shared with me"
   * list and the scoped-settings tab gating.
   */
  getSharedAccounts(): SharedAccount[] {
    const primaryId = this.getSieveAccountId();
    const toEntry = (id: string, isPrimary: boolean): SharedAccount => {
      const account = this.accounts[id];
      const caps = account?.accountCapabilities;
      const shared = !account?.isPersonal;
      return {
        id,
        name: account?.name || (isPrimary ? (this.username || id) : id),
        isPrimary,
        capabilities: {
          mail: !!caps?.["urn:ietf:params:jmap:mail"] || shared,
          sieve: !!caps?.["urn:ietf:params:jmap:sieve"] || shared,
          calendars: !!caps?.["urn:ietf:params:jmap:calendars"] || shared,
          contacts: !!caps?.["urn:ietf:params:jmap:contacts"] || shared,
          filenode: !!caps?.["urn:ietf:params:jmap:filenode"] || shared,
        },
      };
    };

    const result = [toEntry(primaryId, true)];
    for (const id of Object.keys(this.accounts)) {
      if (id === primaryId) continue;
      const account = this.accounts[id];
      // Mirror the per-feature helpers: include any non-personal account, plus
      // accounts that advertise at least one editable capability.
      const caps = account.accountCapabilities;
      const advertisesAny =
        !!caps?.["urn:ietf:params:jmap:mail"] ||
        !!caps?.["urn:ietf:params:jmap:sieve"] ||
        !!caps?.["urn:ietf:params:jmap:calendars"] ||
        !!caps?.["urn:ietf:params:jmap:contacts"] ||
        !!caps?.["urn:ietf:params:jmap:filenode"];
      if (!account.isPersonal || advertisesAny) {
        result.push(toEntry(id, false));
      }
    }
    return result;
  }

  /**
   * Sieve-capable accounts (primary + shared/group), for the filters UI.
   * Thin wrapper over getSharedAccounts() filtered to the sieve capability.
   */
  getSieveAccounts(): { id: string; name: string; isPrimary: boolean }[] {
    return this.getSharedAccounts()
      .filter((a) => a.isPrimary || a.capabilities.sieve)
      .map(({ id, name, isPrimary }) => ({ id, name, isPrimary }));
  }

  getSieveCapabilities(accountId?: string): SieveCapabilities | null {
    const sieveAccountId = accountId || this.getSieveAccountId();
    const accountInfo = this.accounts[sieveAccountId];
    if (!accountInfo?.accountCapabilities) return null;
    const caps = accountInfo.accountCapabilities["urn:ietf:params:jmap:sieve"];
    return (caps as SieveCapabilities) || null;
  }

  async getSieveScripts(accountId?: string): Promise<SieveScript[]> {
    const response = await this.request([
      ["SieveScript/get", {
        accountId: accountId || this.getSieveAccountId(),
      }, "0"]
    ], this.sieveUsing());

    if (response.methodResponses?.[0]?.[0] === "SieveScript/get") {
      return (response.methodResponses[0][1].list || []) as SieveScript[];
    }
    throw new Error('Failed to fetch Sieve scripts');
  }

  async getSieveScriptContent(blobId: string, accountId?: string): Promise<string> {
    // Blobs are scoped per account, so a shared/group account's script must be
    // downloaded against that owner's accountId, not the primary one.
    const url = this.getBlobDownloadUrl(
      blobId, 'script.sieve', 'application/sieve', accountId || this.getSieveAccountId(),
    );
    const response = await this.authenticatedFetch(url, {});
    if (!response.ok) throw new Error(`Failed to download script: ${response.status}`);
    return response.text();
  }

  private async uploadSieveBlob(content: string, accountId?: string): Promise<string> {
    if (!this.session?.uploadUrl) {
      throw new Error('Upload URL not available');
    }

    const targetAccountId = accountId || this.getSieveAccountId();
    const uploadUrl = this.session.uploadUrl.replace(
      '{accountId}',
      encodeURIComponent(targetAccountId)
    );

    const response = await this.authenticatedFetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/sieve',
      },
      body: content,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to upload sieve script: ${response.status} - ${errorText.substring(0, 200)}`);
    }

    const result = await response.json();
    if (result.blobId) return result.blobId;
    const blobInfo = result[targetAccountId];
    if (blobInfo?.blobId) return blobInfo.blobId;
    throw new Error('Invalid upload response: blobId not found');
  }

  async createSieveScript(name: string, content: string, activate?: boolean, accountId?: string): Promise<SieveScript> {
    const targetAccountId = accountId || this.getSieveAccountId();
    const blobId = await this.uploadSieveBlob(content, targetAccountId);

    const setArgs: Record<string, unknown> = {
      accountId: targetAccountId,
      create: {
        "new-script": { name, blobId }
      },
    };
    if (activate) {
      setArgs.onSuccessActivateScript = "#new-script";
    }

    const response = await this.request([
      ["SieveScript/set", setArgs, "0"]
    ], this.sieveUsing());

    if (response.methodResponses?.[0]?.[0] === "SieveScript/set") {
      const result = response.methodResponses[0][1];
      if (result.notCreated?.["new-script"]) {
        const error = result.notCreated["new-script"];
        throw new Error(error.description || "Failed to create sieve script");
      }
      const createdId = result.created?.["new-script"]?.id;
      if (createdId) {
        const scripts = await this.getSieveScripts(targetAccountId);
        const script = scripts.find(s => s.id === createdId);
        if (script) return script;
      }
    }
    throw new Error("Failed to create sieve script");
  }

  async updateSieveScript(scriptId: string, content: string, activate?: boolean, accountId?: string): Promise<void> {
    const targetAccountId = accountId || this.getSieveAccountId();
    const blobId = await this.uploadSieveBlob(content, targetAccountId);

    const setArgs: Record<string, unknown> = {
      accountId: targetAccountId,
      update: {
        [scriptId]: { blobId }
      },
    };
    if (activate) {
      setArgs.onSuccessActivateScript = scriptId;
    }

    const response = await this.request([
      ["SieveScript/set", setArgs, "0"]
    ], this.sieveUsing());

    if (response.methodResponses?.[0]?.[0] === "SieveScript/set") {
      const result = response.methodResponses[0][1];
      if (result.notUpdated?.[scriptId]) {
        const error = result.notUpdated[scriptId];
        throw new Error(error.description || "Failed to update sieve script");
      }
      return;
    }
    throw new Error("Failed to update sieve script");
  }

  async deleteSieveScript(scriptId: string, accountId?: string): Promise<void> {
    const response = await this.request([
      ["SieveScript/set", {
        accountId: accountId || this.getSieveAccountId(),
        destroy: [scriptId]
      }, "0"]
    ], this.sieveUsing());

    if (response.methodResponses?.[0]?.[0] === "SieveScript/set") {
      const result = response.methodResponses[0][1];
      if (result.notDestroyed?.[scriptId]) {
        const error = result.notDestroyed[scriptId];
        throw new Error(error.description || "Failed to delete sieve script");
      }
      return;
    }
    throw new Error("Failed to delete sieve script");
  }

  async activateSieveScript(scriptId: string, accountId?: string): Promise<void> {
    const response = await this.request([
      ["SieveScript/set", {
        accountId: accountId || this.getSieveAccountId(),
        onSuccessActivateScript: scriptId,
      }, "0"]
    ], this.sieveUsing());

    const [methodName, result] = response.methodResponses?.[0] || [];
    if (methodName === "error") {
      throw new Error(result?.description || "Failed to activate sieve script");
    }
    if (methodName !== "SieveScript/set") {
      throw new Error("Failed to activate sieve script");
    }
  }

  async deactivateSieveScript(accountId?: string): Promise<void> {
    const response = await this.request([
      ["SieveScript/set", {
        accountId: accountId || this.getSieveAccountId(),
        onSuccessActivateScript: null,
      }, "0"]
    ], this.sieveUsing());

    const [methodName, result] = response.methodResponses?.[0] || [];
    if (methodName === "error") {
      throw new Error(result?.description || "Failed to deactivate sieve script");
    }
    if (methodName !== "SieveScript/set") {
      throw new Error("Failed to deactivate sieve script");
    }
  }

  async validateSieveScript(content: string, accountId?: string): Promise<{ isValid: boolean; errors?: string[] }> {
    const targetAccountId = accountId || this.getSieveAccountId();
    const blobId = await this.uploadSieveBlob(content, targetAccountId);

    const response = await this.request([
      ["SieveScript/validate", {
        accountId: targetAccountId,
        blobId,
      }, "0"]
    ], this.sieveUsing());

    if (response.methodResponses?.[0]?.[0] === "SieveScript/validate") {
      const result = response.methodResponses[0][1];
      if (result.error) {
        return { isValid: false, errors: [result.error.description || "Validation failed"] };
      }
      return { isValid: true };
    }

    if (response.methodResponses?.[0]?.[0]?.endsWith('/error')) {
      const error = response.methodResponses[0][1];
      return { isValid: false, errors: [error.description || "Validation failed"] };
    }

    return { isValid: false, errors: ['Unexpected validation response'] };
  }

  getContactsAccountId(): string {
    const contactsAccount = this.session?.primaryAccounts?.["urn:ietf:params:jmap:contacts"];
    return contactsAccount || this.accountId;
  }

  getCalendarsAccountId(): string {
    const calendarsAccount = this.session?.primaryAccounts?.["urn:ietf:params:jmap:calendars"];
    return calendarsAccount || this.accountId;
  }

  private contactUsing(): string[] {
    const using = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:contacts"];
    if (this.hasCapability("urn:ietf:params:jmap:principals")) {
      using.push("urn:ietf:params:jmap:principals:owner");
    }
    return using;
  }

  private calendarUsing(): string[] {
    const using = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars"];
    if (this.hasCapability("urn:ietf:params:jmap:principals")) {
      using.push("urn:ietf:params:jmap:principals:owner");
    }
    return using;
  }

  private getCalendarCapableAccountIds(): string[] {
    const primaryId = this.getCalendarsAccountId();
    const accountIds: string[] = [];
    for (const [id, account] of Object.entries(this.accounts)) {
      if (id === primaryId) continue;
      // Include accounts that either advertise calendar capability
      // or are non-personal (shared/group) accounts - Stalwart doesn't
      // always advertise capabilities on group accounts even when they
      // have calendar resources.
      if (account.accountCapabilities?.["urn:ietf:params:jmap:calendars"] || !account.isPersonal) {
        accountIds.push(id);
      }
    }
    return [primaryId, ...accountIds];
  }

  private getContactCapableAccountIds(): string[] {
    const primaryId = this.getContactsAccountId();
    const accountIds: string[] = [];
    for (const [id, account] of Object.entries(this.accounts)) {
      if (id === primaryId) continue;
      // Include accounts that either advertise contacts capability
      // or are non-personal (shared/group) accounts - Stalwart doesn't
      // always advertise capabilities on group accounts even when they
      // have contact resources.
      if (account.accountCapabilities?.["urn:ietf:params:jmap:contacts"] || !account.isPersonal) {
        accountIds.push(id);
      }
    }
    return [primaryId, ...accountIds];
  }

  async getAddressBooks(): Promise<AddressBook[]> {
    try {
      const accountId = this.getContactsAccountId();
      const response = await this.request([
        ["AddressBook/get", { accountId, properties: ADDRESS_BOOK_PROPERTIES }, "0"]
      ], this.contactUsing());

      if (response.methodResponses?.[0]?.[0] === "AddressBook/get") {
        return (response.methodResponses[0][1].list || []) as AddressBook[];
      }
      return [];
    } catch (error) {
      console.error('Failed to get address books:', error);
      return [];
    }
  }

  async getAllAddressBooks(): Promise<AddressBook[]> {
    try {
      const allBooks: AddressBook[] = [];
      const primaryId = this.getContactsAccountId();
      const accountIds = this.getContactCapableAccountIds();

      for (const accountId of accountIds) {
        const isPrimary = accountId === primaryId;
        const account = this.accounts[accountId];

        try {
          const response = await this.request([
            ["AddressBook/get", { accountId, properties: ADDRESS_BOOK_PROPERTIES }, "0"]
          ], this.contactUsing());

          if (response.methodResponses?.[0]?.[0] === "AddressBook/get") {
            const rawBooks = (response.methodResponses[0][1].list || []) as AddressBook[];
            const books = rawBooks.map((book) => ({
              ...book,
              id: isPrimary ? book.id : `${accountId}:${book.id}`,
              originalId: book.id,
              accountId,
              accountName: account?.name || (isPrimary ? this.username : accountId),
              isShared: !isPrimary,
            }));
            allBooks.push(...books);
          }
        } catch (error) {
          console.error(`Failed to fetch address books for account ${accountId}:`, error);
        }
      }

      return allBooks;
    } catch (error) {
      console.error('Failed to fetch all address books:', error);
      return this.getAddressBooks();
    }
  }

  async createAddressBook(name: string): Promise<AddressBook> {
    const accountId = this.getContactsAccountId();
    const response = await this.request([
      ["AddressBook/set", {
        accountId,
        create: { "new-book": { name } },
      }, "0"]
    ], this.contactUsing());

    if (response.methodResponses?.[0]?.[0] === "AddressBook/set") {
      const result = response.methodResponses[0][1];
      const created = result.created?.["new-book"];
      if (created) {
        return { id: created.id, name, ...created } as AddressBook;
      }
      const err = result.notCreated?.["new-book"];
      throw new Error(err?.description || "Failed to create address book");
    }
    throw new Error("Failed to create address book");
  }

  async updateAddressBook(addressBookId: string, updates: Partial<AddressBook>, targetAccountId?: string): Promise<void> {
    const accountId = targetAccountId || this.getContactsAccountId();
    // Only forward server-settable properties
    const { name, description, sortOrder, isDefault, color } = updates as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (name !== undefined) patch.name = name;
    if (description !== undefined) patch.description = description;
    if (sortOrder !== undefined) patch.sortOrder = sortOrder;
    if (isDefault !== undefined) patch.isDefault = isDefault;
    if (color !== undefined) patch.color = color;

    const response = await this.request([
      ["AddressBook/set", {
        accountId,
        update: { [addressBookId]: patch },
      }, "0"]
    ], this.contactUsing());

    if (response.methodResponses?.[0]?.[0] === "AddressBook/set") {
      const result = response.methodResponses[0][1];
      if (result.notUpdated?.[addressBookId]) {
        const error = result.notUpdated[addressBookId];
        throw new Error(error.description || "Failed to update address book");
      }
      return;
    }
    throw new Error("Failed to update address book");
  }

  async deleteAddressBook(addressBookId: string, targetAccountId?: string): Promise<void> {
    const accountId = targetAccountId || this.getContactsAccountId();
    const response = await this.request([
      ["AddressBook/set", { accountId, destroy: [addressBookId] }, "0"],
    ], this.contactUsing());

    const result = response.methodResponses?.[0]?.[1];
    if (result?.notDestroyed?.[addressBookId]) {
      const err = result.notDestroyed[addressBookId];
      throw new Error(err.description || "Failed to delete address book");
    }
  }

  // ── Sharing (RFC 9670) ──────────────────────────────────────────────────────

  private principalsUsing(): string[] {
    return ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:principals"];
  }

  /**
   * List all principals visible to the user (RFC 9670). Stalwart returns the
   * full directory regardless of `filter`, so we fetch the whole list and let
   * callers filter client-side.
   */
  async getPrincipals(targetAccountId?: string): Promise<Principal[]> {
    if (!this.supportsPrincipals()) return [];
    const accountId = targetAccountId || this.accountId;
    try {
      const response = await this.request([
        ["Principal/query", { accountId }, "0"],
        ["Principal/get", {
          accountId,
          "#ids": { resultOf: "0", name: "Principal/query", path: "/ids" },
        }, "1"],
      ], this.principalsUsing());

      const getResp = response.methodResponses?.find((r) => r[0] === "Principal/get");
      if (!getResp) return [];
      const list = (getResp[1].list || []) as Principal[];
      return list.map((p) => ({ ...p, accountId }));
    } catch (error) {
      console.error("Failed to fetch principals:", error);
      return [];
    }
  }

  /**
   * Add, update, or remove a principal's rights on a calendar.
   * Pass `rights: null` to revoke access.
   */
  async setCalendarShare(
    calendarId: string,
    principalId: string,
    rights: CalendarRights | null,
    targetAccountId?: string,
  ): Promise<void> {
    const accountId = targetAccountId || this.getCalendarsAccountId();
    const response = await this.request([
      ["Calendar/set", {
        accountId,
        update: { [calendarId]: { [`shareWith/${principalId}`]: rights } },
      }, "0"],
    ], this.calendarUsing());

    const result = response.methodResponses?.[0]?.[1];
    if (result?.notUpdated?.[calendarId]) {
      const err = result.notUpdated[calendarId];
      throw new Error(err.description || "Failed to update calendar share");
    }
    if (!result?.updated || !(calendarId in result.updated)) {
      throw new Error("Server did not confirm the share update");
    }
  }

  /**
   * Add, update, or remove a principal's rights on an address book.
   * Pass `rights: null` to revoke access.
   */
  async setAddressBookShare(
    addressBookId: string,
    principalId: string,
    rights: AddressBookRights | null,
    targetAccountId?: string,
  ): Promise<void> {
    const accountId = targetAccountId || this.getContactsAccountId();
    const response = await this.request([
      ["AddressBook/set", {
        accountId,
        update: { [addressBookId]: { [`shareWith/${principalId}`]: rights } },
      }, "0"],
    ], this.contactUsing());

    const result = response.methodResponses?.[0]?.[1];
    if (result?.notUpdated?.[addressBookId]) {
      const err = result.notUpdated[addressBookId];
      throw new Error(err.description || "Failed to update address book share");
    }
    if (!result?.updated || !(addressBookId in result.updated)) {
      throw new Error("Server did not confirm the share update");
    }
  }

  private async fetchPaginatedContacts(
    accountId: string,
    filter?: Record<string, unknown>,
  ): Promise<ContactCard[]> {
    const batchSize = this.getMaxObjectsInGet();
    const allIds: string[] = [];
    let position = 0;

    // Paginate ContactCard/query to collect all IDs
    for (;;) {
      const queryArgs: Record<string, unknown> = { accountId, position, limit: batchSize };
      if (filter) {
        queryArgs.filter = filter;
      }

      const response = await this.request([
        ["ContactCard/query", queryArgs, "q"],
      ], this.contactUsing());

      const queryResult = response.methodResponses?.[0];
      if (queryResult?.[0] !== "ContactCard/query") break;

      const ids: string[] = queryResult[1].ids || [];
      allIds.push(...ids);

      const total: number = queryResult[1].total ?? -1;
      if (ids.length < batchSize || (total > 0 && allIds.length >= total)) {
        break;
      }
      position += ids.length;
    }

    if (allIds.length === 0) return [];

    // Batch ContactCard/get to respect maxObjectsInGet
    const allContacts: ContactCard[] = [];
    for (let i = 0; i < allIds.length; i += batchSize) {
      const chunk = allIds.slice(i, i + batchSize);
      const response = await this.request([
        ["ContactCard/get", { accountId, ids: chunk }, "g"],
      ], this.contactUsing());

      if (response.methodResponses?.[0]?.[0] === "ContactCard/get") {
        const list = (response.methodResponses[0][1].list || []) as ContactCard[];
        allContacts.push(...list);
      }
    }

    return allContacts;
  }

  async getContacts(addressBookId?: string): Promise<ContactCard[]> {
    try {
      const accountId = this.getContactsAccountId();
      const filter = addressBookId ? { inAddressBook: addressBookId } : undefined;
      return await this.fetchPaginatedContacts(accountId, filter);
    } catch (error) {
      console.error('Failed to get contacts:', error);
      return [];
    }
  }

  async getAllContacts(): Promise<ContactCard[]> {
    try {
      const allContacts: ContactCard[] = [];
      const primaryId = this.getContactsAccountId();
      const accountIds = this.getContactCapableAccountIds();

      for (const accountId of accountIds) {
        const isPrimary = accountId === primaryId;
        const account = this.accounts[accountId];

        try {
          const rawContacts = await this.fetchPaginatedContacts(accountId);
          const contacts = rawContacts.map((contact) => ({
            ...contact,
            id: isPrimary ? contact.id : `${accountId}:${contact.id}`,
            originalId: contact.id,
            addressBookIds: isPrimary ? contact.addressBookIds : (contact.addressBookIds ? Object.fromEntries(
              Object.entries(contact.addressBookIds).map(([bookId, v]) => [`${accountId}:${bookId}`, v])
            ) : contact.addressBookIds),
            accountId,
            accountName: account?.name || (isPrimary ? this.username : accountId),
            isShared: !isPrimary,
          }));
          allContacts.push(...contacts);
        } catch (error) {
          console.error(`Failed to fetch contacts for account ${accountId}:`, error);
        }
      }

      return allContacts;
    } catch (error) {
      console.error('Failed to fetch all contacts:', error);
      return this.getContacts();
    }
  }

  async getContact(contactId: string, accountId?: string): Promise<ContactCard | null> {
    try {
      const targetAccountId = accountId || this.getContactsAccountId();
      const response = await this.request([
        ["ContactCard/get", {
          accountId: targetAccountId,
          ids: [contactId],
        }, "0"]
      ], this.contactUsing());

      if (response.methodResponses?.[0]?.[0] === "ContactCard/get") {
        const list = response.methodResponses[0][1].list || [];
        return list[0] || null;
      }
      return null;
    } catch (error) {
      console.error('Failed to get contact:', error);
      return null;
    }
  }

  async createContact(contact: Partial<ContactCard>, targetAccountId?: string): Promise<ContactCard> {
    const accountId = targetAccountId || this.getContactsAccountId();
    let addressBookIds = contact.addressBookIds;
    if (!addressBookIds || Object.keys(addressBookIds).length === 0) {
      const books = await this.getAddressBooks();
      const defaultBook = books.find(b => b.isDefault) || books[0];
      if (defaultBook) {
        addressBookIds = { [defaultBook.id]: true };
      }
    }

    // Strip shared-only fields before sending to JMAP
    const { originalId: _oid, accountId: _aid, accountName: _an, isShared: _is, ...contactData } = contact as ContactCard;

    const response = await this.request([
      ["ContactCard/set", {
        accountId,
        create: {
          "new-contact": {
            ...contactData,
            addressBookIds,
          }
        }
      }, "0"]
    ], this.contactUsing());

    if (response.methodResponses?.[0]?.[0] === "ContactCard/set") {
      const result = response.methodResponses[0][1];

      if (result.notCreated?.["new-contact"]) {
        const error = result.notCreated["new-contact"];
        throw new Error(error.description || "Failed to create contact");
      }

      const createdId = result.created?.["new-contact"]?.id;
      if (createdId) {
        const created = await this.getContact(createdId, accountId);
        if (created) return created;
      }
    }

    throw new Error("Failed to create contact");
  }

  async updateContact(contactId: string, updates: Partial<ContactCard>, targetAccountId?: string): Promise<void> {
    const accountId = targetAccountId || this.getContactsAccountId();

    // Strip shared-only fields before sending to JMAP
    const { originalId: _oid, accountId: _aid, accountName: _an, isShared: _is, ...cleanUpdates } = updates as ContactCard;

    const response = await this.request([
      ["ContactCard/set", {
        accountId,
        update: {
          [contactId]: cleanUpdates
        }
      }, "0"]
    ], this.contactUsing());

    if (response.methodResponses?.[0]?.[0] === "ContactCard/set") {
      const result = response.methodResponses[0][1];

      if (result.notUpdated?.[contactId]) {
        const error = result.notUpdated[contactId];
        throw new Error(error.description || "Failed to update contact");
      }
      return;
    }

    throw new Error("Failed to update contact");
  }

  async deleteContact(contactId: string, targetAccountId?: string): Promise<void> {
    const accountId = targetAccountId || this.getContactsAccountId();

    const response = await this.request([
      ["ContactCard/set", {
        accountId,
        destroy: [contactId]
      }, "0"]
    ], this.contactUsing());

    if (response.methodResponses?.[0]?.[0] === "ContactCard/set") {
      const result = response.methodResponses[0][1];

      if (result.notDestroyed?.[contactId]) {
        const error = result.notDestroyed[contactId];
        throw new Error(error.description || "Failed to delete contact");
      }
      return;
    }

    throw new Error("Failed to delete contact");
  }

  async searchContacts(query: string): Promise<ContactCard[]> {
    try {
      const allResults: ContactCard[] = [];
      const primaryId = this.getContactsAccountId();
      const accountIds = this.getContactCapableAccountIds();

      for (const accountId of accountIds) {
        const isPrimary = accountId === primaryId;
        const account = this.accounts[accountId];

        try {
          const response = await this.request([
            ["ContactCard/query", {
              accountId,
              filter: { text: query },
              limit: 50,
            }, "0"],
            ["ContactCard/get", {
              accountId,
              "#ids": { resultOf: "0", name: "ContactCard/query", path: "/ids" },
            }, "1"]
          ], this.contactUsing());

          if (response.methodResponses?.[1]?.[0] === "ContactCard/get") {
            const rawContacts = (response.methodResponses[1][1].list || []) as ContactCard[];
            const contacts = rawContacts.map((contact) => ({
              ...contact,
              id: isPrimary ? contact.id : `${accountId}:${contact.id}`,
              originalId: contact.id,
              accountId,
              accountName: account?.name || (isPrimary ? this.username : accountId),
              isShared: !isPrimary,
            }));
            allResults.push(...contacts);
          }
        } catch (error) {
          console.error(`Failed to search contacts for account ${accountId}:`, error);
        }
      }

      return allResults;
    } catch (error) {
      console.error('Failed to search contacts:', error);
      return [];
    }
  }

  async getCalendars(): Promise<Calendar[]> {
    try {
      const accountId = this.getCalendarsAccountId();
      const response = await this.request([
        ["Calendar/get", { accountId, properties: CALENDAR_PROPERTIES }, "0"]
      ], this.calendarUsing());

      if (response.methodResponses?.[0]?.[0] === "Calendar/get") {
        return (response.methodResponses[0][1].list || []) as Calendar[];
      }
      return [];
    } catch (error) {
      console.error('Failed to get calendars:', error);
      return [];
    }
  }

  async getAllCalendars(): Promise<Calendar[]> {
    try {
      const allCalendars: Calendar[] = [];
      const primaryId = this.getCalendarsAccountId();
      const accountIds = this.getCalendarCapableAccountIds();

      for (const accountId of accountIds) {
        const isPrimary = accountId === primaryId;
        const account = this.accounts[accountId];

        try {
          const response = await this.request([
            ["Calendar/get", { accountId, properties: CALENDAR_PROPERTIES }, "0"]
          ], this.calendarUsing());

          if (response.methodResponses?.[0]?.[0] === "Calendar/get") {
            const rawCalendars = (response.methodResponses[0][1].list || []) as Calendar[];
            const calendars = rawCalendars.map((cal) => ({
              ...cal,
              id: isPrimary ? cal.id : `${accountId}:${cal.id}`,
              originalId: cal.id,
              accountId,
              accountName: account?.name || (isPrimary ? this.username : accountId),
              isShared: !isPrimary,
            }));
            allCalendars.push(...calendars);
          }
        } catch (error) {
          console.error(`Failed to fetch calendars for account ${accountId}:`, error);
        }
      }

      return allCalendars;
    } catch (error) {
      console.error('Failed to fetch all calendars:', error);
      return this.getCalendars();
    }
  }

  async createCalendar(calendar: Partial<Calendar>, targetAccountId?: string): Promise<Calendar> {
    const accountId = targetAccountId || this.getCalendarsAccountId();

    const response = await this.request([
      ["Calendar/set", {
        accountId,
        create: {
          "new-calendar": calendar
        }
      }, "0"]
    ], this.calendarUsing());

    if (response.methodResponses?.[0]?.[0] === "Calendar/set") {
      const result = response.methodResponses[0][1];

      if (result.notCreated?.["new-calendar"]) {
        const error = result.notCreated["new-calendar"];
        throw new Error(error.description || "Failed to create calendar");
      }

      const createdId = result.created?.["new-calendar"]?.id;
      if (createdId) {
        // Fetch from the target account to find the created calendar
        const fetchAccountId = targetAccountId || this.getCalendarsAccountId();
        const fetchResponse = await this.request([
          ["Calendar/get", { accountId: fetchAccountId, ids: [createdId], properties: CALENDAR_PROPERTIES }, "0"]
        ], this.calendarUsing());
        if (fetchResponse.methodResponses?.[0]?.[0] === "Calendar/get") {
          const list = fetchResponse.methodResponses[0][1].list || [];
          if (list[0]) return list[0] as Calendar;
        }
      }
    }

    throw new Error("Failed to create calendar");
  }

  async updateCalendar(calendarId: string, updates: Partial<Calendar>, targetAccountId?: string): Promise<void> {
    const accountId = targetAccountId || this.getCalendarsAccountId();

    // Stalwart rejects the whole update with invalidProperties if any key is
    // not settable (e.g. id, isDefault, myRights, or client-only fields), so
    // only forward the properties its Calendar/set actually accepts. Keys
    // containing '/' are JSON-pointer patches; keep those whose root segment
    // is settable (shareWith/..., defaultAlertsWithTime/...).
    const cleanUpdates: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(updates as Record<string, unknown>)) {
      const root = key.split('/', 1)[0];
      if (CALENDAR_SETTABLE_PROPERTIES.has(root)) {
        cleanUpdates[key] = value;
      }
    }

    const response = await this.request([
      ["Calendar/set", {
        accountId,
        update: {
          [calendarId]: cleanUpdates
        }
      }, "0"]
    ], this.calendarUsing());

    if (response.methodResponses?.[0]?.[0] === "Calendar/set") {
      const result = response.methodResponses[0][1];

      if (result.notUpdated?.[calendarId]) {
        const error = result.notUpdated[calendarId];
        throw new Error(error.description || "Failed to update calendar");
      }
      return;
    }

    throw new Error("Failed to update calendar");
  }

  /**
   * Mark a calendar as the account default. `isDefault` is read-only in
   * Stalwart's Calendar/set - the default is changed via the
   * `onSuccessSetIsDefault` request argument instead.
   */
  async setDefaultCalendar(calendarId: string, targetAccountId?: string): Promise<void> {
    const accountId = targetAccountId || this.getCalendarsAccountId();

    const response = await this.request([
      ["Calendar/set", {
        accountId,
        onSuccessSetIsDefault: calendarId
      }, "0"]
    ], this.calendarUsing());

    const methodName = response.methodResponses?.[0]?.[0];
    if (methodName === "error") {
      const error = response.methodResponses?.[0]?.[1];
      throw new Error(error?.description || error?.type || "Failed to set default calendar");
    }
    if (methodName !== "Calendar/set") {
      throw new Error("Failed to set default calendar");
    }
  }

  async deleteCalendar(calendarId: string, targetAccountId?: string): Promise<void> {
    const accountId = targetAccountId || this.getCalendarsAccountId();

    const response = await this.request([
      ["Calendar/set", {
        accountId,
        destroy: [calendarId],
        onDestroyRemoveEvents: true
      }, "0"]
    ], this.calendarUsing());

    if (response.methodResponses?.[0]?.[0] === "Calendar/set") {
      const result = response.methodResponses[0][1];

      if (result.notDestroyed?.[calendarId]) {
        const error = result.notDestroyed[calendarId];
        throw new Error(error.description || "Failed to delete calendar");
      }
      return;
    }

    throw new Error("Failed to delete calendar");
  }

  async getCalendarEvents(calendarIds?: string[], targetAccountId?: string): Promise<CalendarEvent[]> {
    const accountId = targetAccountId || this.getCalendarsAccountId();
    const GET_BATCH_SIZE = this.getMaxObjectsInGet();
    const timeZone = getUserTimeZone();

    const queryArgs: Record<string, unknown> = { accountId, limit: 1000 };
    if (timeZone) {
      queryArgs.timeZone = timeZone;
    }
    if (calendarIds && calendarIds.length > 0) {
      queryArgs.filter = buildInCalendarFilter(calendarIds);
    }

    // First, query to get all IDs
    const queryResponse = await this.request([
      ["CalendarEvent/query", queryArgs, "0"],
    ], this.calendarUsing());

    // Check for JMAP method-level errors
    if (queryResponse.methodResponses?.[0]?.[0] === "error") {
      const error = queryResponse.methodResponses[0][1];
      throw new Error(error?.description || error?.type || "CalendarEvent/query failed");
    }

    const ids: string[] = queryResponse.methodResponses?.[0]?.[1]?.ids || [];
    if (ids.length === 0) return [];

    // Batch the /get calls to stay within server max-objects limit
    const allEvents: CalendarEvent[] = [];
    for (let i = 0; i < ids.length; i += GET_BATCH_SIZE) {
      const batchIds = ids.slice(i, i + GET_BATCH_SIZE);
      const getResponse = await this.request([
        ["CalendarEvent/get", {
          accountId,
          properties: [...CALENDAR_EVENT_PROPERTIES],
          ids: batchIds,
          ...(timeZone ? { timeZone } : {}),
        }, "0"]
      ], this.calendarUsing());

      if (getResponse.methodResponses?.[0]?.[0] === "CalendarEvent/get") {
        const events = (getResponse.methodResponses[0][1].list || []) as CalendarEvent[];
        allEvents.push(...events);
      }
    }

    return allEvents
      .filter((event) => !isTaskObject(event))
      .map((event) => normalizeCalendarEventLike(event));
  }

  async queryAllCalendarEvents(
    filter: CalendarEventFilter,
    sort?: Array<{ property: string; isAscending: boolean }>,
    limit?: number
  ): Promise<CalendarEvent[]> {
    try {
      const allEvents: CalendarEvent[] = [];
      const primaryId = this.getCalendarsAccountId();
      const accountIds = this.getCalendarCapableAccountIds();

      for (const accountId of accountIds) {
        const isPrimary = accountId === primaryId;
        const account = this.accounts[accountId];

        try {
          const events = await this.queryCalendarEvents(filter, sort, limit, accountId);
          const mapped = events.map((event) => ({
            ...event,
            id: isPrimary ? event.id : `${accountId}:${event.id}`,
            originalId: event.id,
            originalCalendarIds: event.calendarIds,
            calendarIds: isPrimary ? (event.calendarIds || {}) : Object.fromEntries(
              Object.entries(event.calendarIds || {}).map(([calId, v]) => [`${accountId}:${calId}`, v])
            ),
            accountId,
            accountName: account?.name || (isPrimary ? this.username : accountId),
            isShared: !isPrimary,
          }));
          allEvents.push(...mapped);
        } catch (error) {
          console.error(`Failed to query calendar events for account ${accountId}:`, error);
        }
      }

      return allEvents;
    } catch (error) {
      console.error('Failed to query all calendar events:', error);
      return this.queryCalendarEvents(filter, sort, limit);
    }
  }

  async queryCalendarEvents(
    filter: CalendarEventFilter,
    sort?: Array<{ property: string; isAscending: boolean }>,
    limit?: number,
    targetAccountId?: string
  ): Promise<CalendarEvent[]> {
    try {
      const accountId = targetAccountId || this.getCalendarsAccountId();
      const timeZone = getUserTimeZone();

      const queryArgs: Record<string, unknown> = {
        accountId,
        filter,
        limit: limit || 1000,
      };
      // Interpret the LocalDateTime after/before filter values in the user's
      // time zone (Stalwart defaults to UTC, shifting range boundaries).
      if (timeZone) {
        queryArgs.timeZone = timeZone;
      }
      // NOTE: We do NOT use expandRecurrences because Stalwart returns synthetic
      // IDs that cannot be used for CalendarEvent/set (update/destroy).
      // Recurrence expansion is done client-side instead.
      if (sort) {
        queryArgs.sort = sort;
      }

      const GET_BATCH_SIZE = this.getMaxObjectsInGet();

      // First, query to get IDs
      const queryResponse = await this.request([
        ["CalendarEvent/query", queryArgs, "0"],
      ], this.calendarUsing());

      if (queryResponse.methodResponses?.[0]?.[0] === "error") {
        const error = queryResponse.methodResponses[0][1];
        throw new Error(error?.description || error?.type || "CalendarEvent/query failed");
      }

      const ids: string[] = queryResponse.methodResponses?.[0]?.[1]?.ids || [];
      if (ids.length === 0) return [];

      // Batch the /get calls to stay within server max-objects limit
      const allEvents: CalendarEvent[] = [];
      for (let i = 0; i < ids.length; i += GET_BATCH_SIZE) {
        const batchIds = ids.slice(i, i + GET_BATCH_SIZE);
        const getResponse = await this.request([
          ["CalendarEvent/get", {
            accountId,
            properties: [...CALENDAR_EVENT_PROPERTIES],
            ids: batchIds,
            ...(timeZone ? { timeZone } : {}),
          }, "0"]
        ], this.calendarUsing());

        if (getResponse.methodResponses?.[0]?.[0] === "CalendarEvent/get") {
          const events = (getResponse.methodResponses[0][1].list || []) as CalendarEvent[];
          allEvents.push(...events);
        }
      }

      const filtered = allEvents
        .filter((event) => !isTaskObject(event))
        .map((event) => normalizeCalendarEventLike(event));

      const eventsWithParticipants = filtered.filter(e => e.participants && Object.keys(e.participants).length > 0);
      debug.log('calendar', 'queryCalendarEvents participant summary', {
        totalEvents: filtered.length,
        eventsWithParticipants: eventsWithParticipants.length,
        details: eventsWithParticipants.map(e => ({
          id: e.id,
          title: e.title,
          participantCount: Object.keys(e.participants!).length,
          participants: e.participants,
          replyTo: e.replyTo,
        })),
      });

      return filtered;
    } catch (error) {
      console.error('Failed to query calendar events:', error);
      return [];
    }
  }

  async getCalendarEvent(id: string, targetAccountId?: string): Promise<CalendarEvent | null> {
    try {
      const accountId = targetAccountId || this.getCalendarsAccountId();
      const timeZone = getUserTimeZone();
      const response = await this.request([
        ["CalendarEvent/get", {
          accountId,
          properties: [...CALENDAR_EVENT_PROPERTIES],
          ids: [id],
          ...(timeZone ? { timeZone } : {}),
        }, "0"]
      ], this.calendarUsing());

      if (response.methodResponses?.[0]?.[0] === "CalendarEvent/get") {
        const list = response.methodResponses[0][1].list || [];
        return list[0] ? normalizeCalendarEventLike(list[0] as CalendarEvent) : null;
      }
      return null;
    } catch (error) {
      console.error('Failed to get calendar event:', error);
      return null;
    }
  }

  async createCalendarEvent(event: Partial<CalendarEvent>, sendSchedulingMessages?: boolean, targetAccountId?: string): Promise<CalendarEvent> {
    const accountId = targetAccountId || this.getCalendarsAccountId();

    // Strip client-only shared fields before sending to JMAP
    const { originalId: _oi, originalCalendarIds: _oc, accountId: _ai, accountName: _an, isShared: _is, ...cleanEvent } = event as CalendarEvent;
    cleanRecurrenceRules(cleanEvent as unknown as Record<string, unknown>);

    debug.group('CalendarEvent/create', 'calendar');
    debug.log('calendar', 'CalendarEvent/create outgoing payload', {
      accountId,
      sendSchedulingMessages,
      eventKeys: Object.keys(cleanEvent),
      hasParticipants: !!cleanEvent.participants,
      participantCount: cleanEvent.participants ? Object.keys(cleanEvent.participants).length : 0,
      participants: cleanEvent.participants || null,
      replyTo: cleanEvent.replyTo || null,
    });

    const setArgs: Record<string, unknown> = {
      accountId,
      create: {
        "new-event": cleanEvent
      }
    };
    if (sendSchedulingMessages !== undefined) {
      setArgs.sendSchedulingMessages = sendSchedulingMessages;
    }

    const response = await this.request([
      ["CalendarEvent/set", setArgs, "0"]
    ], this.calendarUsing());

    debug.log('calendar', 'CalendarEvent/create raw set response', response.methodResponses?.[0]?.[1] || null);

    if (response.methodResponses?.[0]?.[0] === "CalendarEvent/set") {
      const result = response.methodResponses[0][1];

      if (result.notCreated?.["new-event"]) {
        const error = result.notCreated["new-event"];
        debug.warn('calendar', 'CalendarEvent/create notCreated', error);
        debug.warn('calendar', 'CalendarEvent/create invalid properties', error.properties);
        debug.warn('calendar', 'CalendarEvent/create sent keys', Object.keys(cleanEvent));
        debug.groupEnd();
        throw new Error(error.description || "Failed to create calendar event");
      }

      const createdId = result.created?.["new-event"]?.id;
      debug.log('calendar', 'CalendarEvent/create server acknowledged created id', {
        createdId,
        created: result.created?.['new-event'] || null,
      });

      if (createdId) {
        const created = await this.getCalendarEvent(createdId, targetAccountId);
        debug.log('calendar', 'CalendarEvent/create fetched created event', {
          ...getCalendarEventDebugSnapshot(created),
          hasParticipants: !!created?.participants,
          participantCount: created?.participants ? Object.keys(created.participants).length : 0,
          participants: created?.participants || null,
          replyTo: created?.replyTo || null,
        });

        if (created?.uid) {
          try {
            const verificationMatches = await this.queryCalendarEvents({ uid: created.uid }, undefined, undefined, targetAccountId);
            debug.log('calendar', 'CalendarEvent/create verification query by uid', {
              uid: created.uid,
              matchCount: verificationMatches.length,
              matches: verificationMatches.map((match) => getCalendarEventDebugSnapshot(match)),
            });
          } catch (verificationError) {
            debug.warn('calendar', 'CalendarEvent/create verification query failed', verificationError);
          }
        }

        if (created) {
          debug.groupEnd();
          return created;
        }

        debug.warn('calendar', 'CalendarEvent/create server returned created id but CalendarEvent/get returned null', {
          createdId,
          targetAccountId,
        });
      }
    }

    debug.groupEnd();

    throw new Error("Failed to create calendar event");
  }

  /**
   * Batch-create multiple calendar events in a single JMAP request.
   * Returns arrays of successfully created events and failed creation keys.
   */
  async batchCreateCalendarEvents(
    events: Partial<CalendarEvent>[],
    targetAccountId?: string,
  ): Promise<{ created: CalendarEvent[]; failed: string[] }> {
    if (events.length === 0) return { created: [], failed: [] };

    const accountId = targetAccountId || this.getCalendarsAccountId();

    // Build the create map: { "new-0": event0, "new-1": event1, ... }
    const createMap: Record<string, Partial<CalendarEvent>> = {};
    for (let i = 0; i < events.length; i++) {
      const { originalId: _oi, originalCalendarIds: _oc, accountId: _ai, accountName: _an, isShared: _is, ...clean } = events[i] as CalendarEvent;
      cleanRecurrenceRules(clean as unknown as Record<string, unknown>);
      createMap[`new-${i}`] = clean;
    }

    debug.log('calendar', 'CalendarEvent/batchCreate', { count: events.length, accountId });

    // Never emit iMIP scheduling messages when importing. Imported events often
    // carry an organizer/participants where the current user is the organizer;
    // without this, Stalwart tries to send invitation emails to every attendee
    // synchronously during CalendarEvent/set, which is both wrong (importing a
    // calendar should not spam invites) and can block the request indefinitely,
    // leaving the import spinner spinning forever (#411).
    const response = await this.request([
      ["CalendarEvent/set", { accountId, sendSchedulingMessages: false, create: createMap }, "0"]
    ], this.calendarUsing());

    const createdIds: string[] = [];
    const failed: string[] = [];

    if (response.methodResponses?.[0]?.[0] === "CalendarEvent/set") {
      const result = response.methodResponses[0][1];
      for (let i = 0; i < events.length; i++) {
        const key = `new-${i}`;
        if (result.created?.[key]?.id) {
          createdIds.push(result.created[key].id);
        } else if (result.notCreated?.[key]) {
          debug.warn('calendar', `CalendarEvent/batchCreate failed for ${key}`, result.notCreated[key]);
          failed.push(key);
        }
      }
    }

    if (createdIds.length === 0) {
      return { created: [], failed };
    }

    // Fetch all created events in a single CalendarEvent/get
    const refetchTimeZone = getUserTimeZone();
    const getResponse = await this.request([
      ["CalendarEvent/get", {
        accountId,
        properties: [...CALENDAR_EVENT_PROPERTIES],
        ids: createdIds,
        ...(refetchTimeZone ? { timeZone: refetchTimeZone } : {}),
      }, "0"]
    ], this.calendarUsing());

    let createdEvents: CalendarEvent[] = [];
    if (getResponse.methodResponses?.[0]?.[0] === "CalendarEvent/get") {
      const list = getResponse.methodResponses[0][1].list || [];
      createdEvents = list.map((e: CalendarEvent) => normalizeCalendarEventLike(e));
    }

    debug.log('calendar', 'CalendarEvent/batchCreate result', {
      requested: events.length,
      created: createdEvents.length,
      failed: failed.length,
    });

    return { created: createdEvents, failed };
  }

  async updateCalendarEvent(
    eventId: string,
    updates: Partial<CalendarEvent>,
    sendSchedulingMessages?: boolean,
    targetAccountId?: string
  ): Promise<void> {
    const accountId = targetAccountId || this.getCalendarsAccountId();

    // Strip client-only and server-immutable fields before sending to JMAP
    const { id: _id, uid: _uid, '@type': _typ, created: _cr, updated: _up, sequence: _sq, isOrigin: _io, isDraft: _idr, originalId: _oi, originalCalendarIds: _oc, accountId: _ai, accountName: _an, isShared: _is, ...cleanUpdates } = updates as CalendarEvent;
    cleanRecurrenceRules(cleanUpdates as unknown as Record<string, unknown>);

    const setArgs: Record<string, unknown> = {
      accountId,
      update: {
        [eventId]: cleanUpdates
      }
    };
    if (sendSchedulingMessages !== undefined) {
      setArgs.sendSchedulingMessages = sendSchedulingMessages;
    }

    debug.log('calendar', 'CalendarEvent/set update request', {
      eventId,
      accountId,
      cleanUpdateKeys: Object.keys(cleanUpdates),
      sendSchedulingMessages,
      hasParticipants: !!cleanUpdates.participants,
      participantCount: cleanUpdates.participants ? Object.keys(cleanUpdates.participants).length : 0,
      participants: cleanUpdates.participants || null,
      replyTo: (cleanUpdates as Record<string, unknown>).replyTo || null,
    });

    const response = await this.request([
      ["CalendarEvent/set", setArgs, "0"]
    ], this.calendarUsing());

    const methodName = response.methodResponses?.[0]?.[0];
    const result = response.methodResponses?.[0]?.[1];

    if (methodName === "error") {
      const errorType = result?.type || 'unknown';
      const errorDesc = result?.description || '';
      debug.error('CalendarEvent/set update returned JMAP error', { type: errorType, description: errorDesc });
      throw new Error(`JMAP error (${errorType}): ${errorDesc}`);
    }

    if (methodName === "CalendarEvent/set") {
      if (result.notUpdated?.[eventId]) {
        const error = result.notUpdated[eventId];
        debug.error('CalendarEvent/set notUpdated', { eventId, error });
        throw new Error(error.description || "Failed to update calendar event");
      }
      debug.log('calendar', 'CalendarEvent/set update full response', { methodName, result });
      debug.log('calendar', 'CalendarEvent/set update success', { eventId, updated: result.updated ? Object.keys(result.updated) : null });
      return;
    }

    debug.error('CalendarEvent/set update unexpected response', { methodName, result });
    throw new Error("Failed to update calendar event");
  }

  async parseCalendarEvents(accountId: string, blobId: string): Promise<Partial<CalendarEvent>[]> {
    const response = await this.request([
      ["CalendarEvent/parse", {
        accountId,
        blobIds: [blobId],
      }, "0"]
    ], this.calendarUsing());

    if (response.methodResponses?.[0]?.[0] === "CalendarEvent/parse") {
      const result = response.methodResponses[0][1];
      console.log('[PARSE DEBUG] CalendarEvent/parse raw result:', JSON.stringify(result, null, 2));

      if (result.notParsable && result.notParsable.includes(blobId)) {
        throw new Error("Invalid calendar file format");
      }

      if (result.notFound && result.notFound.includes(blobId)) {
        throw new Error("Uploaded file not found");
      }

      const parsed = result.parsed?.[blobId];
      if (parsed) {
        return (Array.isArray(parsed) ? parsed : [parsed])
          .map((event) => normalizeCalendarEventLike(event as Partial<CalendarEvent>));
      }

      return [];
    }

    throw new Error("Failed to parse calendar file");
  }

  async deleteCalendarEvent(eventId: string, sendSchedulingMessages?: boolean, targetAccountId?: string): Promise<void> {
    const accountId = targetAccountId || this.getCalendarsAccountId();

    const setArgs: Record<string, unknown> = {
      accountId,
      destroy: [eventId]
    };
    if (sendSchedulingMessages !== undefined) {
      setArgs.sendSchedulingMessages = sendSchedulingMessages;
    }

    debug.log('calendar', 'CalendarEvent/set destroy request', { eventId, accountId, sendSchedulingMessages });

    const response = await this.request([
      ["CalendarEvent/set", setArgs, "0"]
    ], this.calendarUsing());

    const methodName = response.methodResponses?.[0]?.[0];
    const result = response.methodResponses?.[0]?.[1];

    if (methodName === "error") {
      const errorType = result?.type || 'unknown';
      const errorDesc = result?.description || '';
      debug.error('CalendarEvent/set destroy returned JMAP error', { type: errorType, description: errorDesc });
      throw new Error(`JMAP error (${errorType}): ${errorDesc}`);
    }

    if (methodName === "CalendarEvent/set") {
      if (result.notDestroyed?.[eventId]) {
        const error = result.notDestroyed[eventId];
        debug.error('CalendarEvent/set notDestroyed', { eventId, error });
        throw new Error(error.description || "Failed to delete calendar event");
      }
      debug.log('calendar', 'CalendarEvent/set destroy success', { eventId, destroyed: result.destroyed });
      return;
    }

    debug.error('CalendarEvent/set destroy unexpected response', { methodName, result });
    throw new Error("Failed to delete calendar event");
  }

  async batchDeleteCalendarEvents(eventIds: string[], targetAccountId?: string): Promise<{ destroyed: string[]; notDestroyed: string[] }> {
    if (eventIds.length === 0) return { destroyed: [], notDestroyed: [] };

    const accountId = targetAccountId || this.getCalendarsAccountId();
    const response = await this.request([
      ["CalendarEvent/set", { accountId, destroy: eventIds }, "0"]
    ], this.calendarUsing());

    const destroyed: string[] = [];
    const notDestroyed: string[] = [];

    if (response.methodResponses?.[0]?.[0] === "CalendarEvent/set") {
      const result = response.methodResponses[0][1];
      if (result.destroyed) destroyed.push(...result.destroyed);
      if (result.notDestroyed) notDestroyed.push(...Object.keys(result.notDestroyed));
    }

    return { destroyed, notDestroyed };
  }

  // ─── Calendar Tasks (JSCalendar Task objects via CalendarEvent endpoints) ───

  /**
   * Fetch all Task objects via the CalendarEvent endpoints.
   *
   * Stalwart has no `types` filter on CalendarEvent/query (it fails the whole
   * query with `unsupportedFilter`), and the previous CalendarEvent/get
   * ids:null fallback was capped at the server's maxObjectsInGet (500 by
   * default), silently hiding tasks in larger accounts. Instead, page through
   * CalendarEvent/query (which returns events *and* tasks), fetch in
   * /get-sized batches, and detect tasks client-side.
   */
  async getCalendarTasks(calendarIds?: string[], targetAccountId?: string): Promise<CalendarTask[]> {
    const accountId = targetAccountId || this.getCalendarsAccountId();
    debug.group('CalendarTask/fetch', 'tasks');
    debug.log('tasks', 'CalendarTask/fetch start', { accountId, calendarIds: calendarIds || 'all' });

    try {
      // Page through the query to collect all object ids.
      const QUERY_PAGE = 1000;
      const MAX_IDS = 50000; // safety bound
      const timeZone = getUserTimeZone();
      const ids: string[] = [];
      for (let position = 0; position < MAX_IDS;) {
        const queryArgs: Record<string, unknown> = { accountId, limit: QUERY_PAGE, position };
        if (timeZone) {
          queryArgs.timeZone = timeZone;
        }
        if (calendarIds && calendarIds.length > 0) {
          queryArgs.filter = buildInCalendarFilter(calendarIds);
        }
        const response = await this.request([
          ["CalendarEvent/query", queryArgs, "0"],
        ], this.calendarUsing());

        if (response.methodResponses?.[0]?.[0] === "error") {
          const error = response.methodResponses[0][1];
          debug.warn('tasks', 'CalendarTask/fetch query failed', error);
          debug.groupEnd();
          return [];
        }

        const pageIds: string[] = response.methodResponses?.[0]?.[1]?.ids || [];
        ids.push(...pageIds);
        if (pageIds.length < QUERY_PAGE) break;
        position += pageIds.length;
      }

      debug.log('tasks', 'CalendarTask/fetch query returned', ids.length, 'object ids');
      if (ids.length === 0) {
        debug.groupEnd();
        return [];
      }

      // Fetch the objects in batches that respect the server's /get limit.
      const GET_BATCH_SIZE = this.getMaxObjectsInGet();
      const allObjects: Record<string, unknown>[] = [];
      for (let i = 0; i < ids.length; i += GET_BATCH_SIZE) {
        const batchIds = ids.slice(i, i + GET_BATCH_SIZE);
        const getResponse = await this.request([
          ["CalendarEvent/get", {
            accountId,
            properties: [...CALENDAR_TASK_PROPERTIES],
            ids: batchIds,
            ...(timeZone ? { timeZone } : {}),
          }, "0"]
        ], this.calendarUsing());

        if (getResponse.methodResponses?.[0]?.[0] === "CalendarEvent/get") {
          allObjects.push(...(getResponse.methodResponses[0][1].list || []));
        }
      }

      const tasks: CalendarTask[] = [];
      for (const obj of allObjects) {
        const type = obj['@type'];
        const isExplicitTask = typeof type === 'string' && type.toLowerCase() === 'task';
        // CalDAV-created tasks (e.g. Thunderbird) may lack @type or have @type
        // set to something other than 'Event'. Detect them by the presence of
        // task-specific keys (due, progress, percentComplete), which RFC 8984 §5.2
        // defines as Task-only - a VEVENT will never include them in the response.
        // We check for key presence (even if null) because Stalwart may return null
        // instead of the RFC defaults (e.g. progress default is "needs-action").
        // @see https://www.rfc-editor.org/rfc/rfc8984#section-5.2
        const hasTaskFields = ('due' in obj)
          || ('progress' in obj)
          || ('percentComplete' in obj);
        const isCalDavTask = type !== 'Event' && hasTaskFields;

        if (!isExplicitTask && !isCalDavTask) continue;

        tasks.push({ ...obj, '@type': 'Task' as const } as CalendarTask);
      }

      debug.log('tasks', 'CalendarTask/fetch complete,', tasks.length, 'tasks of', allObjects.length, 'objects');
      debug.groupEnd();
      return tasks;
    } catch (error) {
      debug.error('CalendarTask/fetch failed', error);
      debug.groupEnd();
      return [];
    }
  }

  async createCalendarTask(task: Partial<CalendarTask>, targetAccountId?: string): Promise<CalendarTask> {
    const accountId = targetAccountId || this.getCalendarsAccountId();
    const { '@type': _type, ...taskData } = task;
    const cleanTask = { ...taskData, '@type': 'Task' };

    debug.group('CalendarTask/create', 'tasks');
    debug.log('tasks', 'CalendarTask/create accountId', accountId);
    debug.log('tasks', 'CalendarTask/create outgoing payload', cleanTask);

    const response = await this.request([
      ["CalendarEvent/set", {
        accountId,
        sendSchedulingMessages: false,
        create: { "new-task": cleanTask },
      }, "0"]
    ], this.calendarUsing());

    const result = response.methodResponses?.[0]?.[1];
    debug.log('tasks', 'CalendarTask/create raw set response', result);

    if (result?.notCreated?.["new-task"]) {
      const error = result.notCreated["new-task"];
      debug.warn('tasks', 'CalendarTask/create REJECTED by server', error);
      debug.groupEnd();
      throw new Error(error.description || "Failed to create task");
    }

    const createdId = result?.created?.["new-task"]?.id;
    const serverCreated = result?.created?.["new-task"];
    debug.log('tasks', 'CalendarTask/create server acknowledged', { createdId, serverCreated });

    if (!createdId) {
      debug.warn('tasks', 'CalendarTask/create no id in server response');
      debug.groupEnd();
      throw new Error("Failed to create task - no id returned");
    }

    // Fetch back with task-specific properties
    debug.log('calendar', 'CalendarTask/create re-fetching with task properties', { createdId, properties: [...CALENDAR_TASK_PROPERTIES] });
    const refetchTimeZone = getUserTimeZone();
    const getResponse = await this.request([
      ["CalendarEvent/get", {
        accountId,
        properties: [...CALENDAR_TASK_PROPERTIES],
        ids: [createdId],
        ...(refetchTimeZone ? { timeZone: refetchTimeZone } : {}),
      }, "0"]
    ], this.calendarUsing());

    if (getResponse.methodResponses?.[0]?.[0] === "CalendarEvent/get") {
      const list = getResponse.methodResponses[0][1].list || [];
      const notFound = getResponse.methodResponses[0][1].notFound || [];
      debug.log('calendar', 'CalendarTask/create get response', { found: list.length, notFound });
      if (list[0]) {
        const created = { ...list[0], '@type': 'Task' as const } as CalendarTask;
        debug.log('tasks', 'CalendarTask/create final task object', {
          id: created.id,
          uid: created.uid,
          '@type': created['@type'],
          title: created.title,
          due: created.due,
          start: created.start,
          progress: created.progress,
          showWithoutTime: created.showWithoutTime,
          calendarIds: created.calendarIds,
        });
        debug.groupEnd();
        return created;
      }
    }

    debug.warn('tasks', 'CalendarTask/create re-fetch returned nothing for id', createdId);
    debug.groupEnd();
    throw new Error("Failed to fetch created task");
  }

  async updateCalendarTask(taskId: string, updates: Partial<CalendarTask>, targetAccountId?: string): Promise<void> {
    await this.updateCalendarEvent(taskId, updates as unknown as Partial<CalendarEvent>, false, targetAccountId);
  }

  async deleteCalendarTask(taskId: string, targetAccountId?: string): Promise<void> {
    await this.deleteCalendarEvent(taskId, false, targetAccountId);
  }

  // ─── JMAP FileNode methods (draft-ietf-jmap-filenode) ───

  supportsFiles(accountId?: string): boolean {
    // Gate on the ACCOUNT capability, not the server-wide session capability.
    // A server can advertise urn:ietf:params:jmap:filenode while a specific
    // account has its jmap-file-node-* permissions revoked, in which case the
    // capability is absent from that account's accountCapabilities and every
    // FileNode action fails with an authorization error (#563). Mirror
    // getFilesCapableAccountIds(): non-personal (shared/group) accounts don't
    // always advertise per-account, so treat those as capable.
    const id = accountId || this.accountId;
    const account = this.accounts[id];
    if (!account) return false;
    return !!account.accountCapabilities?.["urn:ietf:params:jmap:filenode"] || !account.isPersonal;
  }

  async probeFileNodeSupport(): Promise<boolean> {
    // Some servers support FileNode without advertising a specific capability.
    // Try a minimal FileNode/query to detect support at runtime.
    if (this.supportsFiles()) return true;
    // If the server advertises FileNode server-wide but this account's
    // accountCapabilities omits it, that's an explicit per-account denial (#563)
    // - don't probe (the probe would only confirm the revoked account can't use
    // it, or worse mislead). Only fall through for servers that don't advertise
    // the capability at all.
    if (this.hasCapability("urn:ietf:params:jmap:filenode")) return false;
    if (!this.apiUrl) return false;
    try {
      const accountId = this.getFilesAccountId();
      const response = await this.authenticatedFetch(this.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          using: ["urn:ietf:params:jmap:core"],
          methodCalls: [["FileNode/query", { accountId, filter: {}, limit: 1 }, "probe0"]],
        }),
      });
      if (!response.ok) return false;
      const data = await response.json();
      const result = data.methodResponses?.[0];
      return result && result[0] === "FileNode/query";
    } catch {
      return false;
    }
  }

  getFilesAccountId(): string {
    const filesAccount = this.session?.primaryAccounts?.["urn:ietf:params:jmap:filenode"];
    return filesAccount || this.accountId;
  }

  private fileUsing(): string[] {
    const using = ["urn:ietf:params:jmap:core"];
    if (this.hasCapability("urn:ietf:params:jmap:filenode")) {
      using.push("urn:ietf:params:jmap:filenode");
    }
    // Required for shareWith/myRights on FileNode and for cross-account
    // (shared-with-me) FileNode/get, mirroring calendarUsing().
    if (this.supportsPrincipals()) {
      using.push("urn:ietf:params:jmap:principals:owner");
    }
    return using;
  }

  private static FILE_NODE_PROPERTIES = [
    "id", "parentId", "name", "type", "blobId", "size", "created", "updated",
    // Stalwart omits shareWith/myRights from FileNode/get unless requested
    // explicitly, so the share dialog and indicators can't see existing
    // shares without naming them here (same as CALENDAR_PROPERTIES).
    "shareWith", "myRights",
  ];

  // Accounts (primary + shared/group) that can hold FileNodes. Mirrors
  // getCalendarCapableAccountIds(): includes any non-primary account that
  // advertises the filenode capability or is a non-personal (shared/group)
  // account, since Stalwart doesn't always advertise capabilities on those.
  private getFilesCapableAccountIds(): string[] {
    const primaryId = this.getFilesAccountId();
    const accountIds: string[] = [];
    for (const [id, account] of Object.entries(this.accounts)) {
      if (id === primaryId) continue;
      if (account.accountCapabilities?.["urn:ietf:params:jmap:filenode"] || !account.isPersonal) {
        accountIds.push(id);
      }
    }
    return [primaryId, ...accountIds];
  }

  async getFileNodes(ids: string[] | null, properties?: string[]): Promise<FileNode[]> {
    const accountId = this.getFilesAccountId();
    const args: Record<string, unknown> = { accountId, ids, properties: properties || JMAPClient.FILE_NODE_PROPERTIES };

    const response = await this.request(
      [["FileNode/get", args, "fn0"]],
      this.fileUsing(),
    );

    const result = response.methodResponses?.[0];
    if (!result || result[0] === "error") {
      throw new Error(result?.[1]?.description || "FileNode/get failed");
    }
    return (result[1].list || []) as FileNode[];
  }

  async queryFileNodes(filter: FileNodeFilter, sort?: { property: string; isAscending: boolean }[]): Promise<string[]> {
    const accountId = this.getFilesAccountId();
    const args: Record<string, unknown> = { accountId, filter };
    if (sort) args.sort = sort;

    const response = await this.request(
      [["FileNode/query", args, "fnq0"]],
      this.fileUsing(),
    );

    const result = response.methodResponses?.[0];
    if (!result || result[0] === "error") {
      throw new Error(result?.[1]?.description || "FileNode/query failed");
    }
    return (result[1].ids || []) as string[];
  }

  async listFileNodes(parentId: string | null): Promise<FileNode[]> {
    // FileNode/query omits folder nodes in Stalwart (see listAllFileNodes), so
    // we enumerate the whole account and filter children client-side.
    const all = await this.listAllFileNodes();
    return all.filter(n => (n.parentId ?? null) === parentId);
  }

  /**
   * Fetch every FileNode in the account, files AND folders, to build the folder
   * hierarchy client-side from parentId links.
   *
   * IMPORTANT: this uses `FileNode/get` with `ids: null` (return-all), NOT
   * `FileNode/query`. Stalwart's FileNode/query only returns leaf files - it
   * omits container (folder) nodes entirely - so a query-based listing made
   * every folder invisible (the whole account looked like a single root file).
   */
  async listAllFileNodes(): Promise<FileNode[]> {
    const accountId = this.getFilesAccountId();

    const response = await this.request(
      [["FileNode/get", { accountId, ids: null, properties: JMAPClient.FILE_NODE_PROPERTIES }, "fng0"]],
      this.fileUsing(),
    );

    const getResult = response.methodResponses?.find(r => r[0] === "FileNode/get" || (r[0] === "error" && r[2] === "fng0"));
    if (!getResult || getResult[0] === "error") {
      console.error('[Files] FileNode/get error:', getResult?.[1]);
      throw new Error(getResult?.[1]?.description || "FileNode list failed");
    }
    return (getResult[1].list || []) as FileNode[];
  }

  /**
   * Fetch every FileNode the logged-in user can see across all connected and
   * shared accounts. Nodes owned by another principal (shared with the user)
   * are tagged with `isShared: true` and the owning `accountId`/`accountName`,
   * and their ids are namespaced `accountId:nodeId` so they don't collide with
   * the primary account's ids. Mirrors getAllCalendars().
   */
  async listAllFileNodesAcrossAccounts(): Promise<FileNode[]> {
    const primaryId = this.getFilesAccountId();
    const accountIds = this.getFilesCapableAccountIds();
    const all: FileNode[] = [];

    for (const accountId of accountIds) {
      const isPrimary = accountId === primaryId;
      const account = this.accounts[accountId];
      try {
        const response = await this.request(
          [["FileNode/get", { accountId, ids: null, properties: JMAPClient.FILE_NODE_PROPERTIES }, "fng0"]],
          this.fileUsing(),
        );
        const getResult = response.methodResponses?.find(r => r[0] === "FileNode/get");
        if (!getResult || getResult[0] === "error") continue;
        const nodes = (getResult[1].list || []) as FileNode[];
        for (const node of nodes) {
          all.push({
            ...node,
            id: isPrimary ? node.id : `${accountId}:${node.id}`,
            parentId: node.parentId == null
              ? null
              : (isPrimary ? node.parentId : `${accountId}:${node.parentId}`),
            accountId,
            accountName: account?.name || (isPrimary ? this.username : accountId),
            isShared: !isPrimary,
          });
        }
      } catch (error) {
        console.error(`[Files] Failed to fetch FileNodes for account ${accountId}:`, error);
      }
    }

    return all;
  }

  /**
   * Add, update, or remove a principal's rights on a FileNode (file or folder).
   * Pass `rights: null` to revoke access. Mirrors setCalendarShare /
   * setAddressBookShare; Stalwart applies it via a `shareWith/{principalId}`
   * patch on FileNode/set.
   */
  async setFileNodeShare(
    fileNodeId: string,
    principalId: string,
    rights: FileNodeRights | null,
    targetAccountId?: string,
  ): Promise<void> {
    const accountId = targetAccountId || this.getFilesAccountId();
    const response = await this.request([
      ["FileNode/set", {
        accountId,
        update: { [fileNodeId]: { [`shareWith/${principalId}`]: rights } },
      }, "0"],
    ], this.fileUsing());

    const result = response.methodResponses?.[0]?.[1];
    if (result?.notUpdated?.[fileNodeId]) {
      const err = result.notUpdated[fileNodeId];
      throw new Error(err.description || "Failed to update file share");
    }
    if (!result?.updated || !(fileNodeId in result.updated)) {
      throw new Error("Server did not confirm the share update");
    }
  }

  async createFileDirectory(name: string, parentId: string | null): Promise<FileNode> {
    const accountId = this.getFilesAccountId();

    // A FileNode is a folder (container) only when it has no content - i.e. no
    // blobId, type or size, so the server stores it with `file == null`. Sending
    // any of those - as older builds did (type "d" + an empty blob) - makes it a
    // 0-byte FILE that nothing can ever be parented under, which is what caused
    // "Parent ID does not exist or is not a folder" during the #379 migration.
    const dirProps: Record<string, unknown> = { name };
    if (parentId !== null) {
      dirProps.parentId = parentId;
    }

    const response = await this.request(
      [["FileNode/set", {
        accountId,
        create: {
          dir0: dirProps,
        },
      }, "fns0"]],
      this.fileUsing(),
    );

    const result = response.methodResponses?.[0];
    if (!result || result[0] === "error") {
      throw new Error(result?.[1]?.description || "FileNode/set create failed");
    }
    const created = result[1].created?.dir0;
    if (!created) {
      const err = result[1].notCreated?.dir0;
      throw new Error(err?.description || "Failed to create directory");
    }
    return created as FileNode;
  }

  async createFileNode(name: string, blobId: string, type: string, size: number, parentId: string | null): Promise<FileNode> {
    const accountId = this.getFilesAccountId();

    //fall back for long MIME types
    const safeType = type.length > 30 ? 'application/octet-stream' : type;
    const fileProps: Record<string, unknown> = { name, type: safeType, blobId, size };
    if (parentId !== null) {
      fileProps.parentId = parentId;
    }

    const response = await this.request(
      [["FileNode/set", {
        accountId,
        create: {
          file0: fileProps,
        },
      }, "fns0"]],
      this.fileUsing(),
    );

    const result = response.methodResponses?.[0];
    if (!result || result[0] === "error") {
      throw new Error(result?.[1]?.description || "FileNode/set create failed");
    }
    const created = result[1].created?.file0;
    if (!created) {
      const err = result[1].notCreated?.file0;
      throw new Error(err?.description || "Failed to create file node");
    }
    return created as FileNode;
  }

  async updateFileNode(id: string, updates: Partial<Pick<FileNode, 'name' | 'parentId'>>): Promise<void> {
    const accountId = this.getFilesAccountId();

    const response = await this.request(
      [["FileNode/set", {
        accountId,
        update: { [id]: updates },
      }, "fns0"]],
      this.fileUsing(),
    );

    const result = response.methodResponses?.[0];
    if (!result || result[0] === "error") {
      throw new Error(result?.[1]?.description || "FileNode/set update failed");
    }
    if (result[1].notUpdated?.[id]) {
      throw new Error(result[1].notUpdated[id].description || "Failed to update file node");
    }
  }

  /**
   * Update many FileNodes in a single FileNode/set call. Returns the ids that
   * were updated and a map of id -> error for any the server rejected. Never
   * throws for per-node failures (only for a whole-method error).
   */
  async updateFileNodes(updates: Record<string, Partial<Pick<FileNode, 'name' | 'parentId'>>>): Promise<{ updated: string[]; notUpdated: Record<string, string> }> {
    const ids = Object.keys(updates);
    if (ids.length === 0) return { updated: [], notUpdated: {} };
    const accountId = this.getFilesAccountId();

    const response = await this.request(
      [["FileNode/set", { accountId, update: updates }, "fns0"]],
      this.fileUsing(),
    );

    const result = response.methodResponses?.[0];
    if (!result || result[0] === "error") {
      throw new Error(result?.[1]?.description || "FileNode/set update failed");
    }

    const updatedMap: Record<string, unknown> = result[1].updated || {};
    const notUpdatedMap: Record<string, { description?: string }> = result[1].notUpdated || {};
    const notUpdated: Record<string, string> = {};
    for (const id of Object.keys(notUpdatedMap)) {
      notUpdated[id] = notUpdatedMap[id]?.description || 'not updated';
    }
    // Servers may omit the `updated` map; treat anything not rejected as updated.
    const updated = Object.keys(updatedMap).length > 0
      ? Object.keys(updatedMap)
      : ids.filter(id => !(id in notUpdated));
    return { updated, notUpdated };
  }

  async destroyFileNodes(ids: string[]): Promise<{ destroyed: string[]; notDestroyed: string[] }> {
    const accountId = this.getFilesAccountId();

    const response = await this.request(
      [["FileNode/set", {
        accountId,
        destroy: ids,
        onDestroyRemoveChildren: true,
      }, "fns0"]],
      this.fileUsing(),
    );

    const result = response.methodResponses?.[0];
    if (!result || result[0] === "error") {
      throw new Error(result?.[1]?.description || "FileNode/set destroy failed");
    }

    const notDestroyedMap: Record<string, { type?: string; description?: string }> = result[1].notDestroyed || {};
    const notDestroyedIds = Object.keys(notDestroyedMap);

    if (notDestroyedIds.length > 0) {
      const firstError = notDestroyedMap[notDestroyedIds[0]];
      throw new Error(firstError?.description || `Failed to delete ${notDestroyedIds.length} file(s)`);
    }

    return {
      destroyed: result[1].destroyed || [],
      notDestroyed: [],
    };
  }

  async copyFileNode(id: string, newName: string, parentId: string | null): Promise<FileNode> {
    // Copy: get original, upload blob reference, create new node
    const nodes = await this.getFileNodes([id]);
    if (nodes.length === 0) throw new Error('File node not found');
    const original = nodes[0];

    const accountId = this.getFilesAccountId();
    const createProps: Record<string, unknown> = {
      name: newName,
      type: original.type,
      blobId: original.blobId,
      size: original.size,
    };
    if (parentId !== null) {
      createProps.parentId = parentId;
    }

    const response = await this.request(
      [["FileNode/set", {
        accountId,
        create: {
          copy0: createProps,
        },
      }, "fns0"]],
      this.fileUsing(),
    );

    const result = response.methodResponses?.[0];
    if (!result || result[0] === "error") {
      throw new Error(result?.[1]?.description || "FileNode copy failed");
    }
    const created = result[1].created?.copy0;
    if (!created) {
      const err = result[1].notCreated?.copy0;
      throw new Error(err?.description || "Failed to copy file node");
    }
    return created as FileNode;
  }

  async downloadBlob(blobId: string, name?: string, type?: string): Promise<void> {
    const blob = await this.fetchBlob(blobId, name, type);
    const blobUrl = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = name || 'download';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
  }

  private pollingInterval: NodeJS.Timeout | null = null;
  private pollingStates: { [key: string]: string } = {};
  private sseAbortController: AbortController | null = null;
  private sseReconnectTimeout: NodeJS.Timeout | null = null;
  private ssePingTimer: NodeJS.Timeout | null = null;
  private lastSSEActivity: number = 0;
  private visibilityHandler: (() => void) | null = null;
  private onlineHandler: (() => void) | null = null;

  private static readonly STATE_TYPE_MAP: Record<string, string> = {
    'Mailbox/get': 'Mailbox',
    'Email/get': 'Email',
    'Calendar/get': 'Calendar',
    'CalendarEvent/get': 'CalendarEvent',
    'SieveScript/get': 'SieveScript',
  };

  private static readonly POLLING_INTERVAL = 3_000;
  private static readonly SSE_RECONNECT_DELAY = 3_000;
  private static readonly SSE_PING_TIMEOUT = 90_000; // 3x the 30s ping interval

  setupPushNotifications(): boolean {
    const eventSourceUrl = this.getEventSourceUrl();
    if (eventSourceUrl) {
      this.connectSSE(eventSourceUrl);
    } else {
      this.startPollingFallback();
    }
    this.setupBrowserEventListeners();
    return true;
  }

  private connectSSE(templateUrl: string): void {
    if (this.isRateLimited()) {
      this.scheduleSSEReconnect();
      return;
    }

    const url = templateUrl
      .replace('{types}', '*')
      .replace('{closeafter}', 'no')
      .replace('{ping}', '30');

    this.sseAbortController = new AbortController();

    this.authenticatedFetch(url, {
      headers: { 'Accept': 'text/event-stream' },
      signal: this.sseAbortController.signal,
    }).then(response => {
      if (!response.ok || !response.body) {
        this.fallbackToPolling();
        return;
      }
      this.readSSEStream(response.body);
    }).catch((error) => {
      if (error instanceof RateLimitError) {
        this.sseAbortController = null;
        this.scheduleSSEReconnect();
        return;
      }
      this.fallbackToPolling();
    });
  }

  private async readSSEStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    this.lastSSEActivity = Date.now();
    this.startSSEPingMonitor();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        this.lastSSEActivity = Date.now();

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          this.processSSEEvent(part);
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
    }

    this.stopSSEPingMonitor();

    // Stream ended - reconnect unless we were intentionally closed
    if (this.sseAbortController && !this.sseAbortController.signal.aborted) {
      this.scheduleSSEReconnect();
    }
  }

  private processSSEEvent(raw: string): void {
    let eventType = 'message';
    let dataLines: string[] = [];

    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }

    if (eventType === 'state' && dataLines.length > 0) {
      try {
        const change = JSON.parse(dataLines.join('\n')) as StateChange;
        this.stateChangeCallback?.(change);
      } catch {
        // Malformed SSE data - ignore
      }
    }
  }

  private scheduleSSEReconnect(): void {
    if (this.intentionallyDisconnected) return;
    const eventSourceUrl = this.getEventSourceUrl();
    if (!eventSourceUrl) {
      this.fallbackToPolling();
      return;
    }
    const delay = this.isRateLimited()
      ? Math.max(this.rateLimitedUntil - Date.now(), JMAPClient.SSE_RECONNECT_DELAY)
      : JMAPClient.SSE_RECONNECT_DELAY;
    this.sseReconnectTimeout = setTimeout(() => {
      if (this.isRateLimited()) {
        this.scheduleSSEReconnect();
        return;
      }
      this.connectSSE(eventSourceUrl);
    }, delay);
  }

  private fallbackToPolling(): void {
    this.sseAbortController = null;
    if (!this.pollingInterval) {
      this.startPollingFallback();
    }
  }

  private startPollingFallback(): void {
    if (this.intentionallyDisconnected) return;
    if (this.isRateLimited()) {
      return;
    }
    this.fetchCurrentStates();
    this.pollingInterval = setInterval(() => {
      this.checkForStateChanges();
    }, JMAPClient.POLLING_INTERVAL);
  }

  private buildStatePollingRequest(): { using: string[]; methodCalls: JMAPMethodCall[] } {
    const using = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'];
    const methodCalls: JMAPMethodCall[] = [
      ['Mailbox/get', { accountId: this.accountId, ids: null, properties: ['id'] }, 'a'],
      ['Email/get', { accountId: this.accountId, ids: [], properties: ['id'] }, 'b'],
    ];

    if (this.supportsCalendars()) {
      using.push('urn:ietf:params:jmap:calendars');
      const calAccountId = this.getCalendarsAccountId();
      methodCalls.push(
        ['Calendar/get', { accountId: calAccountId, ids: null, properties: ['id'] }, 'c'],
        ['CalendarEvent/get', { accountId: calAccountId, ids: [], properties: ['id'] }, 'd'],
      );
    }

    if (this.supportsSieve()) {
      using.push('urn:ietf:params:jmap:sieve');
      methodCalls.push(
        ['SieveScript/get', { accountId: this.getSieveAccountId(), ids: [], properties: ['id'] }, 'e'],
      );
    }

    return { using, methodCalls };
  }

  private async fetchCurrentStates(): Promise<void> {
    if (this.isRateLimited()) {
      return;
    }
    try {
      const { using, methodCalls } = this.buildStatePollingRequest();
      const response = await this.authenticatedFetch(this.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ using, methodCalls }),
      });

      if (response.ok) {
        const data = await response.json();
        for (const [method, result] of data.methodResponses) {
          const stateKey = JMAPClient.STATE_TYPE_MAP[method];
          if (stateKey && result.state) {
            this.pollingStates[stateKey] = result.state;
          }
        }
      }
    } catch {
      // Silently fail - polling will retry
    }
  }

  private async checkForStateChanges(): Promise<void> {
    if (this.isRateLimited()) {
      return;
    }
    try {
      const { using, methodCalls } = this.buildStatePollingRequest();
      const response = await this.authenticatedFetch(this.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ using, methodCalls }),
      });

      if (response.ok) {
        const data = await response.json();
        const changes: { [key: string]: string } = {};
        let hasChanges = false;

        for (const [method, result] of data.methodResponses) {
          const stateKey = JMAPClient.STATE_TYPE_MAP[method];
          if (stateKey && result.state) {
            if (this.pollingStates[stateKey] && this.pollingStates[stateKey] !== result.state) {
              changes[stateKey] = result.state;
              hasChanges = true;
            }
            this.pollingStates[stateKey] = result.state;
          }
        }

        if (hasChanges && this.stateChangeCallback) {
          this.stateChangeCallback({
            '@type': 'StateChange',
            changed: { [this.accountId]: changes },
          });
        }
      }
    } catch {
      // Silently fail - polling will retry
    }
  }

  closePushNotifications(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    if (this.sseAbortController) {
      this.sseAbortController.abort();
      this.sseAbortController = null;
    }
    if (this.sseReconnectTimeout) {
      clearTimeout(this.sseReconnectTimeout);
      this.sseReconnectTimeout = null;
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.stopSSEPingMonitor();
    this.cleanupBrowserEventListeners();
    this.stateChangeCallback = null;
    this.pollingStates = {};
  }

  private startSSEPingMonitor(): void {
    this.stopSSEPingMonitor();
    this.ssePingTimer = setInterval(() => {
      if (Date.now() - this.lastSSEActivity > JMAPClient.SSE_PING_TIMEOUT) {
        // SSE connection is stale - abort and reconnect
        this.stopSSEPingMonitor();
        if (this.sseAbortController) {
          this.sseAbortController.abort();
          this.sseAbortController = null;
        }
        this.scheduleSSEReconnect();
      }
    }, 30_000);
  }

  private stopSSEPingMonitor(): void {
    if (this.ssePingTimer) {
      clearInterval(this.ssePingTimer);
      this.ssePingTimer = null;
    }
  }

  private setupBrowserEventListeners(): void {
    if (typeof document !== 'undefined') {
      this.visibilityHandler = () => {
        if (!document.hidden) {
          // Tab became visible - immediately check for state changes
          this.checkForStateChanges();
        }
      };
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }

    if (typeof window !== 'undefined') {
      this.onlineHandler = () => {
        // Network reconnected - reconnect SSE or force a poll
        const eventSourceUrl = this.getEventSourceUrl();
        if (eventSourceUrl && !this.sseAbortController) {
          this.connectSSE(eventSourceUrl);
        } else {
          this.checkForStateChanges();
        }
      };
      window.addEventListener('online', this.onlineHandler);
    }
  }

  private cleanupBrowserEventListeners(): void {
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
    if (this.onlineHandler && typeof window !== 'undefined') {
      window.removeEventListener('online', this.onlineHandler);
      this.onlineHandler = null;
    }
  }

  onConnectionChange(callback: (connected: boolean) => void): void {
    this.connectionChangeCallback = callback;
  }

  onRateLimit(callback: (rateLimited: boolean, retryAfterMs: number) => void): void {
    this.rateLimitCallback = callback;
  }

  isRateLimited(): boolean {
    return Date.now() < this.rateLimitedUntil;
  }

  getRateLimitRemainingMs(): number {
    return Math.max(0, this.rateLimitedUntil - Date.now());
  }

  private setRateLimited(retryAfterMs: number): void {
    this.rateLimitedUntil = Date.now() + retryAfterMs;

    if (this.rateLimitTimeout) {
      clearTimeout(this.rateLimitTimeout);
      this.rateLimitTimeout = null;
    }

    this.rateLimitCallback?.(true, retryAfterMs);

    // Pause live updates until the server's rate-limit window expires.
    const stateChangeCallback = this.stateChangeCallback;
    this.closePushNotifications();
    this.stateChangeCallback = stateChangeCallback;

    // Schedule clearing the rate-limit flag and notifying listeners.
    this.rateLimitTimeout = setTimeout(() => {
      this.rateLimitTimeout = null;
      if (!this.isRateLimited()) {
        this.rateLimitCallback?.(false, 0);
        if (this.session && this.stateChangeCallback) {
          this.setupPushNotifications();
        }
      }
    }, retryAfterMs);
  }

  private notifyRateLimitBlocked(retryAfterMs: number): void {
    if (typeof window === 'undefined') {
      return;
    }

    const now = Date.now();
    if ((now - this.lastRateLimitNoticeAt) < JMAPClient.RATE_LIMIT_TOAST_THROTTLE_MS) {
      return;
    }

    this.lastRateLimitNoticeAt = now;
    window.dispatchEvent(new CustomEvent('bulwark:rate-limit-blocked', {
      detail: { retryAfterMs },
    }));
  }

  private static parseRetryAfter(response: Response): number {
    const header = response.headers.get('Retry-After');
    if (!header) return 60_000; // default 60s if no header
    const seconds = Number(header);
    if (!Number.isNaN(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, 300_000); // cap at 5 minutes
    }
    // Try HTTP-date format
    const date = Date.parse(header);
    if (!Number.isNaN(date)) {
      const ms = date - Date.now();
      return ms > 0 ? Math.min(ms, 300_000) : 60_000;
    }
    return 60_000;
  }

  onStateChange(callback: (change: StateChange) => void): void {
    this.stateChangeCallback = callback;
  }

  getLastStates(): AccountStates {
    return { ...this.lastStates };
  }

  setLastStates(states: AccountStates): void {
    this.lastStates = { ...states };
  }

  // ── S/MIME raw-email helpers ─────────────────────────────────────

  /** Fetch blob content as an ArrayBuffer (for S/MIME byte processing). */
  async fetchBlobArrayBuffer(blobId: string, name?: string, type?: string): Promise<ArrayBuffer> {
    const url = this.getBlobDownloadUrl(blobId, name, type);
    const response = await this.authenticatedFetch(url, {});
    if (!response.ok) {
      throw new Error(`Failed to fetch blob: ${response.status}`);
    }
    return response.arrayBuffer();
  }

  /**
   * Import a raw MIME message blob into the account. Pass `accountId` to
   * target a delegated account the caller has rights on (e.g. importing into
   * a shared mailbox owned by another user). When omitted, falls back to the
   * client's own primary account.
   */
  async importRawEmail(
    blob: Blob,
    mailboxIds: Record<string, boolean>,
    keywords?: Record<string, boolean>,
    accountId?: string,
  ): Promise<string> {
    const targetAccountId = accountId || this.accountId;
    // First upload the blob. Blob uploads are scoped to an account too —
    // when importing into a delegated account, upload there so the resulting
    // blobId is visible to Email/import on that account.
    const file = new File([blob], 'message.eml', { type: 'message/rfc822' });
    const { blobId } = await this.uploadBlob(file, targetAccountId);

    // Then import via Email/import
    const response = await this.request([
      ['Email/import', {
        accountId: targetAccountId,
        emails: {
          'smime-import': {
            blobId,
            mailboxIds,
            keywords: keywords ?? { '$seen': true },
          },
        },
      }, '0'],
    ]);

    const importResult = response.methodResponses?.[0]?.[1];
    if (importResult?.notCreated?.['smime-import']) {
      const err = importResult.notCreated['smime-import'];
      throw new Error(err.description || err.type || 'Failed to import email');
    }

    const emailId = importResult?.created?.['smime-import']?.id;
    if (!emailId) {
      throw new Error('Email import succeeded but no ID returned');
    }
    return emailId;
  }

  /** Submit an already-imported email for delivery. */
  async submitEmail(emailId: string, identityId: string): Promise<void> {
    const response = await this.request([
      ['EmailSubmission/set', {
        accountId: this.getSubmissionAccountId(),
        create: { 'smime-submit': { emailId, identityId } },
      }, '0'],
    ]);

    const result = response.methodResponses?.[0]?.[1];
    if (result?.notCreated?.['smime-submit']) {
      const err = result.notCreated['smime-submit'];
      throw new Error(err.description || err.type || 'Failed to submit email');
    }
  }

  /**
   * Import a raw S/MIME message, move it to the Sent mailbox, and submit it.
   * Encapsulates the full import → update → submit flow.
   */
  async sendRawEmail(
    blob: Blob,
    identityId: string,
    sentMailboxId: string,
    draftMailboxId?: string,
    delayedUntil?: string,
    envelopeRecipients?: string[],
  ): Promise<SendEmailResult> {
    const holdForSeconds = delayedUntil ? this.validateDelayedUntil(delayedUntil) : undefined;
    // Upload the raw message
    const file = new File([blob], 'message.eml', { type: 'message/rfc822' });
    const { blobId } = await this.uploadBlob(file);

    // Import into Drafts first, then move to Sent after submission succeeds.
    // This avoids encrypt-on-append affecting the SMTP send. See #188.
    const importMailboxId = draftMailboxId || sentMailboxId;
    const identities = await this.getIdentities();
    const identity = identities.find(item => item.id === identityId);
    const envelope = createDelayedSubmissionEnvelope(identity?.email || this.username, holdForSeconds, envelopeRecipients);

    const methodCalls: [string, Record<string, unknown>, string][] = [
      ['Email/import', {
        accountId: this.accountId,
        emails: {
          'raw-import': {
            blobId,
            mailboxIds: { [importMailboxId]: true },
            keywords: draftMailboxId ? { '$seen': true, '$draft': true } : { '$seen': true },
          },
        },
      }, '0'],
      ['EmailSubmission/set', {
        accountId: this.getSubmissionAccountId(),
        create: {
          'raw-submit': {
            emailId: '#raw-import',
            identityId,
            ...(envelope ? { envelope } : {}),
          },
        },
        ...(draftMailboxId ? {
          onSuccessUpdateEmail: {
            '#raw-submit': {
              [`mailboxIds/${draftMailboxId}`]: null,
              [`mailboxIds/${sentMailboxId}`]: true,
              'keywords/$draft': null,
            },
          },
        } : {}),
      }, '1'],
    ];

    const response = await this.request(methodCalls);
    let emailId: string | undefined;
    let emailSubmissionId: string | undefined;
    let serverSendAt: string | undefined;

    // Check for errors
    for (const [methodName, result] of response.methodResponses ?? []) {
      if (methodName.endsWith('/error')) {
        throw new Error((result as { description?: string }).description || `Failed: ${(result as { type?: string }).type}`);
      }
      const r = result as { notCreated?: Record<string, { description?: string; type?: string }> };
      if (r.notCreated) {
        const firstErr = Object.values(r.notCreated)[0];
        throw new Error(firstErr?.description || firstErr?.type || 'Failed to send raw email');
      }
      if (methodName === 'Email/import') {
        emailId = (result as { created?: Record<string, { id?: string }> }).created?.['raw-import']?.id;
      }
      if (methodName === 'EmailSubmission/set') {
        const created = (result as { created?: Record<string, { id?: string; sendAt?: string }> }).created?.['raw-submit'];
        emailSubmissionId = created?.id;
        serverSendAt = created?.sendAt;
      }
    }

    if (delayedUntil && emailSubmissionId && !serverSendAt) {
      serverSendAt = await this.getEmailSubmissionSendAt(emailSubmissionId);
    }

    return delayedUntil
      ? { scheduled: true, emailId, emailSubmissionId, sendAt: serverSendAt, isSmime: true }
      : { scheduled: false, emailId, emailSubmissionId, isSmime: true };
  }

  async getScheduledEmails(limit = 50, position = 0): Promise<{ emails: ScheduledEmail[]; hasMore: boolean; total: number; nextPosition: number }> {
    if (!this.hasDelayedSend()) {
      return { emails: [], hasMore: false, total: 0, nextPosition: position };
    }

    const now = Date.now();
    const pageSize = Math.max(limit, 50);
    const submissions: EmailSubmission[] = [];
    let rawPosition = 0;
    let rawTotal = 0;

    do {
      const queryResponse = await this.request([
        ['EmailSubmission/query', {
          accountId: this.getSubmissionAccountId(),
          limit: pageSize,
          position: rawPosition,
        }, '0'],
      ]);

      const query = queryResponse.methodResponses?.[0]?.[1] as { ids?: string[]; total?: number; position?: number } | undefined;
      const ids = query?.ids ?? [];
      rawTotal = query?.total ?? rawPosition + ids.length;
      if (ids.length === 0) break;

      const submissionResponse = await this.request([
        ['EmailSubmission/get', {
          accountId: this.getSubmissionAccountId(),
          ids,
          properties: ['id', 'emailId', 'identityId', 'threadId', 'sendAt', 'undoStatus', 'deliveryStatus'],
        }, '0'],
      ]);

      submissions.push(...((submissionResponse.methodResponses?.[0]?.[1]?.list ?? []) as EmailSubmission[])
        .filter(submission => {
          if (submission.undoStatus !== 'pending' || !submission.sendAt) return false;
          const sendAtTime = new Date(submission.sendAt).getTime();
          return Number.isFinite(sendAtTime) && sendAtTime > now;
        }));

      rawPosition += ids.length;
    } while (rawPosition < rawTotal);

    submissions.sort((a, b) => new Date(a.sendAt || '').getTime() - new Date(b.sendAt || '').getTime());
    const total = submissions.length;
    const pageSubmissions = submissions.slice(position, position + limit);
    const nextPosition = position + pageSubmissions.length;

    if (pageSubmissions.length === 0) {
      return { emails: [], hasMore: false, total, nextPosition };
    }

    const emailResponse = await this.request([
      ['Email/get', {
        accountId: this.accountId,
        ids: pageSubmissions.map(submission => submission.emailId),
        properties: [
          'id', 'threadId', 'mailboxIds', 'keywords', 'size', 'receivedAt', 'from', 'to', 'cc', 'bcc', 'replyTo',
          'subject', 'preview', 'textBody', 'htmlBody', 'bodyValues', 'attachments', 'hasAttachment', 'sentAt',
          'messageId', 'inReplyTo', 'references', 'headers', 'blobId', 'bodyStructure',
        ],
        fetchTextBodyValues: true,
        fetchHTMLBodyValues: true,
        fetchAllBodyValues: true,
        maxBodyValueBytes: 256000,
      }, '0'],
    ]);

    const emailById = new Map(((emailResponse.methodResponses?.[0]?.[1]?.list ?? []) as Email[]).map(email => [email.id, email]));
    const emails = pageSubmissions
      .map((submission): ScheduledEmail | null => {
        const email = emailById.get(submission.emailId);
        if (!email || !submission.sendAt) return null;
        return {
          ...email,
          threadId: submission.threadId || email.threadId,
          scheduledSendAt: submission.sendAt,
          emailSubmissionId: submission.id,
          scheduledIdentityId: submission.identityId,
          scheduledUndoStatus: submission.undoStatus,
          scheduledDeliveryStatus: submission.deliveryStatus,
          isScheduled: true,
          isSmimeScheduled: isSmimeEmail(email),
        };
      })
      .filter((email): email is ScheduledEmail => email !== null)
      .sort((a, b) => new Date(a.scheduledSendAt).getTime() - new Date(b.scheduledSendAt).getTime());

    return { emails, hasMore: nextPosition < total, total, nextPosition };
  }

  async cancelEmailSubmission(submissionId: string): Promise<void> {
    const response = await this.request([
      ['EmailSubmission/set', {
        accountId: this.getSubmissionAccountId(),
        update: { [submissionId]: { undoStatus: 'canceled' } },
      }, '0'],
    ]);
    const result = response.methodResponses?.[0]?.[1];
    const error = result?.notUpdated?.[submissionId];
    if (error) {
      throw new Error(error.description || error.type || 'Failed to cancel scheduled send');
    }
  }

  async rescheduleEmailSubmission(submissionId: string, emailId: string, identityId: string, delayedUntil: string): Promise<SendEmailResult> {
    const holdForSeconds = this.validateDelayedUntil(delayedUntil);
    const mailboxes = await this.getMailboxes();
    const draftsMailbox = mailboxes.find(mb => mb.role === 'drafts');
    const sentMailbox = mailboxes.find(mb => mb.role === 'sent');
    const identities = await this.getIdentities();
    const identity = identities.find(item => item.id === identityId);
    const existingEnvelope = await this.getEmailSubmissionEnvelope(submissionId);
    const email = existingEnvelope?.rcptTo?.length ? undefined : await this.getEmail(emailId);
    const envelopeRecipients = existingEnvelope?.rcptTo?.length
      ? existingEnvelope.rcptTo
      : [...(email?.to || []), ...(email?.cc || []), ...(email?.bcc || [])];
    const envelope = createDelayedSubmissionEnvelope(identity?.email || this.username, holdForSeconds, envelopeRecipients);
    const response = await this.request([
      ['EmailSubmission/set', {
        accountId: this.getSubmissionAccountId(),
        create: { replacement: { emailId, identityId, ...(envelope ? { envelope } : {}) } },
        ...(draftsMailbox && sentMailbox ? {
          onSuccessUpdateEmail: {
            '#replacement': {
              [`mailboxIds/${draftsMailbox.id}`]: null,
              [`mailboxIds/${sentMailbox.id}`]: true,
              'keywords/$draft': null,
            },
          },
        } : {}),
      }, '0'],
    ]);
    const result = response.methodResponses?.[0]?.[1];
    const createError = result?.notCreated?.replacement;
    if (createError) {
      throw new Error(createError.description || createError.type || 'Failed to reschedule email');
    }
    const replacementId = result?.created?.replacement?.id;
    const serverSendAt = result?.created?.replacement?.sendAt;
    if (!replacementId) {
      throw new Error('Server did not return a replacement scheduled send ID');
    }
    const finalSendAt = serverSendAt || await this.getEmailSubmissionSendAt(replacementId);
    try {
      await this.cancelEmailSubmission(submissionId);
    } catch (error) {
      try {
        await this.cancelEmailSubmission(replacementId);
      } catch (cleanupError) {
        console.error('Failed to clean up replacement scheduled send after reschedule failure:', cleanupError);
      }
      const message = error instanceof Error ? error.message : 'Failed to cancel original scheduled send';
      throw new Error(`Reschedule created a replacement but could not cancel the original: ${message}`);
    }
    return { scheduled: true, emailId, emailSubmissionId: replacementId, sendAt: finalSendAt };
  }

  async restoreEmailToDraft(emailId: string, draftMailboxId: string, sentMailboxId?: string): Promise<void> {
    const update: Record<string, unknown> = {
      [`mailboxIds/${draftMailboxId}`]: true,
      'keywords/$draft': true,
      'keywords/$seen': true,
    };
    if (sentMailboxId) {
      update[`mailboxIds/${sentMailboxId}`] = null;
    }
    const response = await this.request([
      ['Email/set', {
        accountId: this.accountId,
        update: { [emailId]: update },
      }, '0'],
    ]);
    const result = response.methodResponses?.[0]?.[1];
    const error = result?.notUpdated?.[emailId];
    if (error) {
      throw new Error(error.description || error.type || 'Failed to restore email to drafts');
    }
  }

  // ── PushSubscription (RFC 8620 §7.2) ──────────────────────────────
  // Used by the PWA Web Push integration. The mobile app does the same dance
  // through its own JMAP client - keep these in sync.

  async listPushSubscriptions(): Promise<PushSubscription[]> {
    const response = await this.request(
      [['PushSubscription/get', { ids: null }, '0']],
      ['urn:ietf:params:jmap:core'],
    );
    const [, body] = response.methodResponses[0] ?? [];
    return ((body as { list?: PushSubscription[] } | undefined)?.list) ?? [];
  }

  async createPushSubscription(params: {
    deviceClientId: string;
    url: string;
    types: string[];
    expires?: string;
  }): Promise<string> {
    const created: Record<string, unknown> = {
      deviceClientId: params.deviceClientId,
      url: params.url,
      types: params.types,
    };
    if (params.expires) created.expires = params.expires;

    const response = await this.request(
      [['PushSubscription/set', { create: { new: created } }, '0']],
      ['urn:ietf:params:jmap:core'],
    );
    const [, body] = response.methodResponses[0] ?? [];
    const result = (body as { created?: { new?: { id?: string } }; notCreated?: { new?: unknown } } | undefined);
    const id = result?.created?.new?.id;
    if (!id) {
      throw new Error(
        `PushSubscription/set create failed: ${JSON.stringify(result?.notCreated?.new ?? body)}`,
      );
    }
    return id;
  }

  async verifyPushSubscription(id: string, verificationCode: string): Promise<void> {
    const response = await this.request(
      [['PushSubscription/set', { update: { [id]: { verificationCode } } }, '0']],
      ['urn:ietf:params:jmap:core'],
    );
    const [, body] = response.methodResponses[0] ?? [];
    const notUpdated = (body as { notUpdated?: Record<string, unknown> } | undefined)?.notUpdated?.[id];
    if (notUpdated) {
      throw new Error(`PushSubscription verification failed: ${JSON.stringify(notUpdated)}`);
    }
  }

  // Returns false when the server rejects the update (e.g. the subscription
  // was already destroyed) - the caller treats that as a signal to recreate.
  async updatePushSubscription(
    id: string,
    patch: { expires?: string; types?: string[] },
  ): Promise<boolean> {
    const response = await this.request(
      [['PushSubscription/set', { update: { [id]: patch } }, '0']],
      ['urn:ietf:params:jmap:core'],
    );
    const [, body] = response.methodResponses[0] ?? [];
    const r = body as { updated?: Record<string, unknown>; notUpdated?: Record<string, unknown> } | undefined;
    if (r?.notUpdated?.[id]) return false;
    return r?.updated?.[id] !== undefined;
  }

  async destroyPushSubscription(id: string): Promise<void> {
    await this.request(
      [['PushSubscription/set', { destroy: [id] }, '0']],
      ['urn:ietf:params:jmap:core'],
    );
  }
}
