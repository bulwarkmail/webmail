import type { Calendar, CalendarPublishLink, CalendarPublishLinkAccess } from '@/lib/jmap/types';

/** Calendars the viewer may create/revoke publish links on. */
export function canManageCalendarPublishLinks(
  calendar: Calendar,
  isSubscriptionCalendar: boolean,
): boolean {
  if (isSubscriptionCalendar) return false;
  if (!calendar.isShared) return true;
  const rights = calendar.myRights;
  return !!(rights?.mayWriteAll || rights?.mayWriteOwn || rights?.mayShare);
}

/** Build the one-time subscribe URL shown after link creation. */
export function buildCalendarPublishLinkUrl(
  serverUrl: string,
  link: Pick<CalendarPublishLink, 'id' | 'access' | 'secret'>,
): string {
  const origin = serverUrl.replace(/\/+$/, '');
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
