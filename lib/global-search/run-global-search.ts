import { accountMatches, type ParsedQuery } from '@/lib/global-search/query-parser';
import { mergeHits, rankHits } from '@/lib/global-search/rank';
import {
  emptyOutcome,
  type SearchAccount,
  type SearchKind,
  type SearchOutcome,
  type SearchProvider,
} from '@/lib/global-search/types';

export interface RunGlobalSearchOptions {
  parsed: ParsedQuery;
  accounts: SearchAccount[];
  providers: SearchProvider[];
  /** Cap on hits per kind taken from the local caches. */
  localLimit: number;
  /** Cap on hits per kind per login asked from the server. */
  remoteLimit: number;
  signal: AbortSignal;
  /** Called with a fresh snapshot each time hits or statuses change. Never called after `signal` aborts. */
  onUpdate: (outcome: SearchOutcome) => void;
  /** In-flight server requests at once. Every login pins HTTP/1.1 sockets already (#702), so keep this small. */
  concurrency?: number;
  /** Per-request budget; a slow login must not hold the palette hostage. */
  timeoutMs?: number;
  /** False skips the local pass (the search tab re-runs the server only). */
  includeLocal?: boolean;
}

export const DEFAULT_SEARCH_CONCURRENCY = 4;
export const DEFAULT_SEARCH_TIMEOUT_MS = 8000;

/** Whether the parsed query has anything the server can be asked for this kind. */
export function hasRemoteQuery(parsed: ParsedQuery, kind: SearchKind): boolean {
  if (parsed.text.trim()) return true;
  if (kind !== 'mail') return false;
  const { mail } = parsed;
  return Boolean(mail.from || mail.to || mail.subject || mail.body
    || mail.hasAttachment !== null || mail.isUnread !== null || mail.isStarred !== null || mail.untagged
    || mail.dateAfter || mail.dateBefore || parsed.mailboxRole);
}

function snapshot(outcome: SearchOutcome): SearchOutcome {
  return {
    hits: { ...outcome.hits },
    status: {
      mail: { ...outcome.status.mail, errors: [...outcome.status.mail.errors] },
      contacts: { ...outcome.status.contacts, errors: [...outcome.status.contacts.errors] },
      calendar: { ...outcome.status.calendar, errors: [...outcome.status.calendar.errors] },
      files: { ...outcome.status.files, errors: [...outcome.status.files.errors] },
    },
  };
}

/**
 * Fans a parsed query out to every provider × login, publishing partial
 * results as they land. Local cache hits are published synchronously before
 * the first server round-trip; each server response is merged, de-duplicated
 * against what is already shown and re-ranked. Per-account failures become
 * error rows instead of failing the whole search.
 */
export async function runGlobalSearch(options: RunGlobalSearchOptions): Promise<SearchOutcome> {
  const {
    parsed, providers, signal, onUpdate, localLimit, remoteLimit,
    concurrency = DEFAULT_SEARCH_CONCURRENCY,
    timeoutMs = DEFAULT_SEARCH_TIMEOUT_MS,
    includeLocal = true,
  } = options;
  const accounts = options.accounts.filter((account) => accountMatches(parsed.account, account));
  const outcome = emptyOutcome();
  const publish = () => {
    if (!signal.aborted) onUpdate(snapshot(outcome));
  };

  const active = providers.filter((p) => parsed.scope === 'all' || p.kind === parsed.scope);

  type Task = { provider: SearchProvider; account: SearchAccount };
  const tasks: Task[] = [];
  const pendingPerKind = new Map<SearchKind, number>();

  for (const provider of active) {
    const { kind } = provider;
    if (includeLocal && parsed.terms.length > 0) {
      try {
        outcome.hits[kind] = rankHits(mergeHits([], provider.local(parsed, accounts, localLimit)), parsed);
      } catch {
        // A cache that is mid-mutation must not kill the search; the server pass still runs.
      }
    }
    const targets = hasRemoteQuery(parsed, kind) ? accounts.filter((a) => provider.supports(a)) : [];
    pendingPerKind.set(kind, targets.length);
    outcome.status[kind].status = targets.length > 0 ? 'loading' : 'done';
    for (const account of targets) tasks.push({ provider, account });
  }
  publish();

  const runTask = async ({ provider, account }: Task) => {
    const { kind } = provider;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Client methods don't all take a signal, so a hung request would never
    // settle on its own - race it against the abort instead of trusting it.
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    });
    try {
      const result = await Promise.race([
        provider.remote(parsed, account, { limit: remoteLimit, signal: controller.signal }),
        aborted,
      ]);
      if (signal.aborted) return;
      outcome.hits[kind] = rankHits(mergeHits(outcome.hits[kind], result.hits), parsed);
      if (result.hasMore) outcome.status[kind].hasMore = true;
    } catch (error) {
      if (signal.aborted) return;
      const timedOut = controller.signal.aborted;
      outcome.status[kind].errors.push({
        localAccountId: account.localAccountId,
        accountLabel: account.label,
        message: timedOut ? 'timeout' : error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      const left = (pendingPerKind.get(kind) ?? 1) - 1;
      pendingPerKind.set(kind, left);
      if (left <= 0) outcome.status[kind].status = 'done';
      publish();
    }
  };

  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, async () => {
    while (next < tasks.length && !signal.aborted) {
      const task = tasks[next++];
      await runTask(task);
    }
  });
  await Promise.all(workers);
  return snapshot(outcome);
}
