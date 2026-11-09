/**
 * The organisation announcement (policy.json `organisation.announcement`,
 * enterprise pack item 10): which text a user sees, whether it is showing
 * right now, when that changes next, and the dismissal memory. The banner
 * itself is components/org/org-announcement.tsx.
 *
 * Dismissal is kept per account in localStorage under the announcement's
 * id and a hash of its content, so an edited announcement shows again.
 * Lite has no settings sync, so a synced setting would behave differently
 * there; localStorage works the same in both builds.
 */

import type { OrganisationPolicy } from '@/lib/admin/organisation-policy';

export type Announcement = OrganisationPolicy['announcement'];

/**
 * The text for `locale`: the exact locale, then its language (pt-BR → pt),
 * then the admin's fallback locale, then the first text there is. '' when
 * the announcement has no text.
 */
export function announcementText(announcement: Announcement | undefined | null, locale: string): string {
  const text = announcement?.text ?? {};
  const entries = Object.entries(text).filter(([, value]) => typeof value === 'string' && value.trim() !== '');
  if (entries.length === 0) return '';
  const find = (code: string | undefined) => {
    if (!code) return undefined;
    const lower = code.toLowerCase();
    return entries.find(([key]) => key.toLowerCase() === lower)?.[1];
  };
  const language = locale.split('-')[0];
  return find(locale)
    ?? find(language)
    ?? entries.find(([key]) => key.split('-')[0].toLowerCase() === language.toLowerCase())?.[1]
    ?? find(announcement?.fallbackLocale)
    ?? entries[0][1];
}

function time(value: string | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/** Whether the announcement is inside its start and end time at `now`. */
export function announcementActive(announcement: Announcement | undefined | null, now: number): boolean {
  if (!announcement) return false;
  const start = time(announcement.startsAt);
  const end = time(announcement.endsAt);
  if (start !== null && now < start) return false;
  if (end !== null && now >= end) return false;
  return true;
}

/**
 * The next moment the announcement starts or ends after `now`, or null
 * when nothing changes any more. The banner sets a timer for it, so it
 * appears and goes away on time without a reload.
 */
export function nextAnnouncementChange(announcement: Announcement | undefined | null, now: number): number | null {
  if (!announcement) return null;
  const times = [time(announcement.startsAt), time(announcement.endsAt)].filter((t): t is number => t !== null && t > now);
  return times.length > 0 ? Math.min(...times) : null;
}

/**
 * FNV-1a over what the message says: a new text or severity is a new
 * announcement for dismissals. Moving its start or end isn't; whoever
 * closed it keeps it closed.
 */
export function announcementHash(announcement: Announcement): string {
  const content = JSON.stringify([
    Object.entries(announcement.text ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    announcement.severity,
  ]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** What a dismissal remembers: the id and the content hash. */
export function announcementKey(announcement: Announcement): string {
  return `${announcement.id}:${announcementHash(announcement)}`;
}

export const DISMISSED_PREFIX = 'bulwark.announcement.dismissed.';

function storageKey(accountId: string | null | undefined): string {
  return `${DISMISSED_PREFIX}${accountId || 'default'}`;
}

/** Whether this account dismissed exactly this announcement. */
export function isAnnouncementDismissed(announcement: Announcement, accountId: string | null | undefined): boolean {
  try {
    return localStorage.getItem(storageKey(accountId)) === announcementKey(announcement);
  } catch {
    return false;
  }
}

/** Remembers the dismissal for this account; a later edit shows the announcement again. */
export function dismissAnnouncement(announcement: Announcement, accountId: string | null | undefined): void {
  try {
    localStorage.setItem(storageKey(accountId), announcementKey(announcement));
  } catch {
    // Storage blocked: the banner stays closed until the page reloads.
  }
}

/** Same link pattern as the plain-text reader (lib/email-sanitization.ts plainTextToSafeHtml). */
const URL_RE = /https?:\/\/[^\s<>"']+/g;
// A sentence ending right after a link keeps its full stop.
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/;

export type AnnouncementPart = { kind: 'text'; text: string } | { kind: 'link'; href: string };

/** The text split into plain parts and links, for React nodes (no HTML is ever built from it). */
export function announcementParts(text: string): AnnouncementPart[] {
  const parts: AnnouncementPart[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    let href = match[0];
    const trailing = href.match(TRAILING_PUNCTUATION)?.[0] ?? '';
    if (trailing) href = href.slice(0, -trailing.length);
    if (start > last) parts.push({ kind: 'text', text: text.slice(last, start) });
    parts.push({ kind: 'link', href });
    last = start + href.length;
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
  return parts;
}
