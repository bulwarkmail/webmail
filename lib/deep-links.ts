/**
 * Deep links (permalinks) for every app surface.
 *
 * The app is a single client-side shell per surface, so the URL is not what
 * mounts a view - it is a serialisation of the view the user is looking at.
 * This module owns that serialisation in both directions:
 *
 *   build*  - view state  → app-relative path (`/mail/message/abc`)
 *   parse*  - route segments → a typed "intent" the surface applies on mount
 *
 * Paths produced here are *app-relative*: no locale prefix and no mount
 * prefix. Use `appPath()` (or `appUrl()` for something copyable) to turn one
 * into a real URL, so subpath deploys (NEXT_PUBLIC_BASE_PATH) and every
 * NEXT_PUBLIC_LOCALE_PREFIX mode are handled in exactly one place.
 *
 * Nothing here throws or 404s on bad input: an unparseable link resolves to
 * `null` and the surface falls back to its default view. Old links degrade,
 * they don't break.
 */

import { routing } from '@/i18n/routing';
import { getLocaleFromPath, getPathPrefix, withBasePath } from '@/lib/browser-navigation';
import {
  UNIFIED_MAILBOX_IDS,
  UNIFIED_ROLE_BY_ID,
  CROSS_VIEW_IDS,
  CROSS_VIEW_BY_ID,
  type Mailbox,
} from '@/lib/jmap/types';
import type { CalendarViewMode } from '@/stores/calendar-store';

/** Sentinel mailbox id for the virtual "Scheduled" view (see the mail page). */
export const SCHEDULED_MAILBOX_ID = '__scheduled__';

// ---------------------------------------------------------------------------
// URL assembly
// ---------------------------------------------------------------------------

/**
 * Turns an app-relative path into one the browser can navigate to, applying
 * the configured locale prefix and the deployment's mount prefix.
 *
 *   appPath('/mail/message/abc')              // prefix "never"  → /mail/message/abc
 *   appPath('/mail/message/abc', 'de')        // prefix "always" → /de/mail/message/abc
 *   appPath('/mail', 'en')                    // "as-needed", default locale → /mail
 *
 * `locale` defaults to the locale in the current URL, so callers in event
 * handlers don't have to thread it through.
 */
export function appPath(path: string, locale?: string): string {
  const normalized = path === '' ? '/' : path;
  const resolved = locale ?? getLocaleFromPath();
  let withLocale = normalized;

  if (routing.localePrefix === 'always') {
    withLocale = `/${resolved}${normalized === '/' ? '' : normalized}`;
  } else if (routing.localePrefix === 'as-needed' && resolved !== routing.defaultLocale) {
    withLocale = `/${resolved}${normalized === '/' ? '' : normalized}`;
  }

  return withBasePath(withLocale);
}

/**
 * Absolute URL for an app-relative path - what "Copy link" puts on the
 * clipboard. Falls back to the bare path during SSR, where there is no origin.
 */
export function appUrl(path: string, locale?: string): string {
  const resolved = appPath(path, locale);
  if (typeof window === 'undefined') return resolved;
  return `${window.location.origin}${resolved}`;
}

/** Percent-encodes an opaque id for use as a single path segment. */
function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A malformed %-sequence is a broken link, not a crash: use it verbatim
    // and let the surface's "not found" path handle it.
    return value;
  }
}

// ---------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------

/**
 * Readable aliases for folders that have no stable server-side id: the virtual
 * unified / cross-account views and the client-side Scheduled view.
 */
const VIRTUAL_FOLDER_ALIASES: Record<string, string> = {
  scheduled: SCHEDULED_MAILBOX_ID,
  'unified-inbox': UNIFIED_MAILBOX_IDS.inbox,
  'unified-sent': UNIFIED_MAILBOX_IDS.sent,
  'unified-drafts': UNIFIED_MAILBOX_IDS.drafts,
  'unified-trash': UNIFIED_MAILBOX_IDS.trash,
  'unified-archive': UNIFIED_MAILBOX_IDS.archive,
  'unified-junk': UNIFIED_MAILBOX_IDS.junk,
  'cross-unread': CROSS_VIEW_IDS.unread,
  'cross-starred': CROSS_VIEW_IDS.starred,
  'cross-all': CROSS_VIEW_IDS.all,
};

const VIRTUAL_ALIAS_BY_ID: Record<string, string> = Object.fromEntries(
  Object.entries(VIRTUAL_FOLDER_ALIASES).map(([alias, id]) => [id, alias]),
);

/** Mailbox roles that get a readable alias instead of their opaque JMAP id. */
const ALIASED_ROLES = new Set(['inbox', 'sent', 'drafts', 'trash', 'archive', 'junk']);

export type MailDeepLink =
  | { kind: 'folder'; ref: string; accountId?: string }
  | { kind: 'message'; id: string; accountId?: string; fullscreen?: boolean }
  | { kind: 'thread'; id: string; accountId?: string };

export interface MailLinkState {
  mailboxId: string | null;
  emailId: string | null;
  threadId: string | null;
}

/**
 * The URL-facing reference for a mailbox: a virtual alias, a role name, or the
 * raw JMAP id for custom folders (whose ids are the only thing that is stable).
 */
export function buildFolderRef(mailboxId: string, mailboxes: Mailbox[] = []): string {
  const virtual = VIRTUAL_ALIAS_BY_ID[mailboxId];
  if (virtual) return virtual;

  const mailbox = mailboxes.find((m) => m.id === mailboxId);
  // Shared folders carry another account's copy of a role (two "inbox" roles
  // in one list), so only the account's own folders may claim the role alias.
  if (mailbox?.role && ALIASED_ROLES.has(mailbox.role) && !mailbox.isShared) {
    return mailbox.role;
  }
  return mailboxId;
}

/**
 * Inverse of `buildFolderRef`. Returns null when the reference matches nothing
 * in this account - a link to a folder that was deleted or belongs elsewhere.
 *
 * Exact ids are checked before aliases so a custom folder whose id happens to
 * read like an alias still resolves to itself.
 */
export function resolveFolderRef(ref: string, mailboxes: Mailbox[] = []): string | null {
  const decoded = decodeSegment(ref);

  if (mailboxes.some((m) => m.id === decoded)) return decoded;

  const virtual = VIRTUAL_FOLDER_ALIASES[decoded];
  if (virtual) return virtual;

  if (ALIASED_ROLES.has(decoded)) {
    const byRole = mailboxes.find((m) => m.role === decoded && !m.isShared)
      ?? mailboxes.find((m) => m.role === decoded);
    if (byRole) return byRole.id;
    return null;
  }

  // Unknown id: the mailbox list may simply not be loaded yet, so hand it back
  // and let the caller decide (it re-runs once mailboxes arrive).
  return decoded || null;
}

/**
 * The canonical path for the current mail view. Returns `/mail` for the bare
 * list so the address bar stays clean when nothing is open.
 *
 * A thread wins over a single message: when the conversation view is open the
 * thread is what the user is looking at.
 */
export function buildMailPath(state: MailLinkState, mailboxes: Mailbox[] = []): string {
  if (state.threadId) return `/mail/thread/${encodeSegment(state.threadId)}`;
  if (state.emailId) return `/mail/message/${encodeSegment(state.emailId)}`;
  if (state.mailboxId) return `/mail/folder/${encodeSegment(buildFolderRef(state.mailboxId, mailboxes))}`;
  return '/mail';
}

/**
 * Parses the segments after `/mail`. Also accepts the legacy `?email=<id>`
 * query the push service worker used to emit, so notifications from an older
 * installed worker keep opening the right message.
 */
export function parseMailPath(
  segments: string[] = [],
  search?: URLSearchParams,
): MailDeepLink | null {
  const accountId = search?.get('account') ?? undefined;
  // `?view=fullscreen` asks for the message alone, no sidebar or list - what
  // a mail dragged out into a new browser tab opens as. The Pro shell always
  // opens message links as fullscreen email tabs and ignores the flag.
  const fullscreen = search?.get('view') === 'fullscreen' || undefined;
  const [kind, value] = segments;

  if (kind && value) {
    const id = decodeSegment(value);
    if (id) {
      if (kind === 'message') return { kind: 'message', id, accountId, fullscreen };
      if (kind === 'thread') return { kind: 'thread', id, accountId };
      if (kind === 'folder') return { kind: 'folder', ref: id, accountId };
    }
  }

  const legacyEmail = search?.get('email');
  if (legacyEmail) return { kind: 'message', id: legacyEmail, accountId };

  return null;
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

const CALENDAR_VIEWS: CalendarViewMode[] = ['month', 'week', 'day', 'agenda', 'tasks'];

export type CalendarDeepLink =
  | { kind: 'event'; id: string; accountId?: string }
  | { kind: 'view'; view: CalendarViewMode; date: Date | null };

export interface CalendarLinkState {
  view: CalendarViewMode;
  date: Date | null;
  eventId?: string | null;
  /** JMAP account owning the event - needed for shared/secondary calendars. */
  accountId?: string | null;
}

/** `YYYY-MM-DD` in local time - the date the user sees, not a UTC shift of it. */
export function formatLinkDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Parses `YYYY-MM-DD` as a local-midnight Date. Returns null if malformed. */
export function parseLinkDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  if (Number.isNaN(date.getTime())) return null;
  // Rejects impossible dates that Date silently rolls over (2026-02-31).
  if (date.getMonth() !== Number(m) - 1 || date.getDate() !== Number(d)) return null;
  return date;
}

export function buildCalendarPath(state: CalendarLinkState): string {
  if (state.eventId) {
    const path = `/calendar/event/${encodeSegment(state.eventId)}`;
    return state.accountId ? `${path}?account=${encodeURIComponent(state.accountId)}` : path;
  }
  if (!state.date) return `/calendar/${state.view}`;
  return `/calendar/${state.view}/${formatLinkDate(state.date)}`;
}

export function parseCalendarPath(
  segments: string[] = [],
  search?: URLSearchParams,
): CalendarDeepLink | null {
  const [first, second] = segments;
  if (!first) return null;

  if (first === 'event') {
    const id = second ? decodeSegment(second) : '';
    if (!id) return null;
    return { kind: 'event', id, accountId: search?.get('account') ?? undefined };
  }

  if ((CALENDAR_VIEWS as string[]).includes(first)) {
    return {
      kind: 'view',
      view: first as CalendarViewMode,
      date: second ? parseLinkDate(second) : null,
    };
  }

  // A bare date with no view (`/calendar/2026-08-06`) keeps the user's view.
  const date = parseLinkDate(first);
  if (date) return { kind: 'view', view: 'month', date };

  return null;
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export type ContactDeepLink =
  | { kind: 'contact'; id: string; edit: boolean; fromEmail: boolean }
  | { kind: 'create'; email?: string; name?: string; fromEmail: boolean };

export interface ContactLinkState {
  contactId: string | null;
  editing?: boolean;
}

export function buildContactsPath(state: ContactLinkState): string {
  if (!state.contactId) return '/contacts';
  const path = `/contacts/${encodeSegment(state.contactId)}`;
  return state.editing ? `${path}/edit` : path;
}

/**
 * Parses `/contacts/<id>[/edit]` plus the legacy query form the email viewer
 * used to build (`?contactId=`, `?addEmail=`, `?addName=`, `?from=email`).
 * Both are still emitted by plugins and bookmarks, so both are supported.
 */
export function parseContactsPath(
  segments: string[] = [],
  search?: URLSearchParams,
): ContactDeepLink | null {
  const fromEmail = search?.get('from') === 'email';
  const [first, second] = segments;

  if (first === 'new') {
    return {
      kind: 'create',
      email: search?.get('email') ?? search?.get('addEmail') ?? undefined,
      name: search?.get('name') ?? search?.get('addName') ?? undefined,
      fromEmail,
    };
  }

  if (first) {
    const id = decodeSegment(first);
    if (id) return { kind: 'contact', id, edit: second === 'edit', fromEmail };
  }

  const legacyId = search?.get('contactId');
  if (legacyId) {
    return { kind: 'contact', id: legacyId, edit: search?.get('view') === 'edit', fromEmail };
  }

  const addEmail = search?.get('addEmail');
  const addName = search?.get('addName');
  if (addEmail || addName) {
    return { kind: 'create', email: addEmail ?? undefined, name: addName ?? undefined, fromEmail };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export interface FilesDeepLink {
  /** Absolute folder path inside the drive, always leading-slashed. */
  path: string;
  /** File name to preview once the folder has loaded, if the link named one. */
  preview?: string;
}

export function buildFilesPath(currentPath: string, preview?: string | null): string {
  const parts = currentPath.split('/').filter(Boolean).map(encodeSegment);
  const base = parts.length > 0 ? `/files/${parts.join('/')}` : '/files';
  return preview ? `${base}?preview=${encodeURIComponent(preview)}` : base;
}

export function parseFilesPath(
  segments: string[] = [],
  search?: URLSearchParams,
): FilesDeepLink | null {
  const parts = segments.map(decodeSegment).filter(Boolean);
  const preview = search?.get('preview') ?? undefined;
  if (parts.length === 0 && !preview) return null;
  return { path: `/${parts.join('/')}`, preview };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function buildSettingsPath(tabId: string | null | undefined): string {
  return tabId ? `/settings/${encodeSegment(tabId)}` : '/settings';
}

/**
 * The tab id from `/settings/<tab>`. Validation against the real tab registry
 * is the settings page's job - it owns the list and the legacy-id migration.
 */
export function parseSettingsPath(segments: string[] = []): string | null {
  const [tab] = segments;
  return tab ? decodeSegment(tab) : null;
}

// ---------------------------------------------------------------------------
// Surface routing (shared by the Pro shell and the login round-trip)
// ---------------------------------------------------------------------------

export type AppSurface = 'mail' | 'calendar' | 'contacts' | 'files' | 'settings';

/**
 * Which surface an app-relative path belongs to, plus the segments after it.
 * `/` and `/mail` both mean mail; anything unrecognised returns null.
 */
export function matchSurface(
  path: string,
): { surface: AppSurface; segments: string[] } | null {
  let clean = path.split('?')[0].split('#')[0];

  // Accepts both app-relative paths and raw `window.location.pathname`, which
  // carries the mount prefix on subpath deployments.
  const prefix = getPathPrefix();
  if (prefix && (clean === prefix || clean.startsWith(`${prefix}/`))) {
    clean = clean.slice(prefix.length) || '/';
  }

  const parts = clean.split('/').filter(Boolean);

  // Drop a leading locale segment so this works under every prefix mode.
  if (parts.length > 0 && (routing.locales as readonly string[]).includes(parts[0])) {
    parts.shift();
  }

  if (parts.length === 0) return { surface: 'mail', segments: [] };

  const [head, ...rest] = parts;
  if (head === 'mail') return { surface: 'mail', segments: rest };
  if (head === 'calendar') return { surface: 'calendar', segments: rest };
  if (head === 'contacts') return { surface: 'contacts', segments: rest };
  if (head === 'files') return { surface: 'files', segments: rest };
  if (head === 'settings') return { surface: 'settings', segments: rest };
  return null;
}

/** Re-exported for callers that need to spot a virtual folder alias. */
export { UNIFIED_ROLE_BY_ID, CROSS_VIEW_BY_ID };
