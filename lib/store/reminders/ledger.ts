/**
 * What has become of each reminder on this device: the one place that decides what
 * fires. Every call is one synchronous transaction in the store's worker, and all tabs
 * and windows reach the same worker, so whichever asks first gets an alert and nobody
 * else ever does, across restarts too. localStorage can't do this: a worker can't read
 * it, and two tabs can read it at the same moment.
 *
 * A row's status:
 * - `fired`: shown, nothing more to do.
 * - `snoozed`: comes back at `snooze_until`.
 * - `missed`: waits for a summary, because the device was away or notifications were
 *   paused.
 * - `summarised`: went into the summary `batch`. On loan until `lease_until` is cleared,
 *   so a crash or a reload before anyone saw it brings it back.
 * - `dismissed`: the user is done with it.
 *
 * None of this goes to the server. JSCalendar's `acknowledged` is read (reminders.ts),
 * never written: decisions file, reminders.
 */

import { metaGet, metaSet } from '../engine/core-schema';
import { listUpcomingAlerts, type UpcomingAlert } from '../calendar/reminders';
import type { StorageAdapter } from '../storage';

/** Younger than this, an alert still fires by itself. As lib/calendar-alerts.ts. */
export const FRESH_MS = 10 * 60_000;
/** A gap between two checks longer than this means the device was away. A little over the page's refresh. */
export const AWAY_MS = 6 * 60_000;
/** How far back a summary reaches. After a month away nobody needs a month of reminders. */
export const MISSED_REACH_MS = 7 * 24 * 3_600_000;
/** How far ahead a check looks for the next fire time. */
export const LOOK_AHEAD_MS = 6 * 3_600_000;
/** Rows older than the reach can't come up again. */
const KEEP_MS = MISSED_REACH_MS + 24 * 3_600_000;
const CURSOR = 'reminder_cursor';
/** How long a summary stays with whoever took it, unless they keep saying it's on screen. */
export const LEASE_MS = 3 * 60_000;
const LONGEST_SNOOZE_MIN = 24 * 60;

export interface ReminderAlert extends UpcomingAlert {
  /** Set when it comes back from a snooze: when that was due. */
  snoozedUntil?: number;
}

export interface TickParams {
  /** Reads floating events: the user's zone. */
  timeZone: string;
  /** Tasks' alerts too. */
  tasks: boolean;
  /** Reminders are switched off: time passes, and nothing counts as missed later. */
  muted?: boolean;
  /** The account's own copy of a meeting that's in several. */
  prefer?: string;
}

export interface TickResult {
  /** Yours to show. No other caller gets these. */
  due: ReminderAlert[];
  /** How many wait for a summary. */
  missed: number;
  /** When to ask again at the latest for the next reminder. Null: none in sight. */
  nextAt: number | null;
  /** The calendar has synced at least once, so an empty answer means something. */
  ready: boolean;
}

interface Row {
  key: string;
  uid: string;
  status: string;
  fire_time: number;
  snooze_until: number | null;
  alert: string;
}

function put(db: StorageAdapter, alert: ReminderAlert, status: string, now: number): void {
  db.run(
    `INSERT INTO reminder (key, uid, status, fire_time, snooze_until, batch, lease_until, alert, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
     ON CONFLICT (key) DO UPDATE SET status = excluded.status, snooze_until = NULL, batch = NULL, lease_until = NULL, alert = excluded.alert, updated_at = excluded.updated_at`,
    [alert.key, alert.uid, status, alert.fireTimeMs, JSON.stringify(alert), now],
  );
}

function readAlert(row: Pick<Row, 'alert'>): ReminderAlert {
  return JSON.parse(row.alert) as ReminderAlert;
}

function missedCount(db: StorageAdapter): number {
  return Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reminder WHERE status = 'missed'")?.n ?? 0);
}

function calendarReady(db: StorageAdapter): boolean {
  return !!db.get("SELECT 1 AS yes FROM sync_state WHERE type = 'CalendarEvent' AND state IS NOT NULL LIMIT 1");
}

/** The same reminder to the user: an edit can give an alert a new id without moving it. */
function sameReminder(uid: string, fireTime: number): string {
  return `${uid}:${fireTime}`;
}

/** Whether a snoozed alert still stands: the event may have gone, moved or been dismissed elsewhere. */
function alertNow(db: StorageAdapter, row: Pick<Row, 'uid' | 'fire_time'>, params: Pick<TickParams, 'timeZone' | 'prefer'>): UpcomingAlert | undefined {
  return listUpcomingAlerts(db, { from: row.fire_time, to: row.fire_time + 1, timeZone: params.timeZone, prefer: params.prefer })
    .find((alert) => alert.uid === row.uid);
}

/**
 * Hands out what's due and settles the rest. Alerts that came due while the device was
 * away go to the summary instead of arriving as a burst. A single recent one is just a
 * reminder that came a little late.
 */
export function tick(db: StorageAdapter, now: number, params: TickParams): TickResult {
  return db.transaction(() => {
    const raw = metaGet(db, CURSOR);
    const cursor = raw === null ? null : Number(raw);
    metaSet(db, CURSOR, String(now));
    db.run("UPDATE reminder SET status = 'missed', batch = NULL, lease_until = NULL WHERE status = 'summarised' AND lease_until IS NOT NULL AND lease_until <= ?", [now]);
    if (params.muted) return { due: [], missed: 0, nextAt: null, ready: calendarReady(db) };

    const freshFrom = now - FRESH_MS;
    const from = cursor === null ? freshFrom : Math.max(Math.min(cursor, freshFrom), now - MISSED_REACH_MS);
    const listed = listUpcomingAlerts(db, { from, to: now + LOOK_AHEAD_MS, timeZone: params.timeZone, prefer: params.prefer })
      .filter((alert) => params.tasks || alert.kind !== 'task');
    const past = listed.filter((alert) => alert.fireTimeMs <= now);
    const known = new Set(
      past.length === 0
        ? []
        : db.all<{ uid: string; fire_time: number }>('SELECT uid, fire_time FROM reminder WHERE fire_time >= ? AND fire_time <= ?', [past[0].fireTimeMs, past[past.length - 1].fireTimeMs])
            .map((row) => sameReminder(row.uid, row.fire_time)),
    );
    const unseen = past.filter((alert) => !known.has(sameReminder(alert.uid, alert.fireTimeMs)));

    const away = cursor === null || now - cursor > AWAY_MS;
    const lastSeen = cursor ?? freshFrom;
    // Behind the cursor: it reached the store late, through a sync. Nobody was away from that.
    const inGap = away ? unseen.filter((alert) => alert.fireTimeMs > lastSeen) : [];
    const summarise = new Set(
      inGap.length === 1 && inGap[0].fireTimeMs >= freshFrom ? [] : inGap.map((alert) => alert.key),
    );
    const due: ReminderAlert[] = [];
    for (const alert of unseen) {
      if (summarise.has(alert.key) || alert.fireTimeMs < freshFrom) {
        put(db, alert, 'missed', now);
      } else {
        put(db, alert, 'fired', now);
        due.push(alert);
      }
    }

    const expired = db.all<Row>("SELECT key, uid, status, fire_time, snooze_until, alert FROM reminder WHERE status = 'snoozed' AND snooze_until <= ?", [now]);
    for (const row of expired) {
      const alert = alertNow(db, row, params);
      if (!alert) {
        db.run("UPDATE reminder SET status = 'dismissed', snooze_until = NULL, updated_at = ? WHERE key = ?", [now, row.key]);
        continue;
      }
      // The alert got a new id: its row goes on under that.
      if (alert.key !== row.key) db.run('DELETE FROM reminder WHERE key = ?', [row.key]);
      if (now - row.snooze_until! < FRESH_MS) {
        const back: ReminderAlert = { ...alert, snoozedUntil: row.snooze_until! };
        put(db, back, 'fired', now);
        due.push(back);
      } else {
        put(db, alert, 'missed', now);
      }
    }

    db.run("DELETE FROM reminder WHERE fire_time < ? AND status NOT IN ('snoozed', 'missed')", [now - KEEP_MS]);

    const coming = listed.find((alert) => alert.fireTimeMs > now)?.fireTimeMs ?? null;
    const snooze = db.get<{ at: number | null }>("SELECT MIN(snooze_until) AS at FROM reminder WHERE status = 'snoozed'")?.at ?? null;
    const nextAt = coming === null ? snooze : snooze === null ? coming : Math.min(coming, snooze);
    return { due, missed: missedCount(db), nextAt, ready: calendarReady(db) };
  });
}

export interface MissedBatch {
  /** Says which summary, for a toast clicked later. */
  batch: number;
  alerts: ReminderAlert[];
}

/**
 * The summary, for one caller only. What's gone from the calendar since doesn't come
 * back to haunt anyone. Null: nothing to say.
 */
export function takeMissed(db: StorageAdapter, now: number, params: { timeZone: string; prefer?: string }): MissedBatch | null {
  return db.transaction(() => {
    const rows = db.all<Row>("SELECT key, uid, status, fire_time, snooze_until, alert FROM reminder WHERE status = 'missed' ORDER BY fire_time, key");
    if (rows.length === 0) return null;
    const standing = new Map(
      listUpcomingAlerts(db, { from: rows[0].fire_time, to: rows[rows.length - 1].fire_time + 1, timeZone: params.timeZone, prefer: params.prefer })
        .map((alert) => [sameReminder(alert.uid, alert.fireTimeMs), alert]),
    );
    const newest = db.get<{ batch: number | null }>('SELECT MAX(batch) AS batch FROM reminder')?.batch ?? 0;
    const batch = Math.max(now, newest + 1);
    const alerts: ReminderAlert[] = [];
    for (const row of rows) {
      const alert = standing.get(sameReminder(row.uid, row.fire_time));
      if (!alert) {
        db.run("UPDATE reminder SET status = 'dismissed', updated_at = ? WHERE key = ?", [now, row.key]);
        continue;
      }
      db.run("UPDATE reminder SET status = 'summarised', batch = ?, lease_until = ?, alert = ?, updated_at = ? WHERE key = ?", [batch, now + LEASE_MS, JSON.stringify(alert), now, row.key]);
      alerts.push(alert);
    }
    return alerts.length > 0 ? { batch, alerts } : null;
  });
}

/** The summary couldn't be shown after all (paused, quiet hours): it stays due. */
export function releaseMissed(db: StorageAdapter, now: number, batch: number): void {
  db.run("UPDATE reminder SET status = 'missed', batch = NULL, lease_until = NULL, updated_at = ? WHERE status = 'summarised' AND batch = ?", [now, batch]);
}

/** Still on screen here. */
export function renewMissed(db: StorageAdapter, now: number, batch: number): void {
  db.run("UPDATE reminder SET lease_until = ?, updated_at = ? WHERE status = 'summarised' AND batch = ? AND lease_until IS NOT NULL", [now + LEASE_MS, now, batch]);
}

/** A native notification has it now, and the OS keeps that for as long as it wants. */
export function settleMissed(db: StorageAdapter, now: number, batch: number): void {
  db.run("UPDATE reminder SET lease_until = NULL, updated_at = ? WHERE status = 'summarised' AND batch = ?", [now, batch]);
}

/** What a summary said, for a click on it, possibly after a restart. */
export function readBatch(db: StorageAdapter, batch: number): ReminderAlert[] {
  return db.all<Row>("SELECT alert FROM reminder WHERE status = 'summarised' AND batch = ? ORDER BY fire_time, key", [batch]).map(readAlert);
}

/** Fired, but nobody could be told: it goes in the next summary. */
export function holdFired(db: StorageAdapter, now: number, keys: readonly string[]): void {
  db.transaction(() => {
    for (const key of keys) db.run("UPDATE reminder SET status = 'missed', updated_at = ? WHERE status = 'fired' AND key = ?", [now, key]);
  });
}

/** False when this device knows no such reminder, or the minutes make no sense. */
export function snooze(db: StorageAdapter, now: number, key: string, minutes: number): boolean {
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > LONGEST_SNOOZE_MIN) return false;
  const until = now + minutes * 60_000;
  return db.run("UPDATE reminder SET status = 'snoozed', snooze_until = ?, batch = NULL, lease_until = NULL, updated_at = ? WHERE key = ?", [until, now, key]).changes > 0;
}

export function dismiss(db: StorageAdapter, now: number, keys: readonly string[]): void {
  db.transaction(() => {
    for (const key of keys) db.run("UPDATE reminder SET status = 'dismissed', snooze_until = NULL, lease_until = NULL, updated_at = ? WHERE key = ?", [now, key]);
  });
}

/** One reminder as it was last shown: what a toast's Join reads, since the toast holds only the key. */
export function readReminder(db: StorageAdapter, key: string): ReminderAlert | null {
  const row = db.get<Pick<Row, 'alert'>>('SELECT alert FROM reminder WHERE key = ?', [key]);
  return row ? readAlert(row) : null;
}
