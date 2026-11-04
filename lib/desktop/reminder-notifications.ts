/**
 * Calendar reminders as native notifications, and what their buttons do.
 *
 * A toast may be clicked a day later and after a restart, so what it hands back says
 * which login and which reminder and no more: the rest comes from the store. Main keeps
 * pause, quiet hours and the OS's Do Not Disturb. Nothing about the event goes to main at
 * all while the app is locked, or when the organisation says so for that login
 * (pushWithoutContent, the rule new mail follows).
 */

import { announceAcknowledged } from '@/lib/calendar-reminders/channel';
import { pokeReminders, useMissedReminders } from '@/lib/calendar-reminders/state';
import { getDesktopBridge } from '@/lib/desktop/bridge';
import { isAppLocked } from '@/lib/desktop/app-lock-state';
import type { DesktopOsNotification, DesktopOsNotifyResult } from '@/lib/desktop/types';
import { contentHiddenFor } from '@/lib/desktop/mail-notifications';
import { joinLinkFrom } from '@/lib/event-links';
import { openExternalLink, resolveExternalLink } from '@/lib/plugin-hook-result';
import { loginFingerprint } from '@/lib/pwa-notify/login-fingerprint';
import { getStore } from '@/lib/store/client/api';
import type { MissedBatch, ReminderAlert } from '@/lib/store/reminders/ledger';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';

export const SNOOZE_MINUTES = [5, 10, 15] as const;
const SNOOZE_PREFIX = 'snooze-';
const JOIN = 'join';
const OPEN = 'open';
/** How many titles a summary names. */
const SUMMARY_TITLES = 3;

export interface ReminderLabels {
  /** Says nothing about the event. */
  generic: string;
  /** "In 10 min · Personal". */
  when: (alert: ReminderAlert) => string;
  untitled: string;
  snooze: (minutes: number) => string;
  /** Five buttons in a row on a Windows toast: three "Snooze..." would all cut off. */
  snoozeShort: (minutes: number) => string;
  open: string;
  join: string;
  /** Join a link to no service this app knows: says where it goes. */
  joinHost: (host: string) => string;
  missedTitle: (count: number) => string;
  missedMore: (count: number) => string;
}

export interface ReminderToastContext {
  /** The reminder. */
  r?: string;
  /** The summary. */
  rb?: number;
  /** No store to ask: the click only goes to the calendar. */
  cal?: boolean;
  slot?: number;
  login?: string;
}

async function loginOf(account: string): Promise<Pick<ReminderToastContext, 'slot' | 'login'>> {
  const entry = useAccountStore.getState().accounts.find((candidate) => candidate.id === account);
  if (!entry) return {};
  return { slot: entry.cookieSlot, login: await loginFingerprint(entry.serverUrl, entry.username) };
}

export function joinLabel(alert: Pick<ReminderAlert, 'joinHost'>, labels: Pick<ReminderLabels, 'join' | 'joinHost'>): string {
  return alert.joinHost ? labels.joinHost(alert.joinHost) : labels.join;
}

function reminderId(alert: ReminderAlert): string {
  // Main drops an id it saw in the last few minutes, and a snooze can be shorter.
  return `reminder:${alert.key}${alert.snoozedUntil ? `:${alert.snoozedUntil}` : ''}`;
}

export async function buildReminderNotification(account: string, alert: ReminderAlert, labels: ReminderLabels, sound: boolean): Promise<DesktopOsNotification> {
  const base = { group: 'reminders', kind: 'reminder' as const, sound };
  // Not even the uid. Two at the same moment are one "you have a reminder".
  if (isAppLocked()) return { ...base, id: `reminder-locked:${alert.fireTimeMs}`, title: labels.generic, body: '', context: '' };
  const context: ReminderToastContext = { r: alert.key, ...(await loginOf(account)) };
  const short = getDesktopBridge()?.platform === 'win32';
  const actions = [
    ...(alert.joinUrl ? [{ id: JOIN, label: joinLabel(alert, labels) }] : []),
    { id: OPEN, label: labels.open },
    ...SNOOZE_MINUTES.map((minutes) => ({ id: `${SNOOZE_PREFIX}${minutes}`, label: short ? labels.snoozeShort(minutes) : labels.snooze(minutes) })),
  ];
  const hidden = contentHiddenFor(account);
  return {
    ...base,
    id: reminderId(alert),
    title: hidden ? labels.generic : alert.title || labels.untitled,
    body: hidden ? '' : labels.when(alert),
    context: JSON.stringify(context),
    actions,
  };
}

/** The first few titles of a summary, for a place too small for all of them. */
export function missedBody(alerts: readonly ReminderAlert[], labels: Pick<ReminderLabels, 'untitled' | 'missedMore'>): string {
  const named = alerts.slice(0, SUMMARY_TITLES).map((alert) => alert.title || labels.untitled).join(', ');
  const more = alerts.length - SUMMARY_TITLES;
  return more > 0 ? `${named}, ${labels.missedMore(more)}` : named;
}

export async function buildMissedNotification(account: string, batch: MissedBatch, labels: ReminderLabels): Promise<DesktopOsNotification> {
  const context: ReminderToastContext = { rb: batch.batch, ...(await loginOf(account)) };
  return {
    id: `reminder-missed:${batch.batch}`,
    group: 'reminders',
    kind: 'reminder',
    title: labels.missedTitle(batch.alerts.length),
    body: contentHiddenFor(account) ? '' : missedBody(batch.alerts, labels),
    context: JSON.stringify(context),
  };
}

export interface PlainReminder {
  key: string;
  fireTimeMs: number;
  title: string;
  body: string;
  sound: boolean;
}

/**
 * Without a store: says so, with nothing to snooze. A click goes to the calendar.
 * Resolves to main's answer, which also says whether a sound is in order.
 */
export function notifyWithoutStore(reminder: PlainReminder, labels: { generic: string }, account: string | null): Promise<DesktopOsNotifyResult | undefined> {
  const hidden = contentHiddenFor(account);
  const request = getDesktopBridge()?.os?.notify({
    // The key holds the event's id, and nothing about the event should get out now.
    id: hidden ? `reminder-hidden:${reminder.fireTimeMs}` : `reminder:${reminder.key}`,
    group: 'reminders',
    kind: 'reminder',
    title: hidden ? labels.generic : reminder.title,
    body: hidden ? '' : reminder.body,
    context: JSON.stringify({ cal: true } satisfies ReminderToastContext),
    sound: reminder.sound,
  });
  return (request ?? Promise.resolve(undefined)).catch(() => undefined);
}

async function accountOf(context: ReminderToastContext): Promise<string | null> {
  if (context.slot === undefined || !context.login) return null;
  const entry = useAccountStore.getState().accounts.find((account) => account.cookieSlot === context.slot);
  if (!entry || (await loginFingerprint(entry.serverUrl, entry.username)) !== context.login) return null;
  return entry.id;
}

/** Goes to the event when it's in the account on screen, otherwise to the calendar. */
export function calendarPathFor(account: string, alert: ReminderAlert | null): string | null {
  if (!alert || alert.kind !== 'event' || useAuthStore.getState().activeAccountId !== account) return null;
  const query = alert.calendarId ? `?calendar=${encodeURIComponent(alert.calendarId)}` : '';
  return `/calendar/event/${encodeURIComponent(alert.baseEventId)}${query}`;
}

/**
 * Opens a meeting the way every link in the app opens, past any link check a plugin has.
 * Resolves true when it opened. Only web links get this far, whatever the store holds.
 */
export async function joinMeeting(url: string): Promise<boolean> {
  const link = joinLinkFrom(url);
  if (!link) return false;
  const shell = getDesktopBridge()?.shell;
  if (!shell) return openExternalLink({ href: link.url });
  const target = await resolveExternalLink({ href: link.url });
  if (!target || !joinLinkFrom(target)) return false;
  shell.openExternal(target);
  return true;
}

export function dismissReminders(account: string, keys: string[]): void {
  announceAcknowledged(keys);
  void getStore().area(account, 'reminders.dismiss', { keys }).catch(() => {});
}

export async function snoozeReminder(account: string, key: string, minutes: number): Promise<void> {
  announceAcknowledged([key]);
  await getStore().area<boolean>(account, 'reminders.snooze', { key, minutes });
  pokeReminders();
}

export interface ReminderCommandEnv {
  leaveFor: (path: '/calendar') => void | Promise<void>;
  push: (path: string) => void;
}

function parse(raw: string): ReminderToastContext | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ReminderToastContext;
    return parsed && typeof parsed === 'object' && (parsed.r !== undefined || parsed.rb !== undefined || parsed.cal) ? parsed : null;
  } catch {
    return null;
  }
}

function snoozeMinutes(action: string): number | null {
  if (!action.startsWith(SNOOZE_PREFIX)) return null;
  const minutes = Number(action.slice(SNOOZE_PREFIX.length));
  return (SNOOZE_MINUTES as readonly number[]).includes(minutes) ? minutes : null;
}

/** Whether this click was a reminder's. Buttons that only do something don't bring the window up. */
export async function handleReminderCommand(action: string, rawContext: string, env: ReminderCommandEnv): Promise<boolean> {
  const context = parse(rawContext);
  if (!context) return false;
  const account = await accountOf(context);
  const show = () => getDesktopBridge()?.windows?.focus?.();

  if (context.rb !== undefined) {
    show();
    const alerts = account ? await getStore().area<ReminderAlert[]>(account, 'reminders.batch', { batch: context.rb }).catch(() => []) : [];
    if (account && alerts.length > 0) useMissedReminders.getState().show(account, alerts);
    else await env.leaveFor('/calendar');
    return true;
  }

  const key = context.r;
  const minutes = snoozeMinutes(action);
  if (minutes !== null && account && key) {
    await snoozeReminder(account, key, minutes);
    return true;
  }

  const alert = account && key ? await getStore().area<ReminderAlert | null>(account, 'reminders.get', { key }).catch(() => null) : null;
  if (action === JOIN && alert?.joinUrl) {
    if (await joinMeeting(alert.joinUrl)) {
      dismissReminders(account!, [alert.key]);
    } else {
      show();
    }
    return true;
  }

  // Open, a click on the toast, or a button that can't be carried out any more.
  show();
  await env.leaveFor('/calendar');
  const path = account ? calendarPathFor(account, alert) : null;
  if (path) env.push(path);
  if (account && alert) dismissReminders(account, [alert.key]);
  return true;
}
