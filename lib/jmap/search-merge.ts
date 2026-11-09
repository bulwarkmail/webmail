/**
 * Online, a search also asks the local store and merges the two answers. The
 * store finds what the server's index can't, such as a word inside a German
 * compound. This module knows nothing about the store: it merges two lists.
 *
 * The merge walks both lists newest first, as a search sorts them. When both
 * have a message, the server's copy is kept. A page never holds more than
 * `limit` rows, so a local row can push a server row to the next page.
 *
 * A row only the store has may be stale: deleted or moved since the store last
 * synced. So the server is asked for those rows before they're shown. What it
 * no longer has, or has outside the filter's folders, is dropped, and what it
 * still has is shown as its current copy. It takes a request of its own, since
 * these ids are only known once both answers are in. If that request fails, or
 * the search itself did, the rows stay: an error must not lose results.
 *
 * Callers page by counting the rows they have, so `position` counts merged
 * rows and means nothing to the server once a local row is among them. A cursor
 * for each search remembers how far each side was read:
 * - Position 0 can be a new search or a refresh of a longer list, and only the
 *   next page tells which. So it runs on a cursor of its own next to the one
 *   already there. The next page takes whichever ended closest to its position.
 * - With no cursor (it was evicted), the search is walked again from the start
 *   up to the position. A merged position never goes to the server as it is.
 * - When the store has nothing to say for this search, no merged row exists and
 *   positions are the server's own, so requests pass straight through.
 *
 * `hasMore` is true while either side has rows this search hasn't returned.
 * A local list made only of rows the server also has can therefore cost one
 * extra page that comes back empty, and then it's false. When the server fails
 * on a later page, what it last said about having more still counts.
 *
 * `total` is the server's total plus the local-only rows returned so far, and
 * never less than the local total or the rows already returned. It can grow
 * while paging, because how many local rows the server also has only shows
 * when the lists are read.
 *
 * Local rows older than the last row the server sent wait for the next page:
 * they may still be on the server's next page.
 *
 * An error on one side keeps the other side's rows. When the server fails and
 * the store has nothing, the server's error stands, since an empty list would
 * read as "no results". A slow store holds up the server's answer for at most
 * the grace period, counted from when the server answered. Snippets for local
 * rows are asked for separately, so excerpting bodies in the worker doesn't
 * hold up the list either.
 */

import { debug } from '@/lib/debug';
import { attachSearchSnippets, type SearchSnippetResult } from '@/lib/search-snippet';
import type { SearchEmailsResult } from './client-interface';
import type { Email } from './types';

const LOCAL_GRACE_MS = 1_000;
const LOCAL_ALONE_MS = 5_000;
const MAX_CURSORS = 64;
/** How far back an evicted search is walked again. Past this, the list ends. */
const MAX_WALK_PAGES = 20;

const TEXT_FILTER_KEYS = ['text', 'from', 'to', 'cc', 'bcc', 'subject', 'body'];

/**
 * Whether a filter searches for text. Other filters (a folder, a flag, a date)
 * have the same answer on both sides, so only a stale local row could come of
 * merging them. Terms under NOT are searched to be absent, so they don't count.
 */
export function filterHasTextTerms(filter: Record<string, unknown>): boolean {
  if (typeof filter.operator === 'string') {
    if (filter.operator === 'NOT' || !Array.isArray(filter.conditions)) return false;
    return (filter.conditions as Array<Record<string, unknown>>).some(filterHasTextTerms);
  }
  return TEXT_FILTER_KEYS.some((key) => typeof filter[key] === 'string' && (filter[key] as string).trim().length > 0);
}

/** True, false, or null when the filter's answer depends on more than the folders. */
function mailboxAnswer(filter: Record<string, unknown>, boxes: readonly string[]): boolean | null {
  if (typeof filter.operator === 'string') {
    const answers = (Array.isArray(filter.conditions) ? filter.conditions as Array<Record<string, unknown>> : [])
      .map((condition) => mailboxAnswer(condition, boxes));
    const unknown = answers.includes(null);
    if (filter.operator === 'AND') return answers.includes(false) ? false : unknown ? null : true;
    const any = answers.includes(true) ? true : unknown ? null : false;
    if (filter.operator === 'OR') return any;
    if (filter.operator === 'NOT') return any === null ? null : !any;
    return null;
  }
  const answers: boolean[] = [];
  if (typeof filter.inMailbox === 'string') answers.push(boxes.includes(filter.inMailbox));
  if (Array.isArray(filter.inMailboxOtherThan)) {
    const excluded = filter.inMailboxOtherThan as string[];
    answers.push(boxes.some((box) => !excluded.includes(box)));
  }
  if (answers.includes(false)) return false;
  return answers.length > 0 && Object.keys(filter).length === answers.length ? true : null;
}

/** Whether a message's folders still fit the filter. Conditions on anything else don't count against it. */
export function mailboxesFitFilter(filter: Record<string, unknown>, mailboxIds: Record<string, boolean> | undefined): boolean {
  const boxes = Object.entries(mailboxIds ?? {}).filter(([, on]) => on).map(([id]) => id);
  return mailboxAnswer(filter, boxes) !== false;
}

interface MergeCursor {
  /** Merged rows returned so far, which is where the next page should ask from. */
  next: number;
  serverPosition: number;
  localPosition: number;
  serverTotal: number;
  serverHasMore: boolean;
  /** Local-only rows returned so far. */
  extras: number;
  /** Local rows the server said are gone. */
  rejected: number;
  /** Every row returned so far, so none appears twice. */
  shown: Set<string>;
  /** The store has nothing for this search: positions are the server's. */
  passthrough: boolean;
}

function newCursor(): MergeCursor {
  return {
    next: 0, serverPosition: 0, localPosition: 0, serverTotal: 0, serverHasMore: false,
    extras: 0, rejected: 0, shown: new Set(), passthrough: false,
  };
}

interface CursorEntry {
  cursor: MergeCursor;
  /** A position 0 that came after later pages: a new search or a refresh. */
  restarted: MergeCursor | null;
}

function receivedTime(email: Email): number {
  return Date.parse(email.receivedAt) || 0;
}

interface PageMerge {
  emails: Email[];
  serverRead: number;
  localRead: number;
  extraIds: string[];
}

/** One merged page. Rows are added to `shown`. */
export function mergeSearchPages(
  server: readonly Email[],
  serverHasMore: boolean,
  local: readonly Email[],
  limit: number,
  shown: Set<string>,
): PageMerge {
  const serverIds = new Set(server.map((email) => email.id));
  const emails: Email[] = [];
  const extraIds: string[] = [];
  let s = 0;
  let l = 0;
  while (emails.length < limit) {
    const fromServer = server[s];
    const fromLocal = local[l];
    if (fromLocal && (serverIds.has(fromLocal.id) || shown.has(fromLocal.id))) {
      l += 1;
      continue;
    }
    if (fromServer && shown.has(fromServer.id)) {
      s += 1;
      continue;
    }
    if (!fromServer && (!fromLocal || serverHasMore)) break;
    if (fromServer && (!fromLocal || receivedTime(fromLocal) <= receivedTime(fromServer))) {
      emails.push(fromServer);
      shown.add(fromServer.id);
      s += 1;
    } else {
      emails.push({ ...fromLocal, foundLocally: true });
      shown.add(fromLocal.id);
      extraIds.push(fromLocal.id);
      l += 1;
    }
  }
  return { emails, serverRead: s, localRead: l, extraIds };
}

/** The promise's value, or null if it takes longer than `ms`. The promise must not reject. */
function within<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

/** Runs a store call with its failure handled right away, so it can't go unhandled while the server is awaited. */
function safely<T>(what: string, call: () => Promise<T | null>): Promise<T | null> {
  return Promise.resolve().then(call).catch((error: unknown) => {
    debug.warn('jmap', `${what} failed:`, error);
    return null;
  });
}

export interface MergedSearchRequest {
  /** The same for every page of one search. */
  key: string;
  limit: number;
  position: number;
  server(position: number): Promise<SearchEmailsResult>;
  /** Null when the store doesn't cover this account. */
  local(position: number): Promise<SearchEmailsResult | null>;
  /** The server's current copies of these rows, leaving out what's gone or no longer fits the search. */
  verify?(rows: Email[]): Promise<Email[]>;
  /** Highlights for rows only the store has. */
  localSnippets?(ids: string[]): Promise<SearchSnippetResult[] | null>;
  /** Hand local snippets back as `snippets` instead of waiting for them. */
  deferSnippets?: boolean;
}

export interface LocalSearchMergeOptions {
  /** How long a slow store may hold up the server's answer. */
  graceMs?: number;
}

export class LocalSearchMerge {
  private readonly cursors = new Map<string, CursorEntry>();
  private readonly graceMs: number;

  constructor(options: LocalSearchMergeOptions = {}) {
    this.graceMs = options.graceMs ?? LOCAL_GRACE_MS;
  }

  /** Least recently used goes first, so a search being paged through stays. */
  private remember(key: string, entry: CursorEntry): void {
    this.cursors.delete(key);
    this.cursors.set(key, entry);
    if (this.cursors.size > MAX_CURSORS) this.cursors.delete(this.cursors.keys().next().value as string);
  }

  async run(request: MergedSearchRequest): Promise<SearchEmailsResult> {
    const { key, limit, position } = request;
    const entry = this.cursors.get(key);
    if (position === 0) {
      const fresh = newCursor();
      const alongside = entry && entry.cursor.next > 0 ? entry.cursor : null;
      this.remember(key, alongside ? { cursor: alongside, restarted: fresh } : { cursor: fresh, restarted: null });
      return this.page(fresh, request, 0, limit, { alongside });
    }
    if (!entry) return this.walkTo(request);
    this.remember(key, entry);
    const cursor = this.choose(entry, position);
    if (cursor.passthrough) return request.server(position);
    return this.page(cursor, request, position, limit, {});
  }

  /** Which cursor the page after a position 0 continues from. Only that one is kept from then on. */
  private choose(entry: CursorEntry, position: number): MergeCursor {
    const { cursor, restarted } = entry;
    if (!restarted) return cursor;
    entry.restarted = null;
    const restartedIsCloser = Math.abs(position - restarted.next) <= Math.abs(position - cursor.next);
    if (cursor.passthrough || restartedIsCloser) {
      entry.cursor = restarted;
      return restarted;
    }
    for (const id of restarted.shown) cursor.shown.add(id);
    return cursor;
  }

  /** No cursor: read the search again from the start, so the rows the caller holds are accounted for. */
  private async walkTo(request: MergedSearchRequest): Promise<SearchEmailsResult> {
    const { key, limit, position } = request;
    const cursor = newCursor();
    let last: SearchEmailsResult | null = null;
    for (let page = 0; cursor.next < position && !cursor.passthrough; page += 1) {
      if (page === MAX_WALK_PAGES) return { emails: [], hasMore: false, total: last?.total ?? position };
      last = await this.page(cursor, request, cursor.next, Math.min(limit, position - cursor.next), { walking: true });
      if (last.emails.length === 0 || !last.hasMore) break;
    }
    this.remember(key, { cursor, restarted: null });
    if (cursor.passthrough) return request.server(position);
    // The search ended before the position: the caller holds rows that are gone.
    cursor.next = position;
    return this.page(cursor, request, position, limit, {});
  }

  private async page(
    cursor: MergeCursor,
    request: MergedSearchRequest,
    position: number,
    limit: number,
    { alongside = null, walking = false }: { alongside?: MergeCursor | null; walking?: boolean },
  ): Promise<SearchEmailsResult> {
    // A caller that removed rows or added its own asks from a little off
    // where the last page ended, and the server's side moves with it.
    const serverPosition = Math.max(0, cursor.serverPosition + position - cursor.next);
    const localAnswer = safely('Local search', () => request.local(cursor.localPosition));

    let serverPage: SearchEmailsResult | null = null;
    let serverError: unknown = null;
    try {
      serverPage = await request.server(serverPosition);
    } catch (error) {
      serverError = error;
    }
    const localPage = await within(localAnswer, serverPage ? this.graceMs : LOCAL_ALONE_MS);

    if (!serverPage && !localPage?.emails.length) throw serverError;
    if (serverPage && !localPage && cursor.extras === 0) {
      // Nothing local in this search: the server's answer, untouched.
      cursor.passthrough = true;
      cursor.next = position + serverPage.emails.length;
      return serverPage;
    }

    const server = serverPage?.emails ?? [];
    const serverHasMore = serverPage?.hasMore ?? false;
    const local = serverPage
      ? await this.verified(request, cursor, server, serverHasMore, localPage?.emails ?? [])
      : localPage?.emails ?? [];
    const merged = mergeSearchPages(server, serverHasMore, local, limit, cursor.shown);

    cursor.serverPosition = serverPosition + merged.serverRead;
    cursor.localPosition += merged.localRead;
    cursor.next = position + merged.emails.length;
    cursor.extras += merged.extraIds.length;
    if (serverPage) {
      cursor.serverTotal = serverPage.total;
      cursor.serverHasMore = merged.serverRead < server.length || serverHasMore;
    }

    const localLeft = localPage ? merged.localRead < local.length || localPage.hasMore : false;
    // A refresh of a longer list counts the local rows already in that list.
    const extras = Math.max(cursor.extras, alongside?.extras ?? 0);
    const rejected = Math.max(cursor.rejected, alongside?.rejected ?? 0);
    const result: SearchEmailsResult = {
      ...serverPage,
      emails: merged.emails,
      hasMore: cursor.serverHasMore || localLeft,
      total: Math.max(cursor.serverTotal + extras, (localPage?.total ?? 0) - rejected, cursor.next),
    };
    if (!walking && merged.extraIds.length > 0 && request.localSnippets) await this.addLocalSnippets(request, merged, result);
    return result;
  }

  /** The local rows, with what the server no longer has marked as read past, and the rest as its current copies. */
  private async verified(
    request: MergedSearchRequest,
    cursor: MergeCursor,
    server: readonly Email[],
    serverHasMore: boolean,
    local: Email[],
  ): Promise<Email[]> {
    if (!request.verify) return local;
    const serverIds = new Set(server.map((email) => email.id));
    const oldestPlaceable = serverHasMore && server.length > 0 ? receivedTime(server[server.length - 1]) : -Infinity;
    const candidates = local.filter((row) => !serverIds.has(row.id) && !cursor.shown.has(row.id) && receivedTime(row) >= oldestPlaceable);
    if (candidates.length === 0) return local;
    let current: Email[];
    try {
      current = await request.verify(candidates);
    } catch (error) {
      debug.warn('jmap', 'Checking local search results failed:', error);
      return local;
    }
    const byId = new Map(current.map((row) => [row.id, row]));
    for (const row of candidates) {
      if (byId.has(row.id)) continue;
      cursor.shown.add(row.id);
      cursor.rejected += 1;
    }
    return local.map((row) => byId.get(row.id) ?? row);
  }

  private async addLocalSnippets(request: MergedSearchRequest, merged: PageMerge, result: SearchEmailsResult): Promise<void> {
    const asked = safely('Local snippets', () => (request.localSnippets as NonNullable<MergedSearchRequest['localSnippets']>)(merged.extraIds));
    if (!request.deferSnippets) {
      attachSearchSnippets(result.emails, (await within(asked, this.graceMs)) ?? undefined);
      return;
    }
    const fromServer = result.snippets;
    result.snippets = Promise.all([fromServer, asked]).then(([a, b]) => (a || b ? [...(a ?? []), ...(b ?? [])] : undefined));
  }
}
