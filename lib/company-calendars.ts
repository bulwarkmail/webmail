/**
 * Company calendars (organisation.calendars.feeds): ICS feeds the admin
 * lists, shown to every user in scope as read-only calendars under
 * "Organisation".
 *
 * They are virtual calendars in the browser, like the birthday calendar, not
 * calendars imported into each user's account (the subscription sync in
 * lib/calendar-subscription-sync.ts does that): nothing lands in anyone's
 * free/busy, removing a feed removes it everywhere at once, and Lite runs the
 * same code. What is reused from the subscriptions is the fetch (full
 * Bulwark: /api/fetch-ical, here by feed id so the address stays on the
 * server) and the parsing (CalendarEvent/parse on an uploaded blob, so there
 * is no ICS parser in the bundle).
 *
 * The upload quota (1000 files or 50 MB an hour on Stalwart) is spared: a
 * feed is fetched at most once per refresh interval (60 minutes or more),
 * its text is hashed and not uploaded again while it is unchanged, and the
 * parsed events are kept per account in IndexedDB, which a full sign-out
 * deletes. Uploads take the XHR path, so a 429 there doesn't freeze the rest
 * of the client.
 */

import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';
import type { CompanyFeed } from '@/lib/admin/organisation-policy';
import { apiFetch } from '@/lib/browser-navigation';
import { getActiveAccountSlotHeaders } from '@/lib/auth/active-account-slot';
import { IS_LITE } from '@/lib/lite';
import { onBeforeSignOut, onFullSignOut } from '@/lib/sign-out-cleanup';
import { useAccountStore } from '@/stores/account-store';
import { debug } from '@/lib/debug';

export const COMPANY_CALENDAR_PREFIX = '__company-calendar__:';

export function companyCalendarId(feedId: string): string {
  return `${COMPANY_CALENDAR_PREFIX}${feedId}`;
}

export function isCompanyCalendarId(id: string): boolean {
  return id.startsWith(COMPANY_CALENDAR_PREFIX);
}

export function feedIdOf(calendarId: string): string {
  return calendarId.slice(COMPANY_CALENDAR_PREFIX.length);
}

/** The read-only calendar a feed is shown as. */
export function createCompanyCalendar(feed: Pick<CompanyFeed, 'id' | 'name' | 'color'>): Calendar {
  return {
    id: companyCalendarId(feed.id),
    name: feed.name,
    description: null,
    color: feed.color || '#2563eb',
    sortOrder: 1000,
    isSubscribed: true,
    isVisible: true,
    isDefault: false,
    includeInAvailability: 'none',
    defaultAlertsWithTime: null,
    defaultAlertsWithoutTime: null,
    timeZone: null,
    shareWith: null,
    isCompany: true,
    myRights: {
      mayReadFreeBusy: true,
      mayReadItems: true,
      mayWriteAll: false,
      mayWriteOwn: false,
      mayUpdatePrivate: false,
      mayRSVP: false,
      mayShare: false,
      mayDelete: false,
    },
  };
}

/** The parsed events of a feed as events of its calendar: no attendees, nothing to answer. */
export function toCompanyEvents(feedId: string, parsed: Partial<CalendarEvent>[]): CalendarEvent[] {
  const calendarId = companyCalendarId(feedId);
  const events: CalendarEvent[] = [];
  parsed.forEach((event, index) => {
    if (typeof event.start !== 'string' || !event.start) return;
    const rest = { ...(event as Record<string, unknown>) };
    delete rest.method;
    events.push({
      ...(rest as Partial<CalendarEvent>),
      id: `company-${feedId}-${index}`,
      uid: event.uid || `company-${feedId}-${index}`,
      title: event.title || '',
      calendarIds: { [calendarId]: true },
      // A feed's ATTENDEE lines are someone else's invitation: shown as an
      // event, never as one to answer.
      participants: null,
      replyTo: null,
      organizerCalendarAddress: null,
      isDraft: false,
      isOrigin: false,
      alerts: null,
      useDefaultAlerts: false,
    } as CalendarEvent);
  });
  return events;
}

export interface FeedCacheEntry {
  /** SHA-256 of the feed text the events were parsed from. */
  hash: string;
  fetchedAt: number;
  events: Partial<CalendarEvent>[];
}

// ── IndexedDB, per account ──────────────────────────────────────────

/** Also deleted by name in lib/sign-out-cleanup.ts, whether this module was loaded or not. */
export const COMPANY_CALENDAR_DB = 'bulwark-company-calendars';
const DB_NAME = COMPANY_CALENDAR_DB;
const STORE = 'feeds';

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbGet(key: string): Promise<FeedCacheEntry | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      request.onsuccess = () => resolve((request.result as FeedCacheEntry | undefined) ?? null);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  }).finally(() => db.close()) as Promise<FeedCacheEntry | null>;
}

async function idbPut(key: string, value: FeedCacheEntry): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
  db.close();
}

async function idbDelete(match: (key: string) => boolean): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const request = store.getAllKeys();
      request.onsuccess = () => {
        for (const key of request.result) if (typeof key === 'string' && match(key)) store.delete(key);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
  db.close();
}

const memory = new Map<string, FeedCacheEntry>();

/** Drop every cached feed: on a full sign-out the events are the organisation's. */
export function clearCompanyCalendarCache(): void {
  memory.clear();
  inFlight.clear();
  if (typeof indexedDB === 'undefined') return;
  try {
    indexedDB.deleteDatabase(DB_NAME);
  } catch {
    /* storage unavailable */
  }
}

onFullSignOut(clearCompanyCalendarCache);

/** Drop one login's cached feeds (keys start with its address). */
export async function forgetCompanyCalendarsOf(username: string): Promise<void> {
  const prefix = `${username}|`;
  for (const key of [...memory.keys()]) if (key.startsWith(prefix)) memory.delete(key);
  await idbDelete((key) => key.startsWith(prefix));
}

// Signing one account out takes its cached feeds along.
onBeforeSignOut(async (accountId) => {
  if (accountId === 'all') return;
  const username = useAccountStore.getState().getAccountById(accountId)?.username;
  if (username) await forgetCompanyCalendarsOf(username);
});

/** The feed is gone for this user (removed, or no longer in their scope). */
class FeedGoneError extends Error {
  constructor(feedId: string) {
    super(`Company calendar ${feedId} is gone`);
    this.name = 'FeedGoneError';
  }
}

async function sha256(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  // No WebCrypto (an http origin): a plain string hash still tells a change.
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return `s${text.length}-${h}`;
}

/** The feed text: by id through the server in full Bulwark, from its address in Lite. */
async function fetchFeedText(feed: CompanyFeed): Promise<string> {
  const response = IS_LITE
    ? await fetch(feed.url, { headers: { Accept: 'text/calendar, application/ics, text/plain, */*' }, credentials: 'omit' })
    : await apiFetch('/api/fetch-ical', {
        method: 'POST',
        // The server resolves the feed against the active account's scopes:
        // name its sign-in slot, or it picks the first signed-in account.
        headers: { 'Content-Type': 'application/json', ...getActiveAccountSlotHeaders() },
        body: JSON.stringify({ feedId: feed.id }),
      });
  if (response.status === 404 || response.status === 410) throw new FeedGoneError(feed.id);
  if (!response.ok) throw new Error(`Company calendar ${feed.id}: ${response.status}`);
  return response.text();
}

type FeedClient = Pick<IJMAPClient, 'uploadBlob' | 'parseCalendarEvents' | 'getCalendarsAccountId'>;

const inFlight = new Map<string, Promise<Partial<CalendarEvent>[]>>();

/**
 * The parsed events of one feed for one account: from the cache while it is
 * fresh, else fetched, and parsed again only when the text changed. A feed
 * that can't be fetched keeps what was cached. Never rejects.
 */
export function loadFeedEvents(client: FeedClient, accountKey: string, feed: CompanyFeed, now = Date.now()): Promise<Partial<CalendarEvent>[]> {
  const key = `${accountKey}|${feed.id}`;
  const running = inFlight.get(key);
  if (running) return running;
  const work = (async () => {
    const cached = memory.get(key) ?? (await idbGet(key));
    if (cached) memory.set(key, cached);
    if (cached && now - cached.fetchedAt < feed.refreshMinutes * 60_000) return cached.events;
    try {
      const text = await fetchFeedText(feed);
      const hash = await sha256(text);
      let events = cached?.events ?? [];
      if (!cached || cached.hash !== hash) {
        const accountId = client.getCalendarsAccountId();
        const file = new File([text], 'company-calendar.ics', { type: 'text/calendar' });
        // The XHR path (progress callback): a 429 is this upload's alone.
        const uploaded = await client.uploadBlob(file, { accountId, onProgress: () => {} });
        events = await client.parseCalendarEvents(accountId, uploaded.blobId);
      }
      const entry: FeedCacheEntry = { hash, fetchedAt: now, events };
      memory.set(key, entry);
      await idbPut(key, entry);
      return events;
    } catch (error) {
      // A feed the server no longer gives this user takes its events along;
      // one that is only down keeps showing what it had.
      if (error instanceof Error && error.name === 'FeedGoneError') {
        memory.delete(key);
        await idbDelete((k) => k === key);
        return [];
      }
      debug.warn('calendar', 'Company calendar could not be refreshed', { feed: feed.id, error });
      return cached?.events ?? [];
    }
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, work);
  return work;
}

/** For tests. */
export function resetCompanyCalendarMemory(): void {
  memory.clear();
  inFlight.clear();
}
