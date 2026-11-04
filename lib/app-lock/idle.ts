/**
 * Time without use, counted across all windows and tabs: every one of them writes
 * to the same localStorage key and reads from it. Clocks jump over sleep, which is
 * what's wanted: a laptop opened after the timeout locks at once.
 */

import { APP_LOCK_ACTIVITY_KEY } from './state';

const WRITE_EVERY_MS = 5_000;
const CHECK_EVERY_MS = 10_000;
const EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;

export function lastActivity(): number {
  try {
    const at = Number(localStorage.getItem(APP_LOCK_ACTIVITY_KEY));
    return Number.isFinite(at) ? at : 0;
  } catch {
    return 0;
  }
}

export function noteActivity(now = Date.now()): void {
  try {
    localStorage.setItem(APP_LOCK_ACTIVITY_KEY, String(now));
  } catch {
    // This tab's own timer then runs from when it started.
  }
}

export interface IdleWatchOptions {
  timeoutMs: () => number;
  onIdle: () => void;
  now?: () => number;
}

/**
 * Calls `onIdle` once the time has passed. A touch after it has passed locks rather
 * than counts: coming back to the machine must not undo the timeout. Returns the stop.
 */
export function watchIdle(options: IdleWatchOptions): () => void {
  const now = options.now ?? Date.now;
  let last = now();
  noteActivity(last);
  let written = last;
  let stopped = false;

  const expired = (at: number) => at - Math.max(last, lastActivity()) >= options.timeoutMs();
  const fire = () => {
    if (stopped) return;
    stop();
    options.onIdle();
  };
  const check = () => {
    if (expired(now())) fire();
  };
  const onUse = () => {
    const at = now();
    if (expired(at)) {
      fire();
      return;
    }
    last = at;
    if (at - written >= WRITE_EVERY_MS) {
      written = at;
      noteActivity(at);
    }
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible') check();
  };

  for (const event of EVENTS) window.addEventListener(event, onUse, { capture: true, passive: true });
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', check);
  const timer = setInterval(check, CHECK_EVERY_MS);

  function stop() {
    stopped = true;
    clearInterval(timer);
    for (const event of EVENTS) window.removeEventListener(event, onUse, { capture: true });
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('focus', check);
  }
  return stop;
}
