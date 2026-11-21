import { describe, expect, it, vi } from 'vitest';
import { parseSearchQuery } from '../query-parser';
import { hasRemoteQuery, runGlobalSearch } from '../run-global-search';
import type { GlobalSearchHit, SearchAccount, SearchOutcome, SearchProvider } from '../types';

function account(id: string): SearchAccount {
  return { localAccountId: id, label: id.toUpperCase(), email: `${id}@example.org`, client: {} as SearchAccount['client'] };
}

function hit(kind: GlobalSearchHit['kind'], localAccountId: string, id: string, source: 'local' | 'remote' = 'remote'): GlobalSearchHit {
  return {
    kind, localAccountId, id, jmapAccountId: 'j', accountLabel: localAccountId, title: id, subtitle: '', date: null, source,
    contact: {} as never, storeId: id,
  } as GlobalSearchHit;
}

function provider(kind: GlobalSearchHit['kind'], impl: Partial<SearchProvider>): SearchProvider {
  return {
    kind,
    supports: () => true,
    local: () => [],
    remote: async () => ({ hits: [], hasMore: false }),
    ...impl,
  };
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('hasRemoteQuery', () => {
  it('needs text for non-mail kinds but accepts mail operators alone', () => {
    expect(hasRemoteQuery(parseSearchQuery('is:unread'), 'mail')).toBe(true);
    expect(hasRemoteQuery(parseSearchQuery('is:unread'), 'contacts')).toBe(false);
    expect(hasRemoteQuery(parseSearchQuery('in:trash'), 'mail')).toBe(true);
    expect(hasRemoteQuery(parseSearchQuery('is:untagged'), 'mail')).toBe(true);
    expect(hasRemoteQuery(parseSearchQuery('has:notag'), 'mail')).toBe(true);
    expect(hasRemoteQuery(parseSearchQuery('bob'), 'files')).toBe(true);
    expect(hasRemoteQuery(parseSearchQuery(''), 'mail')).toBe(false);
  });
});

describe('runGlobalSearch', () => {
  it('publishes local hits first, then merges each login as it lands', async () => {
    const a = deferred<{ hits: GlobalSearchHit[]; hasMore: boolean }>();
    const b = deferred<{ hits: GlobalSearchHit[]; hasMore: boolean }>();
    const contacts = provider('contacts', {
      local: () => [hit('contacts', 'a', 'c1', 'local')],
      remote: (_p, acc) => (acc.localAccountId === 'a' ? a.promise : b.promise),
    });
    const updates: SearchOutcome[] = [];
    const run = runGlobalSearch({
      parsed: parseSearchQuery('bob'),
      accounts: [account('a'), account('b')],
      providers: [contacts],
      localLimit: 5,
      remoteLimit: 5,
      signal: new AbortController().signal,
      onUpdate: (o) => updates.push(o),
    });

    expect(updates).toHaveLength(1);
    expect(updates[0].hits.contacts.map((h) => h.id)).toEqual(['c1']);
    expect(updates[0].status.contacts.status).toBe('loading');

    b.resolve({ hits: [hit('contacts', 'b', 'c9')], hasMore: false });
    await vi.waitFor(() => expect(updates).toHaveLength(2));
    expect(updates[1].hits.contacts.map((h) => `${h.localAccountId}/${h.id}`)).toEqual(['a/c1', 'b/c9']);
    expect(updates[1].status.contacts.status).toBe('loading');

    a.resolve({ hits: [hit('contacts', 'a', 'c1')], hasMore: true });
    const final = await run;
    expect(final.status.contacts.status).toBe('done');
    expect(final.status.contacts.hasMore).toBe(true);
    // The remote twin replaced the local one, no duplicate.
    expect(final.hits.contacts.filter((h) => h.id === 'c1')).toHaveLength(1);
    expect(final.hits.contacts.find((h) => h.id === 'c1')?.source).toBe('remote');
  });

  it('turns a failing login into an error row and keeps the others', async () => {
    const mail = provider('mail', {
      remote: async (_p, acc) => {
        if (acc.localAccountId === 'b') throw new Error('boom');
        return { hits: [hit('mail', acc.localAccountId, 'm1')], hasMore: false };
      },
    });
    const final = await runGlobalSearch({
      parsed: parseSearchQuery('x'), accounts: [account('a'), account('b')], providers: [mail],
      localLimit: 5, remoteLimit: 5, signal: new AbortController().signal, onUpdate: () => {},
    });
    expect(final.hits.mail.map((h) => h.localAccountId)).toEqual(['a']);
    expect(final.status.mail.errors).toEqual([{ localAccountId: 'b', accountLabel: 'B', message: 'boom' }]);
    expect(final.status.mail.status).toBe('done');
  });

  it('skips logins the provider does not support and kinds outside the scope', async () => {
    const remote = vi.fn(async () => ({ hits: [], hasMore: false }));
    const files = provider('files', { supports: (acc) => acc.localAccountId === 'a', remote });
    const calendar = provider('calendar', { remote });
    const final = await runGlobalSearch({
      parsed: parseSearchQuery('in:files x'), accounts: [account('a'), account('b')], providers: [files, calendar],
      localLimit: 5, remoteLimit: 5, signal: new AbortController().signal, onUpdate: () => {},
    });
    expect(remote).toHaveBeenCalledTimes(1);
    expect(final.status.files.status).toBe('done');
    expect(final.status.calendar.status).toBe('idle');
  });

  it('collapses identical hits from two logins to the same server (multi-account duplicates)', async () => {
    const sameObject = (localAccountId: string) => ({
      ...hit('calendar', localAccountId, 'evt-002'),
      jmapAccountId: 'c',
      serverUrl: 'https://mail.example',
      event: { id: 'evt-002' },
    } as GlobalSearchHit);
    const final = await runGlobalSearch({
      parsed: parseSearchQuery('planning'),
      accounts: [account('a'), account('b')],
      providers: [provider('calendar', { remote: async (_p, acc) => ({ hits: [sameObject(acc.localAccountId)], hasMore: false }) })],
      localLimit: 5, remoteLimit: 5, signal: new AbortController().signal, onUpdate: () => {},
    });
    expect(final.hits.calendar).toHaveLength(1);
  });

  it('honours account: by dropping non-matching logins', async () => {
    const remote = vi.fn(async (_p: unknown, acc: SearchAccount) => ({ hits: [hit('mail', acc.localAccountId, 'm')], hasMore: false }));
    const final = await runGlobalSearch({
      parsed: parseSearchQuery('account:b x'), accounts: [account('a'), account('b')], providers: [provider('mail', { remote })],
      localLimit: 5, remoteLimit: 5, signal: new AbortController().signal, onUpdate: () => {},
    });
    expect(remote).toHaveBeenCalledTimes(1);
    expect(final.hits.mail.map((h) => h.localAccountId)).toEqual(['b']);
  });

  it('caps in-flight requests at the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    const remote = () => new Promise<{ hits: GlobalSearchHit[]; hasMore: boolean }>((resolve) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      gates.push(() => { inFlight--; resolve({ hits: [], hasMore: false }); });
    });
    const accounts = ['a', 'b', 'c', 'd', 'e', 'f'].map(account);
    const run = runGlobalSearch({
      parsed: parseSearchQuery('x'), accounts, providers: [provider('mail', { remote })],
      localLimit: 5, remoteLimit: 5, concurrency: 2, signal: new AbortController().signal, onUpdate: () => {},
    });
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    expect(peak).toBe(2);
    // Release one at a time: the pool must refill to exactly two, never more.
    let released = 0;
    while (released < accounts.length) {
      await vi.waitFor(() => expect(gates.length).toBeGreaterThan(0));
      gates.shift()!();
      released++;
    }
    await run;
    expect(peak).toBe(2);
  });

  it('times out a slow login with a "timeout" error and stops publishing after abort', async () => {
    vi.useFakeTimers();
    try {
      const never = () => new Promise<{ hits: GlobalSearchHit[]; hasMore: boolean }>(() => {});
      const updates: SearchOutcome[] = [];
      const run = runGlobalSearch({
        parsed: parseSearchQuery('x'), accounts: [account('a')], providers: [provider('mail', { remote: never })],
        localLimit: 5, remoteLimit: 5, timeoutMs: 1000, signal: new AbortController().signal, onUpdate: (o) => updates.push(o),
      });
      await vi.advanceTimersByTimeAsync(1001);
      const final = await run;
      expect(final.status.mail.errors[0]?.message).toBe('timeout');

      const controller = new AbortController();
      const aborted: SearchOutcome[] = [];
      const run2 = runGlobalSearch({
        parsed: parseSearchQuery('x'), accounts: [account('a')], providers: [provider('mail', { remote: never })],
        localLimit: 5, remoteLimit: 5, timeoutMs: 1000, signal: controller.signal, onUpdate: (o) => aborted.push(o),
      });
      controller.abort();
      await vi.advanceTimersByTimeAsync(1001);
      await run2;
      expect(aborted).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
