import { advertisesMailboxMetadata, bulwarkEntries, escapeMetadataPathSegment, MAX_METADATA_ENTRY_BYTES, METADATA_CAPABILITY, MetadataPatchError, MetadataRefusedError, MetadataTooLargeError, MetadataUnsupportedError, metadataValueBytes, namespaceFor } from "./bulwark-metadata";
import { IncompleteDeleteError } from "./delete-error";
import { ArchiveEmailsError } from "./archive-error";
import { generateUUID } from '@/lib/utils';
import type { Attachment, Email, Mailbox, MailboxRights, StateChange, AccountStates, CollectionChanges, ShareNotification, BusyPeriod, CalendarParticipantIdentity, CalendarEventNotification, Thread, Identity, EmailAddress, ContactCard, AddressBook, AddressBookRights, VacationResponse, Calendar, CalendarComponentType, CalendarRights, CalendarEvent, CalendarEventFilter, CalendarTask, CreateCalendarOptions, FileNode, FileNodeFilter, FileNodeRights, Principal, PrincipalAvailability, PrincipalListing, PushSubscription, EmailPushConfig, DeliveryStatus, EmailSubmission, RejectedRecipient, ScheduledEmail, SendEmailResult, SharedAccount } from "./types";
import type { SieveScript, SieveCapabilities } from "./sieve-types";
import type { BlobBatch, CalendarEventUpdateOptions, CalendarQueryOptions, FileNodeListings, IJMAPClient, KeywordDiscoveryResult, KeywordInfo, KeywordMigration, SearchEmailsResult, SearchRequestOptions } from "./client-interface";
import { attachSearchSnippets, filterHasSnippetTerms, snippetFilterFor, type SearchSnippetResult } from "@/lib/search-snippet";
import { textConditions, textFilter } from "./search-utils";
import { batched, batchedBySize, itemsPerRequest } from "./request-limits";
import { keywordPointer, pointerToken } from "./patch-pointer";
import { FirstTouchGate } from "./first-touch-gate";
import { debug } from "@/lib/debug";
import { normalizeCalendarEventLike, parseDurationSeconds } from "@/lib/calendar-event-normalization";
import { SYNTHETIC_ID_PROBE, RECURRENCE_BASE_PROPERTIES, hydrateRecurrenceInstances, isServerRecurrenceInstance } from "@/lib/recurrence-instances";
import { isTaskLikeObject, type ScannedCalendarObject } from "@/lib/calendar-component-detection";
import { DEFAULT_CALENDAR_COMPONENTS, mkCalendarCollection, newCalendarCollectionName } from "@/lib/webdav/calendar-collection";
import { sanitizeDisplayName, splitMailbox } from "@/lib/rfc5322-mailbox";
import { decodeFileNodeName } from "./filenode-name";
import { fileNodeKind, fromDraftFileNode, toDraftFileNodeCreate } from "./filenode-kind";
import { fileNodeDepth } from "./filenode-depth";
import { contactFromWire, contactToWire } from "./contact-wire";
import { SchedulingDeniedError } from "./scheduling-error";
import { jmapError, jmapErrorFailedIds, jmapErrorType, jmapSetError, type JmapError, type JmapErrorInfo } from "./jmap-error";
import { isServerSetKeyword } from "./server-keywords";
import { PrincipalsRequestError } from "./principals-error";
import { buildShareSetCalls, failAll, parseShareTargets, readShareSetResults, SET_METHOD, type ShareChange, type ShareChangeResult, type ShareTarget } from "./share-batch";
import type { ShareKind } from "./share-rights";
import { ARCHIVED_ITEM_USING, STALWART_CAPABILITY, buildRestoreCalls, hasArchivedEmail, listArchivedEmailsPaged, readRestoreResults, type ArchiveIo, type ArchiveListResult, type ArchiveQueryPage, type RestoreResult } from "@/lib/recovery/archived-items";
import { RescheduleRestoredError } from "./reschedule-error";
import { applyPatchObject } from "./patch-object";

export { SchedulingDeniedError, RescheduleRestoredError };
import { acceptedFileName, fileNameRulesFrom, type FileNameRules } from "@/lib/file-name-rules";
import { folderDepthError, partialCopyError } from "@/lib/file-errors";
import { mediaTypeEssence, OCTET_STREAM } from "@/lib/media-type";
import { canonicalTimeZone, getEffectiveTimeZone, moveLocalDateTime, toLocalDateTime } from "@/lib/timezone";
import { buildEmailSort, compareEmails, hasKeywordLevels, hasTextLevels, type KeywordSortPolarity, type SortLevel } from "@/lib/message-list-order";
import { emailMatchesLogin, sortIdentities } from "@/lib/identity-order";
import type { AccountInfo } from "./types";
import { stalwartChangeId } from "./stalwart-state";
import { downloadNameSegment } from "./download-name";
import { toInertBlob } from "@/lib/file-preview";
import { parseAuthenticationResults } from "@/lib/email-headers";
import { IS_LITE_STALWART } from "@/lib/lite";
import { toStorageQuota, type JMAPQuota, type StorageQuota } from "@/lib/quota";
import { messagePriorityHeaders, type MessagePriority } from "@/lib/message-priority";
import { customHeaderProperties } from "@/lib/outgoing/custom-headers";
import { attachmentParts, HTML_PART_ID, relatedBodyStructure, TEXT_PART_ID, type OutgoingBodyPart } from "./outgoing-body";

// Cap for the follow-up Email/get issued when a displayed body part comes
// back truncated at the normal 256000-byte limit (see refetchTruncatedBodyValues
// / #884). Bounded well above the default so it stays rare in practice while
// still guarding against unbounded memory use on a malicious/oversized body.
const TRUNCATED_BODY_REFETCH_MAX_BYTES = 8_000_000;
// Opening one message needs its whole body, so its fetch takes more than the
// list-sized cap: a newsletter just over 256 kB came back truncated and was
// fetched a second time. Larger bodies still take the refetch above.
const OPEN_EMAIL_MAX_BODY_BYTES = 1_000_000;

// Names of nodes created over WebDAV come back percent-encoded from
// FileNode/get (see decodeFileNodeName / #869). Normalize at the boundary so
// every consumer (browser, sidebar, breadcrumbs, path resolution) sees the
// human-readable name.
function withDecodedName<T extends Pick<FileNode, 'name'>>(node: T): T {
  const name = decodeFileNodeName(node.name);
  return name === node.name ? node : { ...node, name };
}

type LegacyFileNodeRights = { mayRead?: boolean; mayWrite?: boolean; mayShare?: boolean };

/**
 * Stalwart before 0.16.6 implements an older JMAP File Storage draft whose
 * rights are just mayRead / mayWrite / mayShare. Spread mayWrite over the
 * finer rights the UI checks.
 */
function fromLegacyRights(rights: FileNodeRights | LegacyFileNodeRights | undefined): FileNodeRights | undefined {
  if (!rights || !('mayWrite' in rights)) return rights as FileNodeRights | undefined;
  const write = !!rights.mayWrite;
  return {
    mayRead: !!rights.mayRead,
    mayAddChildren: write,
    mayRename: write,
    mayDelete: write,
    mayModifyContent: write,
    mayShare: !!rights.mayShare,
  };
}

function toLegacyRights(rights: FileNodeRights): LegacyFileNodeRights {
  return {
    mayRead: rights.mayRead,
    mayWrite: rights.mayAddChildren || rights.mayRename || rights.mayDelete || rights.mayModifyContent,
    mayShare: rights.mayShare,
  };
}

/** A FileNode as the server sent it, normalized for the UI. */
function fromWireFileNode(node: FileNode): FileNode {
  const decoded = withDecodedName(fromDraftFileNode(node));
  if (!decoded.myRights && !decoded.shareWith) return decoded;
  return {
    ...decoded,
    myRights: fromLegacyRights(decoded.myRights),
    shareWith: decoded.shareWith
      ? Object.fromEntries(Object.entries(decoded.shareWith).map(([p, r]) => [p, fromLegacyRights(r) as FileNodeRights]))
      : decoded.shareWith,
  };
}

/**
 * A folder Stalwart 1.0 lists only as the way down to something shared
 * with the user: the ancestors of a shared node come back with a name and
 * parent but no dates and every right false. A node the user may read always
 * has both dates, and 0.16 never leaves `modified` out.
 */
function isDiscoverableOnly(node: FileNode): boolean {
  const rights = node.myRights;
  return node.modified == null && node.created == null
    && !!rights && Object.values(rights).every(granted => !granted);
}

/**
 * RFC 7617 Basic credentials, UTF-8 encoded (what Stalwart decodes). `btoa`
 * alone is Latin-1: it garbles `ü` and throws on anything past U+00FF, such
 * as an unconverted IDN login or a password with `€` in it.
 */
function basicAuthHeader(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return `Basic ${btoa(binary)}`;
}

/** Origin of an absolute URL; null for a relative one or garbage. */
function absoluteOrigin(url: string | undefined): string | null {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Parse a recipient string that may be "Name <email>" or bare "email" into
 * { name?, email }. The display name is unquoted and stripped of any address
 * it carries inline: JMAP takes the name and the address as separate fields,
 * so leaving the quoting or a second copy of the address in there makes the
 * server emit an invalid To/Cc mailbox, which it then re-parses into a
 * malformed envelope recipient (#672).
 */
function parseRecipientString(s: string): { name?: string; email: string } {
  return splitMailbox(s);
}

/**
 * Build the `mailboxIds` portion of an `Email/set` PatchObject as a full-property
 * replacement — `{ mailboxIds: { <id>: true, ... } }` — instead of per-id
 * `mailboxIds/<id>` JSON-Pointer patches.
 *
 * Two reasons:
 *  1. It states the actual intent of a post-send / undo-send move: the message
 *     should belong to *exactly* the given mailbox(es).
 *  2. It avoids per-id JSON-Pointer tokens entirely. Stalwart (observed on
 *     0.15.5) rejects an `Email/set` PatchObject whose pointer token is a
 *     purely-numeric string — e.g. `mailboxIds/0` for a mailbox whose JMAP id is
 *     "0" — with `invalidProperties: "Invalid patch value"` (it treats the digits
 *     as a JSON-Pointer array index even though `mailboxIds` is a JSON object;
 *     cf. RFC 6901 §4, and RFC 8620 §1.2's warning against interop-hostile ids).
 *     That silently stranded already-delivered mail in Drafts for accounts whose
 *     Drafts/Sent mailbox id happened to be all digits (a full member of `0`,
 *     `1`, … `9`, `10`, … was verified rejected; ids containing a letter work).
 *     Stalwart fixed the parsing in 0.16.5 (stalwartlabs/stalwart@175f34ea,
 *     jmap-tools 0.1.5), but earlier deployments remain in the wild — and not
 *     emitting interop-hostile pointer tokens is the safer shape regardless.
 *
 * This is a *replacement*: it drops any other mailbox membership the message
 * had, so callers must know the complete target set. Do NOT also place a
 * `mailboxIds/<id>` pointer key in the same PatchObject — a pointer whose prefix
 * is another key in the object is illegal (RFC 8620 §5.3).
 */
function mailboxIdsReplacement(
  mailboxId: string,
  ...moreMailboxIds: string[]
): { mailboxIds: Record<string, true> } {
  const mailboxIds: Record<string, true> = { [mailboxId]: true };
  for (const id of moreMailboxIds) mailboxIds[id] = true;
  return { mailboxIds };
}

export class RateLimitError extends Error {
  retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super('Rate limited by server');
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * A request produced no response headers within its deadline.
 *
 * `fetch()` has no timeout of its own, and a half-dead connection - the OS or a
 * NAT dropped the socket while the browser still believes it is usable - never
 * rejects. iOS hits this constantly: it freezes a backgrounded tab (and, more
 * aggressively, a home-screen web app), and on resume WebKit reuses pooled
 * connections the network has already torn down. The request bytes leave, the
 * server may even act on them, but the response never comes back. Without a
 * deadline the caller's promise stays pending forever, so the composer's Send
 * button stays disabled and "Save draft" never closes the composer (#702).
 */
export class RequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'RequestTimeoutError';
  }
}

/**
 * Credentials mode for the client's own JMAP requests, which always carry
 * their own Authorization header.
 *
 * In the Lite bundle served by Stalwart the page and JMAP share an origin, so
 * the default (`same-origin`) lets the browser act on Stalwart's
 * `WWW-Authenticate: Basic` challenge: an expired access token makes Safari
 * show its native login dialog before the 401 reaches the refresh-and-retry
 * code. With credentials omitted the Fetch standard forbids that prompt
 * (#1396). The regular build keeps the default: a same-origin JMAP server
 * behind a cookie-gated proxy (Pangolin, Authelia) needs the cookie sent.
 */
const JMAP_FETCH_CREDENTIALS: RequestCredentials | undefined = IS_LITE_STALWART ? 'omit' : undefined;

function withJmapCredentials(init: RequestInit | undefined): RequestInit {
  if (!JMAP_FETCH_CREDENTIALS || init?.credentials) return { ...init };
  return { ...init, credentials: JMAP_FETCH_CREDENTIALS };
}

const READ_ONLY_METHOD = /\/(?:get|query|changes|queryChanges|parse)$|^Core\/echo$/;

/**
 * Whether a request may be sent again after the connection failed without
 * an answer. The server may already have acted on it, so only requests that
 * change nothing qualify: GETs, blob uploads (a new upload just yields
 * another blob), and JMAP batches made only of read methods. Anything
 * with a /set, /copy, /import or a submission would be done twice - one
 * Send delivering two messages.
 */
export function isReplaySafeRequest(init?: Parameters<typeof fetch>[1]): boolean {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return true;
  if (typeof init?.body !== 'string') return init?.body instanceof Blob;
  try {
    const request = JSON.parse(init.body) as { methodCalls?: unknown };
    if (!Array.isArray(request.methodCalls) || request.methodCalls.length === 0) return false;
    return request.methodCalls.every((call) => Array.isArray(call) && typeof call[0] === 'string' && READ_ONLY_METHOD.test(call[0]));
  } catch {
    return false;
  }
}

/** The first method error in a JMAP response, for an Error message. */
function methodErrorMessage(response: JMAPResponse, fallback: string): string {
  const failed = response.methodResponses?.find(([name]) => name === 'error');
  const detail = failed?.[1] as { type?: string; description?: string } | undefined;
  return detail?.description || detail?.type || fallback;
}

/**
 * Throw unless every /set in `response` did what it was asked: a method-level
 * error (`["error", ...]`) or any entry in notCreated / notUpdated /
 * notDestroyed fails it. An HTTP 200 says nothing about the objects, and
 * without this check a refused write (no permission, a stale id) was shown
 * as done.
 */
function assertSetSucceeded(response: JMAPResponse, fallback: string): void {
  for (const [name, result] of response.methodResponses ?? []) {
    if (name === 'error') {
      throw jmapError(result?.description || result?.type || fallback, result);
    }
    for (const key of ['notCreated', 'notUpdated', 'notDestroyed'] as const) {
      const failures = result?.[key] as Record<string, JmapErrorInfo> | null | undefined;
      const first = failures ? Object.values(failures)[0] : undefined;
      if (first) throw jmapSetError(first.description || first.type || fallback, first);
    }
  }
}

/** A scheduled send later than the server's hold limit. */
export class ScheduleTooLateError extends Error {
  constructor(readonly maxSeconds?: number) {
    super('Scheduled send time is later than the server allows');
    this.name = 'ScheduleTooLateError';
  }
}

/**
 * The server refused a new EmailSubmission with `overQuota`, and removing the
 * records that can no longer be cancelled did not make room. Stalwart 1.0
 * counts every record, whatever its status or age, against `maxSubmissions`
 * (500 by default) - not to be confused with Email/set's `overQuota`, which
 * means the mailbox storage is full.
 */
export class SubmissionQuotaError extends Error {
  readonly jmapType = 'overQuota';
  constructor(
    /** The server's own description, if it gave one. */
    readonly description?: string,
    /**
     * The submission account is on Stalwart (`urn:stalwart:jmap`), whose
     * limit is the count of submission records. Another server's overQuota
     * may stand for any sending limit.
     */
    readonly countsRecords = false,
  ) {
    super(description || 'There are too many email submissions');
    this.name = 'SubmissionQuotaError';
  }
}

/**
 * "Send now" or "Reschedule" found the original submission no longer pending
 * after making room for its replacement, which can take a while: it went out
 * (`sent`), or was cancelled or removed elsewhere. No replacement was made.
 */
export class NoLongerScheduledError extends Error {
  constructor(readonly sent: boolean) {
    super(sent ? 'The scheduled message was already sent' : 'The message is no longer scheduled');
    this.name = 'NoLongerScheduledError';
  }
}

/**
 * How often the background prune may sweep one account's submission records
 * (see JMAPClient.pruneEmailSubmissions).
 */
const SUBMISSION_PRUNE_INTERVAL_MS = 10 * 60 * 1000;
/**
 * How long an account where making room found nothing that could go is not
 * searched again for an automatic read receipt; see makeRoomForSubmission.
 */
const SUBMISSION_ROOM_RECHECK_MS = 5 * 60 * 1000;
/** Upper bound on the pages one prune or change-log walk reads. */
const SUBMISSION_SCAN_MAX_PAGES = 40;

/**
 * Stalwart advertises `maxDelayedSend` as a fixed 30 days, while its MTA
 * rejects any hold beyond the `futureRelease` limit, 7 days by default,
 * with "501 5.5.4 Requested hold time exceeds maximum of N seconds".
 */
const STALWART_ADVERTISED_MAX_DELAYED_SEND = 30 * 24 * 60 * 60;
const STALWART_DEFAULT_MAX_HOLD = 7 * 24 * 60 * 60;

/** The hold limit named in a rejected submission, if that was the reason. */
export function parseHoldLimit(description: string | undefined): number | null {
  const m = description?.match(/hold time exceeds maximum of (\d+) seconds/i);
  return m ? Number(m[1]) : null;
}

// JMAP protocol types - these are intentionally flexible due to server variations
interface JMAPSession {
  // The authenticated login (JMAP spec Session.username) — server-confirmed,
  // unlike the client-side constructor username or the sending identity.
  username?: string;
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

/** One entry of a JMAP `methodResponses` array. */
type JMAPMethodResponse = [string, JMAPResponseResult, string];

const SUBMISSION_USING = [
  'urn:ietf:params:jmap:core',
  'urn:ietf:params:jmap:mail',
  'urn:ietf:params:jmap:submission',
] as const;

export const KEYWORDS_CAPABILITY = 'https://bulwarkmail.com/ns/jmap/keywords';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JMAPResponseResult = Record<string, any>;

interface JMAPResponse {
  methodResponses: Array<[string, JMAPResponseResult, string]>;
}

/** Per-id failure entry of a CalendarEvent/set (`notCreated` / `notDestroyed`). */
export interface CalendarSetError {
  type?: string;
  description?: string;
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
  // The "Date sent" list order sorts each page on it client-side too; without
  // it every row fell back to receivedAt and undid the server order (#1219).
  "sentAt",
  "from",
  "to",
  "cc",
  "subject",
  "preview",
  "hasAttachment",
  // No "attachments" here: Stalwart answers it (like bodyStructure/textBody)
  // by reading and parsing every message's full raw blob, so a 300-row page of
  // mail with large files took seconds instead of milliseconds (#1089). List
  // rows fetch their attachment chips lazily via getEmailAttachments.
  // Needed so list rows can serve drag-out to the file system as .eml.
  // Served from stored metadata, so it costs nothing.
  "blobId",
  // The sender check, so list avatars can drop the favicon of a forged From
  // (#1439). Stalwart answers header properties from the stored raw headers,
  // not the message blob.
  "header:Authentication-Results:all",
] as const;

/**
 * Parse the Authentication-Results headers a list fetch asked for, as the
 * full message fetch does from `headers`, and drop the raw property.
 */
function applyListAuthenticationResults(emails: Email[]): Email[] {
  for (const email of emails) {
    const record = email as unknown as Record<string, unknown>;
    const raw = record["header:Authentication-Results:all"];
    delete record["header:Authentication-Results:all"];
    if (!Array.isArray(raw)) continue;
    const headers = raw.filter((value): value is string => typeof value === "string");
    if (headers.length > 0) email.authenticationResults = parseAuthenticationResults(headers);
  }
  return emails;
}

// Body-part fields an attachment chip needs (see components/email/attachment-chips.tsx).
const LIST_ATTACHMENT_BODY_PROPERTIES = [
  "partId", "blobId", "size", "name", "type", "charset", "cid", "disposition",
] as const;

/**
 * How many messages `discoverKeywords` walks before it gives up and reports an
 * incomplete scan. A keyword only has to sit on one message to be worth
 * recovering, so there is no cheaper place to stop than "all of them" - the cap
 * exists so a very large account cannot turn a settings page into an unbounded
 * page-by-page crawl, not because the tail is uninteresting.
 */
export const DEFAULT_KEYWORD_SCAN_LIMIT = 25000;

// How long an inconclusive keyword-sort polarity probe (#718) is trusted
// before the next folder fetch tries again.
const KEYWORD_SORT_PROBE_RETRY_MS = 5 * 60 * 1000;

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

// The Principal properties Bulwark reads. 0.16's default list is the same;
// 1.0's adds `capabilities` for every principal and `accounts`, a whole
// account object with every account capability for the user, their groups
// and sharers.
const PRINCIPAL_PROPERTIES = ["id", "type", "name", "description", "email"] as const;

// The Mailbox properties the folder list reads (RFC 8621 §2), which is also
// the default list on 0.16 and 1.0. Stalwart 1.0 advertises JMAP Metadata
// but its handlers are still `todo!()`: a get that selects `metadata` or
// `privateMetadata` panics on the server. An explicit list keeps them out
// even if a later release adds them to the default.
const MAILBOX_PROPERTIES = [
  "id",
  "name",
  "parentId",
  "role",
  "sortOrder",
  "totalEmails",
  "unreadEmails",
  "totalThreads",
  "unreadThreads",
  "myRights",
  "isSubscribed",
] as const;

// SieveScript properties (RFC 9661 §2), explicit for the same reason.
const SIEVE_SCRIPT_PROPERTIES = ["id", "name", "blobId", "isActive"] as const;

// How Stalwart 1.0 words its refusal of Principal/query while the
// administrator has directory queries off (jmap/src/principal/query.rs). A
// role without the permission gets `forbidden` too, as "You are not
// authorized to perform this action", so only the wording tells the two
// apart; it picks the explanation shown, never what Bulwark does.
const DIRECTORY_QUERIES_OFF = "The administrator has disabled directory queries.";

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

/**
 * Whether a calendar method error means the account grants this user no
 * calendar access at all - the expected answer from a shared account the
 * fan-out probed on suspicion (see getCalendarCapableAccountIds). Stalwart
 * 1.0 answers `accountNotSupportedByMethod` for an account that only shared
 * a mail folder, where 0.16 says `forbidden`.
 */
function isCalendarAccessDenial(type: string | undefined, message: string | undefined): boolean {
  return type === 'forbidden' || type === 'accountNotFound' || type === 'accountNotSupportedByMethod'
    || /not have access/i.test(message ?? '');
}

// Stalwart 1.0 fails a CalendarEvent/get that asks for `recurrenceOverrides`
// together with `utcStart` or `utcEnd` (invalidArguments, before any id is
// read), so no property list may hold both. Where a caller needs the
// overrides, fetchCalendarEventsById reads them with a get of their own.
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
  'excludedRecurrenceRule',
  'useDefaultAlerts',
  'alerts',
  'locations',
  'virtualLocations',
  'links',
  'relatedTo',
  'isDraft',
  'isOrigin',
  'baseEventId',
] as const;

/** The second get of fetchCalendarEventsById: the overrides, by id. */
const OVERRIDE_PROPERTIES = ['id', 'recurrenceOverrides'] as const;

// getCalendarEvents' callers (import de-duplication, clearing a calendar,
// iCal subscription refresh) match events by uid and calendar only; the task
// keys let isTaskObject keep tasks out.
const CALENDAR_EVENT_IDENTITY_PROPERTIES = [
  'id',
  '@type',
  'uid',
  'calendarIds',
  'due',
  'progress',
  'percentComplete',
] as const;

// Task-specific properties for CalendarEvent/get when fetching Task objects.
// No utcStart/utcEnd: the task UI works from `due`, and asking for them next
// to recurrenceOverrides fails the get on Stalwart 1.0.
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
  'progress',
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
  'links',
  'percentComplete',  // Task-only per RFC 8984 §5.2.4 - used in detection heuristic
] as const;

const TASK_PROGRESS_NORMALIZATION = new Map<string, CalendarTask['progress']>([
  ['needs-action', 'needs-action'],
  ['needs_action', 'needs-action'],
  ['in-process', 'in-process'],
  ['in_process', 'in-process'],
  ['completed', 'completed'],
  ['cancelled', 'cancelled'],
  ['canceled', 'cancelled'],
]);

function normalizeCalendarTask(task: CalendarTask): CalendarTask {
  const progress = task.progress as unknown;
  if (typeof progress !== 'string') return task;

  const normalizedProgress = TASK_PROGRESS_NORMALIZATION.get(progress.toLowerCase());
  return normalizedProgress === undefined
    ? task
    : { ...task, progress: normalizedProgress };
}

/**
 * IANA time zone of the user - their `timeZone` setting when set (#755),
 * otherwise the browser's - sent as the `timeZone` argument on
 * CalendarEvent/query and CalendarEvent/get. Stalwart interprets the
 * LocalDateTime `after`/`before` filter values and computes utcStart/utcEnd
 * for floating events in this zone, defaulting to UTC when absent - which
 * shifts range boundaries and floating-event times for any user not in UTC.
 * A zone the server's time zone database lacks is read as UTC by 0.16 and
 * refused by 1.0, which fails the whole call; JMAPClient.calendarTimeZone
 * decides what is actually sent. The name goes out as Intl spells it: 1.0
 * matches it exactly, so a setting typed "europe/berlin" would read as
 * unknown.
 */
function getUserTimeZone(): string | undefined {
  try {
    const zone = getEffectiveTimeZone();
    return (zone && canonicalTimeZone(zone)) || undefined;
  } catch {
    return undefined;
  }
}

const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A task's `due` and `start` are LocalDateTimes (RFC 8984). Stalwart accepts a
 * bare date and echoes it over JMAP, but stores no DUE in the iCalendar, so
 * CalDAV clients lose the date. Completes a bare date to midnight.
 */
function completeBareTaskDates<T extends Partial<CalendarTask>>(task: T): T {
  const result = { ...task };
  if (typeof result.due === 'string' && BARE_DATE.test(result.due)) result.due = `${result.due}T00:00:00`;
  if (typeof result.start === 'string' && BARE_DATE.test(result.start)) result.start = `${result.start}T00:00:00`;
  return result;
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

/**
 * RFC 8620 §3.6.1 limit error naming the server's parallel-request ceiling.
 * Stalwart refuses the surplus of a burst with 400 jmap:error:limit /
 * maxConcurrentRequests BEFORE any method runs, so the request is safe to
 * replay - even a /set.
 */
export function isConcurrentRequestRefusal(status: number, body: string): boolean {
  if (status !== 400) return false;
  try {
    const parsed = JSON.parse(body) as { type?: unknown; limit?: unknown } | null;
    return parsed?.type === 'urn:ietf:params:jmap:error:limit' && parsed?.limit === 'maxConcurrentRequests';
  } catch {
    return false;
  }
}

/** Base back-off per attempt when the server refuses a request for being one too many in parallel. */
const CONCURRENT_REQUEST_RETRY_DELAYS_MS = [200, 400, 800];

/** Ids asked for per FileNode/query page; Stalwart clamps it to queryMaxResults (5000 by default). */
const FILE_NODE_QUERY_PAGE = 5000;
/** Safety bound on how many FileNode ids one listing pages through. */
const FILE_NODE_MAX_IDS = 200_000;

/** RFC 9404; Blob/get needs it in `using`. */
const BLOB_CAPABILITY = "urn:ietf:params:jmap:blob";
/**
 * Bytes of blob data one Blob/get in getBlobsAsBase64 asks for. They come
 * back as base64 inside the JSON, a third larger.
 */
const BLOB_BATCH_BYTES = 4 * 1024 * 1024;
/** The largest contact photo Stalwart 1.0 takes by default (maxMediaSize). */
const BLOB_LARGE_BYTES = 2 * 1024 * 1024;
/**
 * Message counts per thread id from the Thread/get chained onto a list
 * request; undefined when the server did not answer it (one that cannot
 * resolve a wildcard back-reference fails just that call).
 */
function threadCountsFrom(methodResponse: unknown): Record<string, number> | undefined {
  if (!Array.isArray(methodResponse) || methodResponse[0] !== "Thread/get") return undefined;
  const list = (methodResponse[1] as { list?: Thread[] } | undefined)?.list;
  if (!Array.isArray(list)) return undefined;
  const counts: Record<string, number> = {};
  for (const thread of list) counts[thread.id] = thread.emailIds?.length ?? 0;
  return counts;
}

function computeHasMore(position: number, emailCount: number, total: number, limit: number): boolean {
  if (total > 0) return (position + emailCount) < total;
  return emailCount === limit;
}

interface JMAPMethodError {
  type?: string;
  description?: string;
  properties?: string[];
}

/**
 * The method errors of a send request. JMAP names a failed call `"error"`
 * (RFC 8620 §3.6.2), not `"<Method>/error"`. An error after a created
 * EmailSubmission comes from its implicit onSuccessUpdateEmail /
 * onSuccessDestroyEmail call: the message has already left, so it is a filing
 * problem, not a failed send (reporting it as one invites a duplicate resend).
 *
 * A refused create ahead of the submission (the Email/set or Email/import of
 * the message itself) is the failure: the submission's `#creationId` then points at
 * nothing and Stalwart fails the whole call with "Invalid reference to
 * non-existing object", which says nothing about why the message was refused.
 */
export function sendMethodErrors(
  methodResponses: JMAPResponse['methodResponses'] | undefined,
): { failure?: JMAPMethodError; filing?: JMAPMethodError } {
  let submitted = false;
  let failure: JMAPMethodError | undefined;
  let filing: JMAPMethodError | undefined;
  for (const [name, result] of methodResponses ?? []) {
    if (name === 'EmailSubmission/set' && Object.keys(result?.created ?? {}).length > 0) {
      submitted = true;
    } else if (!submitted && name !== 'EmailSubmission/set' && name !== 'error') {
      const refused = Object.values((result?.notCreated ?? {}) as Record<string, JMAPMethodError>)[0];
      if (refused) failure ??= refused;
    } else if (name === 'error') {
      if (submitted) filing ??= result;
      else failure ??= result;
    }
  }
  return { failure, filing };
}

/** Call id of the deliveryStatus read-back that rides along with a send. */
const DELIVERY_STATUS_CALL_ID = 'deliveryStatus';

/**
 * Reads back the deliveryStatus of the submission an earlier call of the same
 * request creates as `creationId`. Stalwart runs RCPT TO while creating the
 * submission - for a held send as well, only the delivery waits - and records
 * a refused recipient on it as delivered "no" instead of failing the create,
 * so the set response alone reads as a success - even when every recipient
 * was refused and nothing was queued (#1123). Stalwart answers this way to a
 * relay it doesn't allow ("550 5.1.2 Relay not allowed.") and to a throttle
 * that is used up ("452 4.4.5 Rate limit exceeded, try again later."), on
 * 0.16 and 1.0 alike.
 *
 * A creation-id reference (RFC 8620 §5.3), not a `#ids` result reference:
 * Stalwart does not evaluate result references into /set responses.
 */
function deliveryStatusCall(accountId: string, creationId: string): JMAPMethodCall {
  return ['EmailSubmission/get', {
    accountId,
    ids: [`#${creationId}`],
    properties: ['deliveryStatus'],
  }, DELIVERY_STATUS_CALL_ID];
}

/**
 * Splits the deliveryStatus read-back off a send response. It only reports:
 * an error from it (a failed set leaves its back-reference dangling) must not
 * be taken for a failed send or a filing problem by sendMethodErrors.
 */
function takeDeliveryStatus(response: JMAPResponse): {
  response: JMAPResponse;
  deliveryStatus?: Record<string, DeliveryStatus>;
} {
  const entry = response.methodResponses?.find(([, , callId]) => callId === DELIVERY_STATUS_CALL_ID);
  if (!entry) return { response };
  const [name, result] = entry;
  return {
    response: {
      ...response,
      methodResponses: response.methodResponses.filter(([, , callId]) => callId !== DELIVERY_STATUS_CALL_ID),
    },
    deliveryStatus: name === 'EmailSubmission/get' ? (result?.list?.[0]?.deliveryStatus ?? undefined) : undefined,
  };
}

/**
 * The recipients a submission's deliveryStatus (RFC 8621 §7) marks as not
 * delivered, and whether that is all of them - then the message went nowhere.
 */
export function rejectedRecipients(deliveryStatus: Record<string, DeliveryStatus> | null | undefined): {
  rejected: RejectedRecipient[];
  all: boolean;
} {
  const entries = Object.entries(deliveryStatus ?? {});
  const rejected = entries
    .filter(([, status]) => status?.delivered === 'no')
    .map(([email, status]) => ({ email, smtpReply: status.smtpReply?.trim() ?? '' }));
  return { rejected, all: rejected.length > 0 && rejected.length === entries.length };
}

/** "a@example.com (550 5.1.2 Mailbox does not exist.), b@example.com" */
export function formatRejectedRecipients(recipients: RejectedRecipient[]): string {
  return recipients.map(({ email, smtpReply }) => (smtpReply ? `${email} (${smtpReply})` : email)).join(', ');
}

/** The server refused every recipient of a send, so nothing went out. */
export class RecipientsRejectedError extends Error {
  constructor(readonly recipients: RejectedRecipient[]) {
    super(`The server rejected every recipient: ${formatRejectedRecipients(recipients)}`);
    this.name = 'RecipientsRejectedError';
  }
}

/**
 * The send request came back without an EmailSubmission: nothing confirms the
 * message left, and it may still have. The draft is kept.
 */
export class SendUnconfirmedError extends Error {
  constructor() {
    super('Send confirmation was not received. Check Sent before sending again. Your draft has been kept.');
    this.name = 'SendUnconfirmedError';
  }
}

/** "report.pdf" -> "report (2).pdf", the way Stalwart's onExists "rename" names copies. */
function numberedFileName(name: string, n: number): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

/** Throw on a method error of the query that a search request starts with. */
function assertQuerySucceeded(response: JMAPResponse, what: string): void {
  const [name, result] = response.methodResponses?.[0] ?? [];
  if (name === 'error') {
    throw jmapError(`${what} failed: ${result?.description || result?.type || 'unknown error'}`, result);
  }
}

/**
 * The answer to call `callId` of a request. A method error throws with its
 * JMAP type: read as an empty list, a refused calendar get or query used to
 * show an empty calendar instead of a failure.
 */
function methodResult(response: JMAPResponse, callId: string, what: string): JMAPResponseResult {
  const entry = response.methodResponses?.find((r) => r[2] === callId);
  if (!entry) throw new Error(`${what} failed: no response`);
  const [name, result] = entry;
  if (name === 'error') {
    throw jmapError(`${what} failed: ${result?.description || result?.type || 'unknown error'}`, result);
  }
  return result;
}

/**
 * Whether an expanded CalendarEvent/query failed on the server's cap on
 * occurrences per query: `cannotCalculateOccurrences` on Stalwart 1.0,
 * `invalidArguments` ("The number of expanded recurrences exceeds the server
 * limit") on 0.16.
 */
function isOccurrenceLimitError(error: unknown): boolean {
  const type = jmapErrorType(error);
  if (type === 'cannotCalculateOccurrences') return true;
  return type === 'invalidArguments' && /exceeds/i.test(error instanceof Error ? error.message : '');
}

/**
 * Whether a CalendarEvent get or query failed on its `timeZone` argument:
 * Stalwart 1.0 answers a zone its time zone database lacks with
 * `invalidArguments` "Invalid timeZone \"X\"" (0.16 reads it as UTC).
 */
function isTimeZoneRefusal(type: string | undefined, description: string | undefined): boolean {
  return type === 'invalidArguments' && /invalid timeZone/i.test(description ?? '');
}

function isTimeZoneRefusalError(error: unknown): boolean {
  return isTimeZoneRefusal(jmapErrorType(error), error instanceof Error ? error.message : undefined);
}

const DAY_SECONDS = 86_400;
// Chunks of an expanded range stay a day below maxExpandedQueryDuration: the
// server measures the span in UTC after resolving the bounds in the request
// time zone, so a DST change or an ambiguous local time moves it.
const EXPANDED_CHUNK_SLACK = DAY_SECONDS;
// A chunk that still expands to too many occurrences is halved down to about
// a week, one the server finds too long down to an hour; past that, and past
// this many queries for one range, the range is expanded on the client.
const MIN_OCCURRENCE_CHUNK = 7 * DAY_SECONDS;
const MIN_DURATION_CHUNK = 3600;
const MAX_EXPANDED_CHUNKS = 64;
// With a limit the chunks are read in the sort order, a few per request:
// what later chunks return past the limit is dropped.
const LIMITED_CHUNKS_PER_REQUEST = 4;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** The range of an expanded CalendarEvent/query, and its filter for other bounds. */
interface QueryRange {
  after?: string;
  before?: string;
  withBounds: (after?: string, before?: string) => Record<string, unknown>;
}

/**
 * The after/before bounds of a CalendarEvent filter, and the filter rebuilt
 * for other bounds. The bounds are keys of the filter itself, or single-key
 * conditions of a top-level AND - how global search sends a range with
 * several text parts. Rebuilt, such an AND stays flat: Stalwart 1.0 expands
 * recurrences only for a single FilterCondition, and reads a condition of
 * two keys as an AND of its own. An AND that holds anything else - an OR, a
 * NOT, a condition of several keys - is no range: 1.0 would refuse to expand
 * it, so it goes out as it is.
 */
function rangeOf(filter: CalendarEventFilter): QueryRange {
  if (filter.operator === 'AND' && Array.isArray(filter.conditions)) {
    const plain = (condition: CalendarEventFilter) => !condition.operator && Object.keys(condition).length === 1;
    if (!filter.conditions.every(plain)) return { withBounds: () => ({ ...filter }) };
    let after: string | undefined;
    let before: string | undefined;
    const rest = filter.conditions.filter((condition) => {
      const keys = Object.keys(condition);
      if (keys.length !== 1) return true;
      if (keys[0] === 'after' && typeof condition.after === 'string') {
        after = condition.after;
        return false;
      }
      if (keys[0] === 'before' && typeof condition.before === 'string') {
        before = condition.before;
        return false;
      }
      return true;
    });
    return {
      after,
      before,
      withBounds: (from, to) => ({
        operator: 'AND',
        conditions: [...(from ? [{ after: from }] : []), ...(to ? [{ before: to }] : []), ...rest],
      }),
    };
  }
  const { after, before, ...rest } = filter;
  return {
    after,
    before,
    withBounds: (from, to) => ({ ...rest, ...(from ? { after: from } : {}), ...(to ? { before: to } : {}) }),
  };
}

/**
 * Part of an expanded CalendarEvent/query range, in seconds of the request
 * time zone's wall clock (the LocalDateTime bounds counted as if UTC).
 */
interface RangeChunk {
  start: number;
  end: number;
  /** Where the next page of this chunk starts. */
  position: number;
}

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

/** A LocalDateTime such as "2026-09-01T00:00:00" as wall-clock seconds, or null. */
function wallClockSeconds(value: unknown): number | null {
  const match = typeof value === 'string' ? LOCAL_DATE_TIME.exec(value) : null;
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime() / 1000;
}

function localDateTimeOf(seconds: number): string {
  const date = new Date(seconds * 1000);
  const pad = (n: number, length = 2) => String(n).padStart(length, '0');
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
    + `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/**
 * [start, end] cut into chunks of at most `span` seconds, or null when that
 * takes more than MAX_EXPANDED_CHUNKS. Neighbours share a second: the server
 * counts an occurrence in a range only when it overlaps it strictly, so one
 * that sits exactly on a border would belong to neither chunk.
 */
function chunkRange(start: number, end: number, span: number): RangeChunk[] | null {
  if (span < 2) return null;
  const chunks: RangeChunk[] = [];
  for (let from = start; chunks.length < MAX_EXPANDED_CHUNKS; from = chunks[chunks.length - 1].end - 1) {
    const to = Math.min(from + span, end);
    chunks.push({ start: from, end: to, position: 0 });
    if (to >= end) return chunks;
  }
  return null;
}

/**
 * What to query instead of a chunk the server refused: its two halves, or
 * null when it is already as small as it gets and the range has to be
 * expanded on the client. Any other refusal is rethrown.
 */
function splitRefusedChunk(chunk: RangeChunk, error: unknown): RangeChunk[] | null {
  const length = chunk.end - chunk.start;
  let minimum: number;
  if (jmapErrorType(error) === 'expandDurationTooLarge') minimum = MIN_DURATION_CHUNK;
  else if (isOccurrenceLimitError(error)) minimum = MIN_OCCURRENCE_CHUNK;
  else throw error;
  if (length <= minimum) return null;
  const middle = Math.floor((chunk.start + chunk.end) / 2);
  return [
    { start: chunk.start, end: middle, position: 0 },
    { start: middle - 1, end: chunk.end, position: 0 },
  ];
}

/** The busy periods of a Principal/getAvailability response. */
function busyPeriodsOf(result: JMAPResponseResult | undefined): BusyPeriod[] {
  const list = (result?.list ?? []) as Array<{ utcStart: string; utcEnd: string; busyStatus?: BusyPeriod['busyStatus'] }>;
  return list.map((p) => ({ utcStart: p.utcStart, utcEnd: p.utcEnd, busyStatus: p.busyStatus ?? null }));
}

function hasSubmissionMethod(methodCalls: JMAPMethodCall[]): boolean {
  return methodCalls.some(([method]) => method.startsWith('Identity/') || method.startsWith('EmailSubmission/'));
}

/** A SetError (RFC 8620 §5.3) as returned in notCreated / notUpdated / notDestroyed. */
interface JMAPSetError {
  type?: string;
  description?: string;
  properties?: string[];
}

/** The SetError an EmailSubmission/set create came back with, if it failed that way. */
function submissionCreateError(response: JMAPResponse, creationId: string): JMAPSetError | undefined {
  return response.methodResponses
    ?.find(([name]) => name === 'EmailSubmission/set')?.[1]?.notCreated?.[creationId];
}

function submissionDestroyCall(ids: string[], accountId: string, callId: string): JMAPMethodCall {
  return ['EmailSubmission/set', { accountId, destroy: ids }, callId];
}

/**
 * The ids an EmailSubmission/set destroy removed. `notFound` means the record
 * is gone already - another tab or device got there first - which is what the
 * caller wanted. Any other failure is only logged: a leftover record costs
 * quota, never mail.
 */
function readSubmissionDestroy(response: JMAPResponse, callId: string): string[] {
  const [name, result] = response.methodResponses?.find(([, , id]) => id === callId) ?? [];
  if (name !== 'EmailSubmission/set') {
    console.warn('[EmailSubmission] destroy failed:', result);
    return [];
  }
  const failures = Object.entries((result?.notDestroyed ?? {}) as Record<string, JMAPSetError>)
    .filter(([, error]) => error?.type !== 'notFound');
  if (failures.length > 0) {
    console.warn('[EmailSubmission] not destroyed:', Object.fromEntries(failures));
  }
  return Array.isArray(result?.destroyed) ? result.destroyed as string[] : [];
}

/**
 * The submissions that can no longer be cancelled, going by the undoStatus
 * EmailSubmission/get reports: canceled ones, and final ones whose sendAt has
 * passed. Stalwart computes that status from its queue on every version, so
 * it is the one to trust - unlike the status a create returns (0.16.10-0.16.16
 * say final for a held send) or the query's undoStatus filter (0.16.6-0.16.16
 * match the stored status). A pending submission is never among them, whatever
 * its sendAt: the queue still holds its mail, held or retrying, and without
 * the record it could no longer be cancelled - while destroying it would not
 * stop the delivery either.
 */
export function prunableSubmissionIds(
  submissions: Array<Pick<EmailSubmission, 'id' | 'sendAt' | 'undoStatus'>>,
  now: number,
): string[] {
  return submissions
    .filter((submission) => {
      if (submission.undoStatus === 'canceled') return true;
      if (submission.undoStatus !== 'final' || !submission.sendAt) return false;
      const sendAt = Date.parse(submission.sendAt);
      return Number.isFinite(sendAt) && sendAt <= now;
    })
    .map((submission) => submission.id);
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

// Generate a Message-ID for outgoing mail (bare msg-id, no angle brackets, per
// RFC 8621 §4.1.2.3). Without one the server synthesizes it from its OS
// hostname, which leaks internal names (e.g. @ip-10-0-12-97.ec2.internal) into
// headers — an anti-spam signal and an information disclosure. Use the sender's
// domain instead, matching what receivers expect a Message-ID to look like.
function generateMessageId(fromEmail: string): string {
  const at = fromEmail.lastIndexOf('@');
  const domain = at > 0 ? fromEmail.slice(at + 1) : 'localhost';
  // FTM fix (2026-08-22): crypto.randomUUID() only exists in SECURE contexts (https/localhost).
  // On a plain-http LAN origin it is undefined, so this line threw AFTER the draft was saved and
  // BEFORE EmailSubmission/set — send silently failed with drafts piling up. generateUUID() from
  // lib/utils falls back to crypto.getRandomValues, which insecure contexts do provide.
  return `${Date.now().toString(36)}.${generateUUID()}@${domain}`;
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
  return sanitizeDisplayName(name);
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

/**
 * Per-message SMTP submission options (RFC 8621 §7.1 envelope parameters).
 * `requestDsn` asks the next hops for delivery status notifications (RFC
 * 3461 NOTIFY / RET); `requireTls` refuses relaying over an unencrypted hop
 * (RFC 8689 REQUIRETLS). Both need the matching entry in the account's
 * `submissionExtensions`; see JMAPClient.supportsSubmissionExtension.
 */
export interface SubmissionSendOptions {
  requestReadReceipt?: boolean;
  requestDsn?: boolean;
  requireTls?: boolean;
  /** Importance / X-Priority headers (#970); see lib/message-priority.ts. */
  priority?: MessagePriority;
  /** Extra headers plugins added; see lib/outgoing/custom-headers.ts. */
  headers?: Record<string, string>;
  /** The account the replaced draft (`draftId`) lives in; default the primary. */
  draftAccountId?: string;
}

/** The MAIL FROM / RCPT TO parameters the options translate to. */
export function submissionEnvelopeParameters(options: SubmissionSendOptions | undefined, holdForSeconds?: number): {
  mailFrom: Record<string, string | null>;
  rcptTo: Record<string, string | null>;
} {
  const mailFrom: Record<string, string | null> = {};
  const rcptTo: Record<string, string | null> = {};
  if (holdForSeconds) mailFrom.HOLDFOR = String(holdForSeconds);
  if (options?.requireTls) mailFrom.REQUIRETLS = null;
  if (options?.requestDsn) {
    // Return the headers only (not the full message) with the notification.
    mailFrom.RET = 'HDRS';
    rcptTo.NOTIFY = 'SUCCESS,FAILURE,DELAY';
  }
  return { mailFrom, rcptTo };
}

function createDelayedSubmissionEnvelope(fromEmail: string, holdForSeconds?: number, recipients?: Array<string | EmailAddress>, options?: SubmissionSendOptions): Record<string, unknown> | undefined {
  const parameters = submissionEnvelopeParameters(options, holdForSeconds);
  // Raw sends (S/MIME) leave Bcc out of the message, so the server cannot
  // derive those recipients from the headers. Explicit recipients always
  // need an envelope, even without SMTP parameters (#1206).
  const recipientList = normalizeEnvelopeRecipients(recipients);
  if (Object.keys(parameters.mailFrom).length === 0 && Object.keys(parameters.rcptTo).length === 0 && recipientList.length === 0) return undefined;
  const rcptTo = recipientList.map((r) =>
    Object.keys(parameters.rcptTo).length > 0 ? { ...r, parameters: parameters.rcptTo } : r,
  );
  return {
    mailFrom: {
      email: fromEmail,
      ...(Object.keys(parameters.mailFrom).length > 0 ? { parameters: parameters.mailFrom } : {}),
    },
    rcptTo,
  };
}

type SubmissionCapability = {
  maxDelayedSend?: number;
  submissionExtensions?: unknown;
};

/** An identity address that is exactly `from` (both lower-cased by the caller or here). */
function identityEmailMatchesExactly(identityEmail: string | undefined, from: string): boolean {
  return !!identityEmail && identityEmail.toLowerCase() === from;
}

/** An identity address `from` is a sub-address of (team+tag@ for team@, with the common "+" / "-" delimiters). */
function identityEmailIsSubAddressOf(identityEmail: string | undefined, from: string): boolean {
  if (!identityEmail) return false;
  const [idLocal, idDomain] = identityEmail.toLowerCase().split('@');
  const [fromLocal, fromDomain] = from.split('@');
  if (!idDomain || !fromDomain || idDomain !== fromDomain || idLocal === '*') return false;
  return fromLocal.startsWith(`${idLocal}+`) || fromLocal.startsWith(`${idLocal}-`);
}

/** A wildcard identity for the domain of `from` (RFC 8621 §6, "*@example.com"). */
function identityEmailIsWildcardFor(identityEmail: string | undefined, from: string): boolean {
  if (!identityEmail) return false;
  const [idLocal, idDomain] = identityEmail.toLowerCase().split('@');
  return idLocal === '*' && !!idDomain && idDomain === from.split('@')[1];
}

export class JMAPClient implements IJMAPClient {
  private static readonly RATE_LIMIT_TOAST_THROTTLE_MS = 10_000;
  /**
   * How long a request may go without producing response headers. Generous
   * enough that a slow mobile link or a busy server still completes, short
   * enough that a dead connection surfaces as an error the user can retry
   * rather than a permanently spinning UI.
   */
  private static readonly REQUEST_TIMEOUT_MS = 30_000;
  /**
   * Blob transfers answer only once the payload has moved, so a large
   * attachment on a slow uplink legitimately outlives the normal deadline.
   */
  private static readonly TRANSFER_TIMEOUT_MS = 300_000;
  /**
   * How long an access token counts as good after the server last accepted
   * it. The keep-alive ping confirms it every 30s while the page is awake,
   * and the refresh timer renews it a minute before it expires.
   */
  private static readonly AUTH_ACCEPTED_FRESH_MS = 30_000;

  private serverUrl: string;
  private username: string;
  private password: string;
  private basePassword: string = '';
  private authHeader: string;
  private authMode: 'basic' | 'bearer' = 'basic';
  private onTokenRefresh?: () => Promise<string | null>;
  /** When the server last answered a request without 401 (epoch ms). */
  private authAcceptedAt = 0;
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
  /** Hold limit learned from a rejected scheduled send (seconds). */
  private learnedMaxDelayedSend: number | null = null;
  /** When each account's submission records were last pruned (epoch ms). */
  private submissionPrunedAt = new Map<string, number>();
  /**
   * Shared accounts that advertise EmailSubmission but refused this login's
   * calls with `forbidden` - on 0.16, an account that only shared an address
   * book or a calendar. Left out of getSubmissionAccountIds for the session.
   */
  private refusedSubmissionAccounts = new Set<string>();
  /** Accounts where making room found nothing to free, until when (epoch ms). */
  private submissionRoomRecheckAt = new Map<string, number>();
  // Consecutive keep-alive failures; failed pings skip upcoming ticks
  // (30s -> 1m -> 2m -> ~5m) instead of hammering a down server (#588).
  private pingFailureCount = 0;
  private pingSkipRemaining = 0;
  private accounts: Record<string, JMAPAccount> = {};
  /** Identities per candidate account for resolveSendAccountId, briefly cached. */
  private sendIdentitiesCache: { key: string; identitiesByAccount: Array<[string, Identity[]]>; expires: number } | null = null;
  private eventSource: EventSource | null = null;
  private stateChangeCallback: ((change: StateChange) => void) | null = null;
  private lastStates: AccountStates = {};
  private reconnecting = false;
  private connectionChangeCallback: ((connected: boolean) => void) | null = null;
  private rateLimitedUntil: number = 0;
  private rateLimitCallback: ((rateLimited: boolean, retryAfterMs: number) => void) | null = null;
  private rateLimitTimeout: NodeJS.Timeout | null = null;
  // Per-account result of the keyword sort polarity probe (#718). `null` means
  // the probe was inconclusive (every message read, or unread) and is retried
  // after KEYWORD_SORT_PROBE_RETRY_MS; a determined value lives for the session.
  private keywordSortPolarity = new Map<string, { value: KeywordSortPolarity | null; at: number }>();
  private keywordSortProbes = new Map<string, Promise<KeywordSortPolarity>>();
  // Accounts whose server refused a hasKeyword comparator with unsupportedSort.
  private keywordSortUnsupported = new Set<string>();
  // Accounts whose server refused a blobId in ContactCard media although the
  // capability suggested it takes one; see supportsContactBlobMedia.
  private contactBlobMediaRejected = new Set<string>();
  private lastRateLimitNoticeAt: number = 0;
  // Serialises the first calendar/contacts request per account so Stalwart's
  // lazy default-calendar/address-book creation can't run twice (#907).
  private firstTouchGate = new FirstTouchGate();

  constructor(serverUrl: string, username: string, password: string) {
    this.serverUrl = serverUrl.replace(/\/$/, '');
    this.username = username;
    this.password = password;
    this.authHeader = basicAuthHeader(username, password);
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

  // Throws when the server does not answer: an empty result would read as
  // "these messages are gone", and callers would drop them from the list.
  async getSomeEmails(emailsId: string[], accountId?: string): Promise<Email[]> {
    const targetAccountId = accountId || this.accountId;
    if (!emailsId || emailsId.length === 0) {
      return [];
    }

    const emails: Email[] = [];

    for (const batchIds of batched(emailsId, this.getMaxObjectsInGet())) {
      const response = await this.request([
        ["Email/get", {
          accountId: targetAccountId,
          ids: batchIds,
          properties: [...EMAIL_LIST_PROPERTIES],
        }, "0"],
      ]);

      const getResponse = response.methodResponses?.[0]?.[1];
      if (response.methodResponses?.[0]?.[0] !== "Email/get" || !getResponse) {
        throw new Error(methodErrorMessage(response, 'Failed to get emails'));
      }
      emails.push(...applyListAuthenticationResults((getResponse.list || []) as Email[]));
    }

    emails.sort((a: Email, b: Email) =>
      new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()
    );

    if (accountId && accountId !== this.accountId) {
      namespaceMailboxIds(emails, accountId);
    }

    return emails;
  }

  /**
   * Attachment parts of the given emails, keyed by email id, for list-row
   * chips. Kept out of the list request on purpose: the server has to read
   * each message's whole raw blob to answer it (#1089), so callers should
   * ask only for the rows that are on screen and have `hasAttachment`.
   * Ids the server does not return are absent from the map.
   */
  async getEmailAttachments(emailIds: string[], accountId?: string): Promise<Map<string, Attachment[]>> {
    const targetAccountId = accountId || this.accountId;
    const result = new Map<string, Attachment[]>();
    for (const batchIds of batched(emailIds, this.getMaxObjectsInGet())) {
      const response = await this.request([
        ["Email/get", {
          accountId: targetAccountId,
          ids: batchIds,
          properties: ["id", "attachments"],
          bodyProperties: [...LIST_ATTACHMENT_BODY_PROPERTIES],
        }, "0"],
      ]);
      if (response.methodResponses?.[0]?.[0] !== "Email/get") {
        throw new Error("Email/get for list attachments failed");
      }
      const list = (response.methodResponses[0][1]?.list || []) as Pick<Email, "id" | "attachments">[];
      for (const email of list) result.set(email.id, email.attachments ?? []);
    }
    return result;
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
    this.authHeader = basicAuthHeader(this.username, newPassword);
  }

  getAuthHeader(): string {
    return this.authHeader;
  }

  /**
   * The password of a plain Basic session, or null for a bearer session and
   * for one that appends a TOTP code (that code expires; the password alone
   * would not sign in).
   */
  getBasicPassword(): string | null {
    return this.authHeader.startsWith('Basic ') && !this.onTotpRequired ? this.password : null;
  }

  getServerUrl(): string {
    return this.serverUrl;
  }

  /**
   * `fetch` with a deadline on the response *headers*.
   *
   * The timer is cleared as soon as the fetch settles, so it never touches the
   * body: long-lived streams (SSE) and slow blob transfers keep working once
   * the server has started answering. What it does catch is the stalled case -
   * a connection that accepts the request and then goes silent - which fetch
   * itself would leave pending indefinitely.
   *
   * A caller-supplied `init.signal` still aborts the request (and, for SSE, the
   * stream) at any time; it is chained into the internal controller rather than
   * replaced.
   */
  private async timedFetch(
    url: string,
    init: Parameters<typeof fetch>[1],
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const external = init?.signal ?? undefined;
    if (external) {
      if (external.aborted) controller.abort(external.reason);
      else external.addEventListener('abort', () => controller.abort(external.reason), { once: true });
    }

    // Tracked separately from the signal: the abort reason is what distinguishes
    // "we gave up" from "the caller cancelled", and callers must be able to tell
    // those apart (a cancelled send is not a failed send).
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      return await fetch(url, { ...withJmapCredentials(init), headers, signal: controller.signal });
    } catch (error) {
      if (timedOut) throw new RequestTimeoutError(timeoutMs);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async authenticatedFetch(
    url: string,
    init?: Parameters<typeof fetch>[1],
    opts?: { timeoutMs?: number },
  ): Promise<Response> {
    // Short-circuit: if rate-limited, reject immediately without sending a request
    if (this.isRateLimited()) {
      const remaining = this.rateLimitedUntil - Date.now();
      this.notifyRateLimitBlocked(remaining);
      throw new RateLimitError(remaining);
    }

    const timeoutMs = opts?.timeoutMs ?? JMAPClient.REQUEST_TIMEOUT_MS;
    const headers = { ...init?.headers as Record<string, string>, 'Authorization': this.authHeader };
    let response: Response;

    try {
      response = await this.timedFetch(url, init, headers, timeoutMs);
    } catch (error) {
      // Network error: retry once after brief delay (transient proxy/connection issues)
      if (this.reconnecting) throw error;
      // A timeout is NOT retried. The request may well have reached the server
      // and been acted on - only the answer was lost - and these bodies are not
      // idempotent: replaying an EmailSubmission/set would send the mail twice.
      // Surface it instead so the caller can report a failure the user can act on.
      if (error instanceof RequestTimeoutError) throw error;
      // The same holds for a connection that failed after the request was
      // written (a reset, a proxy dropping the response): only a request that
      // changes nothing may be replayed.
      if (!isReplaySafeRequest(init)) throw error;
      await new Promise(r => setTimeout(r, 1000));
      response = await this.timedFetch(url, init, headers, timeoutMs);
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
          response = await this.timedFetch(url, init, retryHeaders, timeoutMs);
        }
      } else if (this.authMode === 'basic' && !this.reconnecting && url !== `${this.serverUrl}/.well-known/jmap`) {
        // JMAP session may have expired - re-establish and retry once
        this.reconnecting = true;
        try {
          await this.refreshSession();
          this.connectionChangeCallback?.(true);
          const retryHeaders = { ...init?.headers as Record<string, string>, 'Authorization': this.authHeader };
          response = await this.timedFetch(url, init, retryHeaders, timeoutMs);
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
                response = await this.timedFetch(url, init, retryHeaders, timeoutMs);
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

    if (response.status !== 401) this.authAcceptedAt = Date.now();
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
    // A proxy in front of the session URL answers the header-less redirected
    // request with 401 instead of Stalwart's silent 200 - the credentials are
    // fine, Safari just dropped them. Retry the final URL directly. (#892)
    if (response.redirected && response.status === 401) {
      return fetch(response.url, withJmapCredentials({
        method: 'GET',
        headers: { 'Authorization': this.authHeader },
      }));
    }
    if (!response.ok || !response.redirected) return response;

    const peek = await response.clone().json().catch(() => null);
    const hasAccounts = peek && Object.keys(peek.accounts || {}).length > 0;
    const hasUsername = typeof peek?.username === 'string' && peek.username.length > 0;
    if (hasAccounts || hasUsername) return response;

    return fetch(response.url, withJmapCredentials({
      method: 'GET',
      headers: { 'Authorization': this.authHeader },
    }));
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
      // A push stream that delivered something within its ping interval has
      // just shown the server reachable; an echo would only repeat that. When
      // the stream goes quiet or drops, the echo is back on the next tick.
      if (this.pingFailureCount === 0 && this.isPushStreamLive()) return;
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

  /** Whether the SSE stream delivered an event or a ping within the last SSE_LIVE_WINDOW. */
  private isPushStreamLive(): boolean {
    return this.sseAbortController !== null
      && this.lastSSEActivity > 0
      && Date.now() - this.lastSSEActivity <= JMAPClient.SSE_LIVE_WINDOW;
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
    if (!url) return url;
    try {
      const { origin } = new URL(this.serverUrl);
      if (!/^(https?:)?\/\//i.test(url)) {
        return origin + (url.startsWith('/') ? url : '/' + url);
      }
      const pathStart = url.indexOf('/', url.indexOf('//') + 2);
      return origin + (pathStart === -1 ? '' : url.slice(pathStart));
    } catch {
      return url;
    }
  }

  /**
   * The server names its URLs under the base URL it believes it has, which
   * behind a reverse proxy may not be one the browser can reach, so they are
   * moved onto `serverUrl`'s origin. A URL on another HTTPS origin than the
   * server's own `apiUrl` is one it deliberately hosts elsewhere (Fastmail
   * serves downloads from a separate domain) and is kept.
   */
  private rewriteSessionUrls(session: JMAPSession): void {
    const reportedOrigin = absoluteOrigin(session.apiUrl);
    const rewrite = (url: string): string => {
      const origin = absoluteOrigin(url);
      const hostedElsewhere = !!origin && !!reportedOrigin && origin !== reportedOrigin && origin.startsWith('https:');
      return hostedElsewhere ? url : this.rewriteSessionUrl(url);
    };
    session.apiUrl = this.rewriteSessionUrl(session.apiUrl);
    session.downloadUrl = rewrite(session.downloadUrl);
    if (session.uploadUrl) {
      session.uploadUrl = rewrite(session.uploadUrl);
    }
    if (session.eventSourceUrl) {
      session.eventSourceUrl = rewrite(session.eventSourceUrl);
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
    const body = JSON.stringify(requestBody);

    const apiUrl = this.apiUrl;
    for (let attempt = 0; ; attempt++) {
      const response = await this.firstTouchGate.run(methodCalls, () =>
        this.authenticatedFetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body,
        }),
      );

      const responseText = await response.text();

      if (!response.ok) {
        // Stalwart caps parallel API requests per user (maxConcurrentRequests,
        // default 4). One push event fans out into several refreshes at once
        // (folders, tag counts, thread counts, the list) - multiplied by open
        // tabs - so the ceiling is reached in ordinary use. The refusal comes
        // before any method runs, so back off briefly and replay instead of
        // failing a refresh outright (which used to blank the folder tree, #780).
        if (attempt < CONCURRENT_REQUEST_RETRY_DELAYS_MS.length && isConcurrentRequestRefusal(response.status, responseText)) {
          const base = CONCURRENT_REQUEST_RETRY_DELAYS_MS[attempt];
          await new Promise(r => setTimeout(r, base + Math.random() * base));
          continue;
        }
        console.error('Request failed:', response.status, responseText);
        throw new Error(`Request failed: ${response.status} - ${responseText.substring(0, 200)}`);
      }

      try {
        return JSON.parse(responseText);
      } catch {
        console.error('Failed to parse response:', responseText);
        throw new Error('Invalid JSON response from server');
      }
    }
  }

  async getQuota(): Promise<StorageQuota | null> {
    if (!this.supportsQuota()) return null;

    try {
      const response = await this.request([
        ["Quota/get", {
          accountId: this.accountId,
        }, "0"]
      ], ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:quota"]);

      if (response.methodResponses?.[0]?.[0] === "Quota/get") {
        return toStorageQuota((response.methodResponses[0][1].list || []) as JMAPQuota[]);
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
        ["Mailbox/get", { accountId: acctId, properties: MAILBOX_PROPERTIES }, "0"]
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
      // Never substitute a placeholder here. A refused request (the server's
      // maxConcurrentRequests ceiling during a push-driven refresh burst) used
      // to yield a lone synthetic "Inbox" with a made-up id, and the store then
      // replaced the real folder tree with it: the sidebar showed only Inbox
      // (empty, since the id matched nothing) until a reload (#780). Callers
      // keep what they already have, or surface the failure.
      console.error('Failed to get mailboxes:', error);
      throw error instanceof Error ? error : new Error('Failed to get mailboxes');
    }
  }

  async getAllMailboxes(): Promise<Mailbox[]> {
    return (await this.getAllMailboxesWithState()).mailboxes;
  }

  /**
   * Like getAllMailboxes, but also returns the Mailbox collection `state`
   * (RFC 8620 §5.1) of every account fetched, keyed by accountId. The store
   * remembers those states so a later push can be resolved with
   * Mailbox/changes (delta) instead of re-fetching every folder tree.
   */
  async getAllMailboxesWithState(): Promise<{ mailboxes: Mailbox[]; states: Record<string, string> }> {
    try {
      const allMailboxes: Mailbox[] = [];
      const states: Record<string, string> = {};
      const accountIds = Object.keys(this.accounts);

      if (accountIds.length === 0) {
        return { mailboxes: await this.getMailboxes(), states };
      }

      let fetchFailed = false;

      // One Mailbox/get per account, packed maxCallsInRequest to a request and
      // a few requests in flight at once. One request per account, one after
      // the other, made the folder tree wait N round trips: ~14 s for 300
      // shared accounts behind a proxy (#1409). Half of maxConcurrentRequests
      // leaves room for the message list and push requests that run at login.
      const batches = batched(accountIds, itemsPerRequest(this.getMaxCallsInRequest(), 1));
      const perAccount: Mailbox[][] = accountIds.map(() => []);
      const maxObjects = this.getMaxObjectsInGet();

      const fetchBatch = async (batch: string[], offset: number) => {
        try {
          const response = await this.request(batch.map((accountId, i): JMAPMethodCall => [
            "Mailbox/get",
            { accountId, properties: MAILBOX_PROPERTIES },
            String(i),
          ]));

          batch.forEach((accountId, i) => {
            const match = response.methodResponses?.find((r) => r[2] === String(i));
            if (match?.[0] !== "Mailbox/get") {
              if (match) debug.warn('jmap', `[JMAP Mailbox] getAllMailboxes: account ${accountId} answered ${match[0]}`, match[1]);
              return;
            }
            const rawMailboxes = (match[1].list || []) as JMAPMailbox[];
            const mailboxState = (match[1] as { state?: unknown }).state;
            if (typeof mailboxState === 'string') {
              states[accountId] = mailboxState;
            }

            debug.log('jmap', `[JMAP Mailbox] getAllMailboxes: account ${accountId} returned ${rawMailboxes.length} mailboxes (isPrimary: ${accountId === this.accountId})`);

            // Warn if response might be truncated
            if (rawMailboxes.length >= maxObjects) {
              debug.warn('jmap',
                `[JMAP Mailbox] Account ${accountId}: response contains ${rawMailboxes.length} mailboxes which equals maxObjectsInGet (${maxObjects}). ` +
                `Some mailboxes may be missing.`
              );
            }

            perAccount[offset + i] = rawMailboxes.map((mb) => this.mapRawMailbox(mb, accountId));
          });
        } catch (error) {
          fetchFailed = true;
          console.error(`Failed to fetch mailboxes for accounts ${batch.join(', ')}:`, error);
        }
      };

      let next = 0;
      const workers = Array.from(
        { length: Math.min(batches.length, Math.max(1, Math.floor(this.getMaxConcurrentRequests() / 2))) },
        async () => {
          while (next < batches.length) {
            const index = next++;
            await fetchBatch(batches[index], index * batches[0].length);
          }
        },
      );
      await Promise.all(workers);

      // Accounts keep the session's order, whichever batch answered first.
      for (const mailboxes of perAccount) allMailboxes.push(...mailboxes);

      // If every account fetch failed (e.g. a transient maxConcurrentRequests
      // limit during a burst of deletes) we have an empty list that is NOT a
      // real "this account has no mailboxes" result. Throwing lets the caller's
      // catch preserve the existing folder list instead of clobbering it with
      // [] — which would leave the sidebar stuck on "Loading mailboxes...".
      if (allMailboxes.length === 0 && fetchFailed) {
        throw new Error('Failed to fetch mailboxes for all accounts');
      }

      return { mailboxes: allMailboxes, states };
    } catch (error) {
      // No placeholder fallback (see getMailboxes): the caller keeps its
      // current list rather than showing a folder tree the server never sent.
      console.error("Failed to fetch all mailboxes:", error);
      throw error instanceof Error ? error : new Error('Failed to fetch mailboxes');
    }
  }

  /**
   * Maps a raw JMAP Mailbox into the store's shape. Folders of a delegated
   * (non-primary) account get namespaced ids (`accountId:id`) exactly like
   * getAllMailboxes produces them, so a delta-patched folder matches the row
   * it replaces.
   */
  private mapRawMailbox(mb: JMAPMailbox, accountId: string): Mailbox {
    const isPrimary = accountId === this.accountId;
    const account = this.accounts[accountId];
    return {
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
    } as Mailbox;
  }

  /**
   * Fetches only the given mailboxes (Mailbox/get with `ids`), mapped like
   * getAllMailboxes. Used to patch the folders a Mailbox/changes response
   * reported as updated without re-fetching the whole tree.
   */
  async getMailboxesByIds(ids: string[], accountId?: string): Promise<Mailbox[]> {
    const acctId = accountId || this.accountId;
    if (ids.length === 0) return [];
    const mailboxes: Mailbox[] = [];
    for (const batchIds of batched(ids, this.getMaxObjectsInGet())) {
      const response = await this.request([
        ["Mailbox/get", { accountId: acctId, ids: batchIds, properties: MAILBOX_PROPERTIES }, "0"],
      ]);
      if (response.methodResponses?.[0]?.[0] !== "Mailbox/get") {
        throw new Error('Unexpected response format');
      }
      const rawMailboxes = (response.methodResponses[0][1].list || []) as JMAPMailbox[];
      mailboxes.push(...rawMailboxes.map((mb) => this.mapRawMailbox(mb, acctId)));
    }
    return mailboxes;
  }

  /**
   * Generic `Foo/changes` (RFC 8620 §5.2). Returns null when the server can
   * no longer compute a delta from `sinceState` (`cannotCalculateChanges`,
   * a too-old state, a state that went backwards, or any other error) - the
   * caller then falls back to a full re-fetch. `hasMoreChanges` is surfaced
   * rather than paged through: a delta that large is cheaper to resolve with
   * a fresh query.
   */
  private async getCollectionChanges(type: 'Email' | 'Mailbox', sinceState: string, accountId?: string, maxChanges?: number): Promise<CollectionChanges | null> {
    const targetAccountId = accountId || this.accountId;
    try {
      const response = await this.request([
        [`${type}/changes`, {
          accountId: targetAccountId,
          sinceState,
          ...(maxChanges ? { maxChanges } : {}),
        }, "0"],
      ]);
      const [method, result] = response.methodResponses?.[0] ?? [];
      if (method !== `${type}/changes` || !result) {
        return null;
      }
      const r = result as {
        oldState?: string;
        newState?: string;
        hasMoreChanges?: boolean;
        created?: string[];
        updated?: string[];
        destroyed?: string[];
        updatedProperties?: string[] | null;
      };
      if (typeof r.newState !== 'string') return null;
      // Stalwart's change ids only grow. A newState below sinceState means its
      // counters went back - a restore, or an upgrade that kept the old change
      // log but restarted the counters lower (1.0 counts per collection where
      // 0.16 counted per account) - and it then answers an old state with an
      // empty delta, skipping every change since. Take the full fetch instead.
      // A multi-node 1.0 cluster can trip this harmlessly: a node answers from
      // its cache for up to 5 seconds, so it may be behind a state another
      // node already handed out. That costs one extra full fetch.
      if (this.hasAccountCapability('urn:stalwart:jmap', targetAccountId)) {
        const since = stalwartChangeId(sinceState);
        const next = stalwartChangeId(r.newState);
        if (since !== null && next !== null && next < since) {
          debug.warn('jmap', `[JMAP] ${type}/changes went back from ${sinceState} to ${r.newState}, falling back to a full fetch`);
          return null;
        }
      }
      return {
        oldState: r.oldState ?? sinceState,
        newState: r.newState,
        hasMoreChanges: r.hasMoreChanges === true,
        created: r.created ?? [],
        updated: r.updated ?? [],
        destroyed: r.destroyed ?? [],
        updatedProperties: Array.isArray(r.updatedProperties) ? r.updatedProperties : null,
      };
    } catch (error) {
      debug.log('jmap', `[JMAP] ${type}/changes since ${sinceState} unavailable, falling back to a full fetch`, error);
      return null;
    }
  }

  /** Email/changes since `sinceState` for the account (see getCollectionChanges). */
  getEmailChanges(sinceState: string, accountId?: string, maxChanges?: number): Promise<CollectionChanges | null> {
    return this.getCollectionChanges('Email', sinceState, accountId, maxChanges);
  }

  /** Mailbox/changes since `sinceState` for the account (see getCollectionChanges). */
  getMailboxChanges(sinceState: string, accountId?: string, maxChanges?: number): Promise<CollectionChanges | null> {
    return this.getCollectionChanges('Mailbox', sinceState, accountId, maxChanges);
  }

  /**
   * Sort properties the server advertises for Email/query on this account
   * (RFC 8621 §1.3 `emailQuerySortOptions`), or null when it doesn't say.
   */
  getEmailQuerySortOptions(accountId?: string): string[] | null {
    const id = accountId || this.accountId;
    const caps = this.session?.accounts?.[id]?.accountCapabilities?.["urn:ietf:params:jmap:mail"] as
      | { emailQuerySortOptions?: unknown }
      | undefined;
    const options = caps?.emailQuerySortOptions;
    return Array.isArray(options) ? options.filter((o): o is string => typeof o === "string") : null;
  }

  /**
   * Whether keyword comparators (hasKeyword) can be sent to this account's
   * server: not when it advertises a sort-option list without them, and not
   * after it has refused one with `unsupportedSort`. Unknown counts as yes.
   */
  private keywordSortSupported(accountId: string): boolean {
    if (this.keywordSortUnsupported.has(accountId)) return false;
    const options = this.getEmailQuerySortOptions(accountId);
    return options === null || options.includes("hasKeyword");
  }

  /**
   * Determines, once per account and session, which way the server reads
   * `isAscending` on hasKeyword comparators (see KeywordSortPolarity in
   * lib/message-list-order.ts). Two one-item queries with opposite
   * directions: if they return different messages both groups exist and the
   * keywords of the ascending winner settle the polarity; if they return the
   * same message the mailbox is homogeneous and the probe is inconclusive.
   * Any failure falls back to the RFC reading without caching a verdict.
   */
  private resolveKeywordSortPolarity(accountId: string): Promise<KeywordSortPolarity> {
    const cached = this.keywordSortPolarity.get(accountId);
    if (cached && (cached.value !== null || Date.now() - cached.at < KEYWORD_SORT_PROBE_RETRY_MS)) {
      return Promise.resolve(cached.value ?? "rfc");
    }
    const pending = this.keywordSortProbes.get(accountId);
    if (pending) return pending;
    const probe = this.probeKeywordSortPolarity(accountId)
      .then((value) => {
        this.keywordSortPolarity.set(accountId, { value, at: Date.now() });
        return value ?? "rfc";
      })
      .catch((error) => {
        debug.warn("jmap", "Keyword sort polarity probe failed:", error);
        this.keywordSortPolarity.set(accountId, { value: null, at: Date.now() });
        return "rfc" as const;
      })
      .finally(() => {
        this.keywordSortProbes.delete(accountId);
      });
    this.keywordSortProbes.set(accountId, probe);
    return probe;
  }

  private async probeKeywordSortPolarity(accountId: string): Promise<KeywordSortPolarity | null> {
    const sortFor = (isAscending: boolean) => [
      { property: "hasKeyword", keyword: "$seen", isAscending },
      { property: "receivedAt", isAscending: false },
    ];
    const response = await this.request([
      ["Email/query", { accountId, sort: sortFor(true), limit: 1 }, "asc"],
      ["Email/query", { accountId, sort: sortFor(false), limit: 1 }, "desc"],
      ["Email/get", {
        accountId,
        "#ids": { resultOf: "asc", name: "Email/query", path: "/ids" },
        properties: ["id", "keywords"],
      }, "get"],
    ]);
    const [ascMethod, ascResult] = response.methodResponses?.[0] ?? [];
    if (ascMethod === "error") {
      if ((ascResult as { type?: string })?.type === "unsupportedSort") {
        this.keywordSortUnsupported.add(accountId);
        return "rfc";
      }
      throw new Error((ascResult as { description?: string })?.description || "Email/query failed");
    }
    const ascIds = ((ascResult as { ids?: string[] })?.ids) ?? [];
    const descIds = ((response.methodResponses?.[1]?.[1] as { ids?: string[] })?.ids) ?? [];
    if (ascIds.length === 0 || descIds.length === 0 || ascIds[0] === descIds[0]) return null;
    const first = ((response.methodResponses?.[2]?.[1] as { list?: Email[] })?.list ?? [])[0];
    if (!first || first.id !== ascIds[0]) return null;
    // Ascending put a $seen message first: the server sorts has-keyword first
    // on isAscending: true, the inverse of the RFC's false < true reading.
    return first.keywords?.$seen ? "inverted" : "rfc";
  }

  /** The Email/query sort for a folder view, with the server's polarity applied. */
  private async buildListSort(accountId: string, pinnedFirst: boolean, order: SortLevel[]): Promise<{ sort: ReturnType<typeof buildEmailSort>; keywordSortSupported: boolean }> {
    if (!hasKeywordLevels(order, pinnedFirst)) {
      return { sort: buildEmailSort(order), keywordSortSupported: true };
    }
    if (!this.keywordSortSupported(accountId)) {
      return { sort: buildEmailSort(order, { pinnedFirst, keywordSortSupported: false }), keywordSortSupported: false };
    }
    const polarity = await this.resolveKeywordSortPolarity(accountId);
    return { sort: buildEmailSort(order, { pinnedFirst, polarity }), keywordSortSupported: true };
  }

  // Throws when the page cannot be read. Answering with an empty page made a
  // failed refresh empty the list, and callers could not tell it from an
  // empty folder.
  async getEmails(mailboxId?: string, accountId?: string, limit: number = 50, position: number = 0, hasKeyword?: string, pinnedFirst?: boolean, extraFilter?: Record<string, unknown>, order: SortLevel[] = []): Promise<{ emails: Email[], hasMore: boolean, total: number, state?: string, threadCounts?: Record<string, number> }> {
    const targetAccountId = accountId || this.accountId;
    const simple: { inMailbox?: string; hasKeyword?: string } = {};
    if (mailboxId) {
      simple.inMailbox = mailboxId;
    }
    if (hasKeyword) {
      simple.hasKeyword = hasKeyword;
    }
    // `extraFilter` is an arbitrary FilterCondition/FilterOperator ANDed
    // into the view - the message-list category tabs' search contract.
    const filter: Record<string, unknown> = extraFilter
      ? {
          operator: "AND",
          conditions: [
            ...(Object.keys(simple).length > 0 ? [simple] : []),
            extraFilter,
          ],
        }
      : simple;
    // Pinned-first and the configured list order (#718) use the hasKeyword
    // sort comparator (RFC 8621 §4.4.2); every page of a view must use the
    // same sort or pagination tears, so the sort is built from settings the
    // same way on the first page, load-more and the push refresh.
    const built = await this.buildListSort(targetAccountId, pinnedFirst === true, order);
    const query = (sort: ReturnType<typeof buildEmailSort>) => this.request([
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
      // The page's conversation sizes, off the thread ids the Email/get
      // returns (RFC 8620 §3.7 wildcard path): no second round trip, and the
      // list paints with its counts instead of re-rendering for them.
      ["Thread/get", {
        accountId: targetAccountId,
        "#ids": { resultOf: "1", name: "Email/get", path: "/list/*/threadId" },
      }, "2"],
    ]);

    let response = await query(built.sort);
    // A server that advertises nothing but refuses hasKeyword fails the whole
    // query. Remember that and retry once without the keyword comparators
    // rather than showing an empty folder.
    if (
      built.keywordSortSupported &&
      response.methodResponses?.[0]?.[0] === "error" &&
      (response.methodResponses[0][1] as { type?: string })?.type === "unsupportedSort"
    ) {
      this.keywordSortUnsupported.add(targetAccountId);
      response = await query(buildEmailSort(order, { pinnedFirst, keywordSortSupported: false }));
    }

    const queryResponse = response.methodResponses?.[0]?.[1];
    const getResponse = response.methodResponses?.[1]?.[1];

    if (response.methodResponses?.[1]?.[0] === "Email/get" && getResponse) {
      const emails = applyListAuthenticationResults((getResponse.list || []) as Email[]);
      if (hasTextLevels(order) && this.keepsServerTextOrder(targetAccountId)) {
        // Stalwart 1.0's sender or subject collation, which the client
        // comparator would only disturb (see keepsServerTextOrder). Keep
        // the query's order: /get may return the objects in any order
        // (RFC 8620 section 5.1).
        const rank = new Map(((queryResponse?.ids ?? []) as string[]).map((id, i) => [id, i]));
        emails.sort((a, b) => (rank.get(a.id) ?? rank.size) - (rank.get(b.id) ?? rank.size));
      } else {
        // Sort client-side as safety net - some servers may not honour
        // the query sort for large mailboxes without additional filters.
        // Must mirror the query sort, or it would undo the configured order.
        // On Stalwart 0.16 this also turns a sender or subject page from
        // raw byte order (capitals first) into a case-insensitive one.
        emails.sort(compareEmails(order, { pinnedFirst }));
      }
      const total = queryResponse?.total || 0;
      const hasMore = computeHasMore(position, emails.length, total, limit);

      if (accountId && accountId !== this.accountId) {
        namespaceMailboxIds(emails, accountId);
      }

      // The Email collection state this page was read at; the store keeps
      // it so a later push can be applied with Email/changes.
      const state = typeof getResponse.state === 'string' ? getResponse.state : undefined;
      return { emails, hasMore, total, state, threadCounts: threadCountsFrom(response.methodResponses?.[2]) };
    }

    throw new Error(methodErrorMessage(response, 'Failed to get emails'));
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

  async getTagCounts(tagIds: string[], accountId?: string, excludeMailboxIds?: string[]): Promise<Record<string, { total: number; unread: number }>> {
    if (tagIds.length === 0) return {};
    const result: Record<string, { total: number; unread: number }> = {};
    const targetAccountId = accountId || this.accountId;
    if (this.countsKeywords(targetAccountId)) {
      const counted = await this.getTagCountsFromKeywords(tagIds, targetAccountId);
      if (counted) return counted;
    }
    const exclusion = excludeMailboxIds && excludeMailboxIds.length > 0
      ? [{ inMailboxOtherThan: excludeMailboxIds }]
      : [];

    const CALLS_PER_TAG = 2;
    const perRequest = itemsPerRequest(this.getMaxCallsInRequest(), CALLS_PER_TAG);

    for (const batch of batched(tagIds, perRequest)) {
      try {
        const methodCalls: JMAPMethodCall[] = [];
        for (let i = 0; i < batch.length; i++) {
          const keyword = `$label:${batch[i]}`;
          // Total count for this tag
          methodCalls.push(["Email/query", {
            accountId: targetAccountId,
            filter: exclusion.length > 0
              ? { operator: "AND", conditions: [{ hasKeyword: keyword }, ...exclusion] }
              : { hasKeyword: keyword },
            // limit 1, not 0: Stalwart treats 0 as "no limit" and returns every id.
            limit: 1,
            calculateTotal: true,
          }, `total_${i}`]);
          // Unread count for this tag
          methodCalls.push(["Email/query", {
            accountId: targetAccountId,
            filter: {
              operator: "AND",
              conditions: [
                { hasKeyword: keyword },
                { notKeyword: "$seen" },
                ...exclusion,
              ],
            },
            // limit 1, not 0: Stalwart treats 0 as "no limit" and returns every id.
            limit: 1,
            calculateTotal: true,
          }, `unread_${i}`]);
        }

        const response = await this.request(methodCalls);

        for (let i = 0; i < batch.length; i++) {
          const totalResp = response.methodResponses?.[i * 2]?.[1];
          const unreadResp = response.methodResponses?.[i * 2 + 1]?.[1];
          result[batch[i]] = {
            total: totalResp?.total ?? 0,
            unread: unreadResp?.total ?? 0,
          };
        }
      } catch (error) {
        console.error('Failed to get tag counts:', error);
      }
    }

    return result;
  }

  /** Whether the server reports every keyword's total and unread in Keyword/get. */
  private countsKeywords(accountId: string): boolean {
    const capability = this.capabilities[KEYWORDS_CAPABILITY] as { supportsCounts?: unknown } | undefined;
    return capability?.supportsCounts === true && this.hasAccountCapability(KEYWORDS_CAPABILITY, accountId);
  }

  /**
   * Tag counts read from the server's own keyword counters: one Keyword/get
   * for every tag, where the query path costs two Email/query per tag.
   *
   * The counters cover the whole account, so `excludeMailboxIds` (#1156) is
   * not applied: a server that counts keywords answers for its own notion of
   * a tag's messages, and a gateway that maps tags to provider labels reports
   * the numbers the provider shows for the label. Returns null when the call
   * fails, so the caller can fall back to querying.
   */
  private async getTagCountsFromKeywords(
    tagIds: string[],
    accountId: string,
  ): Promise<Record<string, { total: number; unread: number }> | null> {
    try {
      const response = await this.request(
        [["Keyword/get", { accountId, ids: tagIds.map((id) => `$label:${id}`) }, "0"]],
        ["urn:ietf:params:jmap:core", KEYWORDS_CAPABILITY],
      );
      const [method, result] = response.methodResponses?.[0] ?? [];
      if (method !== 'Keyword/get' || !Array.isArray(result?.list)) return null;
      // Keywords are case-insensitive (RFC 8621 4.1.1).
      const byId = new Map((result.list as KeywordInfo[]).map((k) => [k.id.toLowerCase(), k]));
      const counts: Record<string, { total: number; unread: number }> = {};
      for (const id of tagIds) {
        const keyword = byId.get(`$label:${id}`.toLowerCase());
        counts[id] = { total: keyword?.total ?? 0, unread: keyword?.unread ?? 0 };
      }
      return counts;
    } catch (error) {
      console.error('Failed to get tag counts from Keyword/get:', error);
      return null;
    }
  }

  /**
   * Every keyword the account's messages actually carry, and how many messages
   * carry each.
   *
   * JMAP has no "list the keywords in use" call - a keyword exists only as a
   * property of the messages bearing it - so the only way to find them is to
   * walk the message list and union what turns up. Each page is one request:
   * an Email/query for the next slice of ids and an Email/get back-referencing
   * it, asking for nothing but `keywords`.
   *
   * Counting here rather than following up with `getTagCounts` costs nothing
   * extra - the messages are already in hand - and counts whatever spelling the
   * keyword actually has, which a `$label:`-shaped count query cannot do for a
   * keyword still written the legacy way. The trade is that a count is only
   * over the messages walked, so it is a floor rather than a total whenever
   * `complete` is false.
   *
   * The walk is capped at `limit` messages because an account can hold far more
   * mail than is worth paging through for this; `complete` says whether the cap
   * (or an abort) cut the scan short, so a caller can say so rather than
   * present a partial answer as the whole truth. Reading is all this does, and
   * it stops at the first failed page instead of retrying - a scan that ends
   * early is reported as incomplete, which is exactly what it is.
   */
  async discoverKeywords(options?: {
    limit?: number;
    onProgress?: (scanned: number, total: number) => void;
    signal?: AbortSignal;
    /** Another account of this login, e.g. a group account (default: the own one). */
    accountId?: string;
  }): Promise<{ keywords: Record<string, number>; scanned: number; total: number; complete: boolean }> {
    const accountId = options?.accountId || this.accountId;
    const cap = Math.max(0, options?.limit ?? DEFAULT_KEYWORD_SCAN_LIMIT);
    const pageSize = Math.max(1, Math.min(500, this.getMaxObjectsInGet()));
    const keywords: Record<string, number> = {};
    let scanned = 0;
    let total = 0;
    let complete = false;

    while (scanned < cap) {
      if (options?.signal?.aborted) break;

      try {
        const response = await this.request([
          ["Email/query", {
            accountId,
            sort: [{ property: "receivedAt", isAscending: false }],
            limit: Math.min(pageSize, cap - scanned),
            position: scanned,
            calculateTotal: scanned === 0,
          }, "0"],
          ["Email/get", {
            accountId,
            "#ids": { resultOf: "0", name: "Email/query", path: "/ids" },
            properties: ["keywords"],
          }, "1"],
        ]);

        const queryResponse = response.methodResponses?.[0]?.[1];
        const getResponse = response.methodResponses?.[1]?.[1];
        const ids: string[] = queryResponse?.ids || [];
        if (scanned === 0) total = queryResponse?.total ?? 0;

        const list = (getResponse?.list || []) as Array<{ keywords?: Record<string, boolean> }>;
        for (const email of list) {
          for (const [keyword, isSet] of Object.entries(email.keywords || {})) {
            if (isSet) keywords[keyword] = (keywords[keyword] ?? 0) + 1;
          }
        }

        // Page by what the query returned, not by what the get did: a message
        // destroyed between the two lands in `notFound` and would otherwise
        // shift every later page by one and skip a message per gap.
        scanned += ids.length;
        options?.onProgress?.(scanned, Math.max(total, scanned));

        // A short page is the end of the list, however much `total` claimed.
        if (ids.length === 0 || ids.length < Math.min(pageSize, cap - (scanned - ids.length))) {
          complete = true;
          break;
        }
      } catch (error) {
        console.error('Failed to scan keywords:', error);
        break;
      }
    }

    return { keywords, scanned, total: Math.max(total, scanned), complete };
  }

  /**
   * Extension-facing keyword enumeration.
   *
   * A JMAP server can advertise a narrow capability that enumerates all cached
   * keywords in one request, including provider labels with no messages.
   * Servers without the capability retain the existing message walk as a
   * transparent fallback.
   */
  async getKeywords(options?: {
    limit?: number;
    onProgress?: (scanned: number, total: number) => void;
    signal?: AbortSignal;
  }): Promise<KeywordDiscoveryResult> {
    const supportsKeywordGet =
      this.hasCapability(KEYWORDS_CAPABILITY) &&
      this.hasAccountCapability(KEYWORDS_CAPABILITY);

    if (!supportsKeywordGet) {
      const scan = await this.discoverKeywords(options);
      // Stalwart 1.0 sets an attachment keyword on every message; it is not a
      // label anyone applied.
      const keywords = Object.fromEntries(
        Object.entries(scan.keywords).filter(([id]) => !isServerSetKeyword(id)),
      );
      const labels: KeywordInfo[] = Object.entries(keywords).map(([id, total]) => ({
        id,
        name: id.startsWith('$label:') ? id.slice('$label:'.length) : id,
        color: null,
        total,
        unread: 0,
        isProviderLabel: false,
        source: 'message',
      }));
      return { ...scan, keywords, labels };
    }

    if (options?.signal?.aborted) {
      return { keywords: {}, labels: [], scanned: 0, total: 0, complete: false };
    }

    const response = await this.request(
      [["Keyword/get", { accountId: this.accountId }, "0"]],
      ["urn:ietf:params:jmap:core", KEYWORDS_CAPABILITY],
    );
    const [method, result] = response.methodResponses?.[0] ?? [];
    if (method !== 'Keyword/get' || !Array.isArray(result?.list)) {
      const description = typeof result?.description === 'string' ? `: ${result.description}` : '';
      throw new Error(`JMAP Keyword/get failed${description}`);
    }

    const labels = (result.list as KeywordInfo[]).map((item) => ({ ...item }));
    const keywords = Object.fromEntries(labels.map((item) => [item.id, item.total]));
    const total = typeof result.totalEmails === 'number' ? result.totalEmails : 0;
    options?.onProgress?.(total, total);
    return { keywords, labels, scanned: total, total, complete: true };
  }

  /**
   * Per-tab unread counts for message-list category tabs. One Email/query
   * (limit 0, calculateTotal) per tab, batched into as few requests as the
   * server's method-call ceiling allows. Each entry's `filter` is the tab's
   * resolved FilterCondition/FilterOperator (null = no extra condition, i.e.
   * all unread in the mailbox).
   */
  async getCategoryUnreadCounts(
    mailboxId: string,
    tabs: Array<{ id: string; filter: Record<string, unknown> | null }>,
    accountId?: string,
  ): Promise<Record<string, number>> {
    if (tabs.length === 0) return {};
    const targetAccountId = accountId || this.accountId;
    const result: Record<string, number> = {};

    for (const batch of batched(tabs, this.getMaxCallsInRequest())) {
      try {
        const methodCalls: JMAPMethodCall[] = batch.map((tab, i) => {
          const conditions: Record<string, unknown>[] = [
            { inMailbox: mailboxId },
            { notKeyword: "$seen" },
          ];
          if (tab.filter) conditions.push(tab.filter);
          return ["Email/query", {
            accountId: targetAccountId,
            filter: { operator: "AND", conditions },
            // limit 1, not 0: Stalwart treats 0 as "no limit" and returns every id.
            limit: 1,
            calculateTotal: true,
          }, `tab_${i}`];
        });

        const response = await this.request(methodCalls);
        for (let i = 0; i < batch.length; i++) {
          result[batch[i].id] = response.methodResponses?.[i]?.[1]?.total ?? 0;
        }
      } catch (error) {
        console.error('Failed to get category tab counts:', error);
      }
    }

    return result;
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
          maxBodyValueBytes: OPEN_EMAIL_MAX_BODY_BYTES,
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

      await this.refetchTruncatedBodyValues([email], targetAccountId);

      if (email.headers) {
        await this.parseEmailHeaders(email);
      }

      return email;
    } catch (error) {
      console.error('Failed to get email:', error);
      return null;
    }
  }

  // The 256000-byte body cap keeps list/thread fetches fast for the common
  // case, but truncation lands mid-tag on large HTML bodies (e.g. a data:image
  // src cut in half), which drops the whole element and can render blank. Only
  // the parts actually shown to the user are checked — fetchAllBodyValues also
  // returns truncated text from attachment parts, which must not trigger a
  // refetch. See #884.
  private hasTruncatedDisplayedBody(email: Email): boolean {
    const bodyValues = email.bodyValues;
    if (!bodyValues) return false;
    const htmlPartId = email.htmlBody?.[0]?.partId;
    const textPartId = email.textBody?.[0]?.partId;
    return Boolean(
      (htmlPartId && bodyValues[htmlPartId]?.isTruncated) ||
      (textPartId && bodyValues[textPartId]?.isTruncated)
    );
  }

  private async refetchTruncatedBodyValues(emails: Email[], accountId: string): Promise<void> {
    const truncated = emails.filter((email) => this.hasTruncatedDisplayedBody(email));
    if (truncated.length === 0) return;

    try {
      const refetchedById = new Map<string, Email['bodyValues']>();
      for (const batchIds of batched(truncated.map((email) => email.id), this.getMaxObjectsInGet())) {
        const response = await this.request([
          ["Email/get", {
            accountId,
            ids: batchIds,
            properties: ["id", "bodyValues"],
            fetchTextBodyValues: true,
            fetchHTMLBodyValues: true,
            fetchAllBodyValues: true,
            maxBodyValueBytes: TRUNCATED_BODY_REFETCH_MAX_BYTES,
          }, "0"],
        ]);
        for (const refetched of (response.methodResponses?.[0]?.[1]?.list || []) as Email[]) {
          refetchedById.set(refetched.id, refetched.bodyValues);
        }
      }

      for (const email of truncated) {
        const bodyValues = refetchedById.get(email.id);
        if (bodyValues) email.bodyValues = bodyValues;
      }
    } catch (error) {
      // Degrade to the already-truncated values - no new error path for callers.
      console.error('Failed to refetch truncated body values:', error);
    }
  }

  private async parseEmailHeaders(email: Email): Promise<void> {
    const { authenticationResultsOnReceipt, parseAuthenticationResults, parseSpamScore, parseSpamLLM } = await import('@/lib/email-headers');

    let headersRecord: Record<string, string | string[]>;
    if (Array.isArray(email.headers)) {
      // The record below loses the order between different header names,
      // which the receipt check needs.
      email.authenticationResultsOnReceipt = authenticationResultsOnReceipt(email.headers as unknown as JMAPEmailHeader[]);
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
      // Keep the headers apart and in message order: the topmost one is the
      // receiving server's own, the rest may be forged by the sender.
      email.authenticationResults = parseAuthenticationResults(authResultsHeader);
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

  // The keyword writers below check the Email/set outcome: the server refuses
  // a keyword per message in `notUpdated`, not as a request error. Stalwart
  // 1.0 refuses keywords over 128 bytes (invalidProperties) and more than 100
  // keywords on one message (tooManyKeywords); a read-only shared folder
  // refuses any. Unchecked, the UI showed the change until the next reload.

  async markAsRead(emailId: string, read: boolean = true, accountId?: string): Promise<void> {
    const targetAccountId = accountId || this.accountId;

    const response = await this.request([
      ["Email/set", {
        accountId: targetAccountId,
        update: {
          [emailId]: {
            "keywords/$seen": read ? true : null,
          },
        },
      }, "0"],
    ]);
    this.assertEmailSetSucceeded(response, read ? "mark as read" : "mark as unread");
  }

  async batchMarkAsRead(emailIds: string[], read: boolean = true, accountId?: string): Promise<void> {
    if (emailIds.length === 0) return;

    const batches = batched(emailIds, this.getMaxObjectsInSet());
    const responses: JMAPResponse[] = [];
    let requestError: unknown;
    for (const batch of batches) {
      const updates = Object.fromEntries(batch.map(id => [id, { "keywords/$seen": read ? true : null }]));
      try {
        responses.push(await this.request([
          ["Email/set", { accountId: accountId || this.accountId, update: updates }, "0"],
        ]));
      } catch (error) {
        requestError = error;
        break;
      }
    }
    this.assertEmailSetBatchesSucceeded(responses, batches, read ? "mark as read" : "mark as unread", requestError);
  }

  async toggleStar(emailId: string, starred: boolean, accountId?: string): Promise<void> {
    const response = await this.request([
      ["Email/set", {
        accountId: accountId || this.accountId,
        update: {
          [emailId]: {
            "keywords/$flagged": starred ? true : null,
          },
        },
      }, "0"],
    ]);
    this.assertEmailSetSucceeded(response, starred ? "star the email" : "unstar the email");
  }

  async updateEmailKeywords(emailId: string, keywords: Record<string, boolean>, accountId?: string): Promise<void> {
    // Every value of a full keyword map must be true (RFC 8621 section
    // 4.1.1). Callers start from local copies, where marking a message unread
    // or unstarred leaves `$seen: false` / `$flagged: false` behind.
    const keywordSet = Object.fromEntries(Object.entries(keywords).filter(([, value]) => value === true));
    const response = await this.request([
      ["Email/set", {
        accountId: accountId || this.accountId,
        update: {
          [emailId]: {
            keywords: keywordSet,
          },
        },
      }, "0"],
    ]);
    this.assertEmailSetSucceeded(response, "update keywords");
  }

  async setKeyword(emailId: string, keyword: string, accountId?: string): Promise<void> {
    const response = await this.request([
      ["Email/set", {
        accountId: accountId || this.accountId,
        update: {
          [emailId]: {
            [keywordPointer(keyword)]: true,
          },
        },
      }, "0"],
    ]);
    this.assertEmailSetSucceeded(response, `set ${keyword}`);
  }

  async removeKeyword(emailId: string, keyword: string, accountId?: string): Promise<void> {
    const response = await this.request([
      ["Email/set", {
        accountId: accountId || this.accountId,
        update: {
          [emailId]: {
            [keywordPointer(keyword)]: null,
          },
        },
      }, "0"],
    ]);
    this.assertEmailSetSucceeded(response, `remove ${keyword}`);
  }

  /**
   * Apply the same keyword PatchObject fragment to many messages in one
   * Email/set. `patch` keys are `keywords/<name>` pointers with true (add)
   * or null (remove) values - the category-tab move primitive.
   */
  async batchUpdateKeywords(emailIds: string[], patch: Record<string, boolean | null>, accountId?: string): Promise<void> {
    if (emailIds.length === 0 || Object.keys(patch).length === 0) return;
    const batches = batched(emailIds, this.getMaxObjectsInSet());
    const responses: JMAPResponse[] = [];
    let requestError: unknown;
    for (const batch of batches) {
      const update = Object.fromEntries(batch.map(id => [id, { ...patch }]));
      try {
        responses.push(await this.request([
          ["Email/set", { accountId: accountId || this.accountId, update }, "0"],
        ]));
      } catch (error) {
        requestError = error;
        break;
      }
    }
    this.assertEmailSetBatchesSucceeded(responses, batches, "update keywords", requestError);
  }

  async migrateKeyword(oldKeyword: string, newKeyword: string): Promise<KeywordMigration> {
    // Query all email IDs that have the old keyword
    const seen = new Set<string>();
    const allIds: string[] = [];
    let position = 0;
    const batchSize = 100;
    // Positions only line up within one queryState (RFC 8620 section 5.5).
    // Mail arriving mid-walk shifts every later page, so a changed state
    // restarts the walk - bounded, since a busy mailbox could change forever.
    let queryState: string | undefined;
    let restarts = 0;
    const maxRestarts = 3;

    while (true) {
      const response = await this.request([
        ["Email/query", {
          accountId: this.accountId,
          filter: { hasKeyword: oldKeyword },
          limit: batchSize,
          position,
        }, "0"],
      ]);

      const [queryMethod, queryResult] = response.methodResponses?.[0] || [];
      if (queryMethod === "error") {
        // Reading a refusal as "no messages carry the tag" would report a
        // clean migration of mail that still has the old keyword.
        throw new Error(queryResult?.description || "Failed to list emails with the keyword");
      }
      const state = queryResult?.queryState as string | undefined;
      if (queryState === undefined) {
        queryState = state;
      } else if (state !== undefined && state !== queryState) {
        if (restarts >= maxRestarts) {
          // Carrying on would mix ids from states that no longer agree, and
          // retagging a message the tag has since been taken off is worse than
          // not retagging at all. Nothing has been written yet, so this is a
          // clean failure the caller can simply repeat.
          throw new Error("The mailbox kept changing while listing the messages to retag");
        }
        restarts++;
        queryState = state;
        seen.clear();
        allIds.length = 0;
        position = 0;
        continue;
      }

      const ids: string[] = queryResult?.ids || [];
      const fresh = ids.filter(id => !seen.has(id));
      for (const id of fresh) seen.add(id);
      allIds.push(...fresh);

      // A server may return fewer ids than the limit asked for (RFC 8620
      // section 5.5 lets it clamp), so a short page does not end the walk.
      // A page carrying nothing new under an unchanged state does: the walk
      // is not advancing, and continuing would loop for as long as the server
      // keeps answering. Position counts the server's own page, not the ids
      // this walk had not seen before.
      if (fresh.length === 0) break;
      position += ids.length;
    }

    if (allIds.length === 0) return { migrated: 0, refused: 0 };

    // Batch update: remove old keyword, add new keyword using per-property patches
    let migrated = 0;
    let refusals = 0;
    // A whole batch the server refused to take: it will not take the next one
    // either. A single message it refused: the rest of the mail is unaffected,
    // and only the reason is worth keeping.
    let stopped: Error | null = null;
    let refusal: Error | null = null;
    for (const batch of batched(allIds, this.getMaxObjectsInSet())) {
      if (stopped) {
        refusals += batch.length;
        continue;
      }

      const update: Record<string, Record<string, boolean | null>> = {};
      for (const id of batch) {
        update[id] = {
          [keywordPointer(oldKeyword)]: null,
          [keywordPointer(newKeyword)]: true,
        };
      }

      const response = await this.request([
        ["Email/set", {
          accountId: this.accountId,
          update,
        }, "0"],
      ]);

      const [setMethod, setResult] = response.methodResponses?.[0] || [];
      if (setMethod === "error") {
        stopped = new Error(setResult?.description || "Failed to migrate keyword");
        refusals += batch.length;
        continue;
      }
      // Email/set applies per message, so a refusal is never all-or-nothing:
      // throwing here would abandon messages this very call already migrated.
      // Report instead - a message deleted since the query (notFound) is
      // nothing to report, any other refusal leaves the old keyword in place
      // on mail the caller would otherwise treat as migrated.
      const notUpdated = (setResult?.notUpdated || {}) as Record<string, { type?: string; description?: string }>;
      const failed = Object.entries(notUpdated);
      const refused = failed.filter(([, error]) => error?.type !== 'notFound');
      if (refused.length > 0) {
        debug.warn('keywords', 'Keyword migration refused for', refused.length, 'message(s):', refused[0][1]);
        refusal = refusal || new Error(refused[0][1]?.description || refused[0][1]?.type || "Failed to migrate keyword");
      }
      refusals += refused.length;
      migrated += batch.length - failed.length;
    }

    // Nothing moved: the caller must not rename the tag over messages that all
    // kept the old keyword. Something moved: that is a partial migration the
    // caller reports, not an error - the messages that did move are migrated
    // and renaming the definition is what keeps them named.
    if (migrated === 0 && (stopped || refusal)) throw (stopped || refusal) as Error;

    return { migrated, refused: refusals };
  }

  /**
   * Reject an Email/set response that reports a method-level error or per-id
   * `notUpdated`/`notDestroyed` failures. `request()` only throws on HTTP
   * errors, so without this the store removes rows the server refused. (#956)
   * The error names the ids left unchanged (jmapErrorFailedIds): the refused
   * ones, or every one of `ids` when the whole call was refused.
   */
  private assertEmailSetSucceeded(response: JMAPResponse, action: string, ids?: string[]): void {
    const [name, result] = response.methodResponses?.[0] ?? [];
    if (name === "error") {
      const error = jmapError(`Failed to ${action}: ${result?.description || result?.type || 'unknown error'}`, result);
      if (ids) error.jmapFailedIds = [...ids];
      throw error;
    }
    const failed: Record<string, JmapErrorInfo> = {
      ...(result?.notUpdated ?? {}),
      ...(result?.notDestroyed ?? {}),
    };
    const failedIds = Object.keys(failed);
    if (failedIds.length === 0) return;
    const first = failed[failedIds[0]];
    const reason = first?.description || first?.type || 'unknown error';
    const error = jmapError(
      failedIds.length === 1
        ? `Failed to ${action}: ${reason}`
        : `Failed to ${action} ${failedIds.length} email(s); first error: ${reason}`,
      first,
    );
    error.jmapFailedIds = failedIds;
    throw error;
  }

  /**
   * {@link assertEmailSetSucceeded} for a write sent in batches, one response
   * per entry of `batches`, checked once all of them were sent: one refused
   * message must not leave the rest of a selection unchanged. Throws for the
   * first refusal, naming what every batch left unchanged, so a caller can
   * show the rest as done.
   *
   * `requestError`: the request of the batch after the last response failed
   * outright (the connection dropped), and the write stopped there. That batch
   * and the ones after it count as unchanged, the ones before as written.
   */
  private assertEmailSetBatchesSucceeded(responses: JMAPResponse[], batches: string[][], action: string, requestError?: unknown): void {
    let failure: JmapError | null = null;
    const failedIds: string[] = [];
    for (let i = 0; i < responses.length; i++) {
      try {
        this.assertEmailSetSucceeded(responses[i], action, batches[i]);
      } catch (error) {
        failure ??= error as JmapError;
        failedIds.push(...(jmapErrorFailedIds(error) ?? batches[i]));
      }
    }
    if (responses.length < batches.length) {
      failure ??= (requestError instanceof Error ? requestError : new Error(`Failed to ${action}`)) as JmapError;
      failedIds.push(...batches.slice(responses.length).flat());
    }
    if (failure) {
      failure.jmapFailedIds = failedIds;
      throw failure;
    }
  }

  async deleteEmail(emailId: string, accountId?: string): Promise<void> {
    const response = await this.request([
      ["Email/set", {
        accountId: accountId || this.accountId,
        destroy: [emailId],
      }, "0"],
    ]);
    this.assertEmailSetSucceeded(response, 'delete email');
  }

  async moveToTrash(emailId: string, trashMailboxId: string, accountId?: string, markAsRead?: boolean): Promise<void> {
    const targetAccountId = accountId || this.accountId;
    const patch: Record<string, unknown> = { mailboxIds: { [trashMailboxId]: true } };
    if (markAsRead) patch["keywords/$seen"] = true;
    const response = await this.request([
      ["Email/set", {
        accountId: targetAccountId,
        update: { [emailId]: patch },
      }, "0"],
    ]);
    this.assertEmailSetSucceeded(response, 'move email to trash');
  }

  async batchDeleteEmails(emailIds: string[], accountId?: string): Promise<void> {
    if (emailIds.length === 0) return;

    const batches = batched(emailIds, this.getMaxObjectsInSet());
    const destroyedIds: string[] = [];
    for (const [index, batch] of batches.entries()) {
      let response: JMAPResponse;
      try {
        response = await this.request([
          ["Email/set", { accountId: accountId || this.accountId, destroy: batch }, "0"],
        ]);
      } catch (cause) {
        // The server may have applied this batch; only later batches are unsent.
        throw new IncompleteDeleteError({ destroyedIds, notDestroyed: {}, unknownIds: batch,
          unattemptedIds: batches.slice(index + 1).flat() }, cause);
      }
      const [name, result] = response.methodResponses?.[0] ?? [];
      const notDestroyed: Record<string, JmapErrorInfo> = {};
      const unknownIds: string[] = [];
      for (const id of batch) {
        if (name === 'Email/set' && Object.prototype.hasOwnProperty.call(result?.notDestroyed ?? {}, id)) {
          notDestroyed[id] = result.notDestroyed[id];
        } else if (name === 'Email/set' && Array.isArray(result?.destroyed) && result.destroyed.includes(id)) {
          destroyedIds.push(id);
        } else if (name === 'error') {
          notDestroyed[id] = result;
        } else {
          unknownIds.push(id);
        }
      }
      let cause: unknown;
      try {
        this.assertEmailSetSucceeded(response, 'delete emails');
      } catch (error) {
        cause = error;
      }
      if (cause || Object.keys(notDestroyed).length > 0 || unknownIds.length > 0) {
        throw new IncompleteDeleteError({ destroyedIds, notDestroyed, unknownIds,
          unattemptedIds: batches.slice(index + 1).flat() },
        cause ?? new Error('Failed to delete emails: deletion was not confirmed'));
      }
    }
  }

  async batchMoveEmails(emailIds: string[], toMailboxId: string, accountId?: string, markAsRead?: boolean): Promise<void> {
    if (emailIds.length === 0) return;

    const buildPatch = () => {
      const patch: Record<string, unknown> = { mailboxIds: { [toMailboxId]: true } };
      if (markAsRead) patch["keywords/$seen"] = true;
      return patch;
    };
    // A refused batch doesn't stop the others, and the error names every
    // message left where it was: the batches after one that failed used to
    // stay unsent while a caller counted them as moved.
    const batches = batched(emailIds, this.getMaxObjectsInSet());
    const responses: JMAPResponse[] = [];
    let requestError: unknown;
    for (const batch of batches) {
      const updates = Object.fromEntries(batch.map(id => [id, buildPatch()]));
      try {
        responses.push(await this.request([
          ["Email/set", { accountId: accountId || this.accountId, update: updates }, "0"],
        ]));
      } catch (error) {
        requestError = error;
        break;
      }
    }
    this.assertEmailSetBatchesSucceeded(responses, batches, 'move emails', requestError);
  }

  async batchArchiveEmails(
    emails: Array<{ id: string; receivedAt: string }>,
    archiveMailboxId: string,
    mode: 'single' | 'year' | 'month',
    existingMailboxes: Mailbox[],
    accountId?: string,
  ): Promise<void> {
    const updatedIds: string[] = [];
    try {
      await this.archiveEmails(emails, archiveMailboxId, mode, existingMailboxes, accountId, updatedIds);
    } catch (error) {
      throw new ArchiveEmailsError(
        error instanceof Error ? error.message : 'Failed to archive emails',
        updatedIds,
        { cause: error },
      );
    }
  }

  private confirmArchivedEmails(
    entry: JMAPResponse['methodResponses'][number] | undefined,
    requestedIds: string[],
    updatedIds: string[],
  ): void {
    const [name, result] = entry ?? [];
    if (name === 'Email/set') {
      updatedIds.push(...requestedIds.filter(id =>
        Object.prototype.hasOwnProperty.call(result?.updated ?? {}, id) && !result?.notUpdated?.[id],
      ));
    }
    this.assertEmailSetSucceeded({ methodResponses: entry ? [entry] : [] } as JMAPResponse, 'archive emails');
    if (requestedIds.some(id => !updatedIds.includes(id))) {
      throw new Error('Failed to archive emails: update was not confirmed');
    }
  }

  private async archiveEmails(
    emails: Array<{ id: string; receivedAt: string }>,
    archiveMailboxId: string,
    mode: 'single' | 'year' | 'month',
    existingMailboxes: Mailbox[],
    accountId: string | undefined,
    updatedIds: string[],
  ): Promise<void> {
    if (emails.length === 0) return;
    const targetAccountId = accountId || this.accountId;

    if (mode === 'single') {
      for (const batch of batched(emails, this.getMaxObjectsInSet())) {
        const response = await this.request([
          ['Email/set', {
            accountId: targetAccountId,
            update: Object.fromEntries(batch.map(e => [e.id, { mailboxIds: { [archiveMailboxId]: true } }])),
          }, '0'],
        ]);
        this.confirmArchivedEmails(response.methodResponses?.[0], batch.map(e => e.id), updatedIds);
      }
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

    // Creation ids are scoped to the request that introduced them (RFC 8620
    // §3.3), so "#<cid>" only resolves in the request carrying the Mailbox/set:
    // the folders are created alongside the first batch of messages, and the
    // ids they were assigned are substituted into every later batch.
    const updateBatches = batched(Object.entries(updates), this.getMaxObjectsInSet());
    const hasCreates = Object.keys(createEntries).length > 0;
    let createdIdFor: Record<string, string> = {};

    for (let i = 0; i < updateBatches.length; i++) {
      const batch: Array<[string, { mailboxIds: Record<string, true> }]> = i === 0
        ? updateBatches[i]
        : updateBatches[i].map(([emailId, patch]) => {
          const [destId] = Object.keys(patch.mailboxIds);
          const resolved = createdIdFor[destId];
          return [emailId, resolved ? { mailboxIds: { [resolved]: true } as Record<string, true> } : patch];
        });

      const methodCalls: JMAPMethodCall[] = [];
      const withCreates = hasCreates && i === 0;
      if (withCreates) {
        methodCalls.push(['Mailbox/set', { accountId: targetAccountId, create: createEntries }, '0']);
      }
      methodCalls.push(['Email/set', { accountId: targetAccountId, update: Object.fromEntries(batch) }, String(methodCalls.length)]);

      const response = await this.request(methodCalls);

      let emailError: unknown;
      try {
        this.confirmArchivedEmails(response.methodResponses?.[withCreates ? 1 : 0], batch.map(([id]) => id), updatedIds);
      } catch (error) {
        emailError = error;
      }

      if (withCreates) {
        if (response.methodResponses?.[0]?.[0] === 'error') {
          const error = response.methodResponses[0][1];
          throw new Error(`Failed to create archive folders: ${error?.description || error?.type || 'unknown error'}`);
        }
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
        const created = (mailboxResult?.created || {}) as Record<string, { id?: string }>;
        createdIdFor = Object.fromEntries(
          Object.entries(created)
            .filter(([, mailbox]) => !!mailbox?.id)
            .map(([cid, mailbox]) => [`#${cid}`, mailbox.id!]),
        );
      }
      if (emailError) throw emailError;
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

  async removeEmailsFromMailbox(emailIds: string[], mailboxId: string, accountId?: string): Promise<void> {
    if (emailIds.length === 0) return;
    // A pointer patch, not a full mailboxIds replacement: the other mailboxes
    // the message is in stay as the server has them, even when the copy the
    // client holds is out of date.
    const patch = { [`mailboxIds/${pointerToken(mailboxId)}`]: null };
    for (const batch of batched(emailIds, this.getMaxObjectsInSet())) {
      const update = Object.fromEntries(batch.map(id => [id, { ...patch }]));
      const response = await this.request([
        ["Email/set", { accountId: accountId || this.accountId, update }, "0"],
      ]);
      assertSetSucceeded(response, 'Failed to remove from folder');
    }
  }

  async restoreEmails(emails: Array<{ id: string; mailboxIds: Record<string, boolean>; seen?: boolean }>, accountId?: string): Promise<void> {
    if (emails.length === 0) return;
    for (const batch of batched(emails, this.getMaxObjectsInSet())) {
      const update = Object.fromEntries(batch.map(email => [email.id, {
        mailboxIds: email.mailboxIds,
        ...(email.seen === undefined ? {} : { 'keywords/$seen': email.seen ? true : null }),
      }]));
      const response = await this.request([
        ["Email/set", { accountId: accountId || this.accountId, update }, "0"],
      ]);
      assertSetSucceeded(response, 'Failed to restore emails');
    }
  }

  async emptyMailbox(mailboxId: string, accountId?: string): Promise<number> {
    const targetAccountId = accountId || this.accountId;
    const batchSize = Math.min(500, this.getMaxObjectsInSet());
    let totalDestroyed = 0;

    // Destroy in batches until the mailbox is empty. Never gate the loop on
    // Email/query's `total`: it is only guaranteed when `calculateTotal` is
    // requested, and Stalwart omits it otherwise, which used to stop the loop
    // after the first batch and leave folders with >500 emails mostly intact.
    while (true) {
      const response = await this.request([
        ["Email/query", {
          accountId: targetAccountId,
          filter: { inMailbox: mailboxId },
          limit: batchSize,
        }, "0"],
        ["Email/set", {
          accountId: targetAccountId,
          "#destroy": { resultOf: "0", name: "Email/query", path: "/ids" },
        }, "1"],
      ]);

      const queryResult = response.methodResponses?.[0]?.[1];
      const setResult = response.methodResponses?.[1]?.[1];
      const found: string[] = queryResult?.ids || [];
      const destroyed = setResult?.destroyed?.length || 0;
      totalDestroyed += destroyed;

      if (found.length === 0) break;
      // The server refused everything in this batch (missing permission,
      // immutable mail): say so, instead of reporting the folder as emptied.
      if (destroyed === 0) {
        assertSetSucceeded(response, 'Failed to empty folder');
        throw new Error('Failed to empty folder');
      }
      // A short page means we just handled the tail of the mailbox.
      if (found.length < batchSize) break;
    }

    return totalDestroyed;
  }

  async moveMailboxContents(
    fromMailboxId: string,
    toMailboxId: string,
    accountId?: string,
    markAsRead?: boolean,
  ): Promise<number> {
    const targetAccountId = accountId || this.accountId;
    const batchSize = Math.min(500, this.getMaxObjectsInGet(), this.getMaxObjectsInSet());
    const patch: Record<string, unknown> = { mailboxIds: { [toMailboxId]: true } };
    if (markAsRead) patch["keywords/$seen"] = true;
    let totalMoved = 0;

    // Moved emails leave the folder, so the next query returns the next page.
    // `update` is keyed by id and cannot take a result reference, hence the
    // separate query per batch.
    while (true) {
      const queryResponse = await this.request([
        ["Email/query", {
          accountId: targetAccountId,
          filter: { inMailbox: fromMailboxId },
          limit: batchSize,
        }, "0"],
      ]);
      const ids: string[] = queryResponse.methodResponses?.[0]?.[1]?.ids || [];
      if (ids.length === 0) break;

      // A refused update leaves the ids in the folder, and the next query
      // would return them again forever.
      const setResponse = await this.request([
        ["Email/set", {
          accountId: targetAccountId,
          update: Object.fromEntries(ids.map(id => [id, patch])),
        }, "0"],
      ]);
      this.assertEmailSetSucceeded(setResponse, 'move the folder contents');

      totalMoved += ids.length;
      if (ids.length < batchSize) break;
    }

    return totalMoved;
  }

  async markMailboxAsRead(mailboxId: string, accountId?: string): Promise<number> {
    const targetAccountId = accountId || this.accountId;
    const pageSize = Math.min(500, this.getMaxObjectsInSet());
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
          limit: pageSize,
        }, "0"],
      ]);

      const ids: string[] = queryResponse.methodResponses?.[0]?.[1]?.ids || [];
      if (ids.length === 0) break;

      const updates = Object.fromEntries(
        ids.map((id) => [id, { "keywords/$seen": true }])
      );

      // A refused update leaves the ids unread, and the next query would
      // return them again forever.
      const setResponse = await this.request([
        ["Email/set", { accountId: targetAccountId, update: updates }, "0"],
      ]);
      this.assertEmailSetSucceeded(setResponse, "mark the folder as read");

      totalMarked += ids.length;
      hasMore = ids.length === pageSize;
    }

    return totalMarked;
  }

  async markAllAsRead(excludeMailboxIds: string[] = [], accountId?: string): Promise<number> {
    const targetAccountId = accountId || this.accountId;
    const excludeSet = new Set(excludeMailboxIds);
    const pageSize = Math.min(500, this.getMaxObjectsInGet(), this.getMaxObjectsInSet());
    let totalMarked = 0;
    let hasMore = true;
    let position = 0;

    while (hasMore) {
      const response = await this.request([
        ["Email/query", {
          accountId: targetAccountId,
          filter: { notKeyword: "$seen" },
          limit: pageSize,
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
        const setResponse = await this.request([
          ["Email/set", { accountId: targetAccountId, update: updates }, "0"],
        ]);
        this.assertEmailSetSucceeded(setResponse, "mark all as read");
        totalMarked += targetIds.length;
      }

      hasMore = ids.length === pageSize;
      // Marked messages drop out of the "unread" query, so the next page
      // starts after the ones left unread (excluded folders) only. Advancing
      // by the whole page skipped a page of unread mail every round.
      position += ids.length - targetIds.length;
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

    // Move + flag in one patch so other JMAP clients (and the server's spam
    // classifier) see the message as junk, not just filed in Junk. (#850)
    const patch: Record<string, unknown> = {
      mailboxIds: { [mailboxId]: true },
      "keywords/$junk": true,
      "keywords/$notjunk": null,
    };
    if (markAsRead) patch["keywords/$seen"] = true;

    const response = await this.request([
      ["Email/set", {
        accountId: targetAccountId,
        update: { [emailId]: patch },
      }, "0"],
    ]);
    this.assertEmailSetSucceeded(response, "mark as spam");
  }

  async undoSpam(emailId: string, originalMailboxId: string, accountId?: string): Promise<void> {
    const targetAccountId = accountId || this.accountId;

    const response = await this.request([
      ["Email/set", {
        accountId: targetAccountId,
        update: {
          [emailId]: {
            mailboxIds: { [originalMailboxId]: true },
            // Moving alone leaves $junk set, so the message shows up in the
            // Inbox while still flagged as junk for every other client. (#850)
            "keywords/$junk": null,
            "keywords/$notjunk": true,
          },
        },
      }, "0"],
    ]);
    this.assertEmailSetSucceeded(response, "mark as not spam");
  }

  async createMailbox(name: string, parentId?: string, accountId?: string, options?: { role?: string }): Promise<Mailbox> {
    const targetAccountId = accountId || this.accountId;
    const createId = `new-${Date.now()}`;
    // Subscribe explicitly: IMAP clients that list folders via LSUB
    // (Thunderbird) hide unsubscribed mailboxes, and the server default is
    // not guaranteed to be true. (#951)
    const createData: Record<string, unknown> = { name, isSubscribed: true };
    if (parentId) {
      createData.parentId = parentId;
    }
    if (options?.role) {
      createData.role = options.role;
    }

    const response = await this.request([
      ["Mailbox/set", {
        accountId: targetAccountId,
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
      role: options?.role,
      sortOrder: 0,
      totalEmails: 0,
      unreadEmails: 0,
      totalThreads: 0,
      unreadThreads: 0,
      myRights: DEFAULT_MAILBOX_RIGHTS,
      isSubscribed: true,
      accountId: targetAccountId,
      accountName: this.accounts[targetAccountId]?.name || (targetAccountId === this.accountId ? this.username : targetAccountId),
      isShared: targetAccountId !== this.accountId,
    };
  }

  async updateMailbox(mailboxId: string, changes: { name?: string; parentId?: string | null; role?: string | null; sortOrder?: number }, accountId?: string): Promise<void> {
    const targetAccountId = accountId || this.accountId;
    const response = await this.request([
      ["Mailbox/set", {
        accountId: targetAccountId,
        update: { [mailboxId]: changes },
      }, "0"],
    ]);

    const result = response.methodResponses?.[0]?.[1];
    if (result?.notUpdated?.[mailboxId]) {
      throw new Error(`Failed to update mailbox: ${result.notUpdated[mailboxId].type || 'unknown error'}`);
    }
  }

  async updateMailboxes(
    updates: Record<string, { name?: string; parentId?: string | null; role?: string | null; sortOrder?: number }>,
    accountId?: string,
  ): Promise<Record<string, string>> {
    const targetAccountId = accountId || this.accountId;
    const failed: Record<string, string> = {};
    for (const batch of batched(Object.entries(updates), this.getMaxObjectsInSet())) {
      const response = await this.request([
        ["Mailbox/set", { accountId: targetAccountId, update: Object.fromEntries(batch) }, "0"],
      ]);
      const [name, result] = response.methodResponses?.[0] ?? [];
      if (name === 'error') {
        throw new Error(result?.description || result?.type || 'Failed to update mailboxes');
      }
      const notUpdated = (result?.notUpdated ?? {}) as Record<string, { type?: string }>;
      for (const [id, err] of Object.entries(notUpdated)) {
        failed[id] = err?.type || 'unknown';
      }
    }
    return failed;
  }

  /**
   * Destroys a folder. By default the server refuses a non-empty folder
   * (`mailboxHasEmail`); with `removeEmails` the messages that are only in
   * this folder go with it (`onDestroyRemoveEmails`, RFC 8621 §2.5).
   */
  async deleteMailbox(mailboxId: string, accountId?: string, options?: { removeEmails?: boolean }): Promise<void> {
    const targetAccountId = accountId || this.accountId;
    const response = await this.request([
      ["Mailbox/set", {
        accountId: targetAccountId,
        destroy: [mailboxId],
        ...(options?.removeEmails ? { onDestroyRemoveEmails: true } : {}),
      }, "0"],
    ]);

    const result = response.methodResponses?.[0]?.[1];
    if (result?.notDestroyed?.[mailboxId]) {
      const err = result.notDestroyed[mailboxId];
      throw jmapError(err.description || `Failed to delete mailbox: ${err.type || 'unknown error'}`, err);
    }
  }

  async searchEmails(query: string, mailboxId?: string, accountId?: string, limit: number = 50, position: number = 0, options: SearchRequestOptions = {}): Promise<SearchEmailsResult> {
    try {
      const targetAccountId = accountId || this.accountId;

      // The JMAP "text" filter searches from, to, cc, bcc, subject and body.
      // Quoted phrases and `word*` prefixes go out as conditions of their
      // own (see splitSearchText). inMailbox joins them in the same AND: a
      // FilterOperator cannot also carry property keys.
      let filter: Record<string, unknown>;
      if (mailboxId) {
        filter = {
          operator: "AND",
          conditions: [
            { inMailbox: mailboxId },
            ...textConditions(query),
          ],
        };
      } else {
        filter = textFilter(query);
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
        ...(options.deferSnippets ? [] : [this.searchSnippetCall(targetAccountId, filter)]),
      ]);
      assertQuerySucceeded(response, 'Search');

      const queryResponse = response.methodResponses?.[0]?.[1];
      const emails = applyListAuthenticationResults((response.methodResponses?.[1]?.[1]?.list || []) as Email[]);
      emails.sort((a: Email, b: Email) =>
        new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()
      );
      const total = queryResponse?.total || 0;
      const hasMore = computeHasMore(position, emails.length, total, limit);
      attachSearchSnippets(emails, this.searchSnippetsFrom(response));

      // Mirror getEmails: emails fetched from a delegated/shared account carry
      // bare owner mailbox ids; namespace them to `${ownerId}:${id}` so they line
      // up with the namespaced ids the store holds for shared mailboxes. (#281 V3)
      if (accountId && accountId !== this.accountId) {
        namespaceMailboxIds(emails, accountId);
      }

      return { emails, hasMore, total, ...this.deferredSnippets(options, targetAccountId, filter, emails) };
    } catch (error) {
      // Rethrow: an empty result would read as "No results found".
      console.error('Search failed:', error);
      throw error;
    }
  }

  /**
   * The SearchSnippet/get call (RFC 8621 §5) chained onto a search request,
   * or a Core/echo no-op when the filter has no term the server could
   * highlight (a purely structural filter yields empty snippets). Reads the
   * ids straight from the Email/query result, so it costs no extra round
   * trip; a failure of this call alone leaves the results without snippets.
   */
  private searchSnippetCall(accountId: string, filter: Record<string, unknown> | undefined): JMAPMethodCall {
    if (!filter || !filterHasSnippetTerms(filter)) {
      return ["Core/echo", {}, "snippets"];
    }
    return ["SearchSnippet/get", {
      accountId,
      filter: snippetFilterFor(filter),
      "#emailIds": { resultOf: "0", name: "Email/query", path: "/ids" },
    }, "snippets"];
  }

  /**
   * With `deferSnippets`, the snippets of a result page as a request of their
   * own, already in flight. Chained onto the search they cost no round trip
   * but hold the whole response back while the server excerpts every hit,
   * several times longer than the query itself, so an interactive search
   * lists its results first and highlights them when this resolves. Never
   * rejects: a failure leaves the results without snippets, as it does when
   * chained.
   */
  private deferredSnippets(
    options: SearchRequestOptions,
    accountId: string,
    filter: Record<string, unknown> | undefined,
    emails: Email[],
  ): Pick<SearchEmailsResult, 'snippets'> {
    if (!options.deferSnippets || emails.length === 0 || !filter || !filterHasSnippetTerms(filter)) return {};
    const snippets = this.request([
      ["SearchSnippet/get", {
        accountId,
        filter: snippetFilterFor(filter),
        emailIds: emails.map((email) => email.id),
      }, "snippets"],
    ]).then((response) => this.searchSnippetsFrom(response)).catch((error) => {
      debug.warn("jmap", "SearchSnippet/get failed:", error);
      return undefined;
    });
    return { snippets };
  }

  /** The SearchSnippet list of a search response, if the call succeeded. */
  private searchSnippetsFrom(response: JMAPResponse): SearchSnippetResult[] | undefined {
    for (const [method, result, callId] of response.methodResponses ?? []) {
      if (callId === "snippets" && method === "SearchSnippet/get") {
        return ((result as { list?: SearchSnippetResult[] })?.list) ?? undefined;
      }
    }
    return undefined;
  }

  async advancedSearchEmails(
    filter: Record<string, unknown>,
    accountId?: string,
    limit: number = 50,
    position: number = 0,
    options: SearchRequestOptions = {},
  ): Promise<SearchEmailsResult> {
    try {
      const targetAccountId = accountId || this.accountId;

      // Searching all folders with no criteria yields an empty FilterCondition,
      // which servers reject; omit the key entirely to mean "no filter".
      const hasFilter = Object.keys(filter).length > 0;

      const response = await this.request([
        ["Email/query", {
          accountId: targetAccountId,
          ...(hasFilter ? { filter } : {}),
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
        ...(options.deferSnippets ? [] : [this.searchSnippetCall(targetAccountId, hasFilter ? filter : undefined)]),
      ]);
      assertQuerySucceeded(response, 'Search');

      const queryResponse = response.methodResponses?.[0]?.[1];
      const emails = applyListAuthenticationResults((response.methodResponses?.[1]?.[1]?.list || []) as Email[]);
      emails.sort((a: Email, b: Email) =>
        new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()
      );
      const total = queryResponse?.total || 0;
      const hasMore = computeHasMore(position, emails.length, total, limit);
      attachSearchSnippets(emails, this.searchSnippetsFrom(response));

      // Namespace shared/delegated-account mailbox ids (see searchEmails). The
      // cross-account views (All mail / Unread / Starred) browse via this method,
      // so without it shared emails would carry bare owner ids there. (#281 V3)
      if (accountId && accountId !== this.accountId) {
        namespaceMailboxIds(emails, accountId);
      }

      return { emails, hasMore, total, ...this.deferredSnippets(options, targetAccountId, hasFilter ? filter : undefined, emails) };
    } catch (error) {
      console.error('Advanced search failed:', error);
      throw error;
    }
  }

  async getEmailFields(
    emailIds: string[],
    properties: string[],
    accountId?: string,
  ): Promise<Array<Record<string, unknown>>> {
    if (emailIds.length === 0) return [];
    const targetAccountId = accountId || this.accountId;
    const list: Array<Record<string, unknown>> = [];
    for (const batchIds of batched(emailIds, this.getMaxObjectsInGet())) {
      const response = await this.request([
        ["Email/get", { accountId: targetAccountId, ids: batchIds, properties: ["id", ...properties] }, "0"],
      ]);
      const [name, result] = response.methodResponses?.[0] ?? [];
      if (name !== "Email/get" || !result) {
        throw new Error(methodErrorMessage(response, 'Failed to get emails'));
      }
      list.push(...((result.list || []) as Array<Record<string, unknown>>));
    }
    return list;
  }

  async queryEmailFields(
    filter: Record<string, unknown>,
    properties: string[],
    accountId?: string,
    limit: number = 10000,
  ): Promise<Array<Record<string, unknown>>> {
    const targetAccountId = accountId || this.accountId;
    const pageSize = Math.min(500, this.getMaxObjectsInGet());
    const seen = new Set<string>();
    const list: Array<Record<string, unknown>> = [];
    let position = 0;
    while (list.length < limit) {
      const requested = Math.min(pageSize, limit - list.length);
      const response = await this.request([
        ["Email/query", {
          accountId: targetAccountId,
          filter,
          sort: [{ property: "receivedAt", isAscending: false }],
          position,
          limit: requested,
        }, "0"],
        ["Email/get", {
          accountId: targetAccountId,
          "#ids": { resultOf: "0", name: "Email/query", path: "/ids" },
          properties: ["id", ...properties],
        }, "1"],
      ]);
      assertQuerySucceeded(response, 'Email query');
      const [getName, getResult] = response.methodResponses?.[1] ?? [];
      if (getName !== "Email/get" || !getResult) {
        throw new Error(methodErrorMessage(response, 'Failed to get emails'));
      }
      const ids = (response.methodResponses?.[0]?.[1]?.ids ?? []) as string[];
      for (const email of (getResult.list || []) as Array<Record<string, unknown>>) {
        const id = email.id as string;
        if (seen.has(id)) continue;
        seen.add(id);
        list.push(email);
      }
      if (ids.length < requested) break;
      position += ids.length;
    }
    return list;
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
      const threads: Thread[] = [];

      for (const batchIds of batched(threadIds, this.getMaxObjectsInGet())) {
        const response = await this.request([
          ["Thread/get", { accountId: targetAccountId, ids: batchIds }, "0"],
        ]);

        if (response.methodResponses?.[0]?.[0] === "Thread/get") {
          threads.push(...((response.methodResponses[0][1].list || []) as Thread[]));
        }
      }

      return threads;
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

      const emails: Email[] = [];

      for (const batchIds of batched(thread.emailIds, this.getMaxObjectsInGet())) {
        const response = await this.request([
          ["Email/get", {
            accountId: targetAccountId,
            ids: batchIds,
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
          emails.push(...applyListAuthenticationResults(response.methodResponses[0][1].list || []));
        }
      }

      if (emails.length > 0) {
        // One batched refetch for the whole thread rather than per-message,
        // to avoid an N+1 request pattern on threads with several oversized
        // messages (#884).
        await this.refetchTruncatedBodyValues(emails, targetAccountId);

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
    // The signatures are String (default ""), so null is not a valid value in
    // a create. Leave blank ones out and let the server apply the default.
    // replyTo and bcc are nullable, so null is fine there.
    const create: Record<string, unknown> = { name, email, replyTo, bcc };
    if (textSignature != null) create.textSignature = textSignature;
    if (htmlSignature != null) create.htmlSignature = htmlSignature;

    const response = await this.request([
      ["Identity/set", {
        accountId: this.accountId,
        create: { "new-identity": create }
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
    htmlBody?: string,
    inReplyTo?: string[],
    references?: string[],
    options?: { priority?: MessagePriority; accountId?: string; previousDraftAccountId?: string },
  ): Promise<string> {
    // A draft for a group identity belongs in the group's Drafts, like its
    // Sent copy (#1090).
    const draftAccountId = options?.accountId ?? await this.resolveSendAccountId(fromEmail);
    const mailboxResponse = await this.request([["Mailbox/get", { accountId: draftAccountId }, "0"]]);
    const mailboxes = (mailboxResponse.methodResponses?.[0]?.[1]?.list || []) as Mailbox[];
    const draftsMailbox = mailboxes.find(mb => mb.role === 'drafts');
    if (!draftsMailbox) {
      throw new Error('No drafts mailbox found');
    }

    const emailId = `draft-${Date.now()}`;

    interface EmailDraft {
      from: { name?: string; email: string }[];
      to: { name?: string; email: string }[];
      cc?: { name?: string; email: string }[];
      bcc?: { name?: string; email: string }[];
      subject: string;
      keywords: Record<string, boolean>;
      mailboxIds: Record<string, boolean>;
      bodyValues: Record<string, { value: string }>;
      textBody?: { partId: string; type?: string }[];
      htmlBody?: { partId: string; type: string }[];
      attachments?: OutgoingBodyPart[];
      bodyStructure?: OutgoingBodyPart;
      inReplyTo?: string[];
      references?: string[];
      [header: `header:${string}`]: string;
    }

    const sanitizedFromName = sanitizeIdentityDisplayName(fromName);
    // A reply draft keeps its thread: re-opened or re-sent after Undo, it has
    // nothing else to rebuild In-Reply-To / References from.
    const draftInReplyTo = inReplyTo?.map(stripMessageIdBrackets).filter(Boolean);
    const draftReferences = references?.map(stripMessageIdBrackets).filter(Boolean);
    const emailData: EmailDraft = {
      from: [{ ...(sanitizedFromName ? { name: sanitizedFromName } : {}), email: fromEmail || this.username }],
      // "Name <addr>" must be split into the two JMAP fields: storing the whole
      // mailbox as the address makes the server treat the display name as part
      // of the addr-spec, and the draft goes out to `Name<addr` (#672).
      to: to.map(parseRecipientString),
      cc: cc?.length ? cc.map(parseRecipientString) : undefined,
      bcc: bcc?.length ? bcc.map(parseRecipientString) : undefined,
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
      ...(draftInReplyTo?.length ? { inReplyTo: draftInReplyTo } : {}),
      ...(draftReferences?.length ? { references: draftReferences } : {}),
      // A re-opened draft reads its priority back from these (#970).
      ...messagePriorityHeaders(options?.priority),
    };

    // Images the HTML shows by cid: go into a multipart/related beside it
    // (#1451), so the draft and the mail sent from it display them.
    const draftStructure = relatedBodyStructure(htmlBody, attachments);
    if (draftStructure) {
      delete emailData.textBody;
      delete emailData.htmlBody;
      emailData.bodyStructure = draftStructure;
    } else if (attachments?.length) {
      emailData.attachments = attachmentParts(attachments);
    }

    // Destroy the previous draft version only AFTER the replacement was
    // created (#849). A combined `Email/set { create, destroy }` processes
    // the two independently: when the create references part blobs of the
    // previous version (re-opened draft with attachments) and fails with
    // blobNotFound, the destroy still went through - deleting the last good
    // copy of the draft. Worst case now is an orphaned old version.
    const response = await this.request([
      ["Email/set", {
        accountId: draftAccountId,
        create: { [emailId]: emailData },
      }, "0"],
    ]);

    if (response.methodResponses?.[0]?.[0] === "Email/set") {
      const result = response.methodResponses[0][1];

      // An empty notCreated map is a success some servers spell out.
      if (result.notCreated && Object.keys(result.notCreated).length) {
        const errors = result.notCreated;
        const firstError = Object.values(errors)[0] as { description?: string; type?: string };
        console.error('Draft save error:', firstError);
        throw new Error(firstError?.description || firstError?.type || 'Failed to save draft');
      }

      if (result.created?.[emailId]) {
        const newDraftId = result.created[emailId].id;

        if (draftId) {
          try {
            const destroyResponse = await this.request([
              ["Email/set", { accountId: options?.previousDraftAccountId || this.accountId, destroy: [draftId] }, "0"],
            ]);
            const destroyResult = destroyResponse.methodResponses?.[0]?.[1];
            if (destroyResult?.notDestroyed) {
              console.warn('Failed to destroy old draft:', destroyResult.notDestroyed);
            }
          } catch (err) {
            console.warn('Failed to destroy old draft:', err);
          }
        }

        return newDraftId;
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
    // `draftAccountId`: the account `draftId` lives in when it is not this
    // one (see createDraft).
    options?: SubmissionSendOptions & { draftAccountId?: string }
  ): Promise<SendEmailResult> {
    const holdForSeconds = delayedUntil ? this.validateDelayedUntil(delayedUntil) : undefined;
    const emailId = `send-${Date.now()}`;
    const targetAccountId = await this.resolveSendAccountId(fromEmail);
    const mboxResp = await this.request([
      ["Mailbox/get", { accountId: targetAccountId, properties: ["id", "role"] }, "0"]
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

    const requestedMailFrom = envelopeMailFrom ? parseRecipientString(envelopeMailFrom).email : undefined;
    let finalIdentityId = identityId;
    let identityReplyTo: EmailAddress[] | undefined;
    let identityEmail: string | undefined;
    let identityName: string | undefined;
    {
      const identityResponse = await this.request([
        ["Identity/get", { accountId: targetAccountId }, "0"]
      ]);

      if (!finalIdentityId) {
        finalIdentityId = targetAccountId;
      }
      if (identityResponse.methodResponses?.[0]?.[0] === "Identity/get") {
        // In the user's order, not the server's: Stalwart 1.0 lists a group's
        // identity before the member's own, and a send that names no sender
        // (a List-Unsubscribe mailto: from the unified view) would go out
        // from the group's address.
        const identities = sortIdentities(
          (identityResponse.methodResponses[0][1].list || []) as Identity[],
          this.username,
        );
        if (identities.length > 0) {
          // A requested MAIL FROM that is itself one of the account's
          // identities is sent through that identity, so the server accepts
          // it as the envelope sender (#1009).
          let matchingIdentity = requestedMailFrom
            ? identities.find((id) => id.email.toLowerCase() === requestedMailFrom.toLowerCase())
            : undefined;
          if (!matchingIdentity && identityId) {
            // Identity ids are per account, and the composer's come from the
            // user's own account. In a shared account the same id can be
            // another of its addresses, and the server derives MAIL FROM from
            // that identity (#1450): there the id only counts when it names
            // the From address.
            const byId = identities.find((id) => id.id === identityId);
            if (byId && (targetAccountId === this.accountId || !fromEmail || emailMatchesLogin(byId.email, fromEmail))) {
              matchingIdentity = byId;
            }
          }
          if (!matchingIdentity) {
            // Addresses compared as the server does: regardless of case.
            const target = fromEmail || this.username;
            matchingIdentity = identities.find((id) => emailMatchesLogin(id.email, target));
          }
          if (!matchingIdentity && fromEmail) {
            // A sub-addressed From or one covered by a wildcard identity, the
            // other ways resolveSendAccountId picks an account.
            const from = parseRecipientString(fromEmail).email.toLowerCase();
            matchingIdentity = identities.find((id) => identityEmailIsSubAddressOf(id.email, from))
              ?? identities.find((id) => identityEmailIsWildcardFor(id.email, from));
          }
          finalIdentityId = matchingIdentity?.id || identities[0].id;
          identityReplyTo = matchingIdentity?.replyTo || identities[0].replyTo;
          identityEmail = (matchingIdentity || identities[0]).email;
          identityName = (matchingIdentity || identities[0]).name;
        }
      }
    }
    // The header From. A composer that had no identity loaded (after a short
    // outage, #1377) passes none, and an OAuth login has no username to fall
    // back on: the identity picked above stands in. Without any address the
    // server would refuse the message only after it was saved and submitted.
    const concreteIdentityEmail = identityEmail && !identityEmail.includes('*') ? identityEmail : undefined;
    const senderEmail = fromEmail || concreteIdentityEmail || this.username;
    if (!parseRecipientString(senderEmail).email.includes('@')) {
      throw new Error('No sender address could be found for this message. Reload the page and try again.');
    }
    // The MAIL FROM the server derives from the identity when the envelope is
    // omitted. A wildcard identity (RFC 8621 §6, "*@example.com") names no
    // concrete address, so the header From stands in for it.
    const identityMailFrom = concreteIdentityEmail ?? parseRecipientString(senderEmail).email;

    // Per RFC 8621 §4.1.2.3 inReplyTo/references are arrays of bare msg-ids
    // (no angle brackets). Stalwart may return them either way, so normalize.
    const normalizedInReplyTo = inReplyTo?.map(stripMessageIdBrackets).filter(Boolean);
    const normalizedReferences = references?.map(stripMessageIdBrackets).filter(Boolean);

    const sanitizedFromName = sanitizeIdentityDisplayName(fromEmail ? fromName : fromName || identityName);
    // Always create a new email with the final body content
    const emailCreate: Record<string, unknown> = {
      from: [{ ...(sanitizedFromName ? { name: sanitizedFromName } : {}), email: senderEmail }],
      replyTo: identityReplyTo?.length ? identityReplyTo : undefined,
      to: to.map(parseRecipientString),
      // RFC 5322 §3.6.3: To/Cc carry an address-list (non-empty). Sending
      // cc:[] makes the server emit a literal `Cc:` header with no addresses,
      // which is malformed and a spam signal. Omit the field when empty.
      cc: cc?.length ? cc.map(parseRecipientString) : undefined,
      bcc: bcc?.length ? bcc.map(parseRecipientString) : undefined,
      subject,
      messageId: [generateMessageId(senderEmail)],
      inReplyTo: normalizedInReplyTo?.length ? normalizedInReplyTo : undefined,
      references: normalizedReferences?.length ? normalizedReferences : undefined,
      keywords: { "$seen": true, "$draft": true },
      mailboxIds: { [draftsMailbox.id]: true },
    };

    if (options?.requestReadReceipt) {
      // RFC 8098: ask the recipient's client to return a Message Disposition
      // Notification to our address. JMAP lets us set the raw header on create
      // via the "header:<Name>:asText" property form.
      emailCreate["header:Disposition-Notification-To:asText"] = senderEmail;
    }

    Object.assign(emailCreate, messagePriorityHeaders(options?.priority));
    Object.assign(emailCreate, customHeaderProperties(options?.headers));

    // Images the HTML shows by cid: go into a multipart/related beside it,
    // or recipients don't see them (#1451).
    const sendStructure = relatedBodyStructure(htmlBody, attachments);
    if (sendStructure) {
      emailCreate.bodyValues = {
        [TEXT_PART_ID]: { value: body },
        [HTML_PART_ID]: { value: htmlBody },
      };
      emailCreate.bodyStructure = sendStructure;
    } else {
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
        emailCreate.attachments = attachmentParts(attachments);
      }
    }

    const methodCalls: JMAPMethodCall[] = [];

    // Use onSuccessUpdateEmail to move from Drafts to Sent after submission.
    // This ensures SMTP send happens before the email lands in Sent, avoiding
    // issues with servers that encrypt on append (e.g. Stalwart). See #188.
    const onSuccessUpdateEmail = {
      "#1": {
        ...mailboxIdsReplacement(sentMailbox.id),
        "keywords/$draft": null,
      },
    };

    // An explicit envelope is only sent when MAIL FROM should differ from the
    // identity's address (a From override, e.g. replying from a catch-all
    // alias without its own Identity) or carries SMTP parameters. JMAP §7.5:
    // when `envelope` is omitted the server derives mailFrom itself.
    const buildSubmissionCreate = (emailRef: string, mailFrom: string): Record<string, unknown> => {
      const create: Record<string, unknown> = { emailId: emailRef, identityId: finalIdentityId };
      const parameters = submissionEnvelopeParameters(options, holdForSeconds);
      const hasMailFromParams = Object.keys(parameters.mailFrom).length > 0;
      const hasRcptToParams = Object.keys(parameters.rcptTo).length > 0;
      if (hasMailFromParams || hasRcptToParams || mailFrom.toLowerCase() !== identityMailFrom.toLowerCase()) {
        const envelopeRecipients = normalizeEnvelopeRecipients([...to, ...(cc || []), ...(bcc || [])]);
        create.envelope = {
          mailFrom: {
            email: mailFrom,
            ...(hasMailFromParams ? { parameters: parameters.mailFrom } : {}),
          },
          rcptTo: hasRcptToParams
            ? envelopeRecipients.map((r) => ({ ...r, parameters: parameters.rcptTo }))
            : envelopeRecipients,
        };
      }
      return { "1": create };
    };
    const firstMailFrom = requestedMailFrom || identityMailFrom;
    // The account the submission is created in — the shared account when
    // sending from a shared identity. Returned so undo/send-now can address it
    // directly instead of searching for it. See #874.
    const submissionAccountId = this.getSubmissionAccountId(targetAccountId);

    // The old draft is destroyed in a separate request only after the
    // submission succeeded (see below, #849). Destroying it up front in the
    // same request meant a failed create/submission - e.g. the outgoing email
    // referencing part blobs of that very draft, which die with it - still
    // deleted the user's only copy of the message.
    methodCalls.push(["Email/set", {
      accountId: targetAccountId,
      create: { [emailId]: emailCreate },
    }, "0"]);
    methodCalls.push(["EmailSubmission/set", {
      accountId: submissionAccountId,
      create: buildSubmissionCreate(`#${emailId}`, firstMailFrom),
      onSuccessUpdateEmail,
    }, "1"]);
    // Which recipients the server took. A refused one is lost without a
    // bounce while the create succeeds and files the message in Sent.
    methodCalls.push(deliveryStatusCall(submissionAccountId, "1"));

    let response = await this.request(methodCalls);

    // The message exists in Drafts from here on, sent or not. Two refusals of
    // the submission can be worked around by submitting that copy once more:
    // - overQuota: Stalwart 1.0 counts every submission record against a
    //   per-account limit, so remove the ones that can go and try again;
    // - a MAIL FROM other than the identity's own address (RFC 8621 §7.5.1
    //   forbiddenMailFrom; Stalwart always refuses it, as forbiddenFrom): use
    //   the identity's address - the composer warns about this before sending
    //   (#1009).
    // Stalwart checks the quota first, so both can happen, one after the other.
    const draftCopyId = response.methodResponses
      ?.find(([name]) => name === 'Email/set')?.[1]?.created?.[emailId]?.id as string | undefined;
    let mailFrom = firstMailFrom;
    let madeRoom = false;
    for (;;) {
      const refusal = submissionCreateError(response, '1');
      if (!draftCopyId || !refusal) break;
      if (refusal.type === 'overQuota' && !madeRoom) {
        madeRoom = true;
        await this.makeRoomForSubmission(submissionAccountId);
      } else if (
        (refusal.type === 'forbiddenMailFrom' || refusal.type === 'forbiddenFrom') &&
        mailFrom.toLowerCase() !== identityMailFrom.toLowerCase()
      ) {
        debug.warn('email', `[sendEmail] server refused ${mailFrom} as MAIL FROM (${refusal.type}), sending with ${identityMailFrom}`);
        mailFrom = identityMailFrom;
      } else {
        break;
      }
      const retry = await this.request([["EmailSubmission/set", {
        accountId: submissionAccountId,
        create: buildSubmissionCreate(draftCopyId, mailFrom),
        onSuccessUpdateEmail,
      }, "1"], deliveryStatusCall(submissionAccountId, "1")]);
      response = {
        ...retry,
        methodResponses: [
          ...response.methodResponses.filter(([name]) => name === 'Email/set'),
          ...(retry.methodResponses ?? []),
        ],
      };
    }

    // The get goes on its own: it fails whenever the create did, and must not
    // count as a failed send or filing either way.
    const statusReadBack = takeDeliveryStatus(response);
    response = statusReadBack.response;

    let createdEmailId: string | undefined;
    let emailSubmissionId: string | undefined;
    let serverSendAt: string | undefined;
    let filingError: string | undefined;

    // The outgoing copy is created in Drafts, next to the user's own draft.
    // When the submission fails it never moves to Sent, so it is removed
    // before the failure is reported; the user's draft is kept for the retry.
    const { failure, filing } = sendMethodErrors(response.methodResponses);
    if (failure) {
      console.error('[sendEmail] JMAP method error:', failure);
      await this.discardUnsentCopy(draftCopyId, targetAccountId);
      const propsHint = failure.properties?.length ? ` (properties: ${failure.properties.join(', ')})` : '';
      throw jmapError(`${failure.description || `Failed to send email: ${failure.type}`}${propsHint}`, failure);
    }
    if (filing) {
      console.error('[sendEmail] post-send method error:', filing);
      filingError = filing.description || filing.type || 'post-send filing failed';
    }

    if (response.methodResponses) {
      for (const [methodName, result] of response.methodResponses) {
        if (result.notCreated && Object.keys(result.notCreated).length) {
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
          // Nothing was sent, so the copy made for this attempt goes; the
          // user's own draft (`draftId`) stays. Each attempt makes a new copy,
          // so keeping them piled up duplicates in Drafts.
          await this.discardUnsentCopy(draftCopyId, targetAccountId);
          this.throwIfHoldTooLong(firstError);
          if (methodName === 'EmailSubmission/set' && firstError?.type === 'overQuota') {
            throw this.submissionQuotaError(firstError.description, submissionAccountId);
          }
          const propsHint = firstError?.properties?.length
            ? ` (properties: ${firstError.properties.join(', ')})`
            : '';
          const typeHint = firstError?.type ? ` [${firstError.type}]` : '';
          throw jmapError(
            `${firstError?.description || firstError?.type || 'Failed to send email'}${typeHint}${propsHint}`,
            firstError,
          );
        }

        // Post-submission filing problems (the implicit Email/set from
        // onSuccessUpdateEmail, or destroying the old draft) must not fail
        // the send - the message already left - but they must not stay
        // silent either: a silently rejected filing/cleanup is exactly how
        // "sent mail still sits in Drafts" reports look (#592, #588's
        // sibling note in 4dc76bbb). Log the details and surface a warning
        // to the caller.
        if (result.notUpdated && Object.keys(result.notUpdated).length) {
          console.error(`[sendEmail] ${methodName} notUpdated:`, JSON.stringify(result.notUpdated, null, 2));
          const first = Object.values(result.notUpdated as Record<string, { type?: string; description?: string }>)[0];
          filingError = filingError ?? (first?.description || first?.type || 'post-send filing failed');
        }
        if (result.notDestroyed && Object.keys(result.notDestroyed).length) {
          console.error(`[sendEmail] ${methodName} notDestroyed (old draft):`, JSON.stringify(result.notDestroyed, null, 2));
          const first = Object.values(result.notDestroyed as Record<string, { type?: string; description?: string }>)[0];
          filingError = filingError ?? (first?.description || first?.type || 'old draft cleanup failed');
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

    // No EmailSubmission came back - a method error, or no answer for it at
    // all. Nothing confirms the message left: report a failure and keep the
    // old draft rather than replacing it as if the send had worked.
    if (!emailSubmissionId) {
      throw new SendUnconfirmedError();
    }

    // Every recipient refused: nothing was queued, so nothing goes out, held
    // or not, and no bounce will tell (#1123). That is a failed send. The copy
    // made for it goes, as after any failed send - onSuccessUpdateEmail filed
    // it in Sent, where it passes for a sent message - while the user's draft
    // stays and the composer keeps the text, so the address can be fixed and
    // the message sent again. The record can neither go out nor be cancelled.
    const { rejected, all: noneAccepted } = rejectedRecipients(statusReadBack.deliveryStatus);
    if (noneAccepted) {
      console.error('[sendEmail] every recipient refused:', JSON.stringify(rejected));
      await this.discardUnsentCopy(createdEmailId ?? draftCopyId, targetAccountId);
      if (this.hasAccountCapability('urn:stalwart:jmap', submissionAccountId)) {
        await this.destroyEmailSubmissions([emailSubmissionId], submissionAccountId);
      }
      throw new RecipientsRejectedError(rejected);
    }

    // An immediate send's submission record has done its job once the
    // request that created it returned: the message is queued and filed, and
    // with no hold there is nothing to cancel. Stalwart 1.0 stops accepting
    // submissions once an account holds `maxSubmissions` records, so drop it
    // now. Stalwart's destroy only removes the record, never the queued
    // message; other servers are left to the prune. Decided by the request,
    // not the created undoStatus, which 0.16.10-0.16.16 report as final even
    // for a held send.
    const submissionToDestroy = !delayedUntil &&
      this.hasAccountCapability('urn:stalwart:jmap', submissionAccountId)
      ? emailSubmissionId
      : undefined;

    // The message is out (or scheduled) - now it is safe to drop the old
    // draft. A failure here leaves an orphan in Drafts, which is reported as
    // a filing warning rather than a failed send (#849). The submission
    // record rides along, and nothing about it may turn into a warning.
    if (draftId && createdEmailId) {
      try {
        const cleanupCalls: JMAPMethodCall[] = [
          ["Email/set", { accountId: options?.draftAccountId || this.accountId, destroy: [draftId] }, "0"],
        ];
        if (submissionToDestroy) {
          cleanupCalls.push(submissionDestroyCall([submissionToDestroy], submissionAccountId, "1"));
        }
        const destroyResponse = await this.request(cleanupCalls);
        const destroyResult = destroyResponse.methodResponses?.find(([, , callId]) => callId === "0")?.[1];
        if (destroyResult?.notDestroyed && Object.keys(destroyResult.notDestroyed).length) {
          console.error('[sendEmail] old draft cleanup notDestroyed:', JSON.stringify(destroyResult.notDestroyed, null, 2));
          const first = Object.values(destroyResult.notDestroyed as Record<string, { type?: string; description?: string }>)[0];
          filingError = filingError ?? (first?.description || first?.type || 'old draft cleanup failed');
        }
        if (submissionToDestroy) readSubmissionDestroy(destroyResponse, "1");
      } catch (err) {
        console.error('[sendEmail] old draft cleanup failed:', err);
        filingError = filingError ?? 'old draft cleanup failed';
      }
    } else if (submissionToDestroy) {
      await this.destroyEmailSubmissions([submissionToDestroy], submissionAccountId);
    }

    if (delayedUntil && emailSubmissionId && !serverSendAt) {
      serverSendAt = await this.getEmailSubmissionSendAt(emailSubmissionId, submissionAccountId);
    }

    // Some recipients refused: the others get the message, the caller says
    // who doesn't.
    const rejectedRecipientsResult = rejected.length ? rejected : undefined;
    return delayedUntil
      ? { scheduled: true, emailId: createdEmailId, emailAccountId: targetAccountId, emailSubmissionId, sendAt: serverSendAt, submissionAccountId, filingError, rejectedRecipients: rejectedRecipientsResult }
      : { scheduled: false, emailId: createdEmailId, emailAccountId: targetAccountId, emailSubmissionId, submissionAccountId, filingError, rejectedRecipients: rejectedRecipientsResult };
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
      messageId: [generateMessageId(opts.attendeeEmail)],
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
            ...mailboxIdsReplacement(sentMailbox.id),
            "keywords/$draft": null,
          },
        },
      }, "1"],
    ];

    debug.log('calendar', '[iMIP] Sending JMAP request with', methodCalls.length, 'method calls');
    debug.log('calendar', '[iMIP] Email create payload:', JSON.stringify(emailCreate, null, 2));

    const response = await this.request(methodCalls);

    debug.log('calendar', '[iMIP] JMAP response:', JSON.stringify(response.methodResponses, null, 2));

    const { failure: replyError } = sendMethodErrors(response.methodResponses);
    if (replyError) {
      debug.error('[iMIP] method error:', replyError);
      throw new Error(replyError.description || `iMIP reply failed: ${replyError.type}`);
    }

    if (response.methodResponses) {
      for (const [, result] of response.methodResponses) {
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
      messageId: [generateMessageId(organizerEmail)],
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
            ...mailboxIdsReplacement(sentMailbox.id),
            "keywords/$draft": null,
          },
        },
      }, "1"],
    ];

    const response = await this.request(methodCalls);

    const { failure: invitationError } = sendMethodErrors(response.methodResponses);
    if (invitationError) {
      throw new Error(invitationError.description || `iMIP invitation failed: ${invitationError.type}`);
    }

    if (response.methodResponses) {
      for (const [, result] of response.methodResponses) {
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
      messageId: [generateMessageId(organizerEmail)],
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
            ...mailboxIdsReplacement(sentMailbox.id),
            "keywords/$draft": null,
          },
        },
      }, "1"],
    ];

    const response = await this.request(methodCalls);

    const { failure: cancellationError } = sendMethodErrors(response.methodResponses);
    if (cancellationError) {
      throw new Error(cancellationError.description || `iMIP cancellation failed: ${cancellationError.type}`);
    }

    if (response.methodResponses) {
      for (const [, result] of response.methodResponses) {
        if (result.notCreated) {
          const firstError = Object.values(result.notCreated)[0] as { description?: string; type?: string };
          throw new Error(firstError?.description || firstError?.type || 'Failed to send iMIP cancellation');
        }
      }
    }
  }

  /**
   * XMLHttpRequest has no credentials mode, so in Lite on Stalwart an upload
   * with an expired access token still lets the browser act on the Basic
   * challenge and show its login dialog (#1396). When nothing has confirmed
   * the token lately (the machine slept, say), check it with a fetch first:
   * that one omits credentials, and an expired token is refreshed there.
   */
  private async confirmTokenBeforeXhr(): Promise<void> {
    if (JMAP_FETCH_CREDENTIALS !== 'omit' || this.authMode !== 'bearer' || !this.onTokenRefresh) return;
    if (Date.now() - this.authAcceptedAt < JMAPClient.AUTH_ACCEPTED_FRESH_MS) return;
    await this.request([['Core/echo', {}, '0']]);
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

      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let uploaded = 0;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        xhr.onload = xhr.onerror = xhr.onabort = xhr.ontimeout = null;
        xhr.upload.onprogress = null;
      };
      const settle = (complete: () => void): boolean => {
        if (settled) return false;
        settled = true;
        cleanup();
        complete();
        return true;
      };
      const abortWith = (error: Error) => {
        // Settle first: abort() may synchronously dispatch an abort event.
        if (settle(() => reject(error))) xhr.abort();
      };
      const onAbort = () => abortWith(new DOMException('Upload aborted', 'AbortError'));
      const onTimeout = () => abortWith(new RequestTimeoutError(JMAPClient.TRANSFER_TIMEOUT_MS));
      const resetWatchdog = () => {
        clearTimeout(timer);
        // XHR uses this budget for inactivity, unlike fetch's deadline until
        // response headers. Additional upload bytes renew it; after 100% it
        // stays armed while waiting for the terminal response.
        timer = setTimeout(onTimeout, JMAPClient.TRANSFER_TIMEOUT_MS);
      };

      xhr.upload.onprogress = (ev) => {
        if (settled) return;
        if (ev.loaded > uploaded) {
          uploaded = ev.loaded;
          resetWatchdog();
        }
        // ev.total is only meaningful when lengthComputable; fall back
        // to file.size so callers always get a usable denominator.
        onProgress?.(ev.loaded, ev.lengthComputable ? ev.total : file.size);
      };
      xhr.onload = () => settle(() => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr.responseText);
        } else {
          reject(new Error(`Failed to upload file: ${xhr.status} - ${xhr.responseText}`));
        }
      });
      xhr.onerror = () => settle(() => reject(new Error('Upload network error')));
      xhr.onabort = () => settle(() => reject(new DOMException('Upload aborted', 'AbortError')));
      xhr.ontimeout = onTimeout;

      try {
        signal?.addEventListener('abort', onAbort, { once: true });
        // Fire 0% immediately so the UI leaves its initial state even
        // before the first network packet flushes.
        onProgress?.(0, file.size);
        if (settled) return;
        resetWatchdog();
        xhr.send(file);
      } catch (error) {
        settle(() => reject(error));
      }
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
      await this.confirmTokenBeforeXhr();
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
      }, { timeoutMs: JMAPClient.TRANSFER_TIMEOUT_MS });
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
    const submit = () => this.request([
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
    let response = await submit();
    if (submissionCreateError(response, subId)?.type === 'overQuota') {
      await this.makeRoomForSubmission(targetAccountId, { automatic: params.automatic });
      response = await submit();
    }
    const [name, result] = response.methodResponses?.[0] ?? [];
    const error: JMAPSetError | undefined = name === 'error' ? result : result?.notCreated?.[subId];
    if (error) {
      // Nothing went out: take the receipt back out of Sent, where it would
      // pass for a sent one.
      await this.discardUnsentCopy(emailId, targetAccountId);
      if (name === 'EmailSubmission/set' && error.type === 'overQuota') throw this.submissionQuotaError(error.description, targetAccountId);
      throw jmapError(`MDN submission failed: ${error.description || error.type || 'unknown'}`, error);
    }
    await this.destroyImmediateSubmission(result?.created?.[subId]?.id, targetAccountId);
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
      .replace('{name}', encodeURIComponent(downloadNameSegment(name)))
      .replace('{type}', encodeURIComponent(type || 'application/octet-stream'));
  }

  async fetchBlob(blobId: string, name?: string, type?: string, accountId?: string): Promise<Blob> {
    const url = this.getBlobDownloadUrl(blobId, name, type, accountId);
    const response = await this.authenticatedFetch(url, {}, { timeoutMs: JMAPClient.TRANSFER_TIMEOUT_MS });
    if (!response.ok) {
      throw new Error(`Failed to fetch blob: ${response.status}`);
    }
    return response.blob();
  }

  /**
   * Object URL for a blob. It shares the webmail origin and the type comes
   * from whoever sent the blob, so it is re-typed to something no browser
   * runs as a document (toInertBlob); image/svg+xml and text/html come back
   * as application/octet-stream.
   */
  async fetchBlobAsObjectUrl(blobId: string, name?: string, type?: string, accountId?: string): Promise<string> {
    const blob = await this.fetchBlob(blobId, name, type, accountId);
    return URL.createObjectURL(toInertBlob(blob));
  }

  /**
   * The contents of many blobs as base64, through Blob/get (RFC 9404), for an
   * export that needs a lot of them: one download per blob queues behind the
   * server's per-user limits (Stalwart: 4 requests at a time, 1000 a minute),
   * while one Blob/get returns many.
   *
   * More blobs than two of the largest photos would fill are first asked for
   * their sizes, then fetched in requests of about BLOB_BATCH_BYTES, so a
   * response stays bounded however large the photos are.
   *
   * Null when the session doesn't advertise the blob capability, which then
   * must stay out of `using`. Blobs the server doesn't find are left out; once
   * a request fails, the blobs not fetched yet are listed in `failed`.
   *
   * Stalwart answers Blob/get only in accounts the user is a member of: an
   * address book shared with the user is in an account that isn't one, and
   * the call comes back `forbidden` ("You are not an owner of account ...").
   * It checks the access to each blob by itself, though, whichever account the
   * request names, so the rest are asked for in the user's own account.
   */
  async getBlobsAsBase64(blobIds: string[], accountId?: string): Promise<BlobBatch | null> {
    if (!this.hasCapability(BLOB_CAPABILITY)) return null;
    let account = accountId || this.accountId;
    const ids = [...new Set(blobIds)];
    const data = new Map<string, string>();
    const blobGet = async (chunk: string[], property: "size" | "data:asBase64") => {
      const call = () => this.request([
        ["Blob/get", { accountId: account, ids: chunk, properties: [property] }, "0"],
      ], ["urn:ietf:params:jmap:core", BLOB_CAPABILITY]);
      let [name, result] = (await call()).methodResponses?.[0] ?? [];
      if (name === "error" && result?.type === "forbidden" && account !== this.accountId) {
        account = this.accountId;
        [name, result] = (await call()).methodResponses?.[0] ?? [];
      }
      if (name !== "Blob/get") {
        throw jmapError(`Blob/get failed: ${result?.description || result?.type || "unknown"}`, result);
      }
      return (result.list ?? []) as Array<Record<string, unknown>>;
    };

    let chunks: string[][] = ids.length > 0 ? [ids] : [];
    if (ids.length * BLOB_LARGE_BYTES > BLOB_BATCH_BYTES) {
      const sizes = new Map<string, number | undefined>();
      try {
        for (const chunk of batched(ids, this.getMaxObjectsInGet())) {
          for (const blob of await blobGet(chunk, "size")) {
            if (typeof blob.id === "string") sizes.set(blob.id, typeof blob.size === "number" ? blob.size : undefined);
          }
        }
      } catch (error) {
        debug.warn("jmap", "Blob/get of sizes failed:", error);
        return { data, failed: ids };
      }
      chunks = batchedBySize(ids.filter((id) => sizes.has(id)), (id) => sizes.get(id), BLOB_BATCH_BYTES, this.getMaxObjectsInGet());
    }

    for (let i = 0; i < chunks.length; i++) {
      try {
        for (const blob of await blobGet(chunks[i], "data:asBase64")) {
          const base64 = blob["data:asBase64"];
          if (typeof blob.id === "string" && typeof base64 === "string") data.set(blob.id, base64);
        }
      } catch (error) {
        debug.warn("jmap", "Blob/get failed:", error);
        return { data, failed: chunks.slice(i).flat() };
      }
    }
    return { data, failed: [] };
  }

  getCapabilities(): Record<string, unknown> {
    return this.capabilities;
  }

  hasCapability(capability: string): boolean {
    return capability in this.capabilities;
  }

  /** The value of an account capability (primary account by default). */
  getAccountCapability(capability: string, accountId?: string): unknown {
    const id = accountId || this.accountId;
    return this.session?.accounts?.[id]?.accountCapabilities?.[capability];
  }

  /** Check whether a capability is present on the primary account. */
  hasAccountCapability(capability: string, accountId?: string): boolean {
    const id = accountId || this.accountId;
    const caps = this.session?.accounts?.[id]?.accountCapabilities;
    return !!caps && capability in caps;
  }

  /**
   * Whether a sender or subject sorted list of the account keeps the order
   * the server returned. Stalwart 1.0 collates those itself (lowercased
   * byte-order keys, empty values last), which the client comparator would
   * only disturb. 0.16 compares the raw bytes, capitals before lowercase, so
   * its pages are re-sorted case-insensitively. Every 1.0 account lists
   * principals:owner in its accountCapabilities; 0.16 never does.
   */
  keepsServerTextOrder(accountId?: string): boolean {
    return this.hasAccountCapability("urn:ietf:params:jmap:principals:owner", accountId);
  }

  getAccountInfo(accountId: string): AccountInfo | null {
    const account = this.accounts[accountId];
    if (!account) return null;
    return {
      name: account.name ?? '',
      isPersonal: account.isPersonal === true,
      isReadOnly: account.isReadOnly === true,
      accountCapabilities: account.accountCapabilities ?? {},
    };
  }

  /**
   * The most participants an event may have, from the account's calendars
   * capability (`maxParticipantsPerEvent`; the primary calendar account's
   * when the account names none), or null when it is not advertised.
   * Stalwart 1.0 refuses to create or update an event with more ATTENDEEs,
   * an answer to an invitation included; 0.16 advertises the same value
   * without enforcing it.
   */
  getMaxParticipantsPerEvent(accountId?: string): number | null {
    for (const id of [accountId, this.getCalendarsAccountId()]) {
      if (!id) continue;
      const capability = this.getAccountCapability("urn:ietf:params:jmap:calendars", id) as
        { maxParticipantsPerEvent?: unknown } | undefined;
      const max = capability?.maxParticipantsPerEvent;
      if (typeof max === 'number' && max > 0) return max;
    }
    return null;
  }

  getMaxSizeAttachmentsPerEmail(): number {
    const mail = this.getAccountCapability("urn:ietf:params:jmap:mail") as { maxSizeAttachmentsPerEmail?: number } | undefined;
    return mail?.maxSizeAttachmentsPerEmail || 0;
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

  getMaxObjectsInSet(): number {
    const coreCapability = this.capabilities["urn:ietf:params:jmap:core"] as { maxObjectsInSet?: number } | undefined;
    return coreCapability?.maxObjectsInSet || 500;
  }

  getMaxConcurrentRequests(): number {
    const coreCapability = this.capabilities["urn:ietf:params:jmap:core"] as { maxConcurrentRequests?: number } | undefined;
    return coreCapability?.maxConcurrentRequests || 4;
  }

  getMaxDelayedSend(accountId?: string): number {
    const maxDelayedSend = this.getSubmissionCapability(accountId)?.maxDelayedSend;
    if (typeof maxDelayedSend !== 'number' || maxDelayedSend <= 0) return 0;
    if (this.learnedMaxDelayedSend !== null) return Math.min(maxDelayedSend, this.learnedMaxDelayedSend);
    if (
      maxDelayedSend === STALWART_ADVERTISED_MAX_DELAYED_SEND &&
      this.hasAccountCapability('urn:stalwart:jmap', accountId)
    ) {
      return STALWART_DEFAULT_MAX_HOLD;
    }
    return maxDelayedSend;
  }

  /**
   * Turn a "hold time exceeds maximum" rejection into ScheduleTooLateError
   * and remember the limit, so the picker offers only times that work.
   */
  private throwIfHoldTooLong(error: { description?: string } | undefined): void {
    const limit = parseHoldLimit(error?.description);
    if (limit === null) return;
    this.learnedMaxDelayedSend = limit;
    throw new ScheduleTooLateError(limit);
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
      throw new ScheduleTooLateError(maxDelayedSend);
    }
    return Math.ceil((time - now) / 1000);
  }

  private async getEmailSubmissionSendAt(submissionId: string, accountId?: string): Promise<string | undefined> {
    const response = await this.request([
      ['EmailSubmission/get', {
        accountId: accountId ?? await this.resolveSubmissionAccountId(submissionId),
        ids: [submissionId],
        properties: ['sendAt', 'undoStatus'],
      }, '0'],
    ]);
    const submission = response.methodResponses?.[0]?.[1]?.list?.[0] as { sendAt?: string } | undefined;
    return submission?.sendAt;
  }

  private async getEmailSubmissionForReschedule(submissionId: string, accountId?: string): Promise<{ identityId?: string; envelope?: { rcptTo?: Array<{ email: string }> }; sendAt?: string } | undefined> {
    const response = await this.request([
      ['EmailSubmission/get', {
        accountId: accountId ?? await this.resolveSubmissionAccountId(submissionId),
        ids: [submissionId],
        properties: ['identityId', 'envelope', 'sendAt'],
      }, '0'],
    ]);
    return response.methodResponses?.[0]?.[1]?.list?.[0] as { identityId?: string; envelope?: { rcptTo?: Array<{ email: string }> }; sendAt?: string } | undefined;
  }

  /**
   * The account a message sent From `fromEmail` belongs to: where it is
   * created, submitted and filed in Sent (#1090).
   *
   * Matching the session account *name* against the address alone misses a
   * group mailbox whose account name is not that address (a bare principal
   * name such as "team", a display name), an alias identity of the group, and
   * a sub-addressed From (team+tag@). Stalwart also lists a group's send-as
   * identity among the member's own identities, so the send then silently went
   * through the member's account and its Sent copy landed there.
   *
   * Order: an account named exactly `fromEmail`; then an account that owns an
   * identity for the address - exact, then sub-address, then wildcard, and a
   * delegated (group/shared) account before the primary one, since the
   * primary may merely mirror the group's identity; else the primary account.
   * A sub-address of the member's own address stays theirs even when a
   * shared catch-all account has a wildcard identity for the domain.
   */
  async resolveSendAccountId(fromEmail?: string): Promise<string> {
    if (!fromEmail) return this.accountId;
    const from = parseRecipientString(fromEmail).email.toLowerCase();
    const named = Object.keys(this.accounts).find(id => this.accounts[id]?.name?.toLowerCase() === from);
    if (named) return named;

    const delegated = Object.keys(this.accounts).filter(id =>
      id !== this.accountId
      && !!this.session?.accounts?.[id]?.accountCapabilities?.['urn:ietf:params:jmap:submission'],
    );
    if (delegated.length === 0) return this.accountId;

    const candidates = [...delegated, this.accountId];
    let identitiesByAccount: Array<[string, Identity[]]>;
    const cached = this.sendIdentitiesCache;
    if (cached && cached.expires > Date.now() && cached.key === candidates.join('\u0000')) {
      identitiesByAccount = cached.identitiesByAccount;
    } else {
      try {
        const response = await this.request(
          candidates.map((id, i) => ["Identity/get", { accountId: id }, String(i)] as JMAPMethodCall),
          ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:submission"],
        );
        identitiesByAccount = candidates.map((id, i) => {
          const [name, result] = response.methodResponses?.[i] ?? [];
          return [id, name === "Identity/get" ? ((result?.list ?? []) as Identity[]) : []];
        });
        // Draft autosave resolves on every save; identities rarely change.
        this.sendIdentitiesCache = {
          key: candidates.join('\u0000'),
          identitiesByAccount,
          expires: Date.now() + 60_000,
        };
      } catch (err) {
        debug.warn('email', '[sendEmail] could not load identities to pick the sending account', err);
        return this.accountId;
      }
    }

    for (const matches of [identityEmailMatchesExactly, identityEmailIsSubAddressOf, identityEmailIsWildcardFor]) {
      const hit = identitiesByAccount.find(([, list]) => list.some(identity => matches(identity.email, from)));
      if (hit) return hit[0];
    }
    return this.accountId;
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

  /**
   * Every account whose submissions this session can see: the primary
   * submission account plus each shared/group account that advertises the
   * submission capability in its own right.
   *
   * A delayed send composed from a shared identity is created in the *shared*
   * account (sendEmail passes the target account to getSubmissionAccountId),
   * so a scheduled-mail lookup that only ever asks the primary account misses
   * it entirely: the message stays pending on the server and goes out at
   * sendAt, but the UI cannot list, cancel or reschedule it. See #874.
   */
  private getSubmissionAccountIds(): string[] {
    const ids: string[] = [];
    const primary = this.getSubmissionAccountId();
    if (primary) ids.push(primary);
    for (const [accountId, account] of Object.entries(this.session?.accounts ?? {})) {
      if (ids.includes(accountId) || this.refusedSubmissionAccounts.has(accountId)) continue;
      if (account?.accountCapabilities?.['urn:ietf:params:jmap:submission']) ids.push(accountId);
    }
    return ids;
  }

  /**
   * Locate the account that actually holds a submission. Shared-account
   * submissions are invisible to (and not updatable through) the primary
   * account, which answers `notFound`. Resolved by asking each submission
   * account in turn, primary first.
   */
  private async resolveSubmissionAccountId(submissionId: string): Promise<string> {
    const accountIds = this.getSubmissionAccountIds();
    if (accountIds.length <= 1) return accountIds[0] ?? this.getSubmissionAccountId();
    for (const accountId of accountIds) {
      try {
        const response = await this.request([
          ['EmailSubmission/get', { accountId, ids: [submissionId], properties: ['id'] }, '0'],
        ]);
        const list = response.methodResponses?.[0]?.[1]?.list as Array<{ id?: string }> | undefined;
        if (list?.length) return accountId;
      } catch {
        // An account that cannot answer for this submission is simply not the
        // owner; keep looking rather than failing the whole operation.
      }
    }
    return this.getSubmissionAccountId();
  }

  private getSubmissionCapability(accountId?: string): SubmissionCapability | undefined {
    const submissionAccountId = this.getSubmissionAccountId(accountId);
    return this.session?.accounts?.[submissionAccountId]?.accountCapabilities?.['urn:ietf:params:jmap:submission'] as SubmissionCapability | undefined;
  }

  /**
   * Whether the submission account advertises an SMTP extension (RFC 8621
   * §1.3 `submissionExtensions`), e.g. "DSN" or "REQUIRETLS".
   */
  supportsSubmissionExtension(extension: string, accountId?: string): boolean {
    return this.hasSubmissionExtension(this.getSubmissionCapability(accountId)?.submissionExtensions, extension);
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

  // Server-confirmed authenticated login from the JMAP Session object. Use
  // this (not getUsername(), which echoes the constructor arg, nor the
  // sending identity) to verify a slot's token resolved to the expected
  // account.
  getSessionUsername(): string | undefined {
    return this.session?.username;
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

  /**
   * Whether the user may use a capability's methods with an account. The
   * account's own accountCapabilities decide (RFC 8620 s2): a server can
   * advertise a capability while an account has the matching permissions
   * revoked. Some shared accounts list no capabilities at all, so an explicitly
   * shared account (isPersonal === false) with an empty list falls back to the
   * server-wide capability - accountCapabilities is a subset of it (#1239).
   */
  accountSupports(accountId: string, capability: string): boolean {
    const account = this.accounts[accountId];
    if (!account) return false;
    const caps = account.accountCapabilities;
    if (caps?.[capability]) return true;
    if (caps && Object.keys(caps).length > 0) return false;
    return account.isPersonal === false && !!this.capabilities?.[capability];
  }

  supportsContacts(accountId?: string): boolean {
    return this.accountSupports(accountId || this.accountId, "urn:ietf:params:jmap:contacts");
  }

  supportsCalendars(accountId?: string): boolean {
    return this.accountSupports(accountId || this.accountId, "urn:ietf:params:jmap:calendars");
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
   * the capabilities the user may use with it (accountSupports()). Primary
   * account first; a non-primary account is listed when it supports at least
   * one editable capability. Name from the session account (primary falls back
   * to the username). Drives the settings "Shared with me" list and the
   * scoped-settings tab gating.
   */
  getSharedAccounts(): SharedAccount[] {
    const primaryId = this.getSieveAccountId();
    const toEntry = (id: string, isPrimary: boolean): SharedAccount => {
      const account = this.accounts[id];
      const has = (cap: string) => this.accountSupports(id, cap);
      return {
        id,
        name: account?.name || (isPrimary ? (this.username || id) : id),
        isPrimary,
        capabilities: {
          mail: has("urn:ietf:params:jmap:mail"),
          sieve: has("urn:ietf:params:jmap:sieve"),
          calendars: has("urn:ietf:params:jmap:calendars"),
          contacts: has("urn:ietf:params:jmap:contacts"),
          filenode: has("urn:ietf:params:jmap:filenode"),
        },
      };
    };

    const result = [toEntry(primaryId, true)];
    for (const id of Object.keys(this.accounts)) {
      if (id === primaryId) continue;
      const entry = toEntry(id, false);
      if (Object.values(entry.capabilities).some(Boolean)) {
        result.push(entry);
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
        properties: SIEVE_SCRIPT_PROPERTIES,
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

    if (response.methodResponses?.[0]?.[0] === 'error') {
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

  /**
   * Whether ContactCard/set in the account takes a `media` entry that carries
   * a blobId. Stalwart 1.0 embeds contact media as blobs and lists ContactCard
   * among the blob capability's supportedTypeNames (RFC 9404); 0.16 lists only
   * Email, Thread and SieveScript, and refuses such an entry with
   * invalidProperties ("blobIds in media is not supported."). A refusal seen
   * at runtime (rejectContactBlobMedia) wins for the rest of the session.
   */
  supportsContactBlobMedia(accountId?: string): boolean {
    const id = accountId || this.getContactsAccountId();
    if (this.contactBlobMediaRejected.has(id)) return false;
    const blob = this.getAccountCapability("urn:ietf:params:jmap:blob", id) as { supportedTypeNames?: unknown } | undefined;
    return Array.isArray(blob?.supportedTypeNames) && blob.supportedTypeNames.includes("ContactCard");
  }

  rejectContactBlobMedia(accountId?: string): void {
    this.contactBlobMediaRejected.add(accountId || this.getContactsAccountId());
  }

  private contactUsing(): string[] {
    const using = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:contacts"];
    if (this.hasCapability("urn:ietf:params:jmap:principals:owner")) {
      using.push("urn:ietf:params:jmap:principals:owner");
    }
    return using;
  }

  private calendarUsing(): string[] {
    const using = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars"];
    if (this.hasCapability("urn:ietf:params:jmap:principals:owner")) {
      using.push("urn:ietf:params:jmap:principals:owner");
    }
    return using;
  }

  private getCalendarCapableAccountIds(): string[] {
    const primaryId = this.getCalendarsAccountId();
    const accountIds: string[] = [];
    for (const id of Object.keys(this.accounts)) {
      if (id === primaryId) continue;
      if (this.accountSupports(id, "urn:ietf:params:jmap:calendars")) {
        accountIds.push(id);
      }
    }
    return [primaryId, ...accountIds];
  }

  private getContactCapableAccountIds(): string[] {
    const primaryId = this.getContactsAccountId();
    const accountIds: string[] = [];
    for (const id of Object.keys(this.accounts)) {
      if (id === primaryId) continue;
      if (this.accountSupports(id, "urn:ietf:params:jmap:contacts")) {
        accountIds.push(id);
      }
    }
    return [primaryId, ...accountIds];
  }

  async getAddressBooks(options?: { throwOnError?: boolean }): Promise<AddressBook[]> {
    try {
      const accountId = this.getContactsAccountId();
      const response = await this.request([
        ["AddressBook/get", { accountId, properties: ADDRESS_BOOK_PROPERTIES }, "0"]
      ], this.contactUsing());

      if (response.methodResponses?.[0]?.[0] === "AddressBook/get") {
        return (response.methodResponses[0][1].list || []) as AddressBook[];
      }
      const methodError = response.methodResponses?.[0]?.[1];
      throw new Error(methodError?.description || methodError?.type || "AddressBook/get failed");
    } catch (error) {
      console.error('Failed to get address books:', error);
      // Callers that would treat an empty list as "nothing exists yet" must be
      // able to tell a real empty account from a failed fetch (#730).
      if (options?.throwOnError) throw error;
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
    // Only forward server-settable properties. `isDefault` is deliberately not
    // among them: it is read-only in AddressBook/set and including it fails the
    // whole update with invalidProperties - use setDefaultAddressBook instead.
    const { name, description, sortOrder, color } = updates as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (name !== undefined) patch.name = name;
    if (description !== undefined) patch.description = description;
    if (sortOrder !== undefined) patch.sortOrder = sortOrder;
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

  /**
   * Mark an address book as the account default. `isDefault` is read-only in
   * AddressBook/set - the default is changed via the `onSuccessSetIsDefault`
   * request argument instead (same shape as Calendar/set).
   */
  async setDefaultAddressBook(addressBookId: string, targetAccountId?: string): Promise<void> {
    const accountId = targetAccountId || this.getContactsAccountId();

    const response = await this.request([
      ["AddressBook/set", {
        accountId,
        onSuccessSetIsDefault: addressBookId,
      }, "0"]
    ], this.contactUsing());

    const methodName = response.methodResponses?.[0]?.[0];
    if (methodName === "error") {
      const error = response.methodResponses?.[0]?.[1];
      throw new Error(error?.description || error?.type || "Failed to set default address book");
    }
    if (methodName !== "AddressBook/set") {
      throw new Error("Failed to set default address book");
    }
  }

  async deleteAddressBook(
    addressBookId: string,
    targetAccountId?: string,
    options?: { removeContents?: boolean },
  ): Promise<void> {
    const accountId = targetAccountId || this.getContactsAccountId();
    // Without onDestroyRemoveContents a book that still holds cards is
    // refused with `addressBookHasContents` (RFC 9610 §2.3).
    const response = await this.request([
      ["AddressBook/set", {
        accountId,
        destroy: [addressBookId],
        ...(options?.removeContents ? { onDestroyRemoveContents: true } : {}),
      }, "0"],
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
   * List all principals visible to the user (RFC 9670), and how complete the
   * list is; callers filter client-side. Paged by maxObjectsInGet: an
   * unbounded query hands every id to the chained Principal/get, which the
   * server refuses with `requestTooLarge` once the directory holds more than
   * that (500).
   *
   * Stalwart 1.0 refuses Principal/query with `forbidden` unless the
   * administrator allows directory queries, which is off by default; 0.16
   * does the same for a role without the query permission. The chained get
   * then fails with `invalidResultReference`, so only the query's own error
   * says why. The listing is then `restricted` to what Principal/get without
   * ids still returns: on 1.0 the principals the user knows, on 0.16
   * everyone, unless the role may not read principals either.
   */
  async listPrincipals(targetAccountId?: string, options?: { throwOnError?: boolean }): Promise<PrincipalListing> {
    if (!this.supportsPrincipals()) return { principals: [], status: "ok" };
    const accountId = targetAccountId || this.accountId;
    const pageSize = this.getMaxObjectsInGet();
    const MAX_PRINCIPALS = 20000;
    const all: Principal[] = [];
    try {
      for (let position = 0; position < MAX_PRINCIPALS;) {
        const page = await this.queryPrincipals(accountId, { position, limit: pageSize });
        if (!page.ok) {
          const { error } = page;
          if (options?.throwOnError) throw new PrincipalsRequestError(error?.type ?? null, error?.description);
          if (page.forbidden) {
            return {
              principals: await this.getKnownPrincipals(accountId),
              status: "restricted",
              ...(page.directoryQueriesOff ? { directoryQueriesOff: true } : {}),
            };
          }
          console.error("Failed to fetch principals:", error);
          return { principals: all, status: "error" };
        }
        const { ids, list } = page;
        all.push(...list);
        if (ids.length < pageSize) break;
        position += ids.length;
      }
      return { principals: all, status: "ok" };
    } catch (error) {
      if (options?.throwOnError) {
        throw error instanceof PrincipalsRequestError
          ? error
          : new PrincipalsRequestError(null, error instanceof Error ? error.message : undefined);
      }
      console.error("Failed to fetch principals:", error);
      return { principals: all, status: "error" };
    }
  }

  /**
   * One Principal/query with the matching Principal/get, as listPrincipals
   * and findPrincipalByEmail send it. When the query is refused the chained
   * get fails with `invalidResultReference`, so only the query's own error
   * says why: `forbidden`, and `directoryQueriesOff` when Stalwart 1.0 says
   * the administrator turned directory queries off.
   */
  private async queryPrincipals(
    accountId: string,
    args: { filter?: Record<string, unknown>; position?: number; limit: number },
  ): Promise<
    | { ok: true; ids: string[]; list: Principal[] }
    | { ok: false; forbidden: boolean; directoryQueriesOff: boolean; error: JmapErrorInfo | undefined }
  > {
    const response = await this.request([
      ["Principal/query", { accountId, ...args }, "0"],
      ["Principal/get", {
        accountId,
        "#ids": { resultOf: "0", name: "Principal/query", path: "/ids" },
        properties: PRINCIPAL_PROPERTIES,
      }, "1"],
    ], this.principalsUsing());
    const responses = response.methodResponses ?? [];
    const queryResp = responses.find((r) => r[0] === "Principal/query");
    const getResp = responses.find((r) => r[0] === "Principal/get");
    if (!queryResp || !getResp) {
      const error = responses.find((r) => r[0] === "error")?.[1] as JmapErrorInfo | undefined;
      return { ok: false, forbidden: error?.type === "forbidden", directoryQueriesOff: error?.description === DIRECTORY_QUERIES_OFF, error };
    }
    const list = ((getResp[1].list || []) as Principal[]).map((p) => ({ ...p, accountId }));
    return { ok: true, ids: queryResp[1]?.ids ?? [], list };
  }

  /** The principals of {@link listPrincipals}, without the status. */
  async getPrincipals(targetAccountId?: string, options?: { throwOnError?: boolean }): Promise<Principal[]> {
    return (await this.listPrincipals(targetAccountId, options)).principals;
  }

  /**
   * Principal/get without ids. When the directory can't be listed, Stalwart
   * 1.0 still returns the principals the user already knows: their own
   * account, their groups and the accounts that shared something with them.
   * Empty when that is refused too.
   */
  private async getKnownPrincipals(accountId: string): Promise<Principal[]> {
    try {
      const response = await this.request([
        ["Principal/get", { accountId, ids: null, properties: PRINCIPAL_PROPERTIES }, "0"],
      ], this.principalsUsing());
      const [method, result] = response.methodResponses?.[0] ?? [];
      if (method !== "Principal/get") return [];
      return ((result as { list?: Principal[] }).list ?? []).map((p) => ({ ...p, accountId }));
    } catch (error) {
      console.error("Failed to fetch principals:", error);
      return [];
    }
  }

  // ── CalendarEventNotification (draft-ietf-jmap-calendars §7) ───

  /**
   * Pending event notifications (invitations, updates, cancellations made by
   * other participants), oldest first. `event` is requested for the title
   * only; the default property set omits it.
   */
  async getCalendarEventNotifications(): Promise<CalendarEventNotification[]> {
    if (!this.supportsCalendars()) return [];
    const accountId = this.getCalendarsAccountId();
    const response = await this.request([
      ["CalendarEventNotification/query", {
        accountId,
        sort: [{ property: "created", isAscending: true }],
      }, "0"],
      ["CalendarEventNotification/get", {
        accountId,
        "#ids": { resultOf: "0", name: "CalendarEventNotification/query", path: "/ids" },
        properties: ["id", "created", "changedBy", "comment", "type", "calendarEventId", "isDraft", "event"],
      }, "1"],
    ], this.calendarUsing());
    const getResp = response.methodResponses?.find((r) => r[0] === "CalendarEventNotification/get");
    if (!getResp) {
      const error = response.methodResponses?.find((r) => r[0] === "error")?.[1] as { description?: string } | undefined;
      throw new Error(error?.description || "Failed to load calendar event notifications");
    }
    return ((getResp[1] as { list?: CalendarEventNotification[] }).list ?? []);
  }

  /** Acknowledges (destroys) event notifications that have been shown. */
  async destroyCalendarEventNotifications(ids: string[]): Promise<void> {
    if (ids.length === 0 || !this.supportsCalendars()) return;
    const accountId = this.getCalendarsAccountId();
    for (const batch of batched(ids, this.getMaxObjectsInSet())) {
      await this.request([
        ["CalendarEventNotification/set", { accountId, destroy: batch }, "0"],
      ], this.calendarUsing());
    }
  }

  // ── ParticipantIdentity (draft-ietf-jmap-calendars §6) ─────────

  /**
   * The calendar addresses this user can organise events as, with the
   * server's default flagged. Empty when the server has no calendars.
   */
  async getParticipantIdentities(): Promise<CalendarParticipantIdentity[]> {
    if (!this.supportsCalendars()) return [];
    const accountId = this.getCalendarsAccountId();
    const response = await this.request([
      ["ParticipantIdentity/get", { accountId }, "0"],
    ], this.calendarUsing());
    const [method, result] = response.methodResponses?.[0] ?? [];
    if (method !== "ParticipantIdentity/get") {
      throw new Error((result as { description?: string })?.description || "Failed to load participant identities");
    }
    return ((result as { list?: Array<Partial<CalendarParticipantIdentity> & { id: string }> }).list ?? []).map((i) => ({
      id: i.id,
      name: i.name ?? "",
      calendarAddress: i.calendarAddress ?? "",
      isDefault: i.isDefault === true,
    }));
  }

  /** Makes `id` the default identity (ParticipantIdentity/set onSuccessSetIsDefault). */
  async setDefaultParticipantIdentity(id: string): Promise<void> {
    const accountId = this.getCalendarsAccountId();
    const response = await this.request([
      ["ParticipantIdentity/set", { accountId, onSuccessSetIsDefault: id }, "0"],
    ], this.calendarUsing());
    const [method, result] = response.methodResponses?.[0] ?? [];
    if (method !== "ParticipantIdentity/set") {
      throw new Error((result as { description?: string })?.description || "Failed to set the default participant identity");
    }
  }

  // ── Principal/getAvailability (free/busy) ──────────────────────

  static readonly PRINCIPALS_AVAILABILITY_CAPABILITY = 'urn:ietf:params:jmap:principals:availability';

  /** Whether the server can answer free/busy queries for its principals. */
  supportsAvailability(): boolean {
    return this.supportsPrincipals() && this.hasCapability(JMAPClient.PRINCIPALS_AVAILABILITY_CAPABILITY);
  }

  /**
   * Whether this user may ask for other people's free/busy. The session
   * advertises free/busy either way, so the answer comes from the user's own
   * principal: Stalwart 1.0 sets `capabilities[calendars].mayGetAvailability`
   * to false while the administrator has directory queries off, and answers
   * every getAvailability with `forbidden` then. 0.16 leaves that object
   * empty, which means go ahead. A `forbidden` answer here (a role without
   * the principal permissions) means no as well; other failures throw.
   */
  async mayGetAvailability(): Promise<boolean> {
    if (!this.supportsAvailability()) return false;
    const principals = this.getAccountCapability("urn:ietf:params:jmap:principals") as
      { currentUserPrincipalId?: string | null } | undefined;
    const ownId = principals?.currentUserPrincipalId || this.accountId;
    const response = await this.request([
      ["Principal/get", { accountId: this.accountId, ids: [ownId], properties: ["id", "capabilities"] }, "0"],
    ], this.principalsUsing());
    const [method, result] = response.methodResponses?.[0] ?? [];
    if (method !== "Principal/get") {
      const error = result as JmapErrorInfo | undefined;
      if (error?.type === "forbidden") return false;
      throw jmapError(error?.description || "Failed to read the user's principal", error);
    }
    const own = ((result as { list?: Principal[] }).list ?? []).find((p) => p.id === ownId);
    const calendars = own?.capabilities?.["urn:ietf:params:jmap:calendars"] as { mayGetAvailability?: boolean } | undefined;
    return calendars?.mayGetAvailability !== false;
  }

  /**
   * The principal type ("individual", "group") of each id. Stalwart uses the
   * account id as the principal id, and Principal/get answers for accounts
   * the user can access even with directory queries off. Null when the
   * server has no principals or refuses.
   */
  async getPrincipalTypes(ids: string[]): Promise<Record<string, string> | null> {
    if (!this.supportsPrincipals() || ids.length === 0) return ids.length === 0 ? {} : null;
    try {
      const response = await this.request([
        ["Principal/get", { accountId: this.accountId, ids, properties: ["id", "type"] }, "0"],
      ], this.principalsUsing());
      const [method, result] = response.methodResponses?.[0] ?? [];
      if (method !== "Principal/get") return null;
      const types: Record<string, string> = {};
      for (const principal of (result as { list?: Principal[] }).list ?? []) {
        if (principal.id && typeof principal.type === "string") types[principal.id] = principal.type;
      }
      return types;
    } catch {
      return null;
    }
  }

  /**
   * Accounts whose metadata request failed, with when: not asked again for
   * ten minutes. A dropped connection (the pre-release 1.0 build) looks the
   * same as a network blip, so the pause is not for the whole session.
   */
  private metadataUnsupported = new Map<string, number>();

  /** Whether Bulwark may keep data in this account's Inbox metadata (lib/jmap/bulwark-metadata.ts). */
  supportsBulwarkMetadata(accountId?: string): boolean {
    const id = accountId || this.accountId;
    const failedAt = this.metadataUnsupported.get(id);
    if (failedAt !== undefined && Date.now() - failedAt < 10 * 60_000) return false;
    return advertisesMailboxMetadata(this.accounts[id]?.accountCapabilities as Record<string, unknown> | undefined);
  }

  /**
   * Bulwark's metadata entries of the account's Inbox, by key, shared or the
   * user's private ones. Null when the server has no usable metadata.
   */
  async getBulwarkMetadata(accountId?: string, options?: { private?: boolean }): Promise<Record<string, unknown> | null> {
    const id = accountId || this.accountId;
    if (!this.supportsBulwarkMetadata(id)) return null;
    const property = options?.private ? "privateMetadata" : "metadata";
    try {
      // A request of its own: a server that can't answer it must not take
      // other calls down with it.
      const response = await this.request([
        ["Mailbox/query", { accountId: id, filter: { role: "inbox" } }, "q"],
        ["Mailbox/get", { accountId: id, "#ids": { resultOf: "q", name: "Mailbox/query", path: "/ids" }, properties: ["id", property] }, "g"],
      ], ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", METADATA_CAPABILITY]);
      const get = response.methodResponses?.find((r) => r[0] === "Mailbox/get");
      const inbox = (get?.[1] as { list?: Array<Record<string, unknown>> } | undefined)?.list?.[0];
      // An answer without the property is a server that doesn't keep it,
      // never "every entry was removed".
      if (!inbox || !(property in inbox)) throw new MetadataUnsupportedError("No Inbox metadata in the answer");
      this.metadataInboxIds.set(id, inbox.id as string);
      this.metadataUnsupported.delete(id);
      return bulwarkEntries(inbox[property]);
    } catch (error) {
      debug.warn('jmap', `Metadata unavailable for account ${id}:`, error);
      this.metadataUnsupported.set(id, Date.now());
      return null;
    }
  }

  private metadataInboxIds = new Map<string, string>();

  /**
   * Writes one Bulwark metadata entry of the account's Inbox (null removes
   * it), leaving every other entry as it is. Throws MetadataTooLargeError
   * when the server refuses the size, MetadataUnsupportedError when the
   * account has no metadata.
   */
  async setBulwarkMetadata(accountId: string | undefined, key: string, value: unknown, options?: { private?: boolean }): Promise<void> {
    const id = accountId || this.accountId;
    if (!this.supportsBulwarkMetadata(id)) throw new MetadataUnsupportedError();
    const property = options?.private ? "privateMetadata" : "metadata";
    if (value !== null && metadataValueBytes(value) > MAX_METADATA_ENTRY_BYTES) {
      throw new MetadataTooLargeError(`The entry is larger than ${MAX_METADATA_ENTRY_BYTES} bytes`);
    }
    await this.updateInboxMetadata(id, { [`${property}/${namespaceFor(key)}`]: value }, options);
  }

  /**
   * Whether the account advertises vendor metadata on mailboxes, whatever
   * its last request did (supportsBulwarkMetadata also pauses after a
   * failure). False means the server keeps no metadata for this account.
   */
  advertisesBulwarkMetadata(accountId?: string): boolean {
    const id = accountId || this.accountId;
    return advertisesMailboxMetadata(this.accounts[id]?.accountCapabilities as Record<string, unknown> | undefined);
  }

  /**
   * Changes values inside one Bulwark metadata entry of the account's Inbox
   * and nothing else: each patch path (segments, escaped here) is set, null
   * removes it, an empty path is the whole entry. Returns the Mailbox state
   * after the change, so a caller can recognise the push of its own write.
   * Throws MetadataTooLargeError (the server's size limit),
   * MetadataPatchError (a parent of a path doesn't exist) and
   * MetadataUnsupportedError.
   */
  async patchBulwarkMetadata(accountId: string | undefined, key: string, patches: Array<{ path: string[]; value: unknown }>): Promise<{ newState?: string }> {
    const id = accountId || this.accountId;
    if (!this.supportsBulwarkMetadata(id)) throw new MetadataUnsupportedError();
    const update: Record<string, unknown> = {};
    for (const { path, value } of patches) {
      update[[`metadata/${namespaceFor(key)}`, ...path.map(escapeMetadataPathSegment)].join("/")] = value;
    }
    return { newState: await this.updateInboxMetadata(id, update) };
  }

  /** One Mailbox/set of the Inbox's metadata; answers the new Mailbox state. */
  private async updateInboxMetadata(id: string, update: Record<string, unknown>, options?: { private?: boolean }): Promise<string | undefined> {
    let inboxId = this.metadataInboxIds.get(id);
    if (!inboxId) {
      await this.getBulwarkMetadata(id, options);
      inboxId = this.metadataInboxIds.get(id);
      if (!inboxId) throw new MetadataUnsupportedError();
    }
    const response = await this.request([
      ["Mailbox/set", { accountId: id, update: { [inboxId]: update } }, "0"],
    ], ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", METADATA_CAPABILITY]);
    const [method, result] = response.methodResponses?.[0] ?? [];
    if (method !== "Mailbox/set") {
      throw jmapError((result as JmapErrorInfo | undefined)?.description || "Failed to save metadata", result as JmapErrorInfo | undefined);
    }
    const notUpdated = (result as { notUpdated?: Record<string, { type?: string; description?: string }> }).notUpdated?.[inboxId];
    if (notUpdated) {
      if (/exceeds the maximum/i.test(notUpdated.description ?? "")) throw new MetadataTooLargeError(notUpdated.description!);
      if (notUpdated.type === "invalidPatch") throw new MetadataPatchError(notUpdated.description || "A parent of the patched value does not exist");
      throw new MetadataRefusedError(notUpdated.type ?? "unknown", notUpdated.description || `Failed to save metadata (${notUpdated.type ?? "unknown"})`);
    }
    const newState = (result as { newState?: unknown }).newState;
    return typeof newState === "string" ? newState : undefined;
  }

  /**
   * The busy periods of a principal between `utcStart` and `utcEnd`
   * (Principal/getAvailability). Event details are never requested: this
   * only tells whether an attendee is free, not what they are doing.
   * A refusal throws with the JMAP error type: `forbidden` when the server
   * won't answer free/busy for this user, `rateLimit` on Stalwart 1.0 after
   * 100 calls a minute.
   */
  async getPrincipalAvailability(principalId: string, utcStart: Date, utcEnd: Date): Promise<BusyPeriod[]> {
    if (!this.supportsAvailability()) return [];
    const response = await this.request([
      ["Principal/getAvailability", this.availabilityArgs(principalId, utcStart, utcEnd), "0"],
    ], [...this.principalsUsing(), JMAPClient.PRINCIPALS_AVAILABILITY_CAPABILITY]);
    const [method, result] = response.methodResponses?.[0] ?? [];
    if (method !== "Principal/getAvailability") {
      const error = result as JmapErrorInfo | undefined;
      throw jmapError(error?.description || "Failed to query availability", error);
    }
    return busyPeriodsOf(result);
  }

  /**
   * The busy periods of several principals over one window, batched into as
   * few requests as maxCallsInRequest allows: Principal/getAvailability takes
   * a single id. Each principal gets its periods, or the error type its call
   * was refused with. Batching saves round trips only: Stalwart 1.0 counts
   * every call against its limit of 100 a minute. A failed request throws.
   */
  async getPrincipalsAvailability(principalIds: string[], utcStart: Date, utcEnd: Date): Promise<Record<string, PrincipalAvailability>> {
    const results: Record<string, PrincipalAvailability> = {};
    if (!this.supportsAvailability()) return results;
    for (const batch of batched(principalIds, this.getMaxCallsInRequest())) {
      const response = await this.request(
        batch.map((id, i): JMAPMethodCall => ["Principal/getAvailability", this.availabilityArgs(id, utcStart, utcEnd), String(i)]),
        [...this.principalsUsing(), JMAPClient.PRINCIPALS_AVAILABILITY_CAPABILITY],
      );
      const byCallId = new Map((response.methodResponses ?? []).map((r) => [r[2], r]));
      batch.forEach((id, i) => {
        const [method, result] = byCallId.get(String(i)) ?? [];
        results[id] = method === "Principal/getAvailability"
          ? { periods: busyPeriodsOf(result) }
          : { error: (result as JmapErrorInfo | undefined)?.type || "serverFail" };
      });
    }
    return results;
  }

  private availabilityArgs(principalId: string, utcStart: Date, utcEnd: Date): Record<string, unknown> {
    return {
      accountId: this.accountId,
      id: principalId,
      utcStart: utcStart.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      utcEnd: utcEnd.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      showDetails: false,
    };
  }

  // ── ShareNotification (RFC 9670 §3) ────────────────────────────

  /** Whether the server can report who shared what with this user. */
  supportsShareNotifications(): boolean {
    return this.supportsPrincipals();
  }

  /**
   * Every pending share notification of the user's own account, oldest
   * first. The list is small by construction: notifications are destroyed
   * once they have been shown (see destroyShareNotifications).
   */
  async getShareNotifications(): Promise<ShareNotification[]> {
    if (!this.supportsShareNotifications()) return [];
    const accountId = this.accountId;
    const response = await this.request([
      ["ShareNotification/query", {
        accountId,
        sort: [{ property: "created", isAscending: true }],
      }, "0"],
      ["ShareNotification/get", {
        accountId,
        "#ids": { resultOf: "0", name: "ShareNotification/query", path: "/ids" },
      }, "1"],
    ], this.principalsUsing());
    const getResp = response.methodResponses?.find((r) => r[0] === "ShareNotification/get");
    if (!getResp) {
      const error = response.methodResponses?.find((r) => r[0] === "error")?.[1] as { description?: string } | undefined;
      throw new Error(error?.description || "Failed to load share notifications");
    }
    return ((getResp[1] as { list?: ShareNotification[] }).list ?? []);
  }

  /** Acknowledges (destroys) share notifications that have been shown. */
  async destroyShareNotifications(ids: string[]): Promise<void> {
    if (ids.length === 0 || !this.supportsShareNotifications()) return;
    for (const batch of batched(ids, this.getMaxObjectsInSet())) {
      await this.request([
        ["ShareNotification/set", { accountId: this.accountId, destroy: batch }, "0"],
      ], this.principalsUsing());
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

  // ── Mailbox sharing (urn:ietf:params:jmap:mail:share) ─────────────

  static readonly MAIL_SHARE_CAPABILITY = 'urn:ietf:params:jmap:mail:share';

  /** Whether the account's server accepts `shareWith` on Mailbox objects. */
  supportsMailboxSharing(accountId?: string): boolean {
    return this.hasAccountCapability(JMAPClient.MAIL_SHARE_CAPABILITY, accountId || this.accountId);
  }

  /**
   * The current `shareWith` map of one folder. Fetched on demand (the share
   * dialog) rather than with every folder list: Stalwart omits shareWith from
   * Mailbox/get unless it is requested, and it is only needed here.
   */
  async getMailboxShareWith(mailboxId: string, accountId?: string): Promise<Record<string, MailboxRights> | null> {
    const targetAccountId = accountId || this.accountId;
    const response = await this.request([
      ["Mailbox/get", {
        accountId: targetAccountId,
        ids: [mailboxId],
        properties: ["id", "shareWith"],
      }, "0"],
    ], ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", JMAPClient.MAIL_SHARE_CAPABILITY]);
    const [method, result] = response.methodResponses?.[0] ?? [];
    if (method !== "Mailbox/get") {
      throw new Error((result as { description?: string })?.description || "Failed to load folder sharing");
    }
    const mailbox = ((result as { list?: Array<{ id: string; shareWith?: Record<string, MailboxRights> | null }> }).list ?? [])
      .find((mb) => mb.id === mailboxId);
    if (!mailbox) {
      throw new Error("Folder not found");
    }
    return mailbox.shareWith ?? null;
  }

  /**
   * Grants (`rights`) or revokes (`null`) a principal's access to a folder
   * via a `shareWith/{principalId}` patch, like the calendar / address book
   * variants.
   */
  async setMailboxShare(
    mailboxId: string,
    principalId: string,
    rights: MailboxRights | null,
    accountId?: string,
  ): Promise<void> {
    const targetAccountId = accountId || this.accountId;
    const response = await this.request([
      ["Mailbox/set", {
        accountId: targetAccountId,
        update: { [mailboxId]: { [`shareWith/${principalId}`]: rights } },
      }, "0"],
    ], ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", JMAPClient.MAIL_SHARE_CAPABILITY]);

    const [method, result] = response.methodResponses?.[0] ?? [];
    if (method !== "Mailbox/set") {
      throw new Error((result as { description?: string })?.description || "Failed to update folder share");
    }
    const setResult = result as { updated?: Record<string, unknown>; notUpdated?: Record<string, { description?: string }> };
    if (setResult.notUpdated?.[mailboxId]) {
      throw new Error(setResult.notUpdated[mailboxId].description || "Failed to update folder share");
    }
    if (!setResult.updated || !(mailboxId in setResult.updated)) {
      throw new Error("Server did not confirm the share update");
    }
  }

  // ── Sharing many items at once (the Delegates page) ──────────────

  /**
   * Whether the server keeps a folder's "mark as read" and keyword rights as
   * one right, so a read-only share can also flag mail. Stalwart 1.0 does
   * (a read grant reads back with maySetKeywords); every 1.0 account lists
   * principals:owner, which 0.16 never does (see keepsServerTextOrder).
   */
  sharesSeenWithKeywords(accountId?: string): boolean {
    return this.hasAccountCapability("urn:ietf:params:jmap:principals:owner", accountId);
  }

  /**
   * Every folder, calendar and address book of the user's own account with
   * its `shareWith`, and the files that are shared with someone. A type the
   * account can't share is left out; one whose read failed is in `failed`,
   * so the caller doesn't mistake it for "shared with nobody".
   */
  async getShareTargets(
    include: { calendars?: boolean; contacts?: boolean; files?: boolean } = {},
  ): Promise<{ targets: ShareTarget[]; failed: ShareKind[] }> {
    const calls: JMAPMethodCall[] = [];
    const using = new Set<string>(["urn:ietf:params:jmap:core"]);
    const accounts: { mailbox?: string; calendar?: string; addressBook?: string } = {};
    if (this.supportsMailboxSharing()) {
      accounts.mailbox = this.accountId;
      calls.push(["Mailbox/get", { accountId: this.accountId, ids: null, properties: ["id", "name", "role", "parentId", "shareWith"] }, "m"]);
      for (const u of ["urn:ietf:params:jmap:mail", JMAPClient.MAIL_SHARE_CAPABILITY]) using.add(u);
    }
    const calendarsAccountId = this.getCalendarsAccountId();
    if (include.calendars !== false && this.supportsCalendars(calendarsAccountId)) {
      accounts.calendar = calendarsAccountId;
      calls.push(["Calendar/get", { accountId: calendarsAccountId, ids: null, properties: ["id", "name", "isDefault", "shareWith"] }, "c"]);
      for (const u of this.calendarUsing()) using.add(u);
    }
    const contactsAccountId = this.getContactsAccountId();
    if (include.contacts !== false && this.supportsContacts(contactsAccountId)) {
      accounts.addressBook = contactsAccountId;
      calls.push(["AddressBook/get", { accountId: contactsAccountId, ids: null, properties: ["id", "name", "isDefault", "shareWith"] }, "a"]);
      for (const u of this.contactUsing()) using.add(u);
    }

    const readCollections = async (): Promise<{ targets: ShareTarget[]; failed: ShareKind[] }> => {
      if (calls.length === 0) return { targets: [], failed: [] };
      try {
        const response = await this.request(calls, [...using]);
        return parseShareTargets(response.methodResponses as [string, Record<string, unknown>, string][], accounts);
      } catch (error) {
        console.error("Failed to read sharing:", error);
        return { targets: [], failed: Object.keys(accounts) as ShareKind[] };
      }
    };
    const filesAccountId = this.getFilesAccountId();
    const readFiles = async (): Promise<{ targets: ShareTarget[]; failed: ShareKind[] }> => {
      if (include.files === false || !this.supportsFiles(filesAccountId)) return { targets: [], failed: [] };
      try {
        const targets: ShareTarget[] = [];
        for (const node of await this.listAllFileNodes()) {
          if (!node.shareWith || Object.keys(node.shareWith).length === 0) continue;
          targets.push({ kind: "file", accountId: filesAccountId, id: node.id, name: node.name, parentId: node.parentId ?? null, shareWith: node.shareWith });
        }
        return { targets, failed: [] };
      } catch (error) {
        console.error("Failed to read file sharing:", error);
        return { targets: [], failed: ["file"] };
      }
    };
    // The file tree can take several requests; it is read alongside the rest.
    const [collections, fileTargets] = await Promise.all([readCollections(), readFiles()]);
    return { targets: [...collections.targets, ...fileTargets.targets], failed: [...collections.failed, ...fileTargets.failed] };
  }

  /**
   * Applies `shareWith` changes to many items in as few requests as the
   * server's limits allow, and says for each one whether it worked. Never
   * throws: a request that fails marks its items failed.
   */
  async applyShareChanges(changes: ShareChange[]): Promise<ShareChangeResult[]> {
    if (changes.length === 0) return [];
    const { calls, changesByCall } = buildShareSetCalls(changes, {
      maxObjectsInSet: this.getMaxObjectsInSet(),
      wireRights: (change) => change.kind === "file" && change.rights && this.isLegacyFileNodeServer(change.accountId)
        ? toLegacyRights(change.rights as FileNodeRights)
        : change.rights,
    });
    const usingFor: Record<string, string[]> = {
      [SET_METHOD.mailbox]: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", JMAPClient.MAIL_SHARE_CAPABILITY],
      [SET_METHOD.calendar]: this.calendarUsing(),
      [SET_METHOD.addressBook]: this.contactUsing(),
      [SET_METHOD.file]: this.fileUsing(),
    };
    const results: ShareChangeResult[] = [];
    for (const group of batched(calls, this.getMaxCallsInRequest())) {
      const using = [...new Set(group.flatMap(([method]) => usingFor[method] ?? []))];
      try {
        const response = await this.request(group, using);
        results.push(...readShareSetResults(group, changesByCall, response.methodResponses as [string, Record<string, unknown>, string][]));
      } catch (error) {
        results.push(...failAll(group, changesByCall, error));
      }
    }
    return results;
  }

  /**
   * The principal with this address, through a directory query. `forbidden`
   * when the server refuses queries (Stalwart 1.0 with directory queries off,
   * the default), with `directoryQueriesOff` when that is the reason.
   */
  async findPrincipalByEmail(email: string): Promise<{ principal: Principal | null; status: "ok" | "forbidden" | "error"; directoryQueriesOff?: boolean }> {
    if (!this.supportsPrincipals()) return { principal: null, status: "error" };
    const wanted = email.trim().toLowerCase();
    try {
      const page = await this.queryPrincipals(this.accountId, { filter: { email: wanted }, limit: 10 });
      if (!page.ok) {
        if (page.forbidden) return { principal: null, status: "forbidden", ...(page.directoryQueriesOff ? { directoryQueriesOff: true } : {}) };
        return { principal: null, status: "error" };
      }
      const principal = page.list.find((p) => p.email?.toLowerCase() === wanted || p.name?.toLowerCase() === wanted) ?? null;
      return { principal, status: "ok" };
    } catch (error) {
      console.error("Failed to look up principal:", error);
      return { principal: null, status: "error" };
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
        allContacts.push(...list.map(contactFromWire));
      }
    }

    return allContacts;
  }

  async getContacts(addressBookId?: string, options?: { throwOnError?: boolean }): Promise<ContactCard[]> {
    try {
      const accountId = this.getContactsAccountId();
      const filter = addressBookId ? { inAddressBook: addressBookId } : undefined;
      return await this.fetchPaginatedContacts(accountId, filter);
    } catch (error) {
      console.error('Failed to get contacts:', error);
      if (options?.throwOnError) throw error;
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
        const list = (response.methodResponses[0][1].list || []) as ContactCard[];
        return list[0] ? contactFromWire(list[0]) : null;
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

    const contactData = contactToWire(contact, 'create');

    const response = await this.request([
      ["ContactCard/set", {
        accountId,
        create: {
          "new-contact": {
            ...contactData,
            //  Stalwart stores the card without one if omitted (#644)
            uid: contact.uid || `urn:uuid:${generateUUID()}`,
            addressBookIds,
          }
        }
      }, "0"]
    ], this.contactUsing());

    if (response.methodResponses?.[0]?.[0] === "ContactCard/set") {
      const result = response.methodResponses[0][1];

      if (result.notCreated?.["new-contact"]) {
        const error = result.notCreated["new-contact"];
        throw jmapError(error.description || "Failed to create contact", error);
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

    const cleanUpdates = contactToWire(updates, 'update');

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
        throw jmapError(error.description || "Failed to update contact", error);
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
              // Same text rules as mail search (see splitSearchText).
              filter: textFilter(query),
              limit: 50,
            }, "0"],
            ["ContactCard/get", {
              accountId,
              "#ids": { resultOf: "0", name: "ContactCard/query", path: "/ids" },
            }, "1"]
          ], this.contactUsing());

          if (response.methodResponses?.[1]?.[0] === "ContactCard/get") {
            const rawContacts = (response.methodResponses[1][1].list || []) as ContactCard[];
            const contacts = rawContacts.map(contactFromWire).map((contact) => ({
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

  /**
   * Calendar/get for one account. The session's first one on the primary
   * calendar account also carries the synthetic-id probe (see
   * supportsSyntheticCalendarIds) and the time zone probe (see
   * calendarTimeZone), so the reads that follow need no round trip of their
   * own for them.
   */
  private requestCalendars(accountId: string): Promise<JMAPResponse> {
    const methodCalls: JMAPMethodCall[] = [
      ["Calendar/get", { accountId, properties: CALENDAR_PROPERTIES }, "0"],
    ];
    const isPrimary = accountId === this.getCalendarsAccountId();
    const carriesProbe = !this.syntheticCalendarIdSupport && isPrimary;
    if (carriesProbe) methodCalls.push(this.syntheticIdProbeCall(accountId));
    const timeZone = getUserTimeZone();
    const checksTimeZone = isPrimary && !!timeZone && timeZone !== 'UTC' && !this.timeZoneProbes.has(timeZone);
    if (checksTimeZone) methodCalls.push(this.timeZoneProbeCall(accountId, timeZone));
    const pending = this.request(methodCalls, this.calendarUsing());
    if (carriesProbe) this.rememberSyntheticIdProbe(pending);
    if (checksTimeZone) this.rememberTimeZoneProbe(timeZone, pending);
    return pending;
  }

  async getCalendars(): Promise<Calendar[]> {
    try {
      const accountId = this.getCalendarsAccountId();
      const response = await this.requestCalendars(accountId);

      if (response.methodResponses?.[0]?.[0] === "Calendar/get") {
        const calendars = (response.methodResponses[0][1].list || []) as Calendar[];
        const tasksOnly = await this.getTasksOnlyCalendarIds(accountId, calendars.map((c) => c.id));
        return calendars.map((cal) => ({ ...cal, isTasksOnly: tasksOnly.has(cal.id) }));
      }
      return [];
    } catch (error) {
      console.error('Failed to get calendars:', error);
      return [];
    }
  }

  /**
   * Ids of the given calendars that hold only tasks and no events, so the event
   * calendar UI can hide them. Stalwart's Calendar/get exposes no
   * supported-component set, so this is derived by inspecting objects per calendar.
   *
   * Each calendar is queried on its own with the singular `inCalendar`
   * condition, so a large event archive in one calendar no longer pushes the
   * scan past its cap for all the others. A calendar stops being scanned as
   * soon as one event turns up; one whose pages are all tasks is paged to the
   * end and only then marked. Queries are chunked by maxCallsInRequest and gets
   * by maxObjectsInGet. Past the per-calendar cap, on a failed query or on any
   * error the calendar is left visible (fail open). Empty calendars stay visible.
   */
  private async getTasksOnlyCalendarIds(accountId: string, rawCalendarIds: string[]): Promise<Set<string>> {
    if (rawCalendarIds.length === 0) return new Set();

    const QUERY_PAGE = 200;
    const MAX_SCAN_PER_CALENDAR = 5000; // safety bound; beyond this we fail open
    const PROPERTIES = ['id', '@type', 'due', 'progress', 'percentComplete', 'calendarIds'];
    const timeZone = await this.calendarTimeZone();
    const maxCalls = Math.max(1, this.getMaxCallsInRequest());
    const maxGet = Math.max(1, this.getMaxObjectsInGet());
    const tasksOnly = new Set<string>();
    const position = new Map<string, number>();
    let pending = Array.from(new Set(rawCalendarIds)); // calendars with no event seen so far

    try {
      while (pending.length > 0) {
        const pageIds = new Map<string, string[]>();
        for (let i = 0; i < pending.length; i += maxCalls) {
          const chunk = pending.slice(i, i + maxCalls);
          const queryCalls: JMAPMethodCall[] = chunk.map((calId, idx) => [
            "CalendarEvent/query",
            {
              accountId,
              filter: { inCalendar: calId },
              position: position.get(calId) ?? 0,
              limit: QUERY_PAGE,
              ...(timeZone ? { timeZone } : {}),
            },
            `q_${idx}`,
          ]);
          const qResp = await this.request(queryCalls, this.calendarUsing());
          chunk.forEach((calId, idx) => {
            const match = qResp.methodResponses?.find((r) => r[2] === `q_${idx}`);
            // A failed query leaves this calendar out, so it stays visible.
            if (match?.[0] === "CalendarEvent/query") pageIds.set(calId, match[1]?.ids || []);
          });
        }

        const allIds = Array.from(new Set(Array.from(pageIds.values()).flat()));
        const objectMap = new Map<string, ScannedCalendarObject>();
        for (let i = 0; i < allIds.length; i += maxGet) {
          const getResp = await this.request([
            ["CalendarEvent/get", { accountId, ids: allIds.slice(i, i + maxGet), properties: PROPERTIES, ...(timeZone ? { timeZone } : {}) }, "0"]
          ], this.calendarUsing());
          if (getResp.methodResponses?.[0]?.[0] !== "CalendarEvent/get") return new Set(); // fail open
          for (const obj of (getResp.methodResponses[0][1]?.list || []) as ScannedCalendarObject[]) {
            if (obj.id) objectMap.set(obj.id as string, obj);
          }
        }

        const next: string[] = [];
        for (const [calId, ids] of pageIds) {
          const start = position.get(calId) ?? 0;
          if (ids.length === 0) {
            // End of the calendar. Only mark it if earlier pages held tasks.
            if (start > 0) tasksOnly.add(calId);
            continue;
          }
          const calObjects = ids.map((id) => objectMap.get(id)).filter(Boolean) as ScannedCalendarObject[];
          if (calObjects.length === 0) continue;
          if (calObjects.some((obj) => !isTaskLikeObject(obj))) continue; // holds an event
          if (ids.length < QUERY_PAGE) {
            tasksOnly.add(calId);
            continue;
          }
          const nextPosition = start + ids.length;
          if (nextPosition >= MAX_SCAN_PER_CALENDAR) continue; // too many to check, keep it visible
          position.set(calId, nextPosition);
          next.push(calId);
        }
        pending = next;
      }

      return tasksOnly;
    } catch {
      return new Set(); // fail open
    }
  }

  async getAllCalendars(): Promise<Calendar[]> {
    try {
      return (await this.getAllCalendarsWithFailures()).calendars;
    } catch (error) {
      console.error('Failed to fetch all calendars:', error);
      return [];
    }
  }

  /**
   * getAllCalendars() for callers that reconcile state against the list: a
   * failure on the primary account throws instead of yielding a list without
   * its calendars, and shared accounts that could not be loaded are named in
   * `failedAccountIds`. Read as "no calendars", a failed fetch dropped every
   * calendar from the persisted selection.
   */
  async getAllCalendarsWithFailures(): Promise<{ calendars: Calendar[]; failedAccountIds: string[] }> {
    const allCalendars: Calendar[] = [];
    const failedAccountIds: string[] = [];
    const primaryId = this.getCalendarsAccountId();
    const accountIds = this.getCalendarCapableAccountIds();

    for (const accountId of accountIds) {
      const isPrimary = accountId === primaryId;
      if (!isPrimary && this.calendarAccessDenied.has(accountId)) continue;
      const account = this.accounts[accountId];

      try {
        const response = await this.requestCalendars(accountId);
        const [method, result] = response.methodResponses?.[0] ?? [];

        if (method !== "Calendar/get") {
          // Shared accounts are probed on suspicion (see
          // getCalendarCapableAccountIds); one that grants no calendar access
          // has no calendars to lose.
          if (!isPrimary && isCalendarAccessDenial(result?.type, result?.description)) continue;
          throw new Error(result?.description || result?.type || "Calendar/get failed");
        }

        const rawCalendars = (result.list || []) as Calendar[];
        const tasksOnly = await this.getTasksOnlyCalendarIds(accountId, rawCalendars.map((c) => c.id));
        const calendars = rawCalendars.map((cal) => ({
          ...cal,
          id: isPrimary ? cal.id : `${accountId}:${cal.id}`,
          originalId: cal.id,
          accountId,
          accountName: account?.name || (isPrimary ? this.username : accountId),
          isShared: !isPrimary,
          isTasksOnly: tasksOnly.has(cal.id),
        }));
        allCalendars.push(...calendars);
      } catch (error) {
        if (isPrimary) throw error;
        console.error(`Failed to fetch calendars for account ${accountId}:`, error);
        failedAccountIds.push(accountId);
      }
    }

    return { calendars: allCalendars, failedAccountIds };
  }

  async createCalendar(calendar: Partial<Calendar>, targetAccountId?: string, options?: CreateCalendarOptions): Promise<Calendar> {
    const accountId = targetAccountId || this.getCalendarsAccountId();

    // Stalwart's Calendar/set cannot express the CalDAV
    // supported-calendar-component-set, and the server only accepts that
    // property while the collection is being created, so calendars in the
    // user's own account are made with MKCALENDAR through the WebDAV proxy and
    // finished off over JMAP. If that path is unavailable (older server, proxy
    // unreachable, shared account) we fall back to a plain Calendar/set, which
    // yields the previous "every component type" calendar (#760).
    if (accountId === this.getAccountId()) {
      const created = await this.createCalendarViaCalDav(calendar, accountId, options?.components);
      if (created) return created;
    }

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
        const created = await this.getCalendarById(accountId, createdId);
        if (created) return created;
      }
    }

    throw new Error("Failed to create calendar");
  }

  private async getCalendarById(accountId: string, calendarId: string): Promise<Calendar | null> {
    const response = await this.request([
      ["Calendar/get", { accountId, ids: [calendarId], properties: CALENDAR_PROPERTIES }, "0"]
    ], this.calendarUsing());
    if (response.methodResponses?.[0]?.[0] === "Calendar/get") {
      const list = response.methodResponses[0][1].list || [];
      if (list[0]) return list[0] as Calendar;
    }
    return null;
  }

  private async listAccountCalendars(accountId: string, properties: readonly string[]): Promise<Calendar[]> {
    const response = await this.request([
      ["Calendar/get", { accountId, ids: null, properties }, "0"]
    ], this.calendarUsing());
    if (response.methodResponses?.[0]?.[0] !== "Calendar/get") {
      throw new Error("Failed to list calendars");
    }
    return (response.methodResponses[0][1].list || []) as Calendar[];
  }

  /**
   * MKCALENDAR the collection (pinning its component set), find the JMAP id
   * Stalwart gave it, then apply the remaining properties with Calendar/set.
   * Returns null when the CalDAV step is unavailable so the caller can fall
   * back to a JMAP-only create; throws if the collection was created but
   * could not be completed (a retry over JMAP would leave a duplicate).
   */
  private async createCalendarViaCalDav(
    calendar: Partial<Calendar>,
    accountId: string,
    components?: CalendarComponentType[],
  ): Promise<Calendar | null> {
    const displayName = typeof calendar.name === 'string' ? calendar.name.trim() : '';
    if (!displayName) return null;
    const componentSet = components && components.length > 0
      ? Array.from(new Set(components))
      : DEFAULT_CALENDAR_COMPONENTS;

    // The DAV response carries no JMAP id, so snapshot the ids beforehand and
    // pick out the newcomer afterwards.
    let before: Set<string>;
    try {
      before = new Set((await this.listAccountCalendars(accountId, ["id"])).map((c) => c.id));
    } catch {
      return null;
    }

    let created: boolean;
    try {
      created = await mkCalendarCollection({
        collectionName: newCalendarCollectionName(),
        displayName,
        components: componentSet,
      });
    } catch (error) {
      debug.log('calendar', 'MKCALENDAR unavailable, falling back to Calendar/set', error);
      return null;
    }
    if (!created) return null;

    const fresh = (await this.listAccountCalendars(accountId, CALENDAR_PROPERTIES)).filter((c) => !before.has(c.id));
    const found = fresh.find((c) => c.name === displayName) ?? fresh[0];
    if (!found) throw new Error("Calendar was created but could not be found");

    // The name went in with MKCALENDAR; colour, visibility etc. go over JMAP.
    const updates: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(calendar as Record<string, unknown>)) {
      if (key !== 'name' && value !== undefined && CALENDAR_SETTABLE_PROPERTIES.has(key)) {
        updates[key] = value;
      }
    }
    if (Object.keys(updates).length === 0) return found;

    await this.updateCalendar(found.id, updates as Partial<Calendar>, accountId);
    return (await this.getCalendarById(accountId, found.id)) ?? { ...found, ...updates } as Calendar;
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

  /**
   * Every event of the account (or of `calendarIds`), with only the
   * identity properties (CALENDAR_EVENT_IDENTITY_PROPERTIES) filled in.
   */
  async getCalendarEvents(calendarIds?: string[], targetAccountId?: string): Promise<CalendarEvent[]> {
    const accountId = targetAccountId || this.getCalendarsAccountId();
    return this.withCalendarTimeZone((timeZone) => this.listCalendarEvents(accountId, calendarIds, timeZone));
  }

  private async listCalendarEvents(accountId: string, calendarIds: string[] | undefined, timeZone: string | undefined): Promise<CalendarEvent[]> {
    // Page through the query to collect ALL ids. Callers (import UID
    // deduplication, clear-calendar, subscription refresh) rely on this being
    // the complete list; a single capped query silently hid everything past
    // the first page in large accounts (#113: spurious "UID already exists"
    // import failures once an account holds >1000 events).
    const QUERY_PAGE = 1000;
    const MAX_IDS = 50000; // safety bound
    const ids: string[] = [];
    for (let position = 0; position < MAX_IDS;) {
      const queryArgs: Record<string, unknown> = { accountId, limit: QUERY_PAGE, position };
      if (timeZone) {
        queryArgs.timeZone = timeZone;
      }
      if (calendarIds && calendarIds.length > 0) {
        queryArgs.filter = buildInCalendarFilter(calendarIds);
      }

      const queryResponse = await this.request([
        ["CalendarEvent/query", queryArgs, "0"],
      ], this.calendarUsing());
      const pageIds: string[] = methodResult(queryResponse, "0", "CalendarEvent/query").ids || [];
      ids.push(...pageIds);
      if (pageIds.length < QUERY_PAGE) break;
      position += pageIds.length;
    }

    if (ids.length === 0) return [];

    const allEvents = await this.fetchCalendarEventsById(accountId, ids, CALENDAR_EVENT_IDENTITY_PROPERTIES, { timeZone });
    return (allEvents as unknown as CalendarEvent[])
      .filter((event) => !isTaskObject(event))
      .map((event) => normalizeCalendarEventLike(event));
  }

  /**
   * CalendarEvent/get of `ids` in batches of maxObjectsInGet. With
   * `withOverrides`, each batch also asks for OVERRIDE_PROPERTIES in a second
   * call of the same request, and the overrides are merged in by id: Stalwart
   * 1.0 refuses `recurrenceOverrides` in the same get as `utcStart`/`utcEnd`.
   * A method error on either call fails the whole fetch.
   */
  private async fetchCalendarEventsById(
    accountId: string,
    ids: string[],
    properties: readonly string[],
    options: { withOverrides?: boolean; timeZone?: string } = {},
  ): Promise<Record<string, unknown>[]> {
    const { withOverrides = false, timeZone } = options;
    const objects: Record<string, unknown>[] = [];
    for (const batch of batched(ids, this.getMaxObjectsInGet())) {
      const args = { accountId, ids: batch, ...(timeZone ? { timeZone } : {}) };
      const calls: JMAPMethodCall[] = [["CalendarEvent/get", { ...args, properties: [...properties] }, "0"]];
      if (withOverrides) {
        calls.push(["CalendarEvent/get", { ...args, properties: [...OVERRIDE_PROPERTIES] }, "1"]);
      }
      const response = await this.request(calls, this.calendarUsing());
      const list = (methodResult(response, "0", "CalendarEvent/get").list || []) as Record<string, unknown>[];
      if (withOverrides) {
        const overrides = new Map<unknown, unknown>();
        for (const entry of (methodResult(response, "1", "CalendarEvent/get").list || []) as Record<string, unknown>[]) {
          if ('recurrenceOverrides' in entry) overrides.set(entry.id, entry.recurrenceOverrides);
        }
        for (const object of list) {
          if (overrides.has(object.id)) object.recurrenceOverrides = overrides.get(object.id);
        }
      }
      objects.push(...list);
    }
    return objects;
  }

  // Shared accounts the server rejected calendar access for - probed once,
  // then skipped for the rest of the session (see getCalendarCapableAccountIds
  // for why the fan-out has to probe on suspicion).
  private calendarAccessDenied = new Set<string>();

  /**
   * Whether `error` from a calendar call to the shared account `accountId`
   * means it grants no calendar access; if so, it is remembered and skipped
   * from now on. Any failure of the user's own calendars is the caller's.
   */
  private deniesCalendarAccess(accountId: string, error: unknown): boolean {
    if (accountId === this.getCalendarsAccountId()) return false;
    if (!isCalendarAccessDenial(jmapErrorType(error), error instanceof Error ? error.message : undefined)) return false;
    this.calendarAccessDenied.add(accountId);
    debug.log('calendar', `No calendar access to account ${accountId} - skipping it from now on`);
    return true;
  }

  // Result of the one-off synthetic-id capability probe, shared by every
  // range query on this client (see supportsSyntheticCalendarIds).
  private syntheticCalendarIdSupport: Promise<boolean> | null = null;

  /**
   * Whether CalendarEvent/set accepts the synthetic ids that
   * CalendarEvent/query?expandRecurrences=true hands out (Stalwart >= 0.16.20).
   *
   * Probed once per client with a side-effect-free update of a synthetic id
   * whose event cannot exist (see SYNTHETIC_ID_PROBE): a server that still
   * rejects synthetic ids answers `invalidProperties` before looking the
   * event up, one that supports them answers `notFound`. Anything else
   * (transport error, non-Stalwart server) counts as unsupported so the
   * client-side expansion keeps being used. The session's first Calendar/get
   * carries the probe along (getCalendars), so the usual calendar start-up
   * pays no extra round trip; a range query that comes first probes itself.
   */
  async supportsSyntheticCalendarIds(): Promise<boolean> {
    if (!this.syntheticCalendarIdSupport) {
      const accountId = this.getCalendarsAccountId();
      this.rememberSyntheticIdProbe(
        this.request([this.syntheticIdProbeCall(accountId)], this.calendarUsing()),
      );
    }
    return this.syntheticCalendarIdSupport!;
  }

  private static readonly SYNTHETIC_ID_PROBE_CALL_ID = 'synthetic-id-probe';

  private syntheticIdProbeCall(accountId: string): JMAPMethodCall {
    return ["CalendarEvent/set", { accountId, update: { [SYNTHETIC_ID_PROBE]: {} } }, JMAPClient.SYNTHETIC_ID_PROBE_CALL_ID];
  }

  /** Derive (and cache) the probe verdict from a response that carried the probe call. */
  private rememberSyntheticIdProbe(pending: Promise<JMAPResponse>): void {
    this.syntheticCalendarIdSupport = pending.then(
      (response) => {
        const entry = response.methodResponses?.find((r) => r[2] === JMAPClient.SYNTHETIC_ID_PROBE_CALL_ID);
        if (!entry || entry[0] !== "CalendarEvent/set") return false;
        const failure = (entry[1] as { notUpdated?: Record<string, { type?: string }> } | undefined)?.notUpdated?.[SYNTHETIC_ID_PROBE];
        const supported = failure?.type === 'notFound';
        debug.log('calendar', 'Synthetic calendar id probe', { supported, failure: failure ?? null });
        return supported;
      },
      (error) => {
        debug.log('calendar', 'Synthetic calendar id probe failed; using client-side recurrence expansion', error);
        return false;
      },
    );
  }

  // Time zones checked with the server (see calendarTimeZone): the probe of
  // each zone, settled or in flight, and the zones the server refused.
  private timeZoneProbes = new Map<string, Promise<void>>();
  private refusedTimeZones = new Set<string>();

  private static readonly TIME_ZONE_PROBE_CALL_ID = 'time-zone-probe';

  /** A get of no events, which the server only answers if it knows `timeZone`. */
  private timeZoneProbeCall(accountId: string, timeZone: string): JMAPMethodCall {
    return ["CalendarEvent/get", { accountId, ids: [], properties: ["id"], timeZone }, JMAPClient.TIME_ZONE_PROBE_CALL_ID];
  }

  /** Derive the verdict on `timeZone` from a response that carried its probe. */
  private rememberTimeZoneProbe(timeZone: string, pending: Promise<JMAPResponse>): void {
    this.timeZoneProbes.set(timeZone, pending.then(
      (response) => {
        const entry = response.methodResponses?.find((r) => r[2] === JMAPClient.TIME_ZONE_PROBE_CALL_ID);
        if (entry?.[0] === 'error' && isTimeZoneRefusal(entry[1]?.type, entry[1]?.description)) {
          this.refuseTimeZone(timeZone);
        }
      },
      // No verdict: the zone goes out, and a refusal is still caught
      // (withCalendarTimeZone).
      () => undefined,
    ));
  }

  private refuseTimeZone(timeZone: string): void {
    if (this.refusedTimeZones.has(timeZone)) return;
    this.refusedTimeZones.add(timeZone);
    console.warn(
      `Calendar: the server does not know the time zone "${timeZone}"; asking it for UTC times instead. `
      + 'Events without a time zone of their own may show shifted.',
    );
  }

  /**
   * The `timeZone` argument for CalendarEvent/get and /query: the user's zone
   * (getUserTimeZone), or UTC once the server refused it. Stalwart 1.0 fails
   * every calendar get and query that names a zone its time zone database
   * lacks; 0.16 reads such a zone as UTC. The session's first calendar list
   * checks the zone on the way (requestCalendars); a read that starts before
   * that answer, or without one, sends the user's zone and is repeated with
   * UTC if refused (withCalendarTimeZone).
   */
  private async calendarTimeZone(): Promise<string | undefined> {
    const timeZone = getUserTimeZone();
    if (!timeZone) return undefined;
    await this.timeZoneProbes.get(timeZone);
    return this.refusedTimeZones.has(timeZone) ? 'UTC' : timeZone;
  }

  /**
   * Run a calendar read with calendarTimeZone, and once more with UTC when
   * the server refuses that zone.
   */
  private async withCalendarTimeZone<T>(read: (timeZone: string | undefined) => Promise<T>): Promise<T> {
    const timeZone = await this.calendarTimeZone();
    try {
      return await read(timeZone);
    } catch (error) {
      if (!timeZone || timeZone === 'UTC' || !isTimeZoneRefusalError(error)) throw error;
      this.refuseTimeZone(timeZone);
      return read('UTC');
    }
  }

  async queryAllCalendarEvents(
    filter: CalendarEventFilter,
    sort?: Array<{ property: string; isAscending: boolean }>,
    limit?: number,
    options?: CalendarQueryOptions,
  ): Promise<CalendarEvent[]> {
    const allEvents: CalendarEvent[] = [];
    const primaryId = this.getCalendarsAccountId();
    const accountIds = this.getCalendarCapableAccountIds();

    for (const accountId of accountIds) {
      const isPrimary = accountId === primaryId;
      if (!isPrimary && this.calendarAccessDenied.has(accountId)) continue;
      const account = this.accounts[accountId];
      throwIfAborted(options?.signal);

      let events: CalendarEvent[];
      try {
        events = await this.queryCalendarEvents(filter, sort, limit, accountId, options);
      } catch (error) {
        // The user's own calendars failing fails the whole range - an empty
        // answer would read as "no events". A shared account that fails is
        // left out of the result.
        if (isPrimary || isAbortError(error)) throw error;
        console.error(`Failed to query calendar events for account ${accountId}:`, error);
        continue;
      }
      allEvents.push(...events.map((event) => ({
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
      })));
    }

    return allEvents;
  }

  async queryCalendarEvents(
    filter: CalendarEventFilter,
    sort?: Array<{ property: string; isAscending: boolean }>,
    limit?: number,
    targetAccountId?: string,
    options?: CalendarQueryOptions,
  ): Promise<CalendarEvent[]> {
    const accountId = targetAccountId || this.getCalendarsAccountId();
    try {
      return await this.withCalendarTimeZone((timeZone) =>
        this.queryCalendarEventsIn(accountId, filter, sort, limit, timeZone, options?.signal));
    } catch (error) {
      // The fan-out over shared accounts probes on suspicion (see
      // getCalendarCapableAccountIds) and may hit accounts that grant no
      // calendar access at all. Remember the rejection and go quiet instead
      // of re-probing - and re-logging - on every range change. Anything
      // else, and any failure of the user's own calendars, is the caller's.
      if (targetAccountId && this.deniesCalendarAccess(accountId, error)) return [];
      throw error;
    }
  }

  /** queryCalendarEvents with `timeZone` as the request's time zone. */
  private async queryCalendarEventsIn(
    accountId: string,
    filter: CalendarEventFilter,
    sort: Array<{ property: string; isAscending: boolean }> | undefined,
    limit: number | undefined,
    timeZone: string | undefined,
    signal?: AbortSignal,
  ): Promise<CalendarEvent[]> {
    // Stalwart reads the LocalDateTime after/before filter values in the
    // request's time zone (UTC without one, shifting range boundaries), and
    // drops a `Z` or offset rather than honouring it: UTC bounds become that
    // wall clock. A bound without offset is the user's wall clock (the
    // grid's display dates); it moves along when the server refused the
    // user's zone and the request is in UTC.
    const userTimeZone = getUserTimeZone();
    const bound = (value: string) => toLocalDateTime(
      userTimeZone && timeZone ? moveLocalDateTime(value, userTimeZone, timeZone) : value,
      timeZone,
    );
    const range = rangeOf(filter);
    const after = range.after ? bound(range.after) : undefined;
    const before = range.before ? bound(range.before) : undefined;
    const queryArgs: Record<string, unknown> = { accountId, filter: range.withBounds(after, before) };
    if (timeZone) {
      queryArgs.timeZone = timeZone;
    }
    // Let the server expand recurring series into one synthetic id per
    // occurrence when it also accepts those ids in CalendarEvent/set
    // (Stalwart >= 0.16.20; the server needs both range bounds for it).
    // Older servers keep the client-side expansion in
    // lib/recurrence-expansion.ts, which runs on whatever comes back.
    let expandRecurrences = Boolean(after && before)
      && await this.supportsSyntheticCalendarIds();
    if (sort) {
      queryArgs.sort = sort;
    }

    let ids: string[] | null = null;
    if (expandRecurrences) {
      ids = await this.queryExpandedCalendarEventIds(accountId, queryArgs, { ...range, after, before }, limit, signal);
      if (!ids) {
        // The server will not expand this range within its limits. Ask
        // for the series instead; lib/recurrence-expansion.ts expands
        // them on the client.
        debug.log('calendar', 'Range expands past the server limits; expanding on the client instead');
        expandRecurrences = false;
      }
    }
    ids ??= await this.queryCalendarEventIds(queryArgs, limit);
    if (ids.length === 0) return [];
    throwIfAborted(signal);

    // Only series the client expands itself need their overrides here; a
    // server-expanded occurrence gets them from its base event below.
    const allEvents = await this.fetchCalendarEventsById(accountId, ids, CALENDAR_EVENT_PROPERTIES, {
      withOverrides: !expandRecurrences,
      timeZone,
    });
    const normalized = (allEvents as unknown as CalendarEvent[])
      .filter((event) => !isTaskObject(event))
      .map((event) => normalizeCalendarEventLike(event));
    const filtered = expandRecurrences
      ? await this.hydrateExpandedOccurrences(normalized, accountId, timeZone)
      : normalized;

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
  }

  /**
   * The ids a CalendarEvent/query matches. Without `limit` it pages through
   * the whole result: a busy calendar (or a long expanded range) holds more
   * than one page.
   */
  private async queryCalendarEventIds(queryArgs: Record<string, unknown>, limit?: number): Promise<string[]> {
    const pageSize = limit || 1000;
    const maxIds = limit || 20000;
    const ids: string[] = [];
    for (let position = 0; ids.length < maxIds;) {
      const response = await this.request([
        ["CalendarEvent/query", { ...queryArgs, limit: pageSize, position }, "0"],
      ], this.calendarUsing());
      const page: string[] = methodResult(response, "0", "CalendarEvent/query").ids || [];
      ids.push(...page);
      if (limit || page.length < pageSize) break;
      position += page.length;
    }
    return ids;
  }
  /**
   * The longest range an expanded CalendarEvent/query may span, in seconds:
   * `maxExpandedQueryDuration` from the account's calendars capability (the
   * primary calendar account's when the account has none), an iCalendar
   * duration such as "P365D". Every 0.16 advertises 365 days without
   * enforcing it; 1.0 refuses a longer range with `expandDurationTooLarge`.
   */
  private getMaxExpandedQuerySeconds(accountId: string): number | null {
    for (const id of [accountId, this.getCalendarsAccountId()]) {
      const capability = this.getAccountCapability("urn:ietf:params:jmap:calendars", id) as
        { maxExpandedQueryDuration?: unknown } | undefined;
      const duration = capability?.maxExpandedQueryDuration;
      const seconds = typeof duration === 'string' ? parseDurationSeconds(duration) : null;
      if (seconds) return seconds;
    }
    return null;
  }

  /**
   * The occurrence ids of an expanded range query, or null when the server
   * will not expand the range and the client has to.
   *
   * The range is cut into chunks within the server's maxExpandedQueryDuration
   * and the chunk queries go out together, as many per request as
   * maxCallsInRequest allows. A synthetic id does not depend on the range it
   * was found in, so an occurrence two chunks share is kept once. A chunk the
   * server still refuses is halved: when it is too long
   * (`expandDurationTooLarge`), or when it expands to too many occurrences,
   * down to about a week. Past that the whole range is given up - mixing
   * server- and client-expanded occurrences would show series twice.
   *
   * With a limit the chunks are read in the sort order (by start), a few
   * per request, until the limit is reached.
   */
  private async queryExpandedCalendarEventIds(
    accountId: string,
    queryArgs: Record<string, unknown>,
    range: QueryRange,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<string[] | null> {
    const expandedArgs = { ...queryArgs, expandRecurrences: true };
    const start = wallClockSeconds(range.after);
    const end = wallClockSeconds(range.before);
    if (start === null || end === null || end <= start) {
      try {
        return await this.queryCalendarEventIds(expandedArgs, limit);
      } catch (error) {
        if (jmapErrorType(error) === 'expandDurationTooLarge' || isOccurrenceLimitError(error)) return null;
        throw error;
      }
    }

    const maxSeconds = this.getMaxExpandedQuerySeconds(accountId);
    const span = maxSeconds === null
      ? end - start
      : maxSeconds - Math.min(EXPANDED_CHUNK_SLACK, Math.floor(maxSeconds / 2));
    const chunks = chunkRange(start, end, span);
    if (!chunks) return null;
    const [firstSort] = (queryArgs.sort as Array<{ property?: string; isAscending?: boolean }> | undefined) ?? [];
    const latestFirst = firstSort?.property === 'start' && firstSort.isAscending === false;
    if (latestFirst) chunks.reverse();

    const pageSize = limit || 1000;
    const maxIds = limit || 20000;
    const ids = new Set<string>();
    let pending = chunks;
    // Pages are bounded by maxIds; splitting is what has to stop somewhere.
    const chunksSent = new Set<RangeChunk>();
    while (pending.length > 0 && ids.size < maxIds) {
      throwIfAborted(signal);
      const batch = pending.splice(0, limit
        ? Math.min(LIMITED_CHUNKS_PER_REQUEST, this.getMaxCallsInRequest())
        : this.getMaxCallsInRequest());
      for (const chunk of batch) if (chunk.position === 0) chunksSent.add(chunk);
      if (chunksSent.size > MAX_EXPANDED_CHUNKS) return null;
      const size = limit ? limit - ids.size : pageSize;
      const response = await this.request(batch.map((chunk, i): JMAPMethodCall => ["CalendarEvent/query", {
        ...expandedArgs,
        filter: range.withBounds(localDateTimeOf(chunk.start), localDateTimeOf(chunk.end)),
        position: chunk.position,
        limit: size,
      }, String(i)]), this.calendarUsing());

      // The halves of a refused chunk, and the next page of a full one, go
      // to the front of the queue. With a limit, a chunk that needs another
      // query comes before the rest of its batch in the sort order: what the
      // later chunks returned is dropped and asked for again after it.
      const again: RangeChunk[] = [];
      for (const [i, chunk] of batch.entries()) {
        let page: string[];
        try {
          page = methodResult(response, String(i), "CalendarEvent/query").ids || [];
        } catch (error) {
          const halves = splitRefusedChunk(chunk, error);
          if (!halves) return null;
          again.push(...(latestFirst ? halves.reverse() : halves));
          if (limit) {
            again.push(...batch.slice(i + 1));
            break;
          }
          continue;
        }
        for (const id of page) {
          if (ids.size >= maxIds) break;
          ids.add(id);
        }
        if (ids.size >= maxIds) break;
        if (page.length === size) {
          again.push({ ...chunk, position: chunk.position + page.length });
          if (limit) {
            again.push(...batch.slice(i + 1));
            break;
          }
        }
      }
      pending = [...again, ...pending];
    }
    return [...ids];
  }

  /**
   * Server-expanded occurrences come back without their series' recurrence
   * rule / overrides (and all-day ones without showWithoutTime). Fetch those
   * from the base events in one batched get and merge them in, so an
   * occurrence carries the same series context the client-side expansion
   * used to copy from its master.
   */
  private async hydrateExpandedOccurrences(
    events: CalendarEvent[],
    accountId: string,
    timeZone?: string,
  ): Promise<CalendarEvent[]> {
    const baseIds = Array.from(new Set(
      events
        .filter((event) => isServerRecurrenceInstance(event) && event.recurrenceId)
        .map((event) => event.baseEventId as string),
    ));
    if (baseIds.length === 0) return events;

    const bases = new Map<string, Partial<CalendarEvent>>();
    for (const base of await this.fetchCalendarEventsById(accountId, baseIds, RECURRENCE_BASE_PROPERTIES, { timeZone })) {
      if (typeof base.id === 'string') bases.set(base.id, normalizeCalendarEventLike(base as Partial<CalendarEvent>));
    }
    return hydrateRecurrenceInstances(events, bases);
  }

  /** One event with its recurrence overrides, or null when the server has no such id. */
  async getCalendarEvent(id: string, targetAccountId?: string): Promise<CalendarEvent | null> {
    const accountId = targetAccountId || this.getCalendarsAccountId();
    const [event] = await this.withCalendarTimeZone((timeZone) =>
      this.fetchCalendarEventsById(accountId, [id], CALENDAR_EVENT_PROPERTIES, { withOverrides: true, timeZone }));
    return event ? normalizeCalendarEventLike(event as unknown as CalendarEvent) : null;
  }

  async createCalendarEvent(event: Partial<CalendarEvent>, sendSchedulingMessages?: boolean, targetAccountId?: string): Promise<CalendarEvent> {
    const accountId = targetAccountId || this.getCalendarsAccountId();

    // Strip client-only shared fields before sending to JMAP
    const { originalId: _oi, baseEventId: _be, originalCalendarIds: _oc, accountId: _ai, accountName: _an, isShared: _is, ...cleanEvent } = event as CalendarEvent;
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
        if (sendSchedulingMessages && error.type === 'forbidden') {
          throw new SchedulingDeniedError(error.description || 'forbidden');
        }
        throw jmapSetError(error.description || "Failed to create calendar event", error);
      }

      const createdId = result.created?.["new-event"]?.id;
      debug.log('calendar', 'CalendarEvent/create server acknowledged created id', {
        createdId,
        created: result.created?.['new-event'] || null,
      });

      if (createdId) {
        // The event exists from here on, and its invitations are on their
        // way: a failed read-back must not report a failed create, or a
        // retry creates the event twice. Fall back to what was sent.
        let created: CalendarEvent | null = null;
        try {
          created = await this.getCalendarEvent(createdId, targetAccountId);
        } catch (refetchError) {
          debug.warn('calendar', 'CalendarEvent/create could not read the created event back', refetchError);
        }
        if (!created) {
          debug.warn('calendar', 'CalendarEvent/create returns the sent event for the created id', { createdId, targetAccountId });
          created = normalizeCalendarEventLike({ ...cleanEvent, ...result.created["new-event"], id: createdId } as CalendarEvent);
        }
        debug.log('calendar', 'CalendarEvent/create fetched created event', {
          ...getCalendarEventDebugSnapshot(created),
          hasParticipants: !!created.participants,
          participantCount: created.participants ? Object.keys(created.participants).length : 0,
          participants: created.participants || null,
          replyTo: created.replyTo || null,
        });
        debug.groupEnd();
        return created;
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
  ): Promise<{ created: CalendarEvent[]; failed: string[]; notCreated: Record<string, CalendarSetError> }> {
    if (events.length === 0) return { created: [], failed: [], notCreated: {} };

    const accountId = targetAccountId || this.getCalendarsAccountId();

    debug.log('calendar', 'CalendarEvent/batchCreate', { count: events.length, accountId });

    const createdIds: string[] = [];
    const sentById = new Map<string, Record<string, unknown>>();
    const failed: string[] = [];
    const notCreated: Record<string, CalendarSetError> = {};
    const indexed = events.map((event, index) => ({ event, index }));

    for (const batch of batched(indexed, this.getMaxObjectsInSet())) {
      // Build the create map: { "new-0": event0, "new-1": event1, ... }
      const createMap: Record<string, Partial<CalendarEvent>> = {};
      for (const { event, index } of batch) {
        const { originalId: _oi, originalCalendarIds: _oc, accountId: _ai, accountName: _an, isShared: _is, ...clean } = event as CalendarEvent;
        cleanRecurrenceRules(clean as unknown as Record<string, unknown>);
        createMap[`new-${index}`] = clean;
      }

      // Never emit iMIP scheduling messages when importing. Imported events often
      // carry an organizer/participants where the current user is the organizer;
      // without this, Stalwart tries to send invitation emails to every attendee
      // synchronously during CalendarEvent/set, which is both wrong (importing a
      // calendar should not spam invites) and can block the request indefinitely,
      // leaving the import spinner spinning forever (#411).
      const response = await this.request([
        ["CalendarEvent/set", { accountId, sendSchedulingMessages: false, create: createMap }, "0"]
      ], this.calendarUsing());

      // A method-level error (unknown calendar, missing capability, …) is
      // not a per-event failure: nothing was created, say so. (#434)
      this.throwOnCalendarSetError(response, 'create calendar events');

      if (response.methodResponses?.[0]?.[0] === "CalendarEvent/set") {
        const result = response.methodResponses[0][1];
        for (const { index } of batch) {
          const key = `new-${index}`;
          if (result.created?.[key]?.id) {
            createdIds.push(result.created[key].id);
            sentById.set(result.created[key].id, { ...createMap[key], ...result.created[key] });
          } else if (result.notCreated?.[key]) {
            debug.warn('calendar', `CalendarEvent/batchCreate failed for ${key}`, result.notCreated[key]);
            failed.push(key);
            notCreated[key] = result.notCreated[key];
          }
        }
      }
    }

    if (createdIds.length === 0) {
      return { created: [], failed, notCreated };
    }

    // Read the created events back for their server-assigned properties.
    // They exist whatever the read-back says, so what was sent stands in for
    // any event it does not return.
    let fetched: Record<string, unknown>[] = [];
    try {
      fetched = await this.withCalendarTimeZone((timeZone) =>
        this.fetchCalendarEventsById(accountId, createdIds, CALENDAR_EVENT_PROPERTIES, { timeZone }));
    } catch (error) {
      debug.warn('calendar', 'CalendarEvent/batchCreate could not read the created events back', error);
    }
    const fetchedById = new Map(fetched.map((event) => [event.id, event]));
    const createdEvents = createdIds.map((id) =>
      normalizeCalendarEventLike((fetchedById.get(id) ?? sentById.get(id)) as unknown as CalendarEvent));

    debug.log('calendar', 'CalendarEvent/batchCreate result', {
      requested: events.length,
      created: createdEvents.length,
      failed: failed.length,
    });

    return { created: createdEvents, failed, notCreated };
  }

  async updateCalendarEvent(
    eventId: string,
    updates: Partial<CalendarEvent>,
    sendSchedulingMessages?: boolean,
    targetAccountId?: string,
    options?: CalendarEventUpdateOptions,
  ): Promise<void> {
    const accountId = targetAccountId || this.getCalendarsAccountId();

    // Strip client-only and server-immutable fields before sending to JMAP
    const { id: _id, uid: _uid, '@type': _typ, created: _cr, updated: _up, sequence: _sq, isOrigin: _io, isDraft: _idr, originalId: _oi, baseEventId: _be, originalCalendarIds: _oc, accountId: _ai, accountName: _an, isShared: _is, progressUpdated: _pu, ...cleanUpdates } = updates as CalendarEvent & { progressUpdated?: string | null };
    if (options?.keepSequence && _sq != null) (cleanUpdates as Partial<CalendarEvent>).sequence = _sq;
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
      throw jmapError(`JMAP error (${errorType}): ${errorDesc}`, result);
    }

    if (methodName === "CalendarEvent/set") {
      if (result.notUpdated?.[eventId]) {
        const error = result.notUpdated[eventId];
        debug.error('CalendarEvent/set notUpdated', { eventId, error });
        if (sendSchedulingMessages && error.type === 'forbidden') {
          throw new SchedulingDeniedError(error.description || 'forbidden');
        }
        // Keep the SetError type: the store retries some refusals
        // differently (isOverrideSeriesKeyRejection).
        throw jmapSetError(error.description || "Failed to update calendar event", error);
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
      debug.log('calendar', '[CalendarEvent/parse] raw result:', result);

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

  /**
   * Reject a CalendarEvent/set response that came back as a method-level
   * error. Without this the callers counted the (empty) results and
   * reported "0 events cleared" with no error at all. (#434)
   */
  private throwOnCalendarSetError(response: JMAPResponse, action: string): void {
    const [name, result] = response.methodResponses?.[0] ?? [];
    if (name === "error") {
      throw new Error(`Failed to ${action}: ${result?.description || result?.type || 'unknown error'}`);
    }
  }

  /**
   * Destroy events in batches. Per-id failures come back in `notDestroyed`
   * (with the server's type/description) so the caller can report them;
   * a method-level error, or a batch in which nothing at all could be
   * destroyed, rejects with the first description. (#434)
   */
  async batchDeleteCalendarEvents(eventIds: string[], targetAccountId?: string): Promise<{ destroyed: string[]; notDestroyed: Record<string, CalendarSetError> }> {
    if (eventIds.length === 0) return { destroyed: [], notDestroyed: {} };

    const accountId = targetAccountId || this.getCalendarsAccountId();
    const destroyed: string[] = [];
    const notDestroyed: Record<string, CalendarSetError> = {};

    for (const batch of batched(eventIds, this.getMaxObjectsInSet())) {
      const response = await this.request([
        ["CalendarEvent/set", { accountId, destroy: batch }, "0"]
      ], this.calendarUsing());

      this.throwOnCalendarSetError(response, 'delete calendar events');

      let destroyedInBatch = 0;
      if (response.methodResponses?.[0]?.[0] === "CalendarEvent/set") {
        const result = response.methodResponses[0][1];
        if (result.destroyed) {
          destroyed.push(...result.destroyed);
          destroyedInBatch = result.destroyed.length;
        }
        if (result.notDestroyed) Object.assign(notDestroyed, result.notDestroyed);
      }
      if (destroyedInBatch === 0 && batch.length > 0) {
        const first = Object.values(notDestroyed)[0];
        throw new Error(
          `Failed to delete calendar events: ${first?.description || first?.type || 'server refused the request'}`,
        );
      }
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
  // Store ids for shared calendars and their events and tasks are namespaced
  // `accountId:id`; bare ids belong to the primary calendars account. JMAP ids
  // never contain ':'.
  private splitCalendarObjectId(id: string): { accountId: string; id: string } {
    const sep = id.indexOf(':');
    if (sep < 0) return { accountId: this.getCalendarsAccountId(), id };
    return { accountId: id.slice(0, sep), id: id.slice(sep + 1) };
  }

  private namespaceCalendarTask(task: CalendarTask, accountId: string): CalendarTask {
    if (accountId === this.getCalendarsAccountId()) return task;
    return {
      ...task,
      id: `${accountId}:${task.id}`,
      calendarIds: Object.fromEntries(
        Object.entries(task.calendarIds || {}).map(([calId, v]) => [`${accountId}:${calId}`, v])
      ),
      originalId: task.id,
      accountId,
      isShared: true,
    };
  }

  // Maps the (possibly namespaced) calendarIds of a task to the account that
  // owns those calendars and their real ids there.
  private resolveTaskCalendarIds(calendarIds: Record<string, boolean>): { accountId: string; calendarIds: Record<string, boolean> } {
    let accountId: string | undefined;
    const real: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(calendarIds)) {
      const parts = this.splitCalendarObjectId(key);
      if (accountId && parts.accountId !== accountId) {
        throw new Error("A task can only belong to calendars of one account");
      }
      accountId = parts.accountId;
      real[parts.id] = value;
    }
    return { accountId: accountId ?? this.getCalendarsAccountId(), calendarIds: real };
  }

  /**
   * Without `targetAccountId`, collects tasks from every calendar account, not
   * just the primary one, so tasks in calendars shared with the user show up
   * too. Shared tasks come back namespaced like shared events. (#1204)
   */
  async getCalendarTasks(calendarIds?: string[], targetAccountId?: string): Promise<CalendarTask[]> {
    if (targetAccountId) return this.getAccountCalendarTasks(calendarIds, targetAccountId);

    const primaryId = this.getCalendarsAccountId();
    const tasks: CalendarTask[] = [];
    for (const accountId of this.getCalendarCapableAccountIds()) {
      if (accountId !== primaryId && this.calendarAccessDenied.has(accountId)) continue;
      let accountCalendarIds: string[] | undefined;
      if (calendarIds && calendarIds.length > 0) {
        accountCalendarIds = calendarIds
          .map((id) => this.splitCalendarObjectId(id))
          .filter((parts) => parts.accountId === accountId)
          .map((parts) => parts.id);
        if (accountCalendarIds.length === 0) continue;
      }
      const accountTasks = await this.getAccountCalendarTasks(accountCalendarIds, accountId);
      tasks.push(...accountTasks.map((task) => this.namespaceCalendarTask(task, accountId)));
    }
    return tasks;
  }

  private async getAccountCalendarTasks(calendarIds: string[] | undefined, accountId: string): Promise<CalendarTask[]> {
    debug.group('CalendarTask/fetch', 'tasks');
    debug.log('tasks', 'CalendarTask/fetch start', { accountId, calendarIds: calendarIds || 'all' });

    try {
      const allObjects = await this.withCalendarTimeZone((timeZone) => this.fetchTaskObjects(accountId, calendarIds, timeZone));

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

        tasks.push(normalizeCalendarTask({ ...obj, '@type': 'Task' as const } as CalendarTask));
      }

      debug.log('tasks', 'CalendarTask/fetch complete,', tasks.length, 'tasks of', allObjects.length, 'objects');
      debug.groupEnd();
      return tasks;
    } catch (error) {
      // A shared account probed on suspicion (see queryCalendarEvents) that
      // grants no calendar access has no tasks. Any other refused query or
      // get is a failure, not an empty task list: the task store keeps
      // showing what it has.
      const denied = this.deniesCalendarAccess(accountId, error);
      if (!denied) debug.error('CalendarTask/fetch failed', error);
      debug.groupEnd();
      if (denied) return [];
      throw error;
    }
  }

  /**
   * Every object of the account (or of `calendarIds`) with the task
   * properties. Stalwart has no filter for tasks, so events come too.
   */
  private async fetchTaskObjects(
    accountId: string,
    calendarIds: string[] | undefined,
    timeZone: string | undefined,
  ): Promise<Record<string, unknown>[]> {
    // Page through the query to collect all object ids.
    const QUERY_PAGE = 1000;
    const MAX_IDS = 50000; // safety bound
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
      const pageIds: string[] = methodResult(response, "0", "CalendarEvent/query").ids || [];
      ids.push(...pageIds);
      if (pageIds.length < QUERY_PAGE) break;
      position += pageIds.length;
    }

    debug.log('tasks', 'CalendarTask/fetch query returned', ids.length, 'object ids');
    if (ids.length === 0) {
      return [];
    }

    // Fetch the objects in batches that respect the server's /get limit.
    return this.fetchCalendarEventsById(accountId, ids, CALENDAR_TASK_PROPERTIES, { timeZone });
  }

  async createCalendarTask(task: Partial<CalendarTask>, targetAccountId?: string): Promise<CalendarTask> {
    let accountId = targetAccountId || this.getCalendarsAccountId();
    const { '@type': _type, progressUpdated: _pu, id: _id, originalId: _oi, accountId: _ai, isShared: _is, ...taskData } = task as Partial<CalendarTask> & { progressUpdated?: string | null };
    if (!targetAccountId && taskData.calendarIds && Object.keys(taskData.calendarIds).length > 0) {
      // A task created in a shared calendar has to be created in the account
      // that owns the calendar. (#1204)
      const resolved = this.resolveTaskCalendarIds(taskData.calendarIds);
      accountId = resolved.accountId;
      taskData.calendarIds = resolved.calendarIds;
    }
    const cleanTask = { ...completeBareTaskDates(taskData), '@type': 'Task' };

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

    let result: JMAPResponseResult;
    try {
      // A method-level error (unknown calendar, missing capability) means
      // nothing was created.
      result = methodResult(response, "0", "CalendarEvent/set");
    } catch (error) {
      debug.groupEnd();
      throw error;
    }
    debug.log('tasks', 'CalendarTask/create raw set response', result);

    if (result.notCreated?.["new-task"]) {
      const error = result.notCreated["new-task"];
      debug.warn('tasks', 'CalendarTask/create REJECTED by server', error);
      debug.groupEnd();
      throw jmapSetError(error.description || "Failed to create task", error);
    }

    const createdId = result.created?.["new-task"]?.id;
    const serverCreated = result.created?.["new-task"];
    debug.log('tasks', 'CalendarTask/create server acknowledged', { createdId, serverCreated });

    if (!createdId) {
      debug.warn('tasks', 'CalendarTask/create no id in server response');
      debug.groupEnd();
      throw new Error("Failed to create task - no id returned");
    }

    // Read the task back with the task properties. It exists whatever the
    // read-back says: fall back to what was sent rather than report a failed
    // create, which a retry would duplicate.
    debug.log('calendar', 'CalendarTask/create re-fetching with task properties', { createdId, properties: [...CALENDAR_TASK_PROPERTIES] });
    let fetched: Record<string, unknown> | undefined;
    try {
      [fetched] = await this.withCalendarTimeZone((timeZone) =>
        this.fetchCalendarEventsById(accountId, [createdId], CALENDAR_TASK_PROPERTIES, { timeZone }));
    } catch (error) {
      debug.warn('tasks', 'CalendarTask/create could not read the created task back', error);
    }
    if (!fetched) debug.warn('tasks', 'CalendarTask/create returns the sent task for id', createdId);
    const created = this.namespaceCalendarTask(normalizeCalendarTask({
      ...(fetched ?? { ...cleanTask, ...serverCreated, id: createdId }),
      '@type': 'Task' as const,
    } as CalendarTask), accountId);
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

  /**
   * Updates a task and resolves to its id afterwards. Moving a task into a
   * calendar of another account (a shared calendar) recreates it there, so
   * the id changes. (#1204)
   */
  async updateCalendarTask(taskId: string, updates: Partial<CalendarTask>, targetAccountId?: string): Promise<string> {
    const source = targetAccountId ? { accountId: targetAccountId, id: taskId } : this.splitCalendarObjectId(taskId);
    let patch = completeBareTaskDates(updates);
    if (!targetAccountId && patch.calendarIds) {
      const dest = this.resolveTaskCalendarIds(patch.calendarIds);
      patch = { ...patch, calendarIds: dest.calendarIds };
      if (dest.accountId !== source.accountId) {
        return this.moveCalendarTaskToAccount(source, dest.accountId, patch);
      }
    }
    await this.updateCalendarEvent(source.id, patch as unknown as Partial<CalendarEvent>, false, source.accountId);
    return taskId;
  }

  // JMAP has no cross-account CalendarEvent move: create the task in the
  // destination account, then destroy the original. Creating first means a
  // failed create leaves the task where it was.
  private async moveCalendarTaskToAccount(
    source: { accountId: string; id: string },
    destAccountId: string,
    patch: Partial<CalendarTask>,
  ): Promise<string> {
    const response = await this.request([
      ["CalendarEvent/get", { accountId: source.accountId, ids: [source.id] }, "0"]
    ], this.calendarUsing());
    const [method, result] = response.methodResponses?.[0] ?? [];
    const original = method === "CalendarEvent/get" ? result.list?.[0] : undefined;
    if (!original) throw new Error("Task not found");

    // Drop what the server sets itself; keep the uid so it stays the same task.
    const { id: _id, created: _cr, updated: _up, sequence: _sq, isDraft: _idr, isOrigin: _io, baseEventId: _be, blobId: _bl, utcStart: _us, utcEnd: _ue, ...rest } = original as Record<string, unknown>;
    // The patch may name members by path ("alerts/<id>/acknowledged").
    const created = await this.createCalendarTask(applyPatchObject(rest, patch) as Partial<CalendarTask>, destAccountId);
    await this.deleteCalendarEvent(source.id, false, source.accountId);
    return created.id;
  }

  async deleteCalendarTask(taskId: string, targetAccountId?: string): Promise<void> {
    const target = targetAccountId ? { accountId: targetAccountId, id: taskId } : this.splitCalendarObjectId(taskId);
    await this.deleteCalendarEvent(target.id, false, target.accountId);
  }

  // ─── JMAP FileNode methods (draft-ietf-jmap-filenode) ───

  supportsFiles(accountId?: string): boolean {
    // Gate on the ACCOUNT capability, not the server-wide session capability.
    // A server can advertise urn:ietf:params:jmap:filenode while a specific
    // account has its jmap-file-node-* permissions revoked, in which case the
    // capability is absent from that account's accountCapabilities and every
    // FileNode action fails with an authorization error (#563).
    return this.accountSupports(accountId || this.accountId, "urn:ietf:params:jmap:filenode");
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
    // RFC 9670 places principals:owner in accountCapabilities rather than
    // the session capabilities, so this only fires on servers that also
    // advertise it in the session.
    if (this.hasCapability("urn:ietf:params:jmap:principals:owner")) {
      using.push("urn:ietf:params:jmap:principals:owner");
    }
    return using;
  }

  private static FILE_NODE_PROPERTIES = [
    "id", "parentId", "name", "type", "blobId", "size", "created", "modified",
    // Tells 1.0's symlinks from folders (see fileNodeKind).
    "nodeType",
    // `nodeType` and `type` as Stalwart 1.0.0 names them (see fromDraftFileNode).
    "@type", "mediaType",
    // Stalwart omits shareWith/myRights from FileNode/get unless requested
    // explicitly, so the share dialog and indicators can't see existing
    // shares without naming them here (same as CALENDAR_PROPERTIES).
    "shareWith", "myRights",
  ];

  // Accounts (primary + shared/group) that can hold FileNodes. Mirrors
  // getCalendarCapableAccountIds().
  private getFilesCapableAccountIds(): string[] {
    const primaryId = this.getFilesAccountId();
    const accountIds: string[] = [];
    for (const id of Object.keys(this.accounts)) {
      if (id === primaryId) continue;
      if (this.accountSupports(id, "urn:ietf:params:jmap:filenode")) {
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
    return ((result[1].list || []) as FileNode[]).map(fromWireFileNode);
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
    // FileNode/query omits folder nodes on older Stalwart (see listAllFileNodes),
    // so we enumerate the whole account and filter children client-side.
    const all = await this.listAllFileNodes();
    return all.filter(n => (n.parentId ?? null) === parentId);
  }

  /**
   * Fetch every FileNode in the account, files AND folders, to build the folder
   * hierarchy client-side from parentId links.
   *
   * IMPORTANT: this starts from `FileNode/get` with `ids: null` (return-all),
   * NOT `FileNode/query`. Before Stalwart 0.16.6, FileNode/query only returns
   * leaf files - it omits container (folder) nodes entirely - so a query-based
   * listing made every folder invisible (the whole account looked like a
   * single root file).
   */
  async listAllFileNodes(): Promise<FileNode[]> {
    const nodes = await this.fetchAllFileNodes(this.getFilesAccountId());
    return nodes.map(fromWireFileNode);
  }

  /**
   * Every raw FileNode of one account, past the server's /get ceiling.
   *
   * `FileNode/get { ids: null }` stops at maxObjectsInGet (500 by default) and
   * Stalwart gives no sign that the list was cut, so larger accounts silently
   * lost files (#1069). A full first page therefore counts as truncated: the
   * remaining ids come from paging FileNode/query and are fetched in /get-sized
   * batches. Stalwart before 0.16.6 leaves folders out of FileNode/query, so
   * parents that are still unknown afterwards are fetched by id.
   */
  private async fetchAllFileNodes(accountId: string): Promise<FileNode[]> {
    const using = this.fileUsing();
    const properties = JMAPClient.FILE_NODE_PROPERTIES;

    const response = await this.request(
      [["FileNode/get", { accountId, ids: null, properties }, "fng0"]],
      using,
    );

    const getResult = response.methodResponses?.find(r => r[0] === "FileNode/get" || (r[0] === "error" && r[2] === "fng0"));
    // Stalwart 1.0 refuses the return-all /get instead of cutting it short
    // (#1385); then every node comes from the query below.
    const tooMany = getResult?.[0] === "error" && getResult[1]?.type === "requestTooLarge";
    if (!getResult || (getResult[0] === "error" && !tooMany)) {
      console.error('[Files] FileNode/get error:', getResult?.[1]);
      throw new Error(getResult?.[1]?.description || "FileNode list failed");
    }
    const firstPage = tooMany ? [] : ((getResult[1].list || []) as FileNode[]).map(fromDraftFileNode);
    const maxObjects = this.getMaxObjectsInGet();
    if (!tooMany && firstPage.length < maxObjects) return firstPage;

    const known = new Map(firstPage.map(node => [node.id, node]));
    // Several /get calls share one request, so a large account costs a few
    // round trips rather than one per batch - the tree is re-read on every
    // navigation.
    const fetchByIds = async (ids: string[]) => {
      const calls = batched(ids, maxObjects).map((batch, i): JMAPMethodCall =>
        ["FileNode/get", { accountId, ids: batch, properties }, `fng${i + 1}`]);
      for (const group of batched(calls, this.getMaxCallsInRequest())) {
        const batchResponse = await this.request(group, using);
        for (const result of batchResponse.methodResponses || []) {
          if (result[0] !== "FileNode/get") {
            throw new Error(result[1]?.description || "FileNode/get failed");
          }
          for (const node of (result[1].list || []) as FileNode[]) known.set(node.id, fromDraftFileNode(node));
        }
      }
    };

    try {
      const missing = new Set<string>();
      for (let position = 0; position < FILE_NODE_MAX_IDS;) {
        const queryResponse = await this.request(
          [["FileNode/query", { accountId, filter: {}, position, limit: FILE_NODE_QUERY_PAGE, calculateTotal: true }, "fnq0"]],
          using,
        );
        const queryResult = queryResponse.methodResponses?.[0];
        if (!queryResult || queryResult[0] !== "FileNode/query") {
          throw new Error(queryResult?.[1]?.description || "FileNode/query failed");
        }
        // The server may clamp `limit`, so only an empty page or a reached
        // total ends the listing - never a page shorter than the one asked for.
        const pageIds = (queryResult[1].ids || []) as string[];
        if (pageIds.length === 0) break;
        for (const id of pageIds) {
          if (!known.has(id)) missing.add(id);
        }
        position += pageIds.length;
        const total = queryResult[1].total;
        if (typeof total === "number" && position >= total) break;
      }
      await fetchByIds([...missing]);

      const asked = new Set<string>();
      for (;;) {
        const parents = new Set<string>();
        for (const node of known.values()) {
          if (node.parentId && !known.has(node.parentId) && !asked.has(node.parentId)) parents.add(node.parentId);
        }
        if (parents.size === 0) break;
        for (const id of parents) asked.add(id);
        await fetchByIds([...parents]);
      }
    } catch (error) {
      // A partial tree beats none: keep what was read, as before #1069.
      // With nothing read there is no tree to show, so say why.
      if (known.size === 0) throw error;
      console.warn(`[Files] Listing for account ${accountId} is incomplete past ${maxObjects} nodes:`, error);
    }

    return [...known.values()];
  }

  /**
   * Fetch every FileNode the logged-in user can see across all connected and
   * shared accounts. Nodes owned by another principal (shared with the user)
   * are tagged with `isShared: true` and the owning `accountId`/`accountName`,
   * and their ids are namespaced `accountId:nodeId` so they don't collide with
   * the primary account's ids. Folders listed only as the way down to a shared
   * node are marked `discoverableOnly`. Mirrors getAllCalendars().
   */
  async listAllFileNodesAcrossAccounts(): Promise<FileNode[]> {
    const primaryId = this.getFilesAccountId();
    const accountIds = this.getFilesCapableAccountIds();
    const all: FileNode[] = [];

    for (const accountId of accountIds) {
      const isPrimary = accountId === primaryId;
      const account = this.accounts[accountId];
      try {
        const nodes = await this.fetchAllFileNodes(accountId);
        for (const node of nodes) {
          const wire = fromWireFileNode(node);
          all.push({
            ...wire,
            id: isPrimary ? node.id : `${accountId}:${node.id}`,
            parentId: node.parentId == null
              ? null
              : (isPrimary ? node.parentId : `${accountId}:${node.parentId}`),
            accountId,
            accountName: account?.name || (isPrimary ? this.username : accountId),
            isShared: !isPrimary,
            ...(!isPrimary && isDiscoverableOnly(wire) ? { discoverableOnly: true } : {}),
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
    const node = targetAccountId
      ? { accountId: targetAccountId, id: fileNodeId }
      : this.resolveFileNodeId(fileNodeId);
    const accountId = node.accountId;
    const rawId = node.id as string;
    const wireRights = rights && this.isLegacyFileNodeServer(accountId) ? toLegacyRights(rights) : rights;
    const response = await this.request([
      ["FileNode/set", {
        accountId,
        update: { [rawId]: { [`shareWith/${principalId}`]: wireRights } },
      }, "0"],
    ], this.fileUsing());

    const result = response.methodResponses?.[0]?.[1];
    if (result?.notUpdated?.[rawId]) {
      const err = result.notUpdated[rawId];
      throw new Error(err.description || "Failed to update file share");
    }
    if (!result?.updated || !(rawId in result.updated)) {
      throw new Error("Server did not confirm the share update");
    }
  }

  /**
   * The account and bare id behind a FileNode id. Nodes of shared drives are
   * listed as "<accountId>:<nodeId>" (listAllFileNodesAcrossAccounts; JMAP ids
   * never contain ':'), and a write must go to that account with the bare id.
   * `null` is the primary account's root.
   */
  private resolveFileNodeId(id: string | null): { accountId: string; id: string | null } {
    const primary = this.getFilesAccountId();
    if (id === null) return { accountId: primary, id: null };
    const sep = id.indexOf(':');
    if (sep > 0) {
      const accountId = id.slice(0, sep);
      if (accountId !== primary && this.getFilesCapableAccountIds().includes(accountId)) {
        return { accountId, id: id.slice(sep + 1) };
      }
    }
    return { accountId: primary, id };
  }

  private fileNodeCapability(accountId: string): Record<string, unknown> | undefined {
    return this.getAccountCapability("urn:ietf:params:jmap:filenode", accountId) as Record<string, unknown> | undefined;
  }

  /**
   * The filenode capability whose limits apply in `accountId`. Stalwart
   * publishes the same ones for every account, and a shared account may
   * come without any (see getFilesCapableAccountIds), so the user's own
   * files account stands in.
   */
  private fileNodeLimits(accountId?: string): Record<string, unknown> | undefined {
    const own = this.getFilesAccountId();
    return this.fileNodeCapability(accountId || own) ?? this.fileNodeCapability(own);
  }

  /**
   * Stalwart before 0.16.6 implements an older File Storage draft (old
   * rights names, 30-character MIME types, no naming rules). The draft update
   * added `forbiddenNameChars` to the capability, which tells them apart.
   */
  private isLegacyFileNodeServer(accountId: string): boolean {
    const cap = this.fileNodeCapability(accountId);
    return !!cap && !("forbiddenNameChars" in cap);
  }

  /**
   * Stalwart 1.0 implements File Storage draft 18, which wants `@type` and
   * `mediaType` in a create (see toDraftFileNodeCreate). Of the drafts
   * Stalwart has shipped, only that one lists `supportedNodeTypes`.
   */
  private usesDraftFileNodeCreate(accountId: string): boolean {
    const limits = this.fileNodeLimits(accountId);
    return !!limits && "supportedNodeTypes" in limits;
  }

  /** Naming rules for new FileNodes in `accountId`, if the server publishes any. */
  getFileNameRules(accountId?: string): FileNameRules | null {
    return fileNameRulesFrom(this.fileNodeLimits(accountId));
  }

  /**
   * How deep a node may sit (`maxFileNodeDepth`: 64 on Stalwart 1.0), or
   * null for no limit (0.16 advertises null).
   */
  getMaxFileNodeDepth(accountId?: string): number | null {
    const depth = this.fileNodeLimits(accountId)?.maxFileNodeDepth;
    return typeof depth === 'number' && depth > 0 ? depth : null;
  }

  /** The `type` to create a file node in `accountId` with. */
  private fileNodeType(accountId: string, type: string | null | undefined): string {
    // Stalwart 1.0 only takes a bare, valid media type; servers before
    // 0.16.6 refuse more than 30 characters (most OOXML types).
    const essence = mediaTypeEssence(type);
    return this.isLegacyFileNodeServer(accountId) && essence.length > 30 ? OCTET_STREAM : essence;
  }

  /** Namespace a node created in `accountId` the way the listings do. */
  private namespaceFileNode(node: FileNode, accountId: string): FileNode {
    if (accountId === this.getFilesAccountId()) return node;
    return {
      ...node,
      id: `${accountId}:${node.id}`,
      parentId: node.parentId == null ? null : `${accountId}:${node.parentId}`,
    };
  }

  /**
   * Resolve a parent for a node that lives in `accountId`. Folders only hold
   * nodes of their own account, so a parent in another account is refused
   * instead of being sent (the server would read it as a local id).
   */
  private parentInAccount(parentId: string | null, accountId: string): string | null {
    const parent = this.resolveFileNodeId(parentId);
    if (parent.accountId !== accountId) {
      throw new Error('Files cannot be moved between accounts');
    }
    return parent.id;
  }

  /**
   * FileNode/set `create` of one node. `onExists: "rename"` (Stalwart 0.16.6+,
   * ignored before) turns a name clash into "name (2)" instead of a failure.
   */
  private async createFileNodeIn(
    accountId: string,
    props: Record<string, unknown>,
    what: string,
  ): Promise<FileNode> {
    // Names from the local file system (uploads) may hold characters the
    // server refuses; store an accepted variant instead of failing the batch.
    const baseName = acceptedFileName(String(props.name ?? ''), this.getFileNameRules(accountId));
    for (let attempt = 1; ; attempt++) {
      const name = attempt === 1 ? baseName : numberedFileName(baseName, attempt);
      const wire = this.usesDraftFileNodeCreate(accountId)
        ? toDraftFileNodeCreate({ ...props, name })
        : { ...props, name };
      const response = await this.request(
        [["FileNode/set", { accountId, onExists: "rename", create: { n0: wire } }, "fns0"]],
        this.fileUsing(),
      );
      const result = response.methodResponses?.[0];
      if (!result || result[0] === "error") {
        throw jmapError(result?.[1]?.description || "FileNode/set create failed", result?.[1]);
      }
      const created = result[1].created?.n0;
      if (created) {
        // The create response carries only server-set properties; keep the
        // ones sent so callers can rely on name/parentId/type.
        return withDecodedName(fromDraftFileNode({ ...wire, ...created } as FileNode));
      }
      const err = result[1].notCreated?.n0;
      // Servers before 0.16.6 ignore onExists and refuse the clash instead.
      if (attempt < 20 && /already exists/i.test(err?.description ?? '')) continue;
      throw jmapError(err?.description || `Failed to create ${what}`, err);
    }
  }

  async createFileDirectory(name: string, parentId: string | null): Promise<FileNode> {
    const parent = this.resolveFileNodeId(parentId);

    // A FileNode is a folder (container) only when it has no content - i.e. no
    // blobId, type or size, so the server stores it with `file == null`. Sending
    // any of those - as older builds did (type "d" + an empty blob) - makes it a
    // 0-byte FILE that nothing can ever be parented under, which is what caused
    // "Parent ID does not exist or is not a folder" during the #379 migration.
    const dirProps: Record<string, unknown> = { name };
    if (parent.id !== null) {
      dirProps.parentId = parent.id;
    }

    const created = await this.createFileNodeIn(parent.accountId, dirProps, 'directory');
    return this.namespaceFileNode(created, parent.accountId);
  }

  /**
   * `size` is not sent: every server works it out from the blob, and
   * Stalwart 1.0 refuses a create whose size differs from the blob's.
   */
  async copyBlobs(fromAccountId: string, blobIds: string[], toAccountId: string): Promise<Record<string, string>> {
    if (blobIds.length === 0 || fromAccountId === toAccountId) {
      return Object.fromEntries(blobIds.map((id) => [id, id]));
    }
    const response = await this.request([
      ["Blob/copy", { fromAccountId, accountId: toAccountId, blobIds }, "bc0"],
    ]);
    const [name, result] = response.methodResponses?.[0] ?? [];
    if (name !== "Blob/copy" || !result) {
      throw jmapError(result?.description || result?.type || "Blob/copy failed", result);
    }
    const copied = (result.copied ?? {}) as Record<string, string>;
    const missing = blobIds.filter((id) => !copied[id]);
    if (missing.length > 0) {
      const error = (result.notCopied ?? {})[missing[0]];
      throw jmapError(error?.description || error?.type || "Blob/copy did not copy the blob", error);
    }
    return copied;
  }

  async createFileNode(name: string, blobId: string, type: string, _size: number, parentId: string | null): Promise<FileNode> {
    const parent = this.resolveFileNodeId(parentId);

    const fileProps: Record<string, unknown> = { name, type: this.fileNodeType(parent.accountId, type), blobId };
    if (parent.id !== null) {
      fileProps.parentId = parent.id;
    }

    const created = await this.createFileNodeIn(parent.accountId, fileProps, 'file node');
    return this.namespaceFileNode(created, parent.accountId);
  }

  async updateFileNode(id: string, updates: Partial<Pick<FileNode, 'name' | 'parentId'>>): Promise<void> {
    const node = this.resolveFileNodeId(id);
    const patch: Record<string, unknown> = { ...updates };
    if ('parentId' in updates) {
      patch.parentId = this.parentInAccount(updates.parentId ?? null, node.accountId);
    }

    const response = await this.request(
      [["FileNode/set", {
        accountId: node.accountId,
        update: { [node.id as string]: patch },
      }, "fns0"]],
      this.fileUsing(),
    );

    const result = response.methodResponses?.[0];
    if (!result || result[0] === "error") {
      throw jmapError(result?.[1]?.description || "FileNode/set update failed", result?.[1]);
    }
    const refused = result[1].notUpdated?.[node.id as string];
    if (refused) {
      throw jmapError(refused.description || "Failed to update file node", refused);
    }
  }

  /** Group FileNode ids by the account that owns them. */
  private groupFileNodeIds<T>(entries: Array<[string, T]>): Map<string, Array<{ id: string; rawId: string; value: T }>> {
    const groups = new Map<string, Array<{ id: string; rawId: string; value: T }>>();
    for (const [id, value] of entries) {
      const node = this.resolveFileNodeId(id);
      const list = groups.get(node.accountId) ?? [];
      list.push({ id, rawId: node.id as string, value });
      groups.set(node.accountId, list);
    }
    return groups;
  }

  /**
   * Update many FileNodes in a single FileNode/set call. Returns the ids that
   * were updated and a map of id -> error for any the server rejected. Never
   * throws for per-node failures (only for a whole-method error).
   */
  async updateFileNodes(updates: Record<string, Partial<Pick<FileNode, 'name' | 'parentId'>>>): Promise<{ updated: string[]; notUpdated: Record<string, string> }> {
    const entries = Object.entries(updates);
    if (entries.length === 0) return { updated: [], notUpdated: {} };

    const updated: string[] = [];
    const notUpdated: Record<string, string> = {};

    for (const [accountId, nodes] of this.groupFileNodeIds(entries)) {
      for (const batch of batched(nodes, this.getMaxObjectsInSet())) {
        const byRawId = new Map(batch.map(n => [n.rawId, n.id]));
        const update: Record<string, Record<string, unknown>> = {};
        for (const n of batch) {
          const patch: Record<string, unknown> = { ...n.value };
          if ('parentId' in n.value) {
            try {
              patch.parentId = this.parentInAccount(n.value.parentId ?? null, accountId);
            } catch (error) {
              notUpdated[n.id] = error instanceof Error ? error.message : 'not updated';
              continue;
            }
          }
          update[n.rawId] = patch;
        }
        if (Object.keys(update).length === 0) continue;

        const response = await this.request(
          [["FileNode/set", { accountId, update }, "fns0"]],
          this.fileUsing(),
        );

        const result = response.methodResponses?.[0];
        if (!result || result[0] === "error") {
          throw new Error(result?.[1]?.description || "FileNode/set update failed");
        }

        const updatedMap: Record<string, unknown> = result[1].updated || {};
        const notUpdatedMap: Record<string, { description?: string }> = result[1].notUpdated || {};
        for (const rawId of Object.keys(notUpdatedMap)) {
          notUpdated[byRawId.get(rawId) ?? rawId] = notUpdatedMap[rawId]?.description || 'not updated';
        }
        // Servers may omit the `updated` map; treat anything not rejected as updated.
        const done = Object.keys(updatedMap).length > 0
          ? Object.keys(updatedMap).map(rawId => byRawId.get(rawId) ?? rawId)
          : Object.keys(update).map(rawId => byRawId.get(rawId) as string).filter(id => !(id in notUpdated));
        updated.push(...done);
      }
    }

    return { updated, notUpdated };
  }

  async destroyFileNodes(ids: string[]): Promise<{ destroyed: string[]; notDestroyed: string[] }> {
    const destroyed: string[] = [];

    for (const [accountId, nodes] of this.groupFileNodeIds(ids.map(id => [id, null] as [string, null]))) {
      for (const batch of batched(nodes, this.getMaxObjectsInSet())) {
        const byRawId = new Map(batch.map(n => [n.rawId, n.id]));
        const response = await this.request(
          [["FileNode/set", {
            accountId,
            destroy: batch.map(n => n.rawId),
            onDestroyRemoveChildren: true,
          }, "fns0"]],
          this.fileUsing(),
        );

        const result = response.methodResponses?.[0];
        if (!result || result[0] === "error") {
          throw jmapError(result?.[1]?.description || "FileNode/set destroy failed", result?.[1]);
        }

        const notDestroyedMap: Record<string, { type?: string; description?: string }> = result[1].notDestroyed || {};
        const notDestroyedIds = Object.keys(notDestroyedMap);

        if (notDestroyedIds.length > 0) {
          const firstError = notDestroyedMap[notDestroyedIds[0]];
          throw jmapError(firstError?.description || `Failed to delete ${notDestroyedIds.length} file(s)`, firstError);
        }

        destroyed.push(...((result[1].destroyed || []) as string[]).map(rawId => byRawId.get(rawId) ?? rawId));
      }
    }

    return { destroyed, notDestroyed: [] };
  }

  /**
   * Copy a file, or a folder with everything in it, into `parentId` (which
   * may be in another account). A folder node carries no content, so creating
   * one "copy" node would only make an empty folder: the subtree is recreated
   * level by level.
   *
   * The copies point at the source's blobs. Stalwart lets anyone who may read
   * a FileNode use its blobId in any account, so this works both ways between
   * drives. Blob/copy reserved the content to the target account, which only
   * that account's members may use: copying into someone else's shared drive
   * failed with it.
   *
   * `listings` lets the copies of one paste share the trees they read.
   */
  async copyFileNode(id: string, newName: string, parentId: string | null, listings?: FileNodeListings): Promise<FileNode> {
    const source = this.resolveFileNodeId(id);
    const target = this.resolveFileNodeId(parentId);
    const listing = (accountId: string): Promise<FileNode[]> => {
      let nodes = listings?.get(accountId);
      if (!nodes) {
        nodes = this.fetchAllFileNodes(accountId);
        listings?.set(accountId, nodes);
      }
      return nodes;
    };

    const tree = await listing(source.accountId);
    const original = tree.find(n => n.id === source.id);
    if (!original) throw new Error('File node not found');
    // Symlinks (Stalwart 1.0) are left out: there is no content to copy, and
    // the blobId rule used to recreate them as empty folders.
    if (fileNodeKind(original) === 'symlink') throw new Error('Symbolic links cannot be copied');
    const isFolderNode = (n: FileNode) => fileNodeKind(n) === 'directory';

    // The whole subtree is laid out from one listing and checked before the
    // first create.
    const childrenOf = new Map<string, FileNode[]>();
    for (const node of tree) {
      if (node.parentId == null) continue;
      const siblings = childrenOf.get(node.parentId);
      if (siblings) siblings.push(node);
      else childrenOf.set(node.parentId, [node]);
    }
    type CopyEntry = { node: FileNode; children: CopyEntry[] };
    const seen = new Set<string>();
    const collect = (node: FileNode): CopyEntry => {
      seen.add(node.id);
      const below = isFolderNode(node) ? childrenOf.get(node.id) ?? [] : [];
      return {
        node: withDecodedName(node),
        children: below
          .filter(child => !seen.has(child.id) && fileNodeKind(child) !== 'symlink')
          .map(collect),
      };
    };
    const plan = collect(original);

    // Stalwart 1.0 refuses nodes below maxFileNodeDepth; a copy that would
    // reach past it fails here rather than part-way.
    const maxDepth = this.getMaxFileNodeDepth(target.accountId);
    if (maxDepth !== null) {
      const height = (entry: CopyEntry): number =>
        1 + entry.children.reduce((tallest, child) => Math.max(tallest, height(child)), 0);
      const targetTree = target.accountId === source.accountId
        ? tree
        : await listing(target.accountId).catch(() => null);
      if (targetTree && fileNodeDepth(targetTree, target.id) + height(plan) > maxDepth) {
        throw folderDepthError();
      }
    }

    // The ids this copy creates, by level below the copy (0 is the copy
    // itself), so that a failure takes back exactly those.
    const made: string[][] = [];
    const createCopy = async (node: FileNode, name: string, parent: string | null, level: number): Promise<FileNode> => {
      const props: Record<string, unknown> = { name };
      if (parent !== null) props.parentId = parent;
      if (!isFolderNode(node)) {
        props.type = this.fileNodeType(target.accountId, node.type);
        props.blobId = node.blobId;
      }
      const created = await this.createFileNodeIn(target.accountId, props, 'copy');
      (made[level] ??= []).push(created.id);
      return created;
    };
    const copyChildren = async (entry: CopyEntry, parent: string, level: number): Promise<void> => {
      for (const child of entry.children) {
        const created = await createCopy(child.node, child.node.name, parent, level);
        await copyChildren(child, created.id, level + 1);
      }
    };

    const root = await createCopy(plan.node, newName, target.id, 0);
    const copy = this.namespaceFileNode(root, target.accountId);
    try {
      await copyChildren(plan, root.id, 1);
    } catch (error) {
      // Take the half-made copy away again and report what stopped it. A
      // large copy runs for minutes: whatever someone put into its folders
      // meanwhile stays, and so do the folders holding it.
      const kept = await this.destroyFileNodesBottomUp(target.accountId, made);
      if (kept > 0) {
        console.warn(`[Files] ${kept} node(s) of a failed copy were left in place`);
        throw partialCopyError(error);
      }
      throw error;
    }
    return copy;
  }

  /**
   * Destroy nodes of one account level by level, the deepest first, without
   * onDestroyRemoveChildren, so a folder that holds anything else is refused
   * (`nodeHasChildren`) and stays. Stalwart 0.16 checks a destroy against the
   * tree as it was before the call and refuses a folder whose children go in
   * the same call (`willDestroy`), hence one call per level. Returns how many
   * of the nodes are still there.
   */
  private async destroyFileNodesBottomUp(accountId: string, levels: string[][]): Promise<number> {
    let kept = 0;
    for (let level = levels.length - 1; level >= 0; level--) {
      for (const batch of batched(levels[level] ?? [], this.getMaxObjectsInSet())) {
        try {
          const response = await this.request(
            [["FileNode/set", { accountId, destroy: batch }, "fns0"]],
            this.fileUsing(),
          );
          const result = response.methodResponses?.[0];
          if (!result || result[0] === "error") {
            kept += batch.length;
            continue;
          }
          const refused = Object.values(result[1].notDestroyed || {}) as Array<{ type?: string } | null>;
          // Gone already is as good as destroyed.
          kept += refused.filter(err => err?.type !== "notFound").length;
        } catch {
          kept += batch.length;
        }
      }
    }
    return kept;
  }

  async downloadBlob(blobId: string, name?: string, type?: string, accountId?: string): Promise<void> {
    const blob = await this.fetchBlob(blobId, name, type, accountId);
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
  private secondaryPollInterval: NodeJS.Timeout | null = null;
  private pollingStates: { [key: string]: string } = {};
  private sseAbortController: AbortController | null = null;
  private sseReconnectTimeout: NodeJS.Timeout | null = null;
  private ssePingTimer: NodeJS.Timeout | null = null;
  private lastSSEActivity: number = 0;
  // Guards a state-change poll from stacking: the 3s interval, the secondary
  // poll, and the visibility/online handlers all call checkForStateChanges, so
  // under socket pressure they would otherwise pile identical POSTs onto an
  // already-saturated pool and amplify the queueing (#781).
  private stateCheckInFlight: boolean = false;
  private visibilityHandler: (() => void) | null = null;
  private onlineHandler: (() => void) | null = null;

  // Per-tab SSE budget (#702). Every logged-in account is its own JMAPClient
  // and each one holds its push stream open as a long-lived fetch - one pinned
  // socket per account. Browsers allow only 6 HTTP/1.1 connections per host,
  // so from the sixth login on there is no socket left for an ordinary JMAP
  // POST: sends grey out and never complete, moves and loads queue for
  // minutes, all until one of the streams happens to drop. Cap the number of
  // concurrent streams per tab well below that limit (two tabs of the app
  // share the same pool) and let the remaining logins fall back to the slow
  // state poll, which borrows a socket for a moment instead of pinning it.
  // Waiters are promoted in order as holders release their slot.
  static readonly MAX_SSE_STREAMS = 2;
  private static sseHolders = new Set<JMAPClient>();
  private static sseWaiters: JMAPClient[] = [];
  private static ssePromotionQueued = false;
  // True between connectSSE and closePushNotifications: this client wants a
  // live stream and may be promoted into one when a slot frees up.
  private sseWanted = false;

  private static acquireSSESlot(client: JMAPClient): boolean {
    if (JMAPClient.sseHolders.has(client)) return true;
    if (JMAPClient.sseHolders.size >= JMAPClient.MAX_SSE_STREAMS) return false;
    JMAPClient.sseHolders.add(client);
    JMAPClient.sseWaiters = JMAPClient.sseWaiters.filter((c) => c !== client);
    return true;
  }

  private static releaseSSESlot(client: JMAPClient): void {
    JMAPClient.sseWaiters = JMAPClient.sseWaiters.filter((c) => c !== client);
    if (!JMAPClient.sseHolders.delete(client)) return;
    // Promote on a microtask, not inline: the push effect tears down every
    // client and immediately sets them all up again (account switch), and a
    // synchronous promotion would open a stream for a waiter that is about to
    // be closed a few statements later.
    if (JMAPClient.ssePromotionQueued) return;
    JMAPClient.ssePromotionQueued = true;
    queueMicrotask(() => {
      JMAPClient.ssePromotionQueued = false;
      JMAPClient.promoteSSEWaiters();
    });
  }

  private static enqueueSSEWaiter(client: JMAPClient): void {
    if (!JMAPClient.sseWaiters.includes(client)) JMAPClient.sseWaiters.push(client);
  }

  private static promoteSSEWaiters(): void {
    while (JMAPClient.sseHolders.size < JMAPClient.MAX_SSE_STREAMS && JMAPClient.sseWaiters.length > 0) {
      const next = JMAPClient.sseWaiters.shift()!;
      if (!next.sseWanted || next.intentionallyDisconnected) continue;
      const url = next.getEventSourceUrl();
      if (!url) continue;
      // Leave the slow poll running only if it is still needed for shared
      // accounts; the SSE branch of setup re-creates it in that case.
      if (next.secondaryPollInterval) {
        clearInterval(next.secondaryPollInterval);
        next.secondaryPollInterval = null;
      }
      next.connectSSE(url);
      next.startSecondaryAccountPoll();
    }
  }

  /** Number of SSE streams currently held open by clients in this tab. */
  static activeSSEStreamCount(): number {
    return JMAPClient.sseHolders.size;
  }

  /** Whether this client holds one of the tab's SSE slots (vs. slow-polling). */
  hasSSEStream(): boolean {
    return JMAPClient.sseHolders.has(this);
  }

  private static readonly STATE_TYPE_MAP: Record<string, string> = {
    'Mailbox/get': 'Mailbox',
    'Email/get': 'Email',
    'Calendar/get': 'Calendar',
    'CalendarEvent/get': 'CalendarEvent',
    'SieveScript/get': 'SieveScript',
  };

  private static readonly POLLING_INTERVAL = 3_000;
  // Shared/secondary accounts get no SSE push (Stalwart pushes the primary
  // account only), so poll them on a slow cadence alongside SSE to keep their
  // folder + unified/All-Mail counters from going stale between focus events.
  private static readonly SECONDARY_POLL_INTERVAL = 20_000;
  private static readonly SSE_RECONNECT_DELAY = 3_000;
  private static readonly SSE_PING_TIMEOUT = 90_000; // 3x the 30s ping interval
  // The 30s ping interval the stream is opened with, plus slack for a late one.
  private static readonly SSE_LIVE_WINDOW = 45_000;

  setupPushNotifications(): boolean {
    const eventSourceUrl = this.getEventSourceUrl();
    if (eventSourceUrl) {
      this.connectSSE(eventSourceUrl);
      // SSE covers the primary account only; keep shared accounts fresh too.
      this.startSecondaryAccountPoll();
    } else {
      // The fallback poll already covers every session account.
      this.startPollingFallback();
    }
    this.setupBrowserEventListeners();
    return true;
  }

  /**
   * Slow poll of the session's shared/secondary accounts, run in parallel with
   * SSE (which never reports them). Skipped when there are no shared accounts,
   * and paused while the tab is hidden (visibilitychange forces a check on
   * return). Reuses checkForStateChanges, which already reports per-account.
   */
  private startSecondaryAccountPoll(): void {
    if (this.secondaryPollInterval) return;
    const hasSecondary = this.pollAccountIds().some((id) => id !== this.accountId);
    if (!hasSecondary) return;
    this.startSlowPoll();
  }

  /**
   * The slow (20s) state poll over every account this login can see. Used
   * alongside SSE for shared accounts, and on its own for logins that did not
   * get one of the tab's SSE slots (#702) - it covers the primary account too.
   */
  private startSlowPoll(): void {
    if (this.secondaryPollInterval) return;
    // Prime the per-account baseline so the first tick doesn't false-fire.
    void this.fetchCurrentStates();
    this.secondaryPollInterval = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void this.checkForStateChanges();
    }, JMAPClient.SECONDARY_POLL_INTERVAL);
  }

  private connectSSE(templateUrl: string): void {
    this.sseWanted = true;
    if (this.isRateLimited()) {
      this.scheduleSSEReconnect();
      return;
    }

    // Budget check (#702): with no slot left in this tab, keep this login on
    // the slow poll and queue it for promotion once a holder releases. It
    // must not pin a sixth socket and starve every other request.
    if (!JMAPClient.acquireSSESlot(this)) {
      JMAPClient.enqueueSSEWaiter(this);
      this.startSlowPoll();
      return;
    }

    const url = templateUrl
      .replace('{types}', '*')
      .replace('{closeafter}', 'no')
      .replace('{ping}', '30');

    // Already-active guard (#781): never stack a second SSE stream on a live
    // one. readSSEStream only unwinds on abort or stream-end, so a previous
    // connect left open would hold its HTTP/1.1 socket indefinitely; with
    // several accounts each pinning a socket, routine JMAP POSTs then queue and
    // time out. Abort any prior stream (and its ping monitor / pending
    // reconnect) before opening the replacement. The old read loop unwinds via
    // AbortError and, because we install a fresh controller below, its
    // end-of-stream reconnect guard (`sseAbortController === controller`) no
    // longer matches, so it does not spawn a competing connection.
    if (this.sseAbortController) {
      this.sseAbortController.abort();
      this.sseAbortController = null;
    }
    this.stopSSEPingMonitor();
    if (this.sseReconnectTimeout) {
      clearTimeout(this.sseReconnectTimeout);
      this.sseReconnectTimeout = null;
    }

    // Each attempt tracks its own controller. When closePushNotifications
    // aborts a connect that is still in flight (every account switch tears
    // down and re-creates push for all connected clients), the rejection
    // lands in the catch below AFTER the next attempt has already been set
    // up - treating it as a network failure there would spawn an
    // unsupervised polling interval and, via fallbackToPolling nulling
    // sseAbortController, orphan the replacement connection.
    const controller = new AbortController();
    this.sseAbortController = controller;

    this.authenticatedFetch(url, {
      headers: { 'Accept': 'text/event-stream' },
      signal: controller.signal,
    }).then(response => {
      if (controller.signal.aborted) return;
      if (!response.ok || !response.body) {
        this.fallbackToPolling();
        return;
      }
      this.readSSEStream(response.body, controller);
    }).catch((error) => {
      // Intentional close, not a failure - no polling fallback.
      if (controller.signal.aborted) return;
      if (error instanceof RateLimitError) {
        this.sseAbortController = null;
        this.scheduleSSEReconnect();
        return;
      }
      this.fallbackToPolling();
    });
  }

  private async readSSEStream(body: ReadableStream<Uint8Array>, controller: AbortController): Promise<void> {
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

    // Stream ended - reconnect only if this stream is still the current one
    // and was not intentionally closed. A superseded stream must not spawn a
    // second connection next to its replacement.
    if (this.sseAbortController === controller && !controller.signal.aborted) {
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
    // No stream is held any more - hand the slot to a waiting login.
    JMAPClient.releaseSSESlot(this);
    if (!this.pollingInterval) {
      this.startPollingFallback();
    }
  }

  private startPollingFallback(): void {
    if (this.intentionallyDisconnected) return;
    if (this.isRateLimited()) {
      return;
    }
    // Idempotent: a repeat setup (or an SSE->poll fallback that races another)
    // must not leak a second 3s interval alongside the first (#781).
    if (this.pollingInterval) return;
    this.fetchCurrentStates();
    this.pollingInterval = setInterval(() => {
      this.checkForStateChanges();
    }, JMAPClient.POLLING_INTERVAL);
  }

  /**
   * Accounts whose Mailbox/Email state the poll should track. Stalwart's SSE
   * only pushes StateChange for the primary account, never for delegated/shared
   * (secondary) accounts, so their folder counters — and the unified/All-Mail
   * badges that aggregate them — would otherwise never refresh from a background
   * change. Polling every session account (primary + shared) closes that gap on
   * the visibility/interval reconcile path. Mailbox/Email get callIds are tagged
   * with the accountId (`mbx:<id>` / `eml:<id>`) so each account is compared
   * independently. (#shared-counter-push)
   */
  private pollAccountIds(): string[] {
    const ids = Object.keys(this.accounts || {});
    return ids.length > 0 ? ids : [this.accountId];
  }

  private buildStatePollingRequest(): { using: string[]; methodCalls: JMAPMethodCall[] } {
    const using = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'];
    const methodCalls: JMAPMethodCall[] = [];
    for (const acctId of this.pollAccountIds()) {
      methodCalls.push(
        ['Mailbox/get', { accountId: acctId, ids: null, properties: ['id'] }, `mbx:${acctId}`],
        ['Email/get', { accountId: acctId, ids: [], properties: ['id'] }, `eml:${acctId}`],
      );
    }

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

  /** Map a polled method response back to its (accountId, stateKey). */
  private resolvePolledState(method: string, callId: unknown): { accountId: string; stateKey: string } | null {
    if (typeof callId === 'string') {
      if (callId.startsWith('mbx:')) return { accountId: callId.slice(4), stateKey: 'Mailbox' };
      if (callId.startsWith('eml:')) return { accountId: callId.slice(4), stateKey: 'Email' };
    }
    const stateKey = JMAPClient.STATE_TYPE_MAP[method];
    return stateKey ? { accountId: this.accountId, stateKey } : null;
  }

  /**
   * Run the state-poll calls and collect their responses. The poll holds two
   * calls per account plus calendars and filters, so enough accounts (seven,
   * on Stalwart's default of 16) push it past `maxCallsInRequest`, and the
   * server refuses the whole request: change detection then stopped without
   * a sound. The calls go out in batches the server accepts, one after the
   * other to keep the socket budget (#702). A batch that fails is skipped.
   */
  private async fetchPolledStateResponses(): Promise<JMAPMethodResponse[]> {
    const { using, methodCalls } = this.buildStatePollingRequest();
    const responses: JMAPMethodResponse[] = [];
    for (const group of batched(methodCalls, this.getMaxCallsInRequest())) {
      const response = await this.firstTouchGate.run(group, () =>
        this.authenticatedFetch(this.apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ using, methodCalls: group }),
        }),
      );
      if (!response.ok) continue;
      const data = await response.json();
      if (Array.isArray(data?.methodResponses)) responses.push(...data.methodResponses);
    }
    return responses;
  }

  private async fetchCurrentStates(): Promise<void> {
    if (this.isRateLimited()) {
      return;
    }
    try {
      for (const [method, result, callId] of await this.fetchPolledStateResponses()) {
        const resolved = this.resolvePolledState(method, callId);
        if (resolved && result?.state) {
          this.pollingStates[`${resolved.accountId}:${resolved.stateKey}`] = result.state as string;
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
    // Coalesce overlapping polls: if one is already awaiting a response, skip
    // this call rather than issuing a duplicate POST (#781). The next tick
    // picks up any change once the in-flight one settles.
    if (this.stateCheckInFlight) {
      return;
    }
    this.stateCheckInFlight = true;
    try {
      // Build a per-account changed map so a background change in a shared
      // (secondary) account is reported under its own accountId — which
      // handleStateChange treats as "some mailbox changed" and refetches the
      // full (own + delegated) mailbox list from.
      const changedByAccount: Record<string, Record<string, string>> = {};

      for (const [method, result, callId] of await this.fetchPolledStateResponses()) {
        const resolved = this.resolvePolledState(method, callId);
        const state = result?.state as string | undefined;
        if (!resolved || !state) continue;
        const key = `${resolved.accountId}:${resolved.stateKey}`;
        if (this.pollingStates[key] && this.pollingStates[key] !== state) {
          (changedByAccount[resolved.accountId] ??= {})[resolved.stateKey] = state;
        }
        this.pollingStates[key] = state;
      }

      if (Object.keys(changedByAccount).length > 0 && this.stateChangeCallback) {
        this.stateChangeCallback({ '@type': 'StateChange', changed: changedByAccount });
      }
    } catch {
      // Silently fail - polling will retry
    } finally {
      this.stateCheckInFlight = false;
    }
  }

  closePushNotifications(): void {
    this.sseWanted = false;
    JMAPClient.releaseSSESlot(this);
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    if (this.secondaryPollInterval) {
      clearInterval(this.secondaryPollInterval);
      this.secondaryPollInterval = null;
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

  /**
   * Drop and rebuild an SSE stream that has gone quiet past the ping deadline.
   *
   * The ping monitor already does this, but it is a `setInterval`, and a
   * suspended tab - an iOS home-screen web app in particular - freezes its
   * timers along with everything else. Coming back to a page whose push
   * connection died while it slept, the monitor needs up to a full tick just to
   * notice, and the connection it is holding is one the OS already tore down.
   * Checking on the way back in makes the recovery immediate rather than
   * leaving the app on a socket that will never deliver another byte.
   */
  private recycleStaleSSE(): void {
    if (this.intentionallyDisconnected) return;
    if (!this.sseAbortController) return;
    if (Date.now() - this.lastSSEActivity <= JMAPClient.SSE_PING_TIMEOUT) return;

    this.stopSSEPingMonitor();
    this.sseAbortController.abort();
    this.sseAbortController = null;
    this.scheduleSSEReconnect();
  }

  private setupBrowserEventListeners(): void {
    if (typeof document !== 'undefined') {
      this.visibilityHandler = () => {
        if (!document.hidden) {
          // Tab became visible - immediately check for state changes
          this.checkForStateChanges();
          this.recycleStaleSSE();
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
  async fetchBlobArrayBuffer(blobId: string, name?: string, type?: string, accountId?: string, rangeHeader?: number): Promise<ArrayBuffer> {
    const url = this.getBlobDownloadUrl(blobId, name, type, accountId);
    const response = await this.authenticatedFetch(url, { }, { timeoutMs: JMAPClient.TRANSFER_TIMEOUT_MS });
    if (!response.ok) {
      throw new Error(`Failed to fetch blob: ${response.status}`);
    }

    const maxBytes = rangeHeader;

    // If no Range header requested or stream is missing, fallback to standard arrayBuffer()
    if (!maxBytes || !response.body) {
      return response.arrayBuffer();
    }
    // used to download only the first N bytes of a blob, e.g. for S/MIME /PGP encryption verification
    // Currently, Stalwart server does not support Range requests for the download endpoint, 
    // so we have to read the stream and cancel it after reading the first N bytes.
    // Stream reading with early termination via reader.cancel()
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytesRead = 0;

    try {
      while (bytesRead < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;

        chunks.push(value);
        bytesRead += value.length;
      }
    } finally {
      // Cancel the response body stream to close the network connection early
      await reader.cancel().catch(() => {});
    }

    // Slice exact requested length and copy chunks into a contiguous ArrayBuffer
    const totalLength = Math.min(bytesRead, maxBytes);
    const result = new Uint8Array(totalLength);
    let offset = 0;

    // Iterate over each chunk of binary data (Uint8Array) collected during the stream
    for (const chunk of chunks) {
      // Determine how many bytes to copy from the current chunk without exceeding totalLength
      const bytesToCopy = Math.min(chunk.length, totalLength - offset);
      // Copy the needed slice from the chunk into the target array starting at the current offset
      result.set(chunk.subarray(0, bytesToCopy), offset);
      // Move the offset forward by the number of bytes just written
      offset += bytesToCopy;
      // Stop processing further chunks if the target size limit has been reached
      if (offset >= totalLength) break;
    }

    return result.buffer;
  }

  /**
   * Import a raw MIME message blob into the account. Pass `accountId` to
   * target a delegated account the caller has rights on (e.g. importing into
   * a shared mailbox owned by another user). When omitted, falls back to the
   * client's own primary account.
   */
  async copyEmailAcrossAccounts(
    emailId: string,
    fromAccountId: string,
    toAccountId: string,
    destMailboxId: string,
    options?: { keepOriginal?: boolean },
  ): Promise<string> {
    // Email/copy drops keywords unless the create sets them, so carry the
    // source's over — otherwise the moved message shows up as unread. All of
    // them: Stalwart 1.0 also takes the copy's `$hasattachment` /
    // `$hasnoattachment`, and with them its hasAttachment, only from here.
    const srcResp = await this.request([
      ["Email/get", { accountId: fromAccountId, ids: [emailId], properties: ["keywords"] }, "0"],
    ]);
    const keywords = srcResp.methodResponses?.[0]?.[1]?.list?.[0]?.keywords ?? {};

    // No onSuccessDestroyOriginal: Stalwart before 0.16.15 destroys the wrong
    // id with it (support.stalw.art #1150), and from 0.16.15 it destroys the
    // source even when the copy failed (over quota, not found), so a failed
    // move lost the message. Destroy the source only once the copy exists.
    const response = await this.request([
      ["Email/copy", {
        fromAccountId,
        accountId: toAccountId,
        create: { c: { id: emailId, mailboxIds: { [destMailboxId]: true }, keywords } },
      }, "0"],
    ]);
    const [name, res] = response.methodResponses?.[0] ?? [];
    if (name === "error") {
      throw new Error(res?.description || res?.type || "Failed to copy email across accounts");
    }
    const err = res?.notCreated?.c;
    if (err) {
      throw new Error(err.description || err.type || "Failed to copy email across accounts");
    }
    const id = res?.created?.c?.id;
    if (!id) {
      throw new Error("Email/copy succeeded but no ID returned");
    }
    if (options?.keepOriginal) return id;

    const destroyResponse = await this.request([
      ["Email/set", { accountId: fromAccountId, destroy: [emailId] }, "0"],
    ]);
    this.assertEmailSetSucceeded(destroyResponse, "remove the moved email from its old account");
    return id;
  }

  async importRawEmail(
    blob: Blob,
    mailboxIds: Record<string, boolean>,
    keywords?: Record<string, boolean>,
    accountId?: string,
    receivedAt?: string,
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
            ...(receivedAt ? { receivedAt } : {}),
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
    const submissionAccountId = this.getSubmissionAccountId();
    const submit = () => this.request([
      ['EmailSubmission/set', {
        accountId: submissionAccountId,
        create: { 'smime-submit': { emailId, identityId } },
      }, '0'],
    ]);
    let response = await submit();
    if (submissionCreateError(response, 'smime-submit')?.type === 'overQuota') {
      await this.makeRoomForSubmission(submissionAccountId);
      response = await submit();
    }

    const result = response.methodResponses?.[0]?.[1];
    if (result?.notCreated?.['smime-submit']) {
      const err = result.notCreated['smime-submit'];
      if (err.type === 'overQuota') throw this.submissionQuotaError(err.description, submissionAccountId);
      throw new Error(err.description || err.type || 'Failed to submit email');
    }
    await this.destroyImmediateSubmission(result?.created?.['smime-submit']?.id, submissionAccountId);
  }

  /**
   * Import a raw S/MIME PGP/MIME message, move it to the Sent mailbox, and submit it.
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
    // These raw/S-MIME paths submit through the primary submission account, so
    // report that as the owning account rather than leaving it unset.
    const submissionAccountId = this.getSubmissionAccountId();

    const { emailId, submissionId: emailSubmissionId, sendAt, rejected } = await this.importAndSubmitRaw(
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
      'raw-import',
      submissionAccountId,
      (submitEmailId) => ({
        accountId: submissionAccountId,
        create: {
          'raw-submit': {
            emailId: submitEmailId,
            identityId,
            ...(envelope ? { envelope } : {}),
          },
        },
        ...(draftMailboxId ? {
          onSuccessUpdateEmail: {
            '#raw-submit': {
              ...mailboxIdsReplacement(sentMailboxId),
              'keywords/$draft': null,
            },
          },
        } : {}),
      }),
      'Failed to send raw email',
    );
    let serverSendAt = sendAt;

    if (delayedUntil && emailSubmissionId && !serverSendAt) {
      serverSendAt = await this.getEmailSubmissionSendAt(emailSubmissionId, submissionAccountId);
    }
    await this.destroyImmediateSubmission(emailSubmissionId, submissionAccountId, delayedUntil);

    const rejectedRecipientsResult = rejected.length ? rejected : undefined;
    return delayedUntil
      ? { scheduled: true, emailId, emailAccountId: this.accountId, emailSubmissionId, sendAt: serverSendAt, submissionAccountId, isSmime: true, rejectedRecipients: rejectedRecipientsResult }
      : { scheduled: false, emailId, emailAccountId: this.accountId, emailSubmissionId, submissionAccountId, isSmime: true, rejectedRecipients: rejectedRecipientsResult };
  }

  /**
   * Submit a raw email blob to the network via JMAP EmailSubmission without auto-archiving to Sent.
   */
  async submitRawEmail(
    blob: Blob,
    identityId: string,
    delayedUntil?: string,
    envelopeRecipients?: string[],
  ): Promise<SendEmailResult> {
    const mailboxes = await this.getMailboxes();
    const draftsMailbox = mailboxes.find(mb => mb.role === 'drafts');
    if (!draftsMailbox) {
          throw new Error('Drafts mailbox not found');
        }

    const holdForSeconds = delayedUntil ? this.validateDelayedUntil(delayedUntil) : undefined;
    
    const file = new File([blob], 'message.eml', { type: 'message/rfc822' });
    const { blobId } = await this.uploadBlob(file);

    const identities = await this.getIdentities();
    const identity = identities.find(item => item.id === identityId);
    const envelope = createDelayedSubmissionEnvelope(identity?.email || this.username, holdForSeconds, envelopeRecipients);
    const submissionAccountId = this.getSubmissionAccountId();

    //Temporarily import the raw email into Drafts to satisfy JMAP's requirement that an EmailSubmission references an existing Email.
    // The Email will be destroyed after submission.
    const { submissionId: emailSubmissionId, sendAt, rejected } = await this.importAndSubmitRaw(
      ['Email/import', {
        accountId: this.accountId,
        emails: {
          'temp-submit': {
            blobId,
            mailboxIds: { [draftsMailbox.id]: true },
            keywords: { '$draft': true },
          },
        },
      }, '0'],
      'temp-submit',
      submissionAccountId,
      (submitEmailId) => ({
        accountId: submissionAccountId,
        create: {
          'raw-submit': {
            emailId: submitEmailId,
            identityId,
            ...(envelope ? { envelope } : {}),
          },
        },
        //destroy the temporary email after submission to avoid leaving a draft behind.
        onSuccessDestroyEmail: ['#raw-submit'],
      }),
      'Failed to submit raw email',
    );
    let serverSendAt = sendAt;

    if (delayedUntil && emailSubmissionId && !serverSendAt) {
      serverSendAt = await this.getEmailSubmissionSendAt(emailSubmissionId, submissionAccountId);
    }
    await this.destroyImmediateSubmission(emailSubmissionId, submissionAccountId, delayedUntil);

    const rejectedRecipientsResult = rejected.length ? rejected : undefined;
    return delayedUntil
      ? { scheduled: true, emailSubmissionId, sendAt: serverSendAt, submissionAccountId, isSmime: true, rejectedRecipients: rejectedRecipientsResult }
      : { scheduled: false, emailSubmissionId, submissionAccountId, isSmime: true, rejectedRecipients: rejectedRecipientsResult };
  }

  /**
   * The Email/import + EmailSubmission/set request of the raw send paths.
   * An overQuota refusal is tried once more after making room - the import
   * exists by then, so it is submitted by id. Any other refusal takes the
   * import back out: nothing was sent, and it would otherwise stay in Drafts
   * (or in Sent, where it passes for a sent message). So does a submission
   * whose recipients were all refused (#1123): it throws
   * RecipientsRejectedError; the ones refused while others were taken come
   * back as `rejected`.
   */
  private async importAndSubmitRaw(
    importCall: JMAPMethodCall,
    importCreationId: string,
    submissionAccountId: string,
    submissionSet: (emailId: string) => Record<string, unknown>,
    failureMessage: string,
  ): Promise<{ emailId?: string; submissionId?: string; sendAt?: string; rejected: RejectedRecipient[] }> {
    const firstSet = submissionSet(`#${importCreationId}`);
    let response = await this.request([
      importCall,
      ['EmailSubmission/set', firstSet, '1'],
      deliveryStatusCall(submissionAccountId, 'raw-submit'),
    ]);
    const importedId = response.methodResponses
      ?.find(([name]) => name === 'Email/import')?.[1]?.created?.[importCreationId]?.id as string | undefined;
    if (importedId && submissionCreateError(response, 'raw-submit')?.type === 'overQuota') {
      await this.makeRoomForSubmission(submissionAccountId);
      const retry = await this.request([
        ['EmailSubmission/set', submissionSet(importedId), '1'],
        deliveryStatusCall(submissionAccountId, 'raw-submit'),
      ]);
      response = {
        ...retry,
        methodResponses: [
          ...response.methodResponses.filter(([name]) => name === 'Email/import'),
          ...(retry.methodResponses ?? []),
        ],
      };
    }
    const statusReadBack = takeDeliveryStatus(response);
    response = statusReadBack.response;

    const { failure } = sendMethodErrors(response.methodResponses);
    if (failure) {
      await this.discardUnsentCopy(importedId, this.accountId);
      throw jmapError(failure.description || `Failed: ${failure.type}`, failure);
    }
    let submissionId: string | undefined;
    let sendAt: string | undefined;
    for (const [methodName, result] of response.methodResponses ?? []) {
      const r = result as { notCreated?: Record<string, JMAPSetError> };
      if (r.notCreated) {
        const firstErr = Object.values(r.notCreated)[0];
        await this.discardUnsentCopy(importedId, this.accountId);
        this.throwIfHoldTooLong(firstErr);
        if (methodName === 'EmailSubmission/set' && firstErr?.type === 'overQuota') {
          throw this.submissionQuotaError(firstErr.description, submissionAccountId);
        }
        throw jmapError(firstErr?.description || firstErr?.type || failureMessage, firstErr);
      }
      if (methodName === 'EmailSubmission/set') {
        const created = (result as { created?: Record<string, { id?: string; sendAt?: string }> }).created?.['raw-submit'];
        submissionId = created?.id;
        sendAt = created?.sendAt;
      }
    }

    // Every recipient refused: nothing was queued, but the import was filed
    // as sent (or, for a temporary one, already destroyed). Take it back
    // out and fail the send; the record can neither go out nor be cancelled.
    const { rejected, all: noneAccepted } = rejectedRecipients(statusReadBack.deliveryStatus);
    if (noneAccepted) {
      if (!firstSet.onSuccessDestroyEmail) await this.discardUnsentCopy(importedId, this.accountId);
      if (submissionId && this.hasAccountCapability('urn:stalwart:jmap', submissionAccountId)) {
        await this.destroyEmailSubmissions([submissionId], submissionAccountId);
      }
      throw new RecipientsRejectedError(rejected);
    }
    return { emailId: importedId, submissionId, sendAt, rejected };
  }

  /**
   * Destroy the record of a submission sent without a hold, as sendEmail
   * does (see there): gated on Stalwart and on the request, never on the
   * undoStatus the create returned.
   */
  private async destroyImmediateSubmission(submissionId: string | undefined, accountId: string, delayedUntil?: string): Promise<void> {
    if (delayedUntil || !submissionId || !this.hasAccountCapability('urn:stalwart:jmap', accountId)) return;
    await this.destroyEmailSubmissions([submissionId], accountId);
  }

  async getScheduledEmails(limit = 50, position = 0): Promise<{ emails: ScheduledEmail[]; hasMore: boolean; total: number; totalByAccount?: Record<string, number>; nextPosition: number }> {
    // Scheduled mail composed from a shared identity lives in the shared
    // account, so gate on *any* reachable submission account supporting
    // delayed send rather than only the primary one.
    const submissionAccountIds = this.getSubmissionAccountIds()
      .filter(accountId => this.hasDelayedSend(accountId));
    if (submissionAccountIds.length === 0) {
      return { emails: [], hasMore: false, total: 0, nextPosition: position };
    }

    const now = Date.now();
    const pageSize = Math.max(limit, 50);
    const submissions: EmailSubmission[] = [];
    // Which account each submission came from — needed to fetch its Email from
    // the right account below, and to route later cancel/reschedule calls.
    // Keyed by the record: submission and email ids repeat across accounts.
    const accountBySubmission = new Map<EmailSubmission, string>();
    const primarySubmissionAccountId = this.getSubmissionAccountId();

    for (const submissionAccountId of submissionAccountIds) {
      let rawPosition = 0;
      let rawTotal = 0;

      try {
        do {
          // `total` only comes back with calculateTotal. Without it the loop
          // stopped after the first page, and since the query lists records
          // oldest sendAt first, mail scheduled furthest ahead dropped off the
          // list once the three-day window held more than a page of records.
          const queryResponse = await this.request([
            ['EmailSubmission/query', {
              accountId: submissionAccountId,
              limit: pageSize,
              position: rawPosition,
              calculateTotal: true,
            }, '0'],
          ]);

          const query = queryResponse.methodResponses?.[0]?.[1] as { ids?: string[]; total?: number; position?: number } | undefined;
          const ids = query?.ids ?? [];
          rawTotal = query?.total ?? rawPosition + ids.length;
          if (ids.length === 0) break;

          const submissionResponse = await this.request([
            ['EmailSubmission/get', {
              accountId: submissionAccountId,
              ids,
              properties: ['id', 'emailId', 'identityId', 'threadId', 'sendAt', 'undoStatus', 'deliveryStatus'],
            }, '0'],
          ]);

          const pending = ((submissionResponse.methodResponses?.[0]?.[1]?.list ?? []) as EmailSubmission[])
            .filter(submission => {
              if (submission.undoStatus !== 'pending' || !submission.sendAt) return false;
              const sendAtTime = new Date(submission.sendAt).getTime();
              return Number.isFinite(sendAtTime) && sendAtTime > now;
            });
          for (const submission of pending) accountBySubmission.set(submission, submissionAccountId);
          submissions.push(...pending);

          rawPosition += ids.length;
        } while (rawPosition < rawTotal);
      } catch (error) {
        // A shared account that cannot answer (revoked access, server-side
        // error) must not take the user's own scheduled mail down with it;
        // the primary account's failure still surfaces as before.
        if (submissionAccountId === primarySubmissionAccountId) throw error;
        console.error(`[getScheduledEmails] shared account ${submissionAccountId} failed:`, error);
      }
    }

    submissions.sort((a, b) => new Date(a.sendAt || '').getTime() - new Date(b.sendAt || '').getTime());
    const total = submissions.length;
    // Per-account totals over ALL pending submissions, not just the page below,
    // so a shared account's badge stays correct past the first page.
    const totalByAccount: Record<string, number> = {};
    for (const submission of submissions) {
      const accountId = accountBySubmission.get(submission);
      if (accountId) totalByAccount[accountId] = (totalByAccount[accountId] ?? 0) + 1;
    }
    const pageSubmissions = submissions.slice(position, position + limit);
    const nextPosition = position + pageSubmissions.length;

    if (pageSubmissions.length === 0) {
      return { emails: [], hasMore: false, total, totalByAccount, nextPosition };
    }

    // The submission's Email lives in the same account as the submission, so a
    // shared-account scheduled message must be fetched from there — asking the
    // primary account returns nothing and the row would be dropped below.
    const emailIdsByAccount = new Map<string, string[]>();
    for (const submission of pageSubmissions) {
      const accountId = accountBySubmission.get(submission) ?? this.accountId;
      const bucket = emailIdsByAccount.get(accountId);
      if (bucket) bucket.push(submission.emailId);
      else emailIdsByAccount.set(accountId, [submission.emailId]);
    }

    const emailsByAccount = new Map<string, Map<string, Email>>();
    for (const [accountId, ids] of emailIdsByAccount) {
      const emailResponse = await this.request([
        ['Email/get', {
          accountId,
          ids,
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
      const fetchedEmails = (emailResponse.methodResponses?.[0]?.[1]?.list ?? []) as Email[];
      await this.refetchTruncatedBodyValues(fetchedEmails, accountId);
      emailsByAccount.set(accountId, new Map(fetchedEmails.map(email => [email.id, email])));
    }
    const emails = pageSubmissions
      .map((submission): ScheduledEmail | null => {
        const accountId = accountBySubmission.get(submission) ?? this.accountId;
        const email = emailsByAccount.get(accountId)?.get(submission.emailId);
        if (!email || !submission.sendAt) return null;
        return {
          ...email,
          // A group or shared account's row is stamped with its account, as in
          // the merged views: it is read from there, and its message and
          // thread ids repeat in the own account.
          ...(accountId !== this.accountId ? { sourceAccountId: accountId } : {}),
          threadId: submission.threadId || email.threadId,
          scheduledSendAt: submission.sendAt,
          emailSubmissionId: submission.id,
          scheduledIdentityId: submission.identityId,
          scheduledUndoStatus: submission.undoStatus,
          scheduledDeliveryStatus: submission.deliveryStatus,
          scheduledAccountId: accountBySubmission.get(submission),
          isScheduled: true,
          isSmimeScheduled: isSmimeEmail(email),
        };
      })
      .filter((email): email is ScheduledEmail => email !== null)
      .sort((a, b) => new Date(a.scheduledSendAt).getTime() - new Date(b.scheduledSendAt).getTime());

    return { emails, hasMore: nextPosition < total, total, totalByAccount, nextPosition };
  }

  async cancelEmailSubmission(submissionId: string, accountId?: string): Promise<void> {
    // A submission created from a shared identity belongs to the shared
    // account; cancelling it through the primary account answers `notFound`
    // and the message would still go out. See #874.
    const submissionAccountId = accountId ?? await this.resolveSubmissionAccountId(submissionId);
    const response = await this.request([
      ['EmailSubmission/set', {
        accountId: submissionAccountId,
        update: { [submissionId]: { undoStatus: 'canceled' } },
      }, '0'],
    ]);
    const [name, result] = response.methodResponses?.[0] ?? [];
    if (name === 'error') {
      throw jmapError(result?.description || result?.type || 'Failed to cancel scheduled send', result);
    }
    const error = result?.notUpdated?.[submissionId];
    if (error) {
      throw jmapError(error.description || error.type || 'Failed to cancel scheduled send', error);
    }
    // The canceled record is dead weight against the submission limit.
    // Destroyed in a request of its own, and only once the cancel is
    // confirmed: had the two gone together and the cancel failed, the mail
    // would still be queued with no record left to cancel it through.
    if (result?.updated && submissionId in result.updated) {
      await this.destroyEmailSubmissions([submissionId], submissionAccountId);
    }
  }

  async rescheduleEmailSubmission(submissionId: string, emailId: string, identityId: string, delayedUntil: string, accountId?: string): Promise<SendEmailResult> {
    // Keep the replacement in the same account as the original: a shared
    // submission rescheduled through the primary account would be recreated
    // in the wrong account (and the original left running). See #874.
    const submissionAccountId = accountId ?? await this.resolveSubmissionAccountId(submissionId);
    const holdForSeconds = this.validateDelayedUntil(delayedUntil, submissionAccountId);
    const holdUntil = Date.now() + holdForSeconds * 1000;
    const mailboxes = await this.getMailboxes(submissionAccountId);
    const draftsMailbox = mailboxes.find(mb => mb.role === 'drafts');
    const sentMailbox = mailboxes.find(mb => mb.role === 'sent');
    const original = await this.getEmailSubmissionForReschedule(submissionId, submissionAccountId);
    // The original's identity is one of the submission account's. The caller's
    // may be the composer's, from the login's own account: for a group
    // identity's message that id names nothing in the group account, or
    // another identity.
    const submissionIdentityId = original?.identityId || identityId;
    // The identity and the Email live beside the submission, so look both up in
    // the owning account. getIdentities() only knows the primary account's
    // identities; a shared identity missing there would silently put the login
    // user's own address into MAIL FROM of the replacement.
    let identity: Identity | undefined;
    try {
      const identityResponse = await this.request([
        ['Identity/get', { accountId: submissionAccountId, ids: [submissionIdentityId], properties: ['id', 'email'] }, '0'],
      ]);
      identity = ((identityResponse.methodResponses?.[0]?.[1]?.list ?? []) as Identity[])
        .find(item => item.id === submissionIdentityId);
    } catch (error) {
      console.error('Failed to get identity for reschedule:', error);
    }
    const existingEnvelope = original?.envelope;
    const email = existingEnvelope?.rcptTo?.length ? undefined : await this.getEmail(emailId, submissionAccountId);
    const envelopeRecipients = existingEnvelope?.rcptTo?.length
      ? existingEnvelope.rcptTo
      : [...(email?.to || []), ...(email?.cc || []), ...(email?.bcc || [])];
    const fromEmail = identity?.email || this.username;

    type Created = { id: string; sendAt?: string; deliveryStatus?: Record<string, DeliveryStatus> };
    // `until`: when the submission goes out (ms); absent, at once.
    const createSubmission = async (until: number | undefined): Promise<Created> => {
      // HOLDFOR counts from when the server takes the request, so a retry
      // after making room takes the time spent off it.
      const holdFor = () => until === undefined ? undefined : Math.max(1, Math.ceil((until - Date.now()) / 1000));
      const send = () => {
        const envelope = createDelayedSubmissionEnvelope(fromEmail, holdFor(), envelopeRecipients);
        return this.request([
          ['EmailSubmission/set', {
            accountId: submissionAccountId,
            create: { replacement: { emailId, identityId: submissionIdentityId, ...(envelope ? { envelope } : {}) } },
            ...(draftsMailbox && sentMailbox ? {
              onSuccessUpdateEmail: {
                '#replacement': {
                  ...mailboxIdsReplacement(sentMailbox.id),
                  'keywords/$draft': null,
                },
              },
            } : {}),
          }, '0'],
          deliveryStatusCall(submissionAccountId, 'replacement'),
        ]);
      };
      let response = await send();
      if (submissionCreateError(response, 'replacement')?.type === 'overQuota') {
        await this.makeRoomForSubmission(submissionAccountId);
        response = await send();
      }
      const statusReadBack = takeDeliveryStatus(response);
      // Only the submission call counts: the implied Email/set from
      // onSuccessUpdateEmail can fail while the submission was created.
      const [methodName, result] = statusReadBack.response.methodResponses?.[0] ?? [];
      if (methodName === 'error') {
        throw jmapError(result?.description || result?.type || 'Failed to reschedule email', result);
      }
      const createError = result?.notCreated?.replacement;
      if (createError) {
        if (createError.type === 'overQuota') throw this.submissionQuotaError(createError.description, submissionAccountId);
        throw jmapError(createError.description || createError.type || 'Failed to reschedule email', createError);
      }
      const id = result?.created?.replacement?.id;
      if (!id) {
        throw new Error('Server did not return a replacement scheduled send ID');
      }
      return { id, sendAt: result?.created?.replacement?.sendAt, deliveryStatus: statusReadBack.deliveryStatus };
    };

    // Cancel first. Some servers allow only one active submission per Email
    // and reject a second create for the same emailId, and servers that undo
    // onSuccessUpdateEmail on cancel would pull the message back to Drafts if
    // the original were canceled after the replacement existed (#1308).
    // If this fails, nothing has changed and the original still goes out -
    // unless it went out already ("Send now" of a message due any moment).
    try {
      await this.cancelEmailSubmission(submissionId, submissionAccountId);
    } catch (error) {
      const status = await this.getSubmissionStatus(submissionId, submissionAccountId).catch(() => undefined);
      if (status === 'final' || status === 'canceled') throw new NoLongerScheduledError(status === 'final');
      throw error;
    }

    // A submission that took no recipient goes nowhere; its record only
    // counts against the limit.
    const withdrawIfDead = async (created: Created): Promise<RejectedRecipient[] | null> => {
      const delivery = rejectedRecipients(created.deliveryStatus);
      if (!delivery.all) return null;
      if (this.hasAccountCapability('urn:stalwart:jmap', submissionAccountId)) {
        await this.destroyEmailSubmissions([created.id], submissionAccountId);
      }
      return delivery.rejected;
    };

    let replacement: Created;
    try {
      replacement = await createSubmission(holdUntil);
      // The recipients are checked again for the replacement, and a throttle
      // used up since the original was taken can refuse some or all of them.
      // When it took nobody the reschedule counts as failed; when it took
      // some, the caller names the refused ones.
      const refused = await withdrawIfDead(replacement);
      if (refused) throw new RecipientsRejectedError(refused);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to reschedule email';
      // Put the original back at its old time. HOLDFOR with the seconds that
      // are left, not HOLDUNTIL: servers disagree on the HOLDUNTIL value format
      // (RFC 3339 vs Unix seconds), every FUTURERELEASE server takes HOLDFOR.
      const originalTime = original?.sendAt ? new Date(original.sendAt).getTime() : NaN;
      let restored: Created | undefined;
      try {
        restored = await createSubmission(Number.isFinite(originalTime) && originalTime > Date.now() ? originalTime : undefined);
      } catch (restoreError) {
        console.error('Failed to restore the original scheduled send after reschedule failure:', restoreError);
      }
      if (restored && !(await withdrawIfDead(restored).catch(() => null))) {
        throw new RescheduleRestoredError(message, restored.id, restored.sendAt || original?.sendAt);
      }
      // Neither went through: the message is not scheduled any more. Make sure
      // it sits in Drafts rather than in Sent looking like it went out.
      if (draftsMailbox) {
        try {
          await this.restoreEmailToDraft(emailId, draftsMailbox.id, sentMailbox?.id, submissionAccountId);
        } catch (draftError) {
          console.error('Failed to move the message back to Drafts after reschedule failure:', draftError);
        }
      }
      if (error instanceof RecipientsRejectedError || error instanceof SubmissionQuotaError) throw error;
      throw new Error(`Reschedule failed and the message is no longer scheduled: ${message}`);
    }
    const rejected = rejectedRecipients(replacement.deliveryStatus).rejected;
    const finalSendAt = replacement.sendAt || await this.getEmailSubmissionSendAt(replacement.id, submissionAccountId);
    return {
      scheduled: true, emailId, emailSubmissionId: replacement.id, sendAt: finalSendAt,
      ...(rejected.length > 0 ? { rejectedRecipients: rejected } : {}),
    };
  }

  // The third parameter is intentionally unused: this restores an undo-send /
  // canceled-scheduled message to be a draft, so it should live in Drafts *only*.
  // A full mailboxIds replacement (rather than mailboxIds/<id> pointer patches)
  // both drops the Sent copy without needing its id and stays safe for numeric
  // mailbox ids — see mailboxIdsReplacement().
  //
  // `accountId` is the account the message lives in: one sent from a shared
  // or group identity lives in that account, with `draftMailboxId` that
  // account's Drafts. Email ids repeat across accounts, so restoring it
  // through the primary account would act on whatever primary message has
  // the same id.
  async restoreEmailToDraft(emailId: string, draftMailboxId: string, _sentMailboxId?: string, accountId?: string): Promise<void> {
    const update: Record<string, unknown> = {
      ...mailboxIdsReplacement(draftMailboxId),
      'keywords/$draft': true,
      'keywords/$seen': true,
    };
    const response = await this.request([
      ['Email/set', {
        accountId: accountId || this.accountId,
        update: { [emailId]: update },
      }, '0'],
    ]);
    const [name, result] = response.methodResponses?.[0] ?? [];
    if (name === 'error') {
      throw jmapError(result?.description || result?.type || 'Failed to restore email to drafts', result);
    }
    const error = result?.notUpdated?.[emailId];
    if (error) {
      throw jmapSetError(error.description || error.type || 'Failed to restore email to drafts', error);
    }
  }

  // ── EmailSubmission records ───────────────────────────────────────
  // Every send leaves an EmailSubmission record behind. Stalwart 1.0 counts
  // all of them, whatever their status or age, against a per-account limit
  // (`maxSubmissions`, 500 by default) and its own purge of old records never
  // runs, so an account that never removes them stops sending for good.
  // Destroying a record only removes the record - on 0.16 and 1.0 it neither
  // cancels nor stops the delivery - but a still-pending submission whose
  // record is gone can no longer be cancelled. So only records that can't be
  // cancelled any more are ever destroyed.

  /**
   * Destroy EmailSubmission records, in batches the server accepts. Callers
   * must only pass records that can no longer be cancelled.
   *
   * Resolves with the ids the server destroyed. Ids it no longer has count as
   * done; other failures are logged. Never rejects, so no send fails over it.
   */
  async destroyEmailSubmissions(ids: string[], accountId?: string): Promise<string[]> {
    const submissionAccountId = accountId ?? this.getSubmissionAccountId();
    const destroyed: string[] = [];
    for (const batch of batched([...new Set(ids)], this.getMaxObjectsInSet())) {
      try {
        const response = await this.request([submissionDestroyCall(batch, submissionAccountId, '0')]);
        destroyed.push(...readSubmissionDestroy(response, '0'));
      } catch (error) {
        console.warn('[EmailSubmission] destroy failed:', error);
      }
    }
    return destroyed;
  }

  /**
   * Destroy, in every submission account, the records that can no longer be
   * cancelled: canceled ones, and final ones whose sendAt has passed (see
   * prunableSubmissionIds). That includes other clients' and other group
   * members' records - the limit is per account. EmailSubmission/query only
   * sees records whose sendAt is at most three days back, so older ones are
   * left to makeRoomForSubmission.
   *
   * Runs at most once per account every ten minutes unless `force` is set.
   * Resolves with the number of records destroyed; never rejects.
   */
  async pruneEmailSubmissions(options: { force?: boolean } = {}): Promise<number> {
    let destroyed = 0;
    for (const accountId of this.getSubmissionAccountIds()) {
      destroyed += await this.pruneSubmissionAccount(accountId, options.force ?? false);
    }
    return destroyed;
  }

  private async pruneSubmissionAccount(accountId: string, force: boolean): Promise<number> {
    const now = Date.now();
    const lastRun = this.submissionPrunedAt.get(accountId);
    if (!force && lastRun !== undefined && now - lastRun < SUBMISSION_PRUNE_INTERVAL_MS) return 0;
    this.submissionPrunedAt.set(accountId, now);
    try {
      const prunable = await this.findPrunableSubmissions(accountId, now);
      if (prunable.length === 0) return 0;
      return (await this.destroyEmailSubmissions(prunable, accountId)).length;
    } catch (error) {
      // Stalwart 0.16 lists an account that shared only an address book or a
      // calendar with the submission capability, then refuses its records
      // ("You are not an owner of account ..."). Nothing of this login's is
      // there, so the account is left alone for the rest of the session.
      if (jmapErrorType(error) === 'forbidden' && accountId !== this.getSubmissionAccountId()) {
        this.refusedSubmissionAccounts.add(accountId);
        debug.log('email', `[EmailSubmission] ${accountId} refuses this login's submissions; not asking again`);
        return 0;
      }
      console.warn(`[EmailSubmission] pruning ${accountId} failed:`, error);
      return 0;
    }
  }

  /**
   * Page through the records the query can see that might go - past sendAt
   * or canceled, a superset either way - and let EmailSubmission/get decide.
   */
  private async findPrunableSubmissions(accountId: string, now: number): Promise<string[]> {
    const pageSize = Math.min(500, this.getMaxObjectsInGet());
    const before = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const prunable: string[] = [];
    let position = 0;
    for (let page = 0; page < SUBMISSION_SCAN_MAX_PAGES; page++) {
      const response = await this.request([
        ['EmailSubmission/query', {
          accountId,
          filter: { operator: 'OR', conditions: [{ before }, { undoStatus: 'canceled' }] },
          position,
          limit: pageSize,
          calculateTotal: true,
        }, '0'],
        ['EmailSubmission/get', {
          accountId,
          '#ids': { resultOf: '0', name: 'EmailSubmission/query', path: '/ids' },
          properties: ['id', 'sendAt', 'undoStatus'],
        }, '1'],
      ]);
      assertQuerySucceeded(response, 'EmailSubmission/query');
      const query = response.methodResponses[0][1] as { ids?: string[]; total?: number };
      const ids = query.ids ?? [];
      prunable.push(...prunableSubmissionIds(this.submissionGetList(response, '1'), now));
      position += ids.length;
      const done = typeof query.total === 'number' ? position >= query.total : ids.length < pageSize;
      if (ids.length === 0 || done) break;
    }
    return prunable;
  }

  /** The list of an EmailSubmission/get response; throws when the get failed. */
  private submissionGetList(response: JMAPResponse, callId: string): Array<Pick<EmailSubmission, 'id' | 'sendAt' | 'undoStatus'>> {
    const [name, result] = response.methodResponses?.find(([, , id]) => id === callId) ?? [];
    if (name !== 'EmailSubmission/get') {
      throw jmapError(`EmailSubmission/get failed: ${result?.description || result?.type || 'unknown error'}`, result);
    }
    return (result?.list ?? []) as Array<Pick<EmailSubmission, 'id' | 'sendAt' | 'undoStatus'>>;
  }

  /**
   * The undoStatus EmailSubmission/get reports for a submission now, which
   * Stalwart works out from its queue; undefined once the record is gone.
   * Throws when the get fails.
   */
  private async getSubmissionStatus(submissionId: string, accountId: string): Promise<EmailSubmission['undoStatus'] | undefined> {
    const response = await this.request([
      ['EmailSubmission/get', { accountId, ids: [submissionId], properties: ['id', 'undoStatus'] }, '0'],
    ]);
    return this.submissionGetList(response, '0').find((submission) => submission.id === submissionId)?.undoStatus;
  }

  /**
   * Make room after an EmailSubmission/set create came back overQuota. Prunes
   * the account at once; when that frees nothing, the records taking up the
   * room are older than the query can see (sendAt more than three days back).
   * On Stalwart their ids are still in the change log (the last 10,000
   * changes by default), and get and destroy by id work at any age, so they
   * are found there and pruned by the same rules. Never rejects: the caller
   * retries the create either way, since another tab may have made room in
   * the meantime.
   *
   * At a full quota every attempt ends up here - each send, reschedule and
   * automatic read receipt. When a search found nothing that can go, it is
   * not repeated for automatic read receipts for a few minutes: what is left
   * is pending or out of reach, and looking again right away would cost the
   * prune, the change-log walk and the gets once more for the same answer.
   * A send the user starts always looks again: pending records - scheduled
   * mail, undo-send holds - can go once their message is out, and until the
   * next search every send would fail with "ask your administrator".
   */
  private async makeRoomForSubmission(accountId: string, options: { automatic?: boolean } = {}): Promise<void> {
    const recheckAt = this.submissionRoomRecheckAt.get(accountId);
    if (options.automatic && recheckAt !== undefined && Date.now() < recheckAt) return;
    const now = Date.now();
    this.submissionPrunedAt.set(accountId, now);
    let found = 0;
    let freed = 0;
    let complete = true;
    const prune = async (lookUp: () => Promise<string[]>, what: string) => {
      try {
        const prunable = await lookUp();
        found += prunable.length;
        if (prunable.length > 0) freed += (await this.destroyEmailSubmissions(prunable, accountId)).length;
      } catch (error) {
        complete = false;
        console.warn(`[EmailSubmission] looking up ${what} of ${accountId} failed:`, error);
      }
    };
    await prune(() => this.findPrunableSubmissions(accountId, now), 'recent submissions');
    if (freed === 0 && this.hasAccountCapability('urn:stalwart:jmap', accountId)) {
      await prune(() => this.findOlderPrunableSubmissions(accountId), 'older submissions');
    }
    // A failed lookup proves nothing, so only an answer of "nothing" counts.
    if (complete && found === 0) this.submissionRoomRecheckAt.set(accountId, Date.now() + SUBMISSION_ROOM_RECHECK_MS);
    else this.submissionRoomRecheckAt.delete(accountId);
  }

  /** The records in the account's change log that can go (see submissionIdsFromChangeLog). */
  private async findOlderPrunableSubmissions(accountId: string): Promise<string[]> {
    const ids = await this.submissionIdsFromChangeLog(accountId);
    const now = Date.now();
    const prunable: string[] = [];
    for (const batch of batched(ids, Math.min(500, this.getMaxObjectsInGet()))) {
      const response = await this.request([
        ['EmailSubmission/get', { accountId, ids: batch, properties: ['id', 'sendAt', 'undoStatus'] }, '0'],
      ]);
      prunable.push(...prunableSubmissionIds(this.submissionGetList(response, '0'), now));
    }
    return prunable;
  }

  /**
   * Every submission id still in the account's change log. Stalwart reads
   * sinceState "n" as its initial state and answers with the whole log, with
   * a record created and destroyed within it left out.
   */
  private async submissionIdsFromChangeLog(accountId: string): Promise<string[]> {
    const ids = new Set<string>();
    let sinceState = 'n';
    for (let page = 0; page < SUBMISSION_SCAN_MAX_PAGES; page++) {
      const response = await this.request([
        ['EmailSubmission/changes', { accountId, sinceState }, '0'],
      ]);
      const [name, result] = response.methodResponses?.[0] ?? [];
      if (name !== 'EmailSubmission/changes') {
        throw jmapError(`EmailSubmission/changes failed: ${result?.description || result?.type || 'unknown error'}`, result);
      }
      for (const id of [...(result.created ?? []), ...(result.updated ?? [])] as string[]) ids.add(id);
      for (const id of (result.destroyed ?? []) as string[]) ids.delete(id);
      if (!result.hasMoreChanges || !result.newState || result.newState === sinceState) break;
      sinceState = result.newState;
    }
    return [...ids];
  }

  /**
   * Destroy the message a send created for a submission that then failed:
   * sendEmail's Drafts copy, an imported read receipt or raw message. Nothing
   * was sent, and leaving it would make it look sent (in Sent) or pile up one
   * duplicate per attempt (in Drafts). Best effort: the send error is what
   * the caller reports.
   */
  private async discardUnsentCopy(emailId: string | undefined, accountId: string): Promise<void> {
    if (!emailId) return;
    try {
      await this.deleteEmail(emailId, accountId);
    } catch (error) {
      console.warn('[EmailSubmission] could not remove the unsent message:', error);
    }
  }

  /**
   * The error for a submission create the account refused with overQuota,
   * noting whether the account is on Stalwart: its limit is the count of
   * submission records, which only an administrator can raise once the
   * prune freed nothing.
   */
  private submissionQuotaError(description: string | undefined, accountId: string): SubmissionQuotaError {
    return new SubmissionQuotaError(description, this.hasAccountCapability('urn:stalwart:jmap', accountId));
  }

  // ── PushSubscription (RFC 8620 §7.2) ──────────────────────────────
  // Used by the PWA Web Push integration. The mobile app does the same dance
  // through its own JMAP client - keep these in sync.

  // draft-ietf-jmap-emailpush: the session advertises this when
  // PushSubscription accepts a per-account `emailPush` delivery filter.
  // Stalwart >= 0.16.16. Older servers reject the capability in `using` and
  // the `emailPush` property outright, so every push call gates on it.
  static readonly EMAIL_PUSH_CAPABILITY = 'urn:ietf:params:jmap:emailpush';

  hasEmailPushCapability(): boolean {
    return this.hasCapability(JMAPClient.EMAIL_PUSH_CAPABILITY);
  }

  private pushUsing(withEmailPush: boolean): string[] {
    return withEmailPush
      ? ['urn:ietf:params:jmap:core', JMAPClient.EMAIL_PUSH_CAPABILITY]
      : ['urn:ietf:params:jmap:core'];
  }

  // The body of the one PushSubscription call in a response. A method-level
  // error throws a plain jmapError: the server refused the whole call, which
  // says nothing about any one subscription.
  private pushMethodResult<T>(response: JMAPResponse, method: string): T {
    const [name, body] = response.methodResponses?.[0] ?? [];
    if (name !== method) {
      const error = body as JmapErrorInfo | undefined;
      throw jmapError(`${method} failed: ${error?.description || error?.type || 'no response'}`, error);
    }
    return (body ?? {}) as T;
  }

  async listPushSubscriptions(): Promise<PushSubscription[]> {
    const emailPush = this.hasEmailPushCapability();
    // `emailPush` is not in the server's default property set, so ask for it
    // explicitly - but only where the server knows the property at all.
    const args: Record<string, unknown> = { ids: null };
    if (emailPush) {
      args.properties = ['id', 'deviceClientId', 'verificationCode', 'expires', 'types', 'emailPush'];
    }
    const response = await this.request(
      [['PushSubscription/get', args, '0']],
      this.pushUsing(emailPush),
    );
    // Throws rather than answering []: to web-push an empty list means "the
    // server dropped our subscription", which forgets a working registration.
    return this.pushMethodResult<{ list?: PushSubscription[] }>(response, 'PushSubscription/get').list ?? [];
  }

  async createPushSubscription(params: {
    deviceClientId: string;
    url: string;
    types: string[];
    expires?: string;
    emailPush?: Record<string, EmailPushConfig>;
  }): Promise<string> {
    const created: Record<string, unknown> = {
      deviceClientId: params.deviceClientId,
      url: params.url,
      types: params.types,
    };
    if (params.expires) created.expires = params.expires;
    const withEmailPush = !!params.emailPush && this.hasEmailPushCapability();
    if (withEmailPush) created.emailPush = params.emailPush;

    const response = await this.request(
      [['PushSubscription/set', { create: { new: created } }, '0']],
      this.pushUsing(withEmailPush),
    );
    const result = this.pushMethodResult<{
      created?: { new?: { id?: string } };
      notCreated?: { new?: JmapErrorInfo };
    }>(response, 'PushSubscription/set');
    // Stalwart refuses the whole emailPush map as `forbidden` when it names an
    // account the user doesn't own, and answers `overQuota` past its
    // subscription limit (15 per account by default).
    const refused = result.notCreated?.new;
    if (refused) {
      throw jmapSetError(
        `PushSubscription/set create failed: ${refused.description || refused.type || 'unknown error'}`,
        refused,
      );
    }
    const id = result.created?.new?.id;
    if (!id) throw new Error('PushSubscription/set create returned no id');
    return id;
  }

  async verifyPushSubscription(id: string, verificationCode: string): Promise<void> {
    const response = await this.request(
      [['PushSubscription/set', { update: { [id]: { verificationCode } } }, '0']],
      ['urn:ietf:params:jmap:core'],
    );
    const result = this.pushMethodResult<{ notUpdated?: Record<string, JmapErrorInfo> }>(
      response,
      'PushSubscription/set',
    );
    const refused = result.notUpdated?.[id];
    if (refused) {
      throw jmapSetError(
        `PushSubscription verification failed: ${refused.description || refused.type || 'unknown error'}`,
        refused,
      );
    }
  }

  // Throws when the server refuses the update: a jmapSetError with the
  // SetError type (`notFound` once the subscription is gone, `forbidden` for
  // an emailPush map naming an account the user may not subscribe to), a
  // plain error for anything that says nothing about the subscription.
  async updatePushSubscription(
    id: string,
    patch: { expires?: string; types?: string[]; emailPush?: Record<string, EmailPushConfig> | null },
  ): Promise<void> {
    const withEmailPush = patch.emailPush !== undefined && this.hasEmailPushCapability();
    const update: Record<string, unknown> = { ...patch };
    if (!withEmailPush) delete update.emailPush;
    const response = await this.request(
      [['PushSubscription/set', { update: { [id]: update } }, '0']],
      this.pushUsing(withEmailPush),
    );
    const result = this.pushMethodResult<{
      updated?: Record<string, unknown> | null;
      notUpdated?: Record<string, JmapErrorInfo>;
    }>(response, 'PushSubscription/set');
    const refused = result.notUpdated?.[id];
    if (refused) {
      throw jmapSetError(
        `PushSubscription/set update failed: ${refused.description || refused.type || 'unknown error'}`,
        refused,
      );
    }
    if (!result.updated || !(id in result.updated)) {
      throw new Error(`PushSubscription/set did not report ${id} as updated`);
    }
  }

  async destroyPushSubscription(id: string): Promise<void> {
    await this.request(
      [['PushSubscription/set', { destroy: [id] }, '0']],
      ['urn:ietf:params:jmap:core'],
    );
  }

  // ── Recover deleted items (Stalwart Enterprise, lib/recovery/archived-items.ts) ──

  advertisesArchivedItems(accountId?: string): boolean {
    return this.hasAccountCapability(STALWART_CAPABILITY, accountId || this.accountId);
  }

  /** Accounts whose server refused the `accountId` filter (every user without Impersonate). */
  private archiveFilterRefused = new Set<string>();

  /**
   * One page of the account's archived item ids, newest first. A request of
   * its own: without an Enterprise license Stalwart refuses it (`forbidden`),
   * and that must not take other calls down with it. The `accountId` filter
   * keeps an admin's answer to this account; a normal user is refused it
   * (`unsupportedFilter`) and asked again without it, once per account.
   */
  async queryArchivedItemIds(accountId?: string, options: { position?: number; limit?: number; calculateTotal?: boolean } = {}): Promise<ArchiveQueryPage> {
    const id = accountId || this.accountId;
    const args: Record<string, unknown> = { accountId: id };
    if (options.position) args.position = options.position;
    if (options.limit) args.limit = options.limit;
    if (options.calculateTotal) args.calculateTotal = true;
    const ask = async (filtered: boolean) => {
      const response = await this.request([["x:ArchivedItem/query", filtered ? { ...args, filter: { accountId: id } } : args, "q"]], ARCHIVED_ITEM_USING);
      return response.methodResponses?.[0] ?? [];
    };
    let [method, result] = await ask(!this.archiveFilterRefused.has(id));
    if (method === "error" && (result as JmapErrorInfo | undefined)?.type === "unsupportedFilter" && !this.archiveFilterRefused.has(id)) {
      this.archiveFilterRefused.add(id);
      [method, result] = await ask(false);
    }
    if (method !== "x:ArchivedItem/query") {
      const error = result as JmapErrorInfo | undefined;
      throw jmapError(error?.description || "Failed to list deleted items", error);
    }
    const { ids, total } = result as { ids?: unknown; total?: unknown };
    return {
      ids: Array.isArray(ids) ? ids.filter((v): v is string => typeof v === "string") : [],
      total: typeof total === "number" ? total : null,
    };
  }

  private archiveIo(accountId: string): ArchiveIo {
    return {
      query: (position, limit) => this.queryArchivedItemIds(accountId, { position, limit, calculateTotal: true }),
      get: async (ids) => {
        const calls: JMAPMethodCall[] = batched(ids, this.getMaxObjectsInGet())
          .map((batch, i): JMAPMethodCall => ["x:ArchivedItem/get", { accountId, ids: batch }, `g${i}`]);
        const list: unknown[] = [];
        for (const group of batched(calls, this.getMaxCallsInRequest())) {
          const response = await this.request(group, ARCHIVED_ITEM_USING);
          for (const [method, result] of response.methodResponses ?? []) {
            if (method !== "x:ArchivedItem/get") {
              const error = result as JmapErrorInfo | undefined;
              throw jmapError(error?.description || "Failed to read deleted items", error);
            }
            const items = (result as { list?: unknown }).list;
            if (Array.isArray(items)) list.push(...items);
          }
        }
        return list;
      },
    };
  }

  /** The account's deleted messages inside the days window, newest first, in pages (see listArchivedEmailsPaged). */
  async listArchivedEmails(accountId?: string, options: { days?: number; startPosition?: number } = {}): Promise<ArchiveListResult> {
    const id = accountId || this.accountId;
    return listArchivedEmailsPaged(this.archiveIo(id), id, { days: options.days ?? 0, startPosition: options.startPosition });
  }

  /** Whether at least one deleted message of the account is inside the days window. */
  async hasArchivedEmail(accountId?: string, options: { days?: number } = {}): Promise<boolean> {
    const id = accountId || this.accountId;
    return hasArchivedEmail(this.archiveIo(id), id, { days: options.days ?? 0 });
  }

  async restoreArchivedItems(ids: string[], accountId?: string): Promise<RestoreResult[]> {
    const id = accountId || this.accountId;
    const calls = buildRestoreCalls(ids, id, this.getMaxObjectsInSet());
    const results: RestoreResult[] = [];
    for (const group of batched(calls, this.getMaxCallsInRequest())) {
      try {
        const response = await this.request(group, ARCHIVED_ITEM_USING);
        results.push(...readRestoreResults(group, (response.methodResponses ?? []) as Array<[string, Record<string, unknown>, string]>));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        for (const [, args] of group) {
          results.push(...Object.keys(args.update as Record<string, unknown>).map((itemId) => ({ id: itemId, ok: false, error: reason })));
        }
      }
    }
    return results;
  }
}
