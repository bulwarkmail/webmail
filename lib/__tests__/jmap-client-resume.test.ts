import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '../jmap/client';

const SERVER = 'https://mail.example.test';
type States = Record<string, { Email: string; Mailbox: string }>;
type Internals = {
  checkForStateChanges(): Promise<void>;
  fetchCurrentStates(): Promise<void>;
  setRateLimited(retryAfterMs: number): void;
  setupBrowserEventListeners(): void;
  pollingStates: Record<string, string>;
};
const clients: JMAPClient[] = [];
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  await vi.advanceTimersByTimeAsync(0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function fixture(accountIds = ['A']) {
  const states: States = Object.fromEntries(accountIds.map(id => [id, { Email: 'e1', Mailbox: 'm1' }]));
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const polls: unknown[][] = [];
  let holdPoll: ((response: Response) => Promise<Response>) | undefined;
  let failPoll = false;
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith('/.well-known/jmap')) {
      return json({
        capabilities: { 'urn:ietf:params:jmap:core': { maxCallsInRequest: 16 } },
        accounts: Object.fromEntries(accountIds.map(id => [id, {
          name: id, isPersonal: id === 'A', accountCapabilities: { 'urn:ietf:params:jmap:mail': {} },
        }])),
        primaryAccounts: { 'urn:ietf:params:jmap:mail': 'A' },
        apiUrl: `${SERVER}/jmap/`,
        eventSourceUrl: `${SERVER}/events?types={types}&ping={ping}&closeafter={closeafter}`,
      });
    }
    if ((init?.headers as Record<string, string>)?.Accept === 'text/event-stream') {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streams.push(controller);
          init?.signal?.addEventListener('abort', () => {
            controller.error(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        },
      });
      return new Response(body, { status: 200 });
    }
    const calls = JSON.parse(String(init?.body)).methodCalls as [string, { accountId: string }, string][];
    polls.push(calls);
    if (failPoll) return new Response(null, { status: 500 });
    const response = json({ methodResponses: calls.map(([method, args, callId]) => [
      method, { accountId: args.accountId, state: states[args.accountId][method === 'Email/get' ? 'Email' : 'Mailbox'], list: [] }, callId,
    ]) });
    return holdPoll ? holdPoll(response) : response;
  });
  vi.stubGlobal('fetch', fetch);
  const client = new JMAPClient(SERVER, 'alice@example.test', 'pw');
  clients.push(client);
  await client.connect();
  const internals = client as unknown as Internals;
  const callback = vi.fn();
  client.onStateChange(callback);
  const settle = () => vi.advanceTimersByTimeAsync(0);
  const event = (changed: Record<string, Record<string, string>>) => {
    streams.at(-1)!.enqueue(new TextEncoder().encode(`event: state\ndata: ${JSON.stringify({ '@type': 'StateChange', changed })}\n\n`));
  };
  function pause() {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    holdPoll = async response => { await gate; return response; };
    return () => { holdPoll = undefined; release(); };
  }
  return { client, internals, callback, states, streams, polls, settle, event, pause, fail: () => { failPoll = true; }, ok: () => { failPoll = false; } };
}

describe('JMAP resume and SSE catch-up', () => {
  it('records an unknown initial state silently, then reports only changed state', async () => {
    const f = await fixture();
    await f.internals.checkForStateChanges();
    expect(f.callback).not.toHaveBeenCalled();
    await f.internals.checkForStateChanges();
    expect(f.callback).not.toHaveBeenCalled();
    f.states.A.Email = 'e2';
    await f.internals.checkForStateChanges();
    expect(f.callback).toHaveBeenCalledExactlyOnceWith({ '@type': 'StateChange', changed: { A: { Email: 'e2' } } });
  });

  it('primes the baseline once after initial SSE success, without reporting or adding fast polling', async () => {
    const f = await fixture();
    f.client.setupPushNotifications();
    await f.settle();
    expect(f.streams).toHaveLength(1);
    expect(f.polls).toHaveLength(1);
    expect(f.polls[0]).toHaveLength(2);
    expect(f.callback).not.toHaveBeenCalled();
    expect(f.internals.pollingStates).toEqual({ 'A:Mailbox': 'm1', 'A:Email': 'e1' });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(f.streams).toHaveLength(1);
    expect(f.polls).toHaveLength(1);
  });

  it('does not report on the first connection of a new push session, only on its reconnects', async () => {
    const f = await fixture();
    f.client.setupPushNotifications();
    await f.settle();
    // An account switch or re-login closes the session and opens a fresh one:
    // the app loads that account anyway, so its first catch-up only primes.
    f.client.closePushNotifications();
    f.states.A = { Mailbox: 'm2', Email: 'e2' };
    f.client.onStateChange(f.callback);
    f.client.setupPushNotifications();
    await f.settle();
    expect(f.streams).toHaveLength(2);
    expect(f.polls).toHaveLength(2);
    expect(f.callback).not.toHaveBeenCalled();
    f.streams.at(-1)!.close();
    await f.settle();
    f.states.A.Email = 'e3';
    await vi.advanceTimersByTimeAsync(3_000);
    expect(f.streams).toHaveLength(3);
    expect(f.callback).toHaveBeenCalledExactlyOnceWith({ '@type': 'StateChange', changed: { A: { Email: 'e3' } } });
  });

  it('reports changes made during a rate-limit pause when the session had a baseline', async () => {
    const f = await fixture();
    f.client.setupPushNotifications();
    await f.settle();
    f.internals.setRateLimited(5_000);
    f.states.A.Email = 'during-pause';
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.streams).toHaveLength(2);
    expect(f.callback).toHaveBeenCalledExactlyOnceWith({ '@type': 'StateChange', changed: { A: { Email: 'during-pause' } } });
  });

  it('primes silently after a rate-limit pause when the session never had a baseline', async () => {
    const f = await fixture();
    f.fail();
    f.client.setupPushNotifications();
    await f.settle();
    expect(f.internals.pollingStates).toEqual({});
    f.internals.setRateLimited(5_000);
    f.ok();
    f.states.A.Email = 'during-pause';
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.streams).toHaveLength(2);
    expect(f.internals.pollingStates).toEqual({ 'A:Mailbox': 'm1', 'A:Email': 'during-pause' });
    expect(f.callback).not.toHaveBeenCalled();
  });

  it('reconciles a resume against the baseline, and coalesces overlapping focus/online checks', async () => {
    const f = await fixture();
    await f.internals.checkForStateChanges();
    expect(f.polls).toHaveLength(1);
    f.internals.setupBrowserEventListeners();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    await f.settle();
    expect(f.polls).toHaveLength(1);
    const release = f.pause();
    f.states.A.Email = 'background-mail';
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
    await f.settle();
    expect(f.polls).toHaveLength(2);
    release();
    await f.settle();
    expect(f.callback).toHaveBeenCalledExactlyOnceWith({ '@type': 'StateChange', changed: { A: { Email: 'background-mail' } } });
    document.dispatchEvent(new Event('visibilitychange'));
    await f.settle();
    expect(f.callback).toHaveBeenCalledTimes(1);
  });

  it('catches missed changes on reconnect, with no duplicate on an unchanged reconnect', async () => {
    const f = await fixture();
    f.client.setupPushNotifications();
    await f.settle();
    f.callback.mockClear();
    f.streams.at(-1)!.close();
    await f.settle();
    f.states.A.Email = 'missed';
    await vi.advanceTimersByTimeAsync(3_000);
    expect(f.streams).toHaveLength(2);
    expect(f.polls).toHaveLength(2);
    expect(f.callback).toHaveBeenCalledExactlyOnceWith({ '@type': 'StateChange', changed: { A: { Email: 'missed' } } });
    f.streams.at(-1)!.close();
    await f.settle();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(f.streams).toHaveLength(3);
    expect(f.polls).toHaveLength(3);
    expect(f.callback).toHaveBeenCalledTimes(1);
  });

  it('keeps foreground SSE updates and suppresses the same state from a later poll or SSE event', async () => {
    const f = await fixture();
    f.client.setupPushNotifications();
    await f.settle();
    f.callback.mockClear();
    f.states.A.Email = 'e2';
    f.event({ A: { Email: 'e2', ContactCard: 'contacts-2' } });
    await f.settle();
    await f.internals.checkForStateChanges();
    f.event({ A: { Email: 'e2' } });
    await f.settle();
    expect(f.callback).toHaveBeenCalledExactlyOnceWith({ '@type': 'StateChange', changed: { A: { Email: 'e2', ContactCard: 'contacts-2' } } });
  });

  it('suppresses an SSE state already delivered by catch-up', async () => {
    const f = await fixture();
    f.client.setupPushNotifications();
    await f.settle();
    f.streams.at(-1)!.close();
    await f.settle();
    f.states.A.Email = 'e2';
    await vi.advanceTimersByTimeAsync(3_000);
    expect(f.callback).toHaveBeenCalledTimes(1);
    f.event({ A: { Email: 'e2' } });
    await f.settle();
    expect(f.callback).toHaveBeenCalledExactlyOnceWith({ '@type': 'StateChange', changed: { A: { Email: 'e2' } } });
  });

  it('still reports an SSE state that a silent baseline prime read first', async () => {
    const f = await fixture();
    // The shared-account prime and the first catch-up record a state without
    // reporting it; they can read new mail before its push event arrives.
    f.states.A.Email = 'raced';
    await f.internals.fetchCurrentStates();
    f.client.setupPushNotifications();
    await f.settle();
    expect(f.callback).not.toHaveBeenCalled();
    f.event({ A: { Email: 'raced' } });
    await f.settle();
    expect(f.callback).toHaveBeenCalledExactlyOnceWith({ '@type': 'StateChange', changed: { A: { Email: 'raced' } } });
  });

  it('does not let a re-prime swallow a change the next check should report', async () => {
    const f = await fixture();
    f.client.setupPushNotifications();
    await f.settle();
    // A promoted stream re-primes the shared-account poll mid-session.
    f.states.A.Email = 'since-last-tick';
    await f.internals.fetchCurrentStates();
    expect(f.internals.pollingStates['A:Email']).toBe('e1');
    await f.internals.checkForStateChanges();
    expect(f.callback).toHaveBeenCalledExactlyOnceWith({ '@type': 'StateChange', changed: { A: { Email: 'since-last-tick' } } });
  });

  it('does not overwrite a newer SSE state with a delayed poll response', async () => {
    const f = await fixture();
    f.client.setupPushNotifications();
    await f.settle();
    f.callback.mockClear();
    const release = f.pause();
    const check = f.internals.checkForStateChanges();
    await f.settle();
    f.states.A.Email = 'newer';
    f.event({ A: { Email: 'newer' } });
    await f.settle();
    release();
    await check;
    expect(f.internals.pollingStates['A:Email']).toBe('newer');
    await f.internals.checkForStateChanges();
    expect(f.callback).toHaveBeenCalledExactlyOnceWith({ '@type': 'StateChange', changed: { A: { Email: 'newer' } } });
  });

  it('preserves secondary-account polling and account-scoped resume changes', async () => {
    const f = await fixture(['A', 'shared']);
    f.client.setupPushNotifications();
    await f.settle();
    f.callback.mockClear();
    f.states.shared.Email = 'shared-new';
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.callback).toHaveBeenCalledExactlyOnceWith({ '@type': 'StateChange', changed: { shared: { Email: 'shared-new' } } });
    f.states.A.Mailbox = 'm2';
    f.states.shared.Mailbox = 'shared-m2';
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await f.settle();
    expect(f.callback).toHaveBeenLastCalledWith({ '@type': 'StateChange', changed: { A: { Mailbox: 'm2' }, shared: { Mailbox: 'shared-m2' } } });
    expect(f.streams).toHaveLength(1);
  });

  it('keeps a successful SSE connection when catch-up fails, without a retry loop', async () => {
    const f = await fixture();
    f.fail();
    f.client.setupPushNotifications();
    await f.settle();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(f.streams).toHaveLength(1);
    expect(f.polls).toHaveLength(1);
    expect(f.callback).not.toHaveBeenCalled();
    f.event({ A: { Email: 'live' } });
    await f.settle();
    expect(f.callback).toHaveBeenCalledExactlyOnceWith({ '@type': 'StateChange', changed: { A: { Email: 'live' } } });
  });

  it('does not let shared-account baseline priming overwrite a live SSE update', async () => {
    const f = await fixture(['A', 'shared']);
    const release = f.pause();
    f.client.setupPushNotifications();
    await f.settle();
    f.states.A.Email = 'live-new';
    f.event({ A: { Email: 'live-new' } });
    await f.settle();
    release();
    await f.settle();
    expect(f.internals.pollingStates['A:Email']).toBe('live-new');
    const count = f.callback.mock.calls.length;
    await f.internals.checkForStateChanges();
    expect(f.callback).toHaveBeenCalledTimes(count);
  });

  it('reconciles a reopened push lifecycle without stale results or overlapping checks', async () => {
    const f = await fixture();
    const releaseOld = f.pause();
    f.client.setupPushNotifications();
    await f.settle();
    expect(f.polls).toHaveLength(1);
    f.client.closePushNotifications();

    f.states.A = { Mailbox: 'm2', Email: 'new-lifecycle' };
    const releaseNew = f.pause();
    f.client.onStateChange(f.callback);
    f.client.setupPushNotifications();
    await f.settle();
    expect(f.streams).toHaveLength(2);
    expect(f.polls).toHaveLength(2);
    expect(f.callback).not.toHaveBeenCalled();

    f.event({ A: { Mailbox: 'm2', Email: 'new-lifecycle' } });
    await f.settle();
    expect(f.callback).toHaveBeenCalledTimes(1);
    releaseOld();
    await f.settle();
    expect(f.internals.pollingStates).toEqual({ 'A:Mailbox': 'm2', 'A:Email': 'new-lifecycle' });
    expect(f.callback).toHaveBeenCalledTimes(1);

    // The old finally must not clear the replacement lifecycle's guard.
    await f.internals.checkForStateChanges();
    expect(f.polls).toHaveLength(2);
    releaseNew();
    await f.settle();
    await f.internals.checkForStateChanges();
    expect(f.polls).toHaveLength(3);
    f.event({ A: { Mailbox: 'm2', Email: 'new-lifecycle' } });
    await f.settle();
    expect(f.callback).toHaveBeenCalledExactlyOnceWith({ '@type': 'StateChange', changed: { A: { Mailbox: 'm2', Email: 'new-lifecycle' } } });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(f.streams).toHaveLength(2);
    expect(f.polls).toHaveLength(3);
  });
});
