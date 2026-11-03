/**
 * Online, a search also asks the local store and merges the two answers. The
 * store finds what the server's index can't, such as a word inside a German
 * compound. This module knows nothing about the store: it merges two lists.
 *
 * The merge walks both lists newest first, as a search sorts them. When both
 * have a message, the server's copy is kept. A page never holds more than
 * `limit` rows, so a local row can push a server row to the next page.
 *
 * Callers page by counting the rows they have, so `position` counts merged
 * rows and means nothing to the server once a local row is among them. A cursor
 * for each search remembers how far each side was read. A request past 0 with
 * no cursor goes to the server alone, exactly as it would without a store.
 *
 * `hasMore` is true while either side has rows this search hasn't returned.
 * A local list made only of rows the server also has can therefore cost one
 * extra page that comes back empty, and then it's false.
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
 * read as "no results". A slow store never holds up the server's answer for
 * longer than LOCAL_GRACE_MS.
 */

import { debug } from '@/lib/debug';
import type { SearchEmailsResult } from './client-interface';
import type { Email } from './types';

const LOCAL_GRACE_MS = 1_000;
const LOCAL_ALONE_MS = 5_000;
const MAX_CURSORS = 8;

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

interface MergeCursor {
  /** Merged rows returned so far, which is where the next page should ask from. */
  next: number;
  serverPosition: number;
  localPosition: number;
  serverTotal: number;
  /** Local-only rows returned so far. */
  extras: number;
  /** Every row returned so far, so none appears twice. */
  shown: Set<string>;
}

function receivedTime(email: Email): number {
  return Date.parse(email.receivedAt) || 0;
}

interface PageMerge {
  emails: Email[];
  serverRead: number;
  localRead: number;
  extras: number;
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
  let s = 0;
  let l = 0;
  let extras = 0;
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
      emails.push(fromLocal);
      shown.add(fromLocal.id);
      l += 1;
      extras += 1;
    }
  }
  return { emails, serverRead: s, localRead: l, extras };
}

/** The promise's value, or null if it fails or takes longer than `ms`. */
function within<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        debug.warn('jmap', 'Local search failed:', error);
        resolve(null);
      },
    );
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
}

export class LocalSearchMerge {
  private readonly cursors = new Map<string, MergeCursor>();

  private startCursor(key: string): MergeCursor {
    const cursor: MergeCursor = { next: 0, serverPosition: 0, localPosition: 0, serverTotal: 0, extras: 0, shown: new Set() };
    this.cursors.delete(key);
    this.cursors.set(key, cursor);
    if (this.cursors.size > MAX_CURSORS) this.cursors.delete(this.cursors.keys().next().value as string);
    return cursor;
  }

  async run(request: MergedSearchRequest): Promise<SearchEmailsResult> {
    const { key, limit, position } = request;
    const cursor = position === 0 ? this.startCursor(key) : this.cursors.get(key);
    if (!cursor) return request.server(position);

    // A caller that removed rows or added its own asks from a little off
    // where the last page ended, and the server's side moves with it.
    const serverPosition = Math.max(0, cursor.serverPosition + position - cursor.next);
    const localAnswer = Promise.resolve().then(() => request.local(cursor.localPosition));

    let serverPage: SearchEmailsResult | null = null;
    let serverError: unknown = null;
    try {
      serverPage = await request.server(serverPosition);
    } catch (error) {
      serverError = error;
    }
    const localPage = await within(localAnswer, serverPage ? LOCAL_GRACE_MS : LOCAL_ALONE_MS);

    if (!serverPage && !localPage?.emails.length) throw serverError;
    if (serverPage && !localPage && cursor.extras === 0) {
      // Nothing local in this search: the server's answer, untouched.
      this.cursors.delete(key);
      return serverPage;
    }

    const server = serverPage?.emails ?? [];
    const serverHasMore = serverPage?.hasMore ?? false;
    const local = localPage?.emails ?? [];
    const merged = mergeSearchPages(server, serverHasMore, local, limit, cursor.shown);

    cursor.serverPosition = serverPosition + merged.serverRead;
    cursor.localPosition += merged.localRead;
    cursor.next = position + merged.emails.length;
    cursor.extras += merged.extras;
    if (serverPage) cursor.serverTotal = serverPage.total;

    const serverLeft = merged.serverRead < server.length || serverHasMore;
    const localLeft = localPage ? merged.localRead < local.length || localPage.hasMore : false;
    return {
      ...serverPage,
      emails: merged.emails,
      hasMore: serverLeft || localLeft,
      total: Math.max(cursor.serverTotal + cursor.extras, localPage?.total ?? 0, cursor.next),
    };
  }
}
