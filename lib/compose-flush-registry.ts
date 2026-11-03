/**
 * Composers that hold text the server may not have yet. An automatic
 * sign-out (the organisation's idle timeout or maximum session length) saves
 * them as drafts before the credentials go: each open composer registers a
 * `flush` that runs its own draft save, and the host of a minimised composer
 * (its state lives only in the host's memory) registers one that reopens it
 * so the composer can save itself.
 *
 * A flush that hangs must not keep the user signed in, so flushComposers
 * waits at most `timeoutMs` for all of them together.
 */

import { getDesktopBridge } from '@/lib/desktop/bridge';

export type ComposeFlush = () => Promise<void>;

/** Less than the desktop shell waits for a closing window. */
const DESKTOP_FLUSH_MS = 3000;

let nextId = 1;
const flushes = new Map<number, ComposeFlush>();
const waiters = new Set<(flush: ComposeFlush) => void>();

let stopDesktopFlush: (() => void) | null = null;

/**
 * In the desktop app, closing a window or quitting saves the open drafts first. The
 * shell only waits while a composer is here, so a window without one closes at once.
 */
function syncDesktopFlush(): void {
  if (flushes.size === 0) {
    stopDesktopFlush?.();
    stopDesktopFlush = null;
    return;
  }
  if (stopDesktopFlush) return;
  const lifecycle = getDesktopBridge()?.lifecycle;
  if (lifecycle) stopDesktopFlush = lifecycle.onFlushRequest(() => flushComposers(DESKTOP_FLUSH_MS));
}

/** Register a composer's flush; returns the unregister function. */
export function registerComposeFlush(flush: ComposeFlush): () => void {
  const id = nextId++;
  flushes.set(id, flush);
  for (const waiter of [...waiters]) waiter(flush);
  syncDesktopFlush();
  return () => {
    flushes.delete(id);
    syncDesktopFlush();
  };
}

/**
 * The flush of the next composer to register, or null after `timeoutMs`.
 * A minimised composer's host reopens it and waits for it here.
 */
export function waitForComposeFlush(timeoutMs: number): Promise<ComposeFlush | null> {
  return new Promise((resolve) => {
    const waiter = (flush: ComposeFlush) => {
      clearTimeout(timer);
      waiters.delete(waiter);
      resolve(flush);
    };
    const timer = setTimeout(() => {
      waiters.delete(waiter);
      resolve(null);
    }, timeoutMs);
    waiters.add(waiter);
  });
}

export interface FlushResult {
  /** Flushes that were registered when the sign-out started. */
  total: number;
  /** Flushes that finished (or failed) in time. */
  settled: number;
  /** Flushes that reported a save the server didn't take (threw). */
  failed: number;
  timedOut: boolean;
}

/** Run every registered flush and wait for them, but no longer than `timeoutMs`. */
export async function flushComposers(timeoutMs: number): Promise<FlushResult> {
  const pending = [...flushes.values()];
  if (pending.length === 0) return { total: 0, settled: 0, failed: 0, timedOut: false };
  let settled = 0;
  let failed = 0;
  const all = Promise.all(pending.map(async (flush) => {
    try {
      await flush();
    } catch {
      // The sign-out goes on; the login page says a draft wasn't saved.
      failed += 1;
    }
    settled += 1;
  }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    all.then(() => false),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), timeoutMs); }),
  ]);
  clearTimeout(timer);
  return { total: pending.length, settled, failed, timedOut };
}

/** Test helper: forget every registration. */
export function resetComposeFlushRegistry(): void {
  flushes.clear();
  waiters.clear();
}
