/**
 * Out-of-office blocks the calendar.
 *
 * While an out-of-office reply with a start and an end is on, Bulwark keeps
 * one busy event for it in the account's default calendar. The event is
 * found again by a fixed UID per account (`bulwark-ooo-<accountId>`; 0.16
 * rejects vendor properties, a UID survives every CalDAV client). It is
 * timed, or all-day when both ends are midnight in the user's time zone;
 * busy, public, without participants, and never sends invitations.
 *
 * The event is Bulwark's while its times are the ones Bulwark last wrote
 * (kept in the settings, per account) or the reply's dates before the change
 * at hand. That second rule works on any device and for anyone who changes
 * the reply (a delegate, the owner), also where the settings don't sync
 * (Lite, sync off). The event also carries the keyword OOO_KEYWORD (a
 * CATEGORIES value, which 0.16 and 1.0 both keep): on a device with no
 * record, a marked event found when the reply is loaded counts as Bulwark's.
 * When none of these hold, someone edited it, and Bulwark leaves it alone. Switching the reply or the block off removes an
 * event that hasn't started and ends one that has at once; a reply that
 * simply ran out leaves its past event in place. An event deleted elsewhere
 * is not put back until the reply's dates change.
 *
 * The sync runs after a save (the settings page and plugins both save
 * through stores/vacation-store.ts) when the switch, the dates or the
 * subject changed, debounced, one at a time, and once per page load and
 * account when the reply is loaded (it may have been set in another
 * client). A reply another client set up under a Sieve script of its own is
 * invisible to VacationResponse, so it can't be followed.
 */

import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';
import { fromWallClock, getEffectiveTimeZone, getWallClock, parseLocalDateTime } from '@/lib/timezone';
import { parseDurationSeconds } from '@/lib/calendar-event-normalization';
import { parseScript } from '@/lib/sieve/parser';
import { VACATION_SCRIPT_NAME } from '@/lib/sieve/generator';
import { supportsInclude } from '@/lib/filters/account-filters';
import { useSettingsStore } from '@/stores/settings-store';
import { usePolicyStore } from '@/stores/policy-store';
import { debug } from '@/lib/debug';

export const OOO_UID_PREFIX = 'bulwark-ooo-';
export const SYNC_DEBOUNCE_MS = 1500;

/** The keyword (iCalendar CATEGORIES) on the busy event. */
export const OOO_KEYWORD = 'bulwark-out-of-office';

export function oooUid(accountId: string): string {
  return `${OOO_UID_PREFIX}${accountId}`;
}

/** What the vacation response says, as far as the block cares. */
export interface ReplyState {
  isEnabled: boolean;
  fromDate: string | null;
  toDate: string | null;
  subject: string;
}

/** The times Bulwark last wrote to the event, as ISO instants. */
export interface WrittenBlock {
  start: string;
  end: string;
}

export type BlockDecision =
  | { action: 'none' }
  | { action: 'create'; start: Date; end: Date }
  | { action: 'update'; start: Date; end: Date }
  | { action: 'destroy' }
  | { action: 'end-now'; end: Date };

export interface DecisionInput {
  /** Block my calendar (the setting, or the organisation's lock). */
  block: boolean;
  reply: ReplyState;
  /** The event with our UID, as instants; null when there is none. */
  event: { start: Date; end: Date } | null;
  last: WrittenBlock | null;
  /** The reply's dates before the change being synced; null when unknown (a load). */
  previous?: Pick<ReplyState, 'fromDate' | 'toDate'> | null;
  /** The event carries OOO_KEYWORD. */
  marked?: boolean;
  now: Date;
  /** `save`: the reply or the block just changed here. `load`: the reply was read. */
  trigger: 'save' | 'load';
}

const same = (a: Date, b: string | Date) => a.getTime() === (typeof b === 'string' ? Date.parse(b) : b.getTime());

/** What to do with the busy event, by the rules in the module comment. */
export function decideBlock(input: DecisionInput): BlockDecision {
  const { reply, event, last, now } = input;
  const from = reply.fromDate ? new Date(reply.fromDate) : null;
  const to = reply.toDate ? new Date(reply.toDate) : null;
  const datesUsable = !!from && !!to && !Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime()) && to > from;
  const wanted = input.block && reply.isEnabled && datesUsable;
  const ranOut = reply.isEnabled && !!to && to <= now;

  if (event) {
    const matchesLast = !!last && same(event.start, last.start) && same(event.end, last.end);
    const matchesPrevious = !!input.previous?.fromDate && !!input.previous.toDate
      && same(event.start, input.previous.fromDate) && same(event.end, input.previous.toDate);
    const markedOnLoad = !last && !!input.marked && input.trigger === 'load';
    if (!matchesLast && !matchesPrevious && !markedOnLoad) {
      // Set up or changed by someone else: left alone.
      return { action: 'none' };
    }
    if (wanted) {
      if (ranOut) return { action: 'none' };
      if (same(event.start, from!) && same(event.end, to!)) return { action: 'none' };
      return { action: 'update', start: from!, end: to! };
    }
    // A reply that ran out leaves its past event; so does any past event.
    if (ranOut || event.end <= now) return { action: 'none' };
    if (event.start > now) return { action: 'destroy' };
    return { action: 'end-now', end: now };
  }

  if (!wanted || ranOut) return { action: 'none' };
  if (input.trigger === 'load' && last && same(from!, last.start) && same(to!, last.end)) {
    // It was there for these dates and someone deleted it: that sticks.
    return { action: 'none' };
  }
  return { action: 'create', start: from!, end: to! };
}

/** ISO 8601 duration of a span, in days, hours and minutes. */
export function isoDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const time = `${hours ? `${hours}H` : ''}${minutes ? `${minutes}M` : ''}`;
  if (!days && !time) return 'PT0S';
  return `P${days ? `${days}D` : ''}${time ? `T${time}` : ''}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The event's time fields for a span: all-day when both ends are midnight in
 * `timeZone` (whole days stay whole for people in other zones), timed in the
 * zone otherwise.
 */
export function blockTimes(start: Date, end: Date, timeZone: string): Pick<CalendarEvent, 'start' | 'duration' | 'timeZone' | 'showWithoutTime'> {
  const a = getWallClock(start, timeZone);
  const b = getWallClock(end, timeZone);
  const midnight = (w: typeof a) => w.hour === 0 && w.minute === 0 && w.second === 0;
  if (midnight(a) && midnight(b)) {
    const days = Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86400000);
    return { start: `${a.year}-${pad(a.month)}-${pad(a.day)}T00:00:00`, duration: `P${days}D`, timeZone: null, showWithoutTime: true };
  }
  return {
    start: `${a.year}-${pad(a.month)}-${pad(a.day)}T${pad(a.hour)}:${pad(a.minute)}:${pad(a.second)}`,
    duration: isoDuration(end.getTime() - start.getTime()),
    timeZone,
    showWithoutTime: false,
  };
}

/** The instants an event covers, read the way blockTimes writes them. */
export function eventSpan(event: Pick<CalendarEvent, 'start' | 'duration' | 'timeZone' | 'showWithoutTime'>, timeZone: string): { start: Date; end: Date } | null {
  const wall = parseLocalDateTime(event.start ?? '');
  if (!wall) return null;
  const zone = event.showWithoutTime ? timeZone : event.timeZone || timeZone;
  const start = fromWallClock(event.showWithoutTime ? { ...wall, hour: 0, minute: 0, second: 0 } : wall, zone);
  const seconds = parseDurationSeconds(event.duration ?? 'PT0S') ?? 0;
  if (event.showWithoutTime) {
    // Whole days in the zone, across a DST change too.
    const days = Math.round(seconds / 86400);
    const endDay = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
    const end = fromWallClock({ year: endDay.getUTCFullYear(), month: endDay.getUTCMonth() + 1, day: endDay.getUTCDate(), hour: 0, minute: 0, second: 0 }, zone);
    return { start, end };
  }
  return { start, end: new Date(start.getTime() + seconds * 1000) };
}

/** The calendar of the account a block goes into: its default, if the user may add events there. */
export function blockCalendar(calendars: Calendar[], accountId: string, primaryAccountId: string): Calendar | null {
  const own = calendars.filter((c) => !c.isTasksOnly && (accountId === primaryAccountId ? !c.isShared : c.accountId === accountId));
  const calendar = own.find((c) => c.isDefault) ?? own[0] ?? null;
  if (!calendar) return null;
  const rights = calendar.myRights;
  return !rights || rights.mayWriteAll || rights.mayWriteOwn ? calendar : null;
}

/**
 * The block setting as it applies: locked, the organisation's value (the
 * lock's value, else the policy default, else on); hidden, the policy default
 * (else on), the user can't see the choice; otherwise the user's choice.
 * The settings card and the sync both read it here.
 */
export function resolveBlockSetting(
  restriction: { locked?: boolean; hidden?: boolean; value?: unknown } | undefined,
  policyDefault: unknown,
  userSetting: unknown,
): { value: boolean; locked: boolean; hidden: boolean } {
  const orgValue = (v: unknown) => (typeof v === 'boolean' ? v : typeof policyDefault === 'boolean' ? policyDefault : true);
  if (restriction?.locked === true) return { value: orgValue('value' in restriction ? restriction.value : undefined), locked: true, hidden: false };
  if (restriction?.hidden === true) return { value: orgValue(undefined), locked: false, hidden: true };
  return { value: userSetting !== false, locked: false, hidden: false };
}

export function effectiveBlockSetting(): boolean {
  const policy = usePolicyStore.getState();
  return resolveBlockSetting(
    policy.getRestriction('vacationBlockCalendar'),
    policy.getEffectiveDefault('vacationBlockCalendar'),
    useSettingsStore.getState().vacationBlockCalendar,
  ).value;
}

function writtenBlocks(): Record<string, WrittenBlock> {
  const value = useSettingsStore.getState().vacationCalendarBlocks;
  return value && typeof value === 'object' ? value : {};
}

function rememberBlock(accountId: string, block: WrittenBlock | null): void {
  const next = { ...writtenBlocks() };
  if (block) next[accountId] = block;
  else delete next[accountId];
  useSettingsStore.getState().updateSetting('vacationCalendarBlocks', next);
}

type SyncClient = Pick<IJMAPClient,
  'getAccountId' | 'supportsCalendars' | 'getAllCalendars' | 'queryCalendarEvents' | 'createCalendarEvent' | 'updateCalendarEvent' | 'deleteCalendarEvent'>;

/**
 * Bring the busy event of one account in line with the reply. Returns what
 * it did; never throws (a failure is logged and tried again next time).
 */
export async function syncVacationBlock(
  client: SyncClient,
  accountId: string | undefined,
  reply: ReplyState,
  trigger: 'save' | 'load',
  now = new Date(),
  previous: Pick<ReplyState, 'fromDate' | 'toDate'> | null = null,
): Promise<BlockDecision['action'] | 'no-calendar' | 'failed'> {
  if (typeof client.supportsCalendars !== 'function' || !client.supportsCalendars()) return 'none';
  const primary = client.getAccountId();
  const account = accountId ?? primary;
  const target = account === primary ? undefined : account;
  const zone = getEffectiveTimeZone();
  try {
    const [found] = await client.queryCalendarEvents({ uid: oooUid(account) }, undefined, 1, target);
    const span = found ? eventSpan(found, zone) : null;
    const last = writtenBlocks()[account] ?? null;
    const marked = !!found?.keywords?.[OOO_KEYWORD];
    const decision = decideBlock({ block: effectiveBlockSetting(), reply, event: span, last, previous, marked, now, trigger });
    switch (decision.action) {
      case 'none':
        // A record of an event that is gone and not wanted any more is dropped.
        if (!found && last && !(reply.isEnabled && effectiveBlockSetting())) rememberBlock(account, null);
        return 'none';
      case 'create': {
        const calendar = blockCalendar(await client.getAllCalendars(), account, primary);
        if (!calendar) return 'no-calendar';
        await client.createCalendarEvent({
          '@type': 'Event',
          uid: oooUid(account),
          title: reply.subject.trim() || OUT_OF_OFFICE_TITLE,
          calendarIds: { [calendar.originalId ?? calendar.id]: true },
          ...blockTimes(decision.start, decision.end, zone),
          freeBusyStatus: 'busy',
          privacy: 'public',
          status: 'confirmed',
          keywords: { [OOO_KEYWORD]: true },
        } as Partial<CalendarEvent>, false, target);
        rememberBlock(account, { start: decision.start.toISOString(), end: decision.end.toISOString() });
        return 'create';
      }
      case 'update':
        await client.updateCalendarEvent(found!.originalId ?? found!.id, {
          ...blockTimes(decision.start, decision.end, zone),
          title: reply.subject.trim() || OUT_OF_OFFICE_TITLE,
          [`keywords/${OOO_KEYWORD}`]: true,
        } as Partial<CalendarEvent>, false, target);
        rememberBlock(account, { start: decision.start.toISOString(), end: decision.end.toISOString() });
        return 'update';
      case 'end-now': {
        const start = span!.start;
        // Whole minutes: Stalwart stores the duration in them.
        const end = new Date(Math.max(start.getTime() + 60000, Math.ceil(decision.end.getTime() / 60000) * 60000));
        await client.updateCalendarEvent(found!.originalId ?? found!.id, blockTimes(start, end, zone), false, target);
        rememberBlock(account, { start: start.toISOString(), end: blockEnd(start, end, zone).toISOString() });
        return 'end-now';
      }
      case 'destroy':
        await client.deleteCalendarEvent(found!.originalId ?? found!.id, false, target);
        rememberBlock(account, null);
        return 'destroy';
    }
  } catch (error) {
    debug.error('Out-of-office calendar block failed:', error);
    return 'failed';
  }
}

/** The end as eventSpan will read it back after blockTimes wrote it. */
function blockEnd(start: Date, end: Date, zone: string): Date {
  return eventSpan(blockTimes(start, end, zone), zone)?.end ?? end;
}

/**
 * The event title when the reply has no subject. In English: the event is
 * seen by colleagues in any language, and a server-side copy can't follow
 * the reader's locale.
 */
export const OUT_OF_OFFICE_TITLE = 'Out of office';

function relevant(reply: ReplyState): string {
  return JSON.stringify([reply.isEnabled, reply.fromDate, reply.toDate, reply.subject]);
}

interface Pending {
  client: SyncClient;
  accountId: string | undefined;
  reply: ReplyState;
  /** The dates before the first change still waiting to be synced. */
  previous: Pick<ReplyState, 'fromDate' | 'toDate'> | null;
  trigger: 'save' | 'load';
}

// Kept on globalThis: the store and the settings page may be in different
// bundle copies, and two schedulers would sync the same event twice.
interface SchedulerState {
  /** Per account: one job waiting, one timer, one sync running. */
  timers: Map<string, ReturnType<typeof setTimeout>>;
  pending: Map<string, Pending>;
  running: Map<string, Promise<unknown>>;
  loaded: Set<string>;
}
const SCHEDULER_KEY = '__bulwarkVacationCalendarSync';
function scheduler(): SchedulerState {
  const g = globalThis as unknown as Record<string, SchedulerState | undefined>;
  return (g[SCHEDULER_KEY] ??= { timers: new Map(), pending: new Map(), running: new Map(), loaded: new Set() });
}

function run(key: string): void {
  const state = scheduler();
  state.timers.delete(key);
  const job = state.pending.get(key);
  if (state.running.has(key) || !job) return;
  state.pending.delete(key);
  state.running.set(key, syncVacationBlock(job.client, job.accountId, job.reply, job.trigger, new Date(), job.previous)
    // The calendar block is a side effect of the reply: a failed sync is
    // logged and never surfaces as a failed save.
    .catch((error) => { debug.error('Out-of-office calendar sync failed:', error); })
    .finally(() => {
      state.running.delete(key);
      if (state.pending.has(key) && !state.timers.has(key)) run(key);
    }));
}

function schedule(job: Pending): void {
  const state = scheduler();
  const key = job.accountId ?? job.client.getAccountId();
  const waiting = state.pending.get(key);
  // A save outranks a load that waits; the latest reply wins, with the
  // dates from before the first change it replaces.
  if (waiting?.trigger === 'save' && job.trigger === 'load') return;
  state.pending.set(key, waiting?.trigger === 'save' ? { ...job, previous: waiting.previous } : job);
  const timer = state.timers.get(key);
  if (timer) clearTimeout(timer);
  state.timers.set(key, setTimeout(() => run(key), SYNC_DEBOUNCE_MS));
}

/** After a saved reply: sync when the switch, the dates or the subject changed. */
export function vacationReplySaved(client: SyncClient, accountId: string | undefined, before: ReplyState, after: ReplyState): void {
  if (relevant(before) === relevant(after)) return;
  safely(() => schedule({ client, accountId, reply: after, previous: { fromDate: before.fromDate, toDate: before.toDate }, trigger: 'save' }));
}

/** The user changed the block setting: sync with the reply as it is. */
export function vacationBlockChanged(client: SyncClient, accountId: string | undefined, reply: ReplyState): void {
  safely(() => schedule({ client, accountId, reply, previous: { fromDate: reply.fromDate, toDate: reply.toDate }, trigger: 'save' }));
}

/** After the reply was loaded: once per page load and account. */
export function vacationReplyLoaded(client: SyncClient, accountId: string | undefined, reply: ReplyState): void {
  safely(() => {
    const key = accountId ?? client.getAccountId();
    const state = scheduler();
    if (state.loaded.has(key)) return;
    state.loaded.add(key);
    schedule({ client, accountId, reply, previous: null, trigger: 'load' });
  });
}

/** Scheduling the calendar sync must never break saving or loading the reply. */
function safely(fn: () => void): void {
  try {
    fn();
  } catch (error) {
    debug.error('Out-of-office calendar sync not scheduled:', error);
  }
}

/** For tests: drop what the scheduler holds. */
export function resetVacationCalendarSync(): void {
  const state = scheduler();
  for (const timer of state.timers.values()) clearTimeout(timer);
  state.timers.clear();
  state.pending.clear();
  state.running.clear();
  state.loaded.clear();
}

/**
 * Whether turning the reply on switches off a filter script of the user's
 * own: Stalwart runs one script at a time, and Bulwark keeps only its own
 * filters running next to the reply (stores/filter-store.ts, through an
 * include). A script it can't read, or any script on a server without
 * `include`, stops while the reply is on.
 */
export async function ownFilterScriptStops(
  client: Pick<IJMAPClient, 'getSieveScripts' | 'getSieveScriptContent' | 'getSieveCapabilities' | 'getSieveAccountId'>,
  accountId?: string,
): Promise<boolean> {
  const account = accountId || client.getSieveAccountId();
  const scripts = await client.getSieveScripts(account);
  const active = scripts.find((s) => s.isActive && s.name !== VACATION_SCRIPT_NAME);
  if (!active) return false;
  if (!supportsInclude(client.getSieveCapabilities(account))) return true;
  const parsed = parseScript(await client.getSieveScriptContent(active.blobId, account));
  return parsed.isOpaque;
}
