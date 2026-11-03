/**
 * What the tray and the jump list show: recent unread mail, the newest conversations,
 * the next calendar event. Read with the same client calls as the rest of the app, so
 * the local store answers when it has them. No content while locked or where the
 * organisation keeps it off notifications.
 */

import { getDesktopBridge } from '@/lib/desktop/bridge';
import { isAppLocked } from '@/lib/desktop/app-lock-state';
import type { DesktopOsSummary, DesktopOsTrayMessage } from '@/lib/desktop/types';
import { devicesForAccount } from '@/lib/device-policy';
import type { CalendarEvent, Email } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { loginFingerprint } from '@/lib/pwa-notify/login-fingerprint';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useEmailStore } from '@/stores/email-store';

const ROWS = 5;
const REFRESH_DELAY_MS = 2000;
const REFRESH_EVERY_MS = 5 * 60 * 1000;
const EVENT_WINDOW_MS = 24 * 60 * 60 * 1000;

export const EMPTY_SUMMARY: DesktopOsSummary = { unread: [], recent: [], nextEvent: null };

export function eventStart(event: CalendarEvent): number {
  return new Date(event.utcStart ?? event.start).getTime();
}

/** The soonest event still ahead, leaving out cancelled ones. */
export function nextEventOf(events: readonly CalendarEvent[], now: number): CalendarEvent | null {
  const ahead = events
    .filter((event) => event.status !== 'cancelled' && !event.showWithoutTime && eventStart(event) >= now)
    .sort((a, b) => eventStart(a) - eventStart(b));
  return ahead[0] ?? null;
}

export function formatEventTime(start: number, now: number, locale: string | undefined): string {
  const date = new Date(start);
  const sameDay = date.toDateString() === new Date(now).toDateString();
  const options: Intl.DateTimeFormatOptions = sameDay
    ? { hour: 'numeric', minute: '2-digit' }
    : { weekday: 'short', hour: 'numeric', minute: '2-digit' };
  return new Intl.DateTimeFormat(locale, options).format(date);
}

export async function readSummary(locale: string | undefined, now = Date.now()): Promise<DesktopOsSummary> {
  if (isAppLocked()) return EMPTY_SUMMARY;
  const auth = useAuthStore.getState();
  const client: IJMAPClient | null = auth.client;
  const entry = useAccountStore.getState().accounts.find((account) => account.id === auth.activeAccountId);
  if (!auth.isAuthenticated || !client || !entry) return EMPTY_SUMMARY;
  if (devicesForAccount(entry.id).pushWithoutContent) return EMPTY_SUMMARY;

  const inbox = useEmailStore.getState().mailboxes.find((mailbox) => mailbox.role === 'inbox' && !mailbox.isShared);
  let unread: DesktopOsTrayMessage[] = [];
  let recent: DesktopOsTrayMessage[] = [];
  if (inbox) {
    const accountId = client.getAccountId();
    const login = await loginFingerprint(entry.serverUrl, entry.username);
    const row = (email: Email): DesktopOsTrayMessage => ({
      emailId: email.id,
      accountId,
      sender: email.from?.[0]?.name || email.from?.[0]?.email || '',
      subject: email.subject ?? '',
      context: JSON.stringify({ emailId: email.id, threadId: email.threadId, accountId, slot: entry.cookieSlot, login }),
    });
    const [unreadList, recentList] = await Promise.all([
      client.getEmails(inbox.originalId || inbox.id, undefined, ROWS, 0, undefined, false, { notKeyword: '$seen' }),
      client.getEmails(inbox.originalId || inbox.id, undefined, ROWS),
    ]);
    unread = unreadList.emails.map(row);
    recent = recentList.emails.map(row);
  }

  let nextEvent: DesktopOsSummary['nextEvent'] = null;
  if (useCalendarStore.getState().supportsCalendar) {
    const events = await client.queryCalendarEvents({
      after: new Date(now).toISOString(),
      before: new Date(now + EVENT_WINDOW_MS).toISOString(),
    }).catch(() => [] as CalendarEvent[]);
    const next = nextEventOf(events, now);
    if (next) nextEvent = { title: next.title ?? '', when: formatEventTime(eventStart(next), now, locale) };
  }
  return { unread, recent, nextEvent };
}

/** Keeps main's copy current: when the unread count moves, and now and then for the next event. */
export function startOsSummary(locale: () => string | undefined): { refresh: () => void; stop: () => void } {
  const os = getDesktopBridge()?.os;
  if (!os) return { refresh: () => {}, stop: () => {} };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stale = false;

  const run = () => {
    timer = null;
    void readSummary(locale()).then((summary) => {
      if (!stale) os.setSummary(summary);
    }, (error) => {
      console.warn('Could not read the tray summary:', error);
    });
  };
  const refresh = () => {
    timer ??= setTimeout(run, REFRESH_DELAY_MS);
  };
  const inboxUnread = () => useEmailStore.getState().mailboxes.find((mailbox) => mailbox.role === 'inbox' && !mailbox.isShared)?.unreadEmails ?? -1;
  let lastUnread = inboxUnread();
  const stopEmail = useEmailStore.subscribe(() => {
    const current = inboxUnread();
    if (current === lastUnread) return;
    lastUnread = current;
    refresh();
  });
  const stopAuth = useAuthStore.subscribe((state, previous) => {
    if (state.activeAccountId !== previous.activeAccountId || state.isAuthenticated !== previous.isAuthenticated) refresh();
  });
  const interval = setInterval(refresh, REFRESH_EVERY_MS);
  refresh();
  return {
    refresh,
    stop() {
      stale = true;
      stopEmail();
      stopAuth();
      clearInterval(interval);
      if (timer) clearTimeout(timer);
    },
  };
}
