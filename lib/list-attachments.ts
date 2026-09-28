import type { Attachment, Email } from "@/lib/jmap/types";
import { debug } from "@/lib/debug";

/**
 * Lazy attachment metadata for message-list rows (#1089).
 *
 * Asking the server for `attachments` in the list request made Stalwart read
 * and parse the full raw blob of every message on the page, attachment or
 * not - seconds for a few hundred rows of real-world mail. Rows now ask for
 * their own chips once they are on screen, and only when `hasAttachment` is
 * set. Requests from rows that mount together (one list render, one scroll
 * step) are coalesced into a single Email/get per client and account, and
 * the answer is cached: an email's parts never change.
 */

export interface ListAttachmentSource {
  getEmailAttachments?(emailIds: string[], accountId?: string): Promise<Map<string, Attachment[]>>;
}

type Listener = (attachments: Attachment[]) => void;

/**
 * Loader handed to list rows: starts a lazy fetch, returns its cancel.
 * `peek` answers from the cache without fetching, so a row the list mounts
 * again can draw its chips in its first render.
 */
export interface LoadListAttachments {
  (email: Email, onLoad: Listener): () => void;
  peek?: (email: Email) => Attachment[] | undefined;
}

interface Queue {
  /** Waiting for the next flush, by email id. */
  pending: Map<string, Set<Listener>>;
  /** Sent, answer not back yet - a row mounting now joins instead of re-asking. */
  inFlight: Map<string, Set<Listener>>;
  timer: ReturnType<typeof setTimeout> | null;
}

// Long enough to collect every row of one render or scroll step, short
// enough that nobody sees the chips arrive late.
const FLUSH_DELAY_MS = 50;
const CACHE_LIMIT = 2000;

const queues = new WeakMap<ListAttachmentSource, Map<string, Queue>>();
const caches = new WeakMap<ListAttachmentSource, Map<string, Attachment[]>>();

const accountKey = (accountId: string | undefined) => accountId ?? "";
const cacheKey = (accountId: string | undefined, emailId: string) => `${accountKey(accountId)}\u0000${emailId}`;

function cacheFor(source: ListAttachmentSource): Map<string, Attachment[]> {
  let cache = caches.get(source);
  if (!cache) {
    cache = new Map();
    caches.set(source, cache);
  }
  return cache;
}

function remember(cache: Map<string, Attachment[]>, key: string, attachments: Attachment[]) {
  cache.delete(key);
  cache.set(key, attachments);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

function queueFor(source: ListAttachmentSource, accountId: string | undefined): Queue {
  let perAccount = queues.get(source);
  if (!perAccount) {
    perAccount = new Map();
    queues.set(source, perAccount);
  }
  let queue = perAccount.get(accountKey(accountId));
  if (!queue) {
    queue = { pending: new Map(), inFlight: new Map(), timer: null };
    perAccount.set(accountKey(accountId), queue);
  }
  return queue;
}

function flush(source: ListAttachmentSource, accountId: string | undefined, queue: Queue) {
  queue.timer = null;
  const batch = new Map<string, Set<Listener>>();
  for (const [id, listeners] of queue.pending) {
    if (listeners.size === 0) continue;
    batch.set(id, listeners);
    queue.inFlight.set(id, listeners);
  }
  queue.pending.clear();
  if (batch.size === 0 || !source.getEmailAttachments) return;

  const cache = cacheFor(source);
  source.getEmailAttachments([...batch.keys()], accountId)
    .then((found) => {
      for (const [id, listeners] of batch) {
        // An id the server did not return is gone; remember that too so a
        // stale row does not ask again on every remount.
        const attachments = found.get(id) ?? [];
        remember(cache, cacheKey(accountId, id), attachments);
        for (const listener of listeners) listener(attachments);
      }
    })
    .catch((error) => {
      // Not cached: the next mount of the row tries again.
      debug.warn("email", "Failed to load list attachments:", error);
    })
    .finally(() => {
      for (const id of batch.keys()) queue.inFlight.delete(id);
    });
}

/** The cached parts of one email, without asking the server for them. */
export function peekListAttachments(
  source: ListAttachmentSource,
  accountId: string | undefined,
  emailId: string,
): Attachment[] | undefined {
  return caches.get(source)?.get(cacheKey(accountId, emailId));
}

/**
 * Ask for one email's attachment parts. `onLoad` runs once with the parts
 * (synchronously when cached). Returns a cancel that drops the request if the
 * row goes away first - a row scrolled past before the flush costs nothing.
 */
export function requestListAttachments(
  source: ListAttachmentSource,
  accountId: string | undefined,
  emailId: string,
  onLoad: Listener,
): () => void {
  if (!source.getEmailAttachments) return () => {};

  const cached = cacheFor(source).get(cacheKey(accountId, emailId));
  if (cached) {
    onLoad(cached);
    return () => {};
  }

  const queue = queueFor(source, accountId);
  let listeners = queue.inFlight.get(emailId) ?? queue.pending.get(emailId);
  if (!listeners) {
    listeners = new Set();
    queue.pending.set(emailId, listeners);
  }
  listeners.add(onLoad);
  if (queue.pending.has(emailId) && !queue.timer) {
    queue.timer = setTimeout(() => flush(source, accountId, queue), FLUSH_DELAY_MS);
  }

  const joined = listeners;
  return () => {
    joined.delete(onLoad);
  };
}
