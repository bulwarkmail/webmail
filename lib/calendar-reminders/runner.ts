/**
 * Asks the local store what's due, at the moment it's due. Runs in the page: in the
 * desktop app that's the main window, which keeps its timers while hidden in the tray,
 * and the store's worker answers with no network. Every tab or window may run one: the
 * store hands each alert to whichever asks first.
 *
 * Between checks it sleeps until the store's next fire time, and looks in every few
 * minutes in case something changed with nobody saying so.
 */

import type { StoreBackend } from '@/lib/store/client/api';
import type { ReminderAlert, TickParams, TickResult } from '@/lib/store/reminders/ledger';
import { HIDDEN_GRACE_MS } from './claims';

const REFRESH_MS = 5 * 60_000;
/** Timers stand still while a machine sleeps. The clock doesn't. */
const CLOCK_WATCH_MS = 60_000;
const CLOCK_JUMP_MS = 2 * CLOCK_WATCH_MS;
/**
 * After a start or a wake, how long a summary waits for the first sync, so it leaves out
 * what was deleted elsewhere in the meantime. Reminders that are due don't wait.
 */
export const SUMMARY_WAIT_MS = 20_000;

export interface ReminderRunnerEnv {
  /** The local accounts with a store right now. */
  accounts(): string[];
  store(): Pick<StoreBackend, 'area'>;
  params(): TickParams;
  /** Out of view: another tab in view should get to go first. */
  hidden(): boolean;
  offline(): boolean;
  /** Runs in the one tab that got these. */
  onDue(account: string, alerts: ReminderAlert[]): void;
  /** There's a summary to give. Resolves when that's been tried. */
  onMissed(account: string): Promise<void>;
  /** Whether this account's reminders come from the store now, or the app's old path keeps them. */
  onSource(account: string, driven: boolean): void;
}

export interface ReminderRunner {
  start(): void;
  stop(): void;
  /** Check now: the calendar changed, a snooze was set. */
  poke(): void;
  /** Back from sleep, or back online. */
  wake(): void;
  /** The store finished a sync for this account. */
  synced(account: string): void;
}

export function createReminderRunner(env: ReminderRunnerEnv): ReminderRunner {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let clockWatch: ReturnType<typeof setInterval> | null = null;
  let lastWatch = 0;
  let running = false;
  let again = false;
  let stopped = true;
  let summaryAt = 0;
  const presenting = new Set<string>();
  const known = new Set<string>();

  const schedule = (at: number) => {
    if (timer) clearTimeout(timer);
    const wait = Math.max(at - Date.now(), 0) + (env.hidden() ? HIDDEN_GRACE_MS : 0);
    timer = setTimeout(() => void run(), wait);
  };

  const check = async (account: string): Promise<number | null> => {
    let result: TickResult;
    try {
      result = await env.store().area<TickResult>(account, 'reminders.tick', env.params());
    } catch {
      // The store is out of reach: the old path takes these over until it's back.
      env.onSource(account, false);
      return null;
    }
    env.onSource(account, result.ready);
    if (result.due.length > 0) env.onDue(account, result.due);
    if (result.missed === 0) return result.nextAt;
    const wait = env.offline() ? 0 : summaryAt - Date.now();
    if (wait > 0) return result.nextAt === null ? summaryAt : Math.min(result.nextAt, summaryAt);
    if (!presenting.has(account)) {
      presenting.add(account);
      void env.onMissed(account)
        .catch(() => {})
        .finally(() => presenting.delete(account));
    }
    return result.nextAt;
  };

  const run = async () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    let next = Date.now() + REFRESH_MS;
    const accounts = env.accounts();
    for (const gone of [...known]) {
      if (!accounts.includes(gone)) {
        known.delete(gone);
        env.onSource(gone, false);
      }
    }
    for (const account of accounts) {
      known.add(account);
      const at = await check(account);
      if (at !== null) next = Math.min(next, at);
    }
    running = false;
    if (stopped) return;
    if (again) {
      again = false;
      void run();
      return;
    }
    schedule(next);
  };

  return {
    start() {
      stopped = false;
      summaryAt = Date.now() + SUMMARY_WAIT_MS;
      lastWatch = Date.now();
      clockWatch = setInterval(() => {
        const now = Date.now();
        const jumped = now - lastWatch > CLOCK_JUMP_MS;
        lastWatch = now;
        if (jumped) this.wake();
      }, CLOCK_WATCH_MS);
      void run();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (clockWatch) clearInterval(clockWatch);
      timer = null;
      clockWatch = null;
      for (const account of known) env.onSource(account, false);
      known.clear();
    },
    poke() {
      void run();
    },
    wake() {
      summaryAt = Date.now() + SUMMARY_WAIT_MS;
      void run();
    },
    synced() {
      summaryAt = 0;
      void run();
    },
  };
}
