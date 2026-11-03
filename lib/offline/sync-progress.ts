/**
 * How far a first sync got, and how long it may still take. The store reports
 * batches of a phase: messages listed, then threads, then bodies, then files.
 */

export interface SyncProgress {
  area: string;
  phase: string;
  done: number;
  total: number | null;
  /** When this phase started here, and how far it was then. */
  startedAt: number;
  startedDone: number;
  at: number;
}

/**
 * Listing a message is about ten times as fast as fetching its body and
 * indexing it (bench rig, 50,000 messages: 35 s to list, 400 s in all). So
 * while listing, the time left includes the bodies that come after it.
 */
const BODY_COST_PER_LIST_ITEM = 10;
/** An estimate from less than this jumps about too much to show. */
const MIN_SAMPLE_MS = 5_000;
/** Too small to be worth a progress line: new mail arriving in a normal pass. */
const MIN_ITEMS_SHOWN = 50;

export function nextProgress(
  previous: SyncProgress | undefined,
  event: { area: string; phase: string; done: number; total: number | null },
  now: number,
): SyncProgress {
  const samePhase = previous?.area === event.area && previous.phase === event.phase && event.done >= previous.done;
  return {
    area: event.area,
    phase: event.phase,
    done: event.done,
    total: event.total,
    startedAt: samePhase ? previous.startedAt : now,
    startedDone: samePhase ? previous.startedDone : event.done,
    at: now,
  };
}

export function progressWorthShowing(progress: SyncProgress | undefined): progress is SyncProgress {
  return !!progress && (progress.total === null || progress.total >= MIN_ITEMS_SHOWN) && progress.done >= 0;
}

/** Minutes left, rounded up; null while there's nothing sensible to say. */
export function minutesLeft(progress: SyncProgress): number | null {
  const { total, done, startedAt, startedDone, at } = progress;
  if (total === null || total <= done) return null;
  const elapsed = at - startedAt;
  const moved = done - startedDone;
  if (elapsed < MIN_SAMPLE_MS || moved <= 0) return null;
  const perItem = elapsed / moved;
  let left = (total - done) * perItem;
  if (progress.phase === 'list') left += total * perItem * BODY_COST_PER_LIST_ITEM;
  return Math.max(1, Math.ceil(left / 60_000));
}
