/**
 * What the tray and the jump list show: recent unread mail, the newest conversations,
 * the next calendar event. Read with the same client calls as the rest of the app, so
 * the local store answers when it has them. No content while locked or where the
 * organisation keeps it off notifications.
 */

import { getDesktopBridge } from '@/lib/desktop/bridge';
import { contentHiddenFor } from '@/lib/desktop/mail-notifications';
import type { DesktopOsSummary, DesktopOsTrayMessage } from '@/lib/desktop/types';
import type { CalendarEvent, Email } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { loginFingerprint } from '@/lib/pwa-notify/login-fingerprint';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useEmailStore } from '@/stores/email-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useSettingsStore, type TimeFormat } from '@/stores/settings-store';

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

/** In the app's own time format (Settings > General), not the language's: 11:00, never 11:00 AM where the app shows 24 hours. */
export function formatEventTime(start: number, now: number, locale: string | undefined, timeFormat: TimeFormat = '24h'): string {
  const date = new Date(start);
  const sameDay = date.toDateString() === new Date(now).toDateString();
  const hour12 = timeFormat === '12h';
  const options: Intl.DateTimeFormatOptions = sameDay
    ? { hour: hour12 ? 'numeric' : '2-digit', minute: '2-digit', hour12 }
    : { weekday: 'short', hour: hour12 ? 'numeric' : '2-digit', minute: '2-digit', hour12 };
  return new Intl.DateTimeFormat(locale, options).format(date);
}

export async function readSummary(locale: string | undefined, now = Date.now()): Promise<DesktopOsSummary> {
  const auth = useAuthStore.getState();
  const client: IJMAPClient | null = auth.client;
  const entry = useAccountStore.getState().accounts.find((account) => account.id === auth.activeAccountId);
  if (!auth.isAuthenticated || !client || !entry || contentHiddenFor(entry.id)) return EMPTY_SUMMARY;

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
    if (next) nextEvent = { title: next.title ?? '', when: formatEventTime(eventStart(next), now, locale, useSettingsStore.getState().timeFormat) };
  }
  // The tray lists one account's inbox: with more than one, it says whose.
  const several = useAccountStore.getState().accounts.length > 1;
  return { unread, recent, nextEvent, ...(several && entry.username ? { account: entry.username } : {}) };
}

/** Keeps main's copy current: when the unread count moves, and now and then for the next event. */
export function startOsSummary(locale: () => string | undefined): { refresh: () => void; stop: () => void } {
  const os = getDesktopBridge()?.os;
  if (!os) return { refresh: () => {}, stop: () => {} };
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** A read under way when the account changed answers for the old one, and is dropped. */
  let generation = 0;

  const run = () => {
    timer = null;
    const mine = ++generation;
    void readSummary(locale()).then((summary) => {
      if (mine === generation) os.setSummary(summary);
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
    if (state.activeAccountId === previous.activeAccountId && state.isAuthenticated === previous.isAuthenticated) return;
    generation += 1;
    if (!state.isAuthenticated) os.setSummary(EMPTY_SUMMARY);
    refresh();
  });
  // An organisation turning sender and subject off goes for what's already showing, too.
  const stopPolicy = usePolicyStore.subscribe((state, previous) => {
    if (state.loaded !== previous.loaded || state.policy !== previous.policy) refresh();
  });
  const interval = setInterval(refresh, REFRESH_EVERY_MS);
  refresh();
  return {
    refresh,
    stop() {
      generation += 1;
      stopEmail();
      stopAuth();
      stopPolicy();
      clearInterval(interval);
      if (timer) clearTimeout(timer);
    },
  };
}
