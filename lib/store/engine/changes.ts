/**
 * The /changes loop, written for how servers really answer (see
 * local-data/desktop-offline-facts-parts/stalwart-changes-prf.md):
 *
 * - sinceState goes last: on Stalwart a malformed state followed by more
 *   arguments is an HTTP 400 that fails the whole request.
 * - hasMoreChanges false doesn't mean caught up. A page walks a fixed range of
 *   the log, so the loop also runs while newState differs from the state the
 *   server last pushed.
 * - An unusable state comes as cannotCalculateChanges, invalidArguments or that
 *   HTTP 400. All three mean: start this type over.
 */

import { JmapMethodError, responseFor, TransportError, type JmapTransport } from './transport';

export interface ChangesPage {
  created: string[];
  updated: string[];
  destroyed: string[];
  newState: string;
  /** Set when only these properties changed (Mailbox counts). */
  updatedProperties: string[] | null;
}

export interface ChangesLoopOptions {
  transport: JmapTransport;
  type: string;
  jmap: string;
  using: string[];
  since: string;
  /** The newest state the server pushed, if any. */
  target?: string | null;
  maxChanges?: number;
  stopped?: () => boolean;
  /** Stores one page and its newState. Runs to completion before the next call. */
  apply(page: ChangesPage): Promise<void>;
}

export type ChangesOutcome =
  | { outcome: 'caughtUp'; state: string; pages: number }
  | { outcome: 'stopped'; state: string; pages: number }
  | { outcome: 'resync'; state: string; pages: number };

const MAX_PAGES_PAST_TARGET = 3;

/** A stored state a server can't have sent: don't send it, it can fail the whole request. */
export function isUsableState(state: unknown): state is string {
  return typeof state === 'string' && state.length > 0 && state.length < 1024 && /^[\w.~+=:/-]+$/.test(state);
}

function isStateRefusal(error: unknown): boolean {
  if (error instanceof JmapMethodError) {
    return error.type === 'cannotCalculateChanges' || error.type === 'invalidArguments';
  }
  if (error instanceof TransportError) {
    return error.kind === 'http' && error.status === 400 && /notRequest/.test(error.problem ?? '');
  }
  return false;
}

export async function runChangesLoop(options: ChangesLoopOptions): Promise<ChangesOutcome> {
  const { transport, type, jmap, using, target } = options;
  const maxChanges = options.maxChanges ?? 500;
  let state = options.since;
  let pages = 0;
  let pastTarget = 0;
  if (!isUsableState(state)) return { outcome: 'resync', state, pages };
  for (;;) {
    if (options.stopped?.()) return { outcome: 'stopped', state, pages };
    let page: ChangesPage & { hasMoreChanges: boolean };
    try {
      const response = await transport.request(
        [[`${type}/changes`, { accountId: jmap, maxChanges, sinceState: state }, 'c']],
        using,
      );
      const [, result] = responseFor(response, 'c');
      page = {
        created: result.created ?? [],
        updated: result.updated ?? [],
        destroyed: result.destroyed ?? [],
        newState: String(result.newState),
        updatedProperties: Array.isArray(result.updatedProperties) ? result.updatedProperties : null,
        hasMoreChanges: Boolean(result.hasMoreChanges),
      };
    } catch (error) {
      if (isStateRefusal(error)) return { outcome: 'resync', state, pages };
      throw error;
    }
    const before = state;
    await options.apply(page);
    state = page.newState;
    pages += 1;
    if (page.hasMoreChanges) continue;
    if (!target || state === target) return { outcome: 'caughtUp', state, pages };
    // Behind the pushed state: the log moved on while we paged. A state that
    // stands still means the server has nothing more for this type.
    if (state === before) return { outcome: 'caughtUp', state, pages };
    pastTarget += 1;
    if (pastTarget >= MAX_PAGES_PAST_TARGET) return { outcome: 'caughtUp', state, pages };
  }
}
