import type { Calendar, CalendarPublishLink, CalendarPublishLinkAccess } from '@/lib/jmap/types';

/** Calendars the viewer may create/revoke publish links on. */
export function canManageCalendarPublishLinks(
  calendar: Calendar,
  isSubscriptionCalendar: boolean,
): boolean {
  if (isSubscriptionCalendar) return false;
  if (!calendar.isShared) return true;
  // Publishing a link exposes the whole calendar externally, so it requires
  // sharing rights specifically — write access to one's own or all items is
  // not sufficient (a participant who can only add events shouldn't be able
  // to make the entire calendar's contents public).
  return !!calendar.myRights?.mayShare;
}

/** Resolve the subscribe URL for a publish link (prefer server-provided url on create). */
export function resolveCalendarPublishLinkUrl(
  serverUrl: string,
  link: Pick<CalendarPublishLink, 'id' | 'access' | 'secret' | 'url'>,
): string {
  if (link.url) {
    return link.url;
  }
  return buildCalendarPublishLinkUrl(serverUrl, link);
}

/** Build subscribe URL from link id (fallback when server omits url). */
export function buildCalendarPublishLinkUrl(
  serverUrl: string,
  link: Pick<CalendarPublishLink, 'id' | 'access' | 'secret'>,
): string {
  // serverUrl isn't guaranteed to include a scheme (e.g. demo mode's
  // 'demo.example.com') — default to https so the subscribe URL is usable.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(serverUrl) ? serverUrl : `https://${serverUrl}`;
  const origin = withScheme.replace(/\/+$/, '');
  if (link.access === 'public') {
    return `${origin}/ics/public/${encodeURIComponent(link.id)}.ics`;
  }
  if (!link.secret) {
    throw new Error('Private publish link is missing secret');
  }
  return `${origin}/ics/${encodeURIComponent(link.id)}/${encodeURIComponent(link.secret)}.ics`;
}

export function calendarPublishLinkAccessLabel(
  access: CalendarPublishLinkAccess,
  t: (key: string) => string,
): string {
  return access === 'public' ? t('access_public') : t('access_private');
}
