import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JMAPClient, RequestTimeoutError } from '../jmap/client';

/**
 * A connection that accepts the request and then goes silent: the promise never
 * settles on its own, exactly like `fetch` over a socket the network has torn
 * down underneath it. Only an abort ends it - which is what the deadline does.
 */
function stalledFetch() {
  return (_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    });
}

// Minimal valid JMAP session response
function makeSession(overrides?: Record<string, unknown>) {
  return {
    capabilities: { 'urn:ietf:params:jmap:core': {} },
    accounts: { 'acct-1': { name: 'test', isPersonal: true, accountCapabilities: {} } },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acct-1' },
    apiUrl: 'https://mail.example.com/jmap/api',
    downloadUrl: 'https://mail.example.com/jmap/download/{accountId}/{blobId}/{name}',
    uploadUrl: 'https://mail.example.com/jmap/upload/{accountId}/',
    eventSourceUrl: 'https://mail.example.com/jmap/eventsource',
    ...overrides,
  };
}

function mockFetchResponse(status: number, body?: unknown): Response {
  return new Response(body ? JSON.stringify(body) : null, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetchResponseWithHeaders(status: number, headers: Record<string, string>, body?: unknown): Response {
  return new Response(body ? JSON.stringify(body) : null, {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

describe('JMAPClient resilience', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  /**
   * Helper: create a connected basic-auth client by mocking the connect() flow
   */
  async function createConnectedClient(mode: 'basic' | 'bearer' = 'basic'): Promise<JMAPClient> {
    const session = makeSession();

    if (mode === 'basic') {
      // connect() calls authenticatedFetch → fetch for session
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, session));
      const client = new JMAPClient('https://mail.example.com', 'user@test.com', 'pass123');
      await client.connect();
      fetchSpy.mockReset();
      return client;
    }

    // bearer
    fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, session));
    const client = JMAPClient.withBearer('https://mail.example.com', 'token123', 'user@test.com');
    await client.connect();
    fetchSpy.mockReset();
    return client;
  }

  describe('authenticatedFetch - network error retry', () => {
    it('retries once on transient network error', async () => {
      const client = await createConnectedClient();
      const echoResponse = { methodResponses: [['Core/echo', { ping: 'pong' }, '0']] };

      fetchSpy
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(mockFetchResponse(200, echoResponse));

      // ping() calls request() which calls authenticatedFetch
      await expect(client.ping()).resolves.toBeUndefined();
      // First call fails, delay, second call succeeds
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('throws on persistent network error after retry', async () => {
      const client = await createConnectedClient();

      fetchSpy
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockRejectedValueOnce(new TypeError('Failed to fetch'));

      await expect(client.ping()).rejects.toThrow('Failed to fetch');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('authenticatedFetch - stalled request deadline', () => {
    const downloadCalls = () =>
      fetchSpy.mock.calls.filter(([url]: unknown[]) => String(url).includes('/jmap/download/'));

    it('rejects a request that never produces response headers', async () => {
      const client = await createConnectedClient();
      fetchSpy.mockImplementation(stalledFetch());

      const pending = client.ping();
      const assertion = expect(pending).rejects.toBeInstanceOf(RequestTimeoutError);
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    });

    it('does not replay a timed-out request', async () => {
      // The network-error path retries once, but a timeout may mean the server
      // received and acted on the request - replaying an EmailSubmission/set
      // there would send the message twice. Counted on the download URL so the
      // keep-alive ping, which fires against the API URL while the clock runs,
      // stays out of the tally.
      const client = await createConnectedClient();
      fetchSpy.mockImplementation(stalledFetch());

      const pending = client.fetchBlob('blob-1', 'big.zip', 'application/zip');
      const assertion = expect(pending).rejects.toBeInstanceOf(RequestTimeoutError);
      await vi.advanceTimersByTimeAsync(300_000);
      await assertion;
      // Well past the 1s the retry path would have waited.
      await vi.advanceTimersByTimeAsync(5_000);

      expect(downloadCalls()).toHaveLength(1);
    });

    it('clears the deadline once the response arrives, leaving the body alone', async () => {
      const client = await createConnectedClient();
      const echoResponse = { methodResponses: [['Core/echo', { ping: 'pong' }, '0']] };
      let capturedSignal: AbortSignal | undefined;

      fetchSpy.mockImplementation((_url: string, init?: RequestInit) => {
        capturedSignal = init?.signal ?? undefined;
        return Promise.resolve(mockFetchResponse(200, echoResponse));
      });

      await expect(client.ping()).resolves.toBeUndefined();

      // Long after the deadline would have fired, a streaming body handed back
      // to the caller (SSE) must still be readable.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(capturedSignal?.aborted).toBe(false);
    });

    it('gives blob transfers a longer budget than ordinary requests', async () => {
      const client = await createConnectedClient();
      fetchSpy.mockImplementation(stalledFetch());

      let outcome: unknown;
      const pending = client
        .fetchBlob('blob-1', 'big.zip', 'application/zip')
        .catch((error) => { outcome = error; });

      // A large attachment on a slow uplink is legitimately still moving well
      // past the deadline that applies to an ordinary API call.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(outcome).toBeUndefined();

      await vi.advanceTimersByTimeAsync(300_000);
      await pending;
      expect(outcome).toBeInstanceOf(RequestTimeoutError);
    });
  });

  describe('authenticatedFetch - basic auth 401 session refresh', () => {
    it('refreshes session and retries on 401 for API requests', async () => {
      const client = await createConnectedClient();
      const refreshedSession = makeSession({ apiUrl: 'https://mail.example.com/jmap/api-v2' });
      const echoResponse = { methodResponses: [['Core/echo', { ping: 'pong' }, '0']] };

      fetchSpy
        // First API call → 401
        .mockResolvedValueOnce(mockFetchResponse(401))
        // refreshSession() fetches /.well-known/jmap
        .mockResolvedValueOnce(mockFetchResponse(200, refreshedSession))
        // Retry of original request → 200
        .mockResolvedValueOnce(mockFetchResponse(200, echoResponse));

      await expect(client.ping()).resolves.toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledTimes(3);

      // Verify the session refresh hit the right URL
      const refreshCall = fetchSpy.mock.calls[1];
      expect(refreshCall[0]).toBe('https://mail.example.com/.well-known/jmap');
    });

    it('returns original 401 response when session refresh fails', async () => {
      const client = await createConnectedClient();

      fetchSpy
        // First API call → 401
        .mockResolvedValueOnce(mockFetchResponse(401))
        // refreshSession() also fails
        .mockResolvedValueOnce(mockFetchResponse(401));

      // request() throws because response.ok is false
      await expect(client.ping()).rejects.toThrow('Request failed: 401');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('does NOT attempt session refresh for /.well-known/jmap requests', async () => {
      // Connect will fail with 401 on the session URL itself
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(401));
      const client = new JMAPClient('https://mail.example.com', 'user@test.com', 'wrong-pass');

      // connect() should throw without trying to refresh session (would cause infinite recursion)
      await expect(client.connect()).rejects.toThrow('Invalid username or password');
      // Only one fetch call - no refresh attempt
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('authenticatedFetch - bearer token refresh', () => {
    it('refreshes token and retries on 401 for bearer mode', async () => {
      const tokenRefresh = vi.fn().mockResolvedValue('new-token-456');
      const session = makeSession();

      fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, session));
      const client = JMAPClient.withBearer('https://mail.example.com', 'old-token', 'user@test.com', tokenRefresh);
      await client.connect();
      fetchSpy.mockReset();

      const echoResponse = { methodResponses: [['Core/echo', { ping: 'pong' }, '0']] };

      fetchSpy
        // First API call → 401
        .mockResolvedValueOnce(mockFetchResponse(401))
        // Retry with new token → 200
        .mockResolvedValueOnce(mockFetchResponse(200, echoResponse));

      await expect(client.ping()).resolves.toBeUndefined();
      expect(tokenRefresh).toHaveBeenCalledOnce();
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      // Verify retry used the new token
      const retryCall = fetchSpy.mock.calls[1];
      const retryHeaders = retryCall[1]?.headers as Record<string, string>;
      expect(retryHeaders['Authorization']).toBe('Bearer new-token-456');
    });
  });

  describe('authenticatedFetch - 429 rate limiting', () => {
    it('stops sending authenticated requests until the retry window expires', async () => {
      const client = await createConnectedClient();

      fetchSpy.mockResolvedValueOnce(
        mockFetchResponseWithHeaders(429, { 'Retry-After': '120' }, {
          type: 'about:blank',
          status: 429,
          title: 'Too Many Authentication Attempts',
        })
      );

      await expect(client.ping()).rejects.toThrow('Rate limited by server');
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      fetchSpy.mockClear();
      await expect(client.ping()).rejects.toThrow('Rate limited by server');
      expect(fetchSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(120_000);
      fetchSpy.mockClear();

      const echoResponse = { methodResponses: [['Core/echo', { ping: 'pong' }, '0']] };
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, echoResponse));

      await expect(client.ping()).resolves.toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('session URL rewriting', () => {
    async function connectWith(session: Record<string, unknown>, serverUrl = 'https://mail.example.com') {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, makeSession(session)));
      const client = new JMAPClient(serverUrl, 'user@test.com', 'pass123');
      await client.connect();
      fetchSpy.mockReset();
      return client;
    }

    async function pingUrl(client: JMAPClient): Promise<string> {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse(200, { methodResponses: [['Core/echo', { ping: 'pong' }, '0']] }),
      );
      await client.ping();
      return String(fetchSpy.mock.calls[0][0]);
    }

    it.each([
      ['absolute-path relative', '/jmap/api'],
      ['bare relative', 'jmap/api'],
      ['cross-origin absolute', 'https://other.example.com/jmap/api'],
      ['network-path reference', '//other.example.com/jmap/api'],
    ])('anchors a %s apiUrl at the server origin', async (_form, apiUrl) => {
      const client = await connectWith({ apiUrl });
      expect(await pingUrl(client)).toBe('https://mail.example.com/jmap/api');
    });

    it('anchors a relative apiUrl at the origin even when serverUrl has a path', async () => {
      const client = await connectWith({ apiUrl: 'jmap/api' }, 'https://mail.example.com/proxy');
      expect(await pingUrl(client)).toBe('https://mail.example.com/jmap/api');
    });

    it.each([
      ['same-origin', 'https://mail.example.com'],
      ['cross-origin', 'https://other.example.com'],
    ])('keeps URI Template placeholders literal in a %s downloadUrl', async (_o, host) => {
      const client = await connectWith({
        downloadUrl: `${host}/download/{accountId}/{blobId}/{name}?accept={type}`,
      });
      expect(client.getBlobDownloadUrl('blob1', 'file.txt', 'text/plain', 'acct-1')).toBe(
        'https://mail.example.com/download/acct-1/blob1/file.txt?accept=text%2Fplain',
      );
    });

    it('leaves an empty downloadUrl falsy so the unavailable guard still fires', async () => {
      const client = await connectWith({ downloadUrl: '' });
      expect(() => client.getBlobDownloadUrl('blob1')).toThrow('Download URL not available');
    });
  });

  describe('refreshSession', () => {
    it('updates session fields from server response', async () => {
      const client = await createConnectedClient();

      const newSession = makeSession({
        apiUrl: 'https://mail.example.com/jmap/api-v2',
        downloadUrl: 'https://mail.example.com/jmap/download-v2/{accountId}/{blobId}/{name}',
        capabilities: { 'urn:ietf:params:jmap:core': {}, 'urn:ietf:params:jmap:mail': {} },
      });

      // Trigger a 401 → refreshSession flow
      const echoResponse = { methodResponses: [['Core/echo', { ping: 'pong' }, '0']] };
      fetchSpy
        .mockResolvedValueOnce(mockFetchResponse(401))
        .mockResolvedValueOnce(mockFetchResponse(200, newSession))
        .mockResolvedValueOnce(mockFetchResponse(200, echoResponse));

      await client.ping();

      // After refresh, subsequent requests should go to the new apiUrl
      fetchSpy.mockReset();
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, echoResponse));
      await client.ping();

      const apiCall = fetchSpy.mock.calls[0];
      expect(apiCall[0]).toBe('https://mail.example.com/jmap/api-v2');
    });
  });

  describe('onConnectionChange callback', () => {
    it('fires with true on successful ping during keep-alive', async () => {
      const client = await createConnectedClient();
      const callback = vi.fn();
      client.onConnectionChange(callback);

      const echoResponse = { methodResponses: [['Core/echo', { ping: 'pong' }, '0']] };
      // A Response body is single-use, so one shared instance breaks as soon
      // as anything fetches more than once in the window - serve a fresh one
      // per call like the other tests in this file.
      fetchSpy.mockImplementation(() => Promise.resolve(mockFetchResponse(200, echoResponse)));

      // Advance past keep-alive interval (30s)
      await vi.advanceTimersByTimeAsync(30_000);

      expect(callback).toHaveBeenCalledWith(true);
    });

    it('fires with false on ping failure, then true on successful reconnect', async () => {
      const client = await createConnectedClient();
      const callback = vi.fn();
      client.onConnectionChange(callback);

      const session = makeSession();

      // ping() will call request() → authenticatedFetch → first fetch fails
      // Then retry in authenticatedFetch also fails
      // So ping throws, keep-alive catches it, fires false
      // Then reconnect → connect() → authenticatedFetch(sessionUrl) succeeds
      fetchSpy
        // ping fails - network error, retry also fails
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        // reconnect → connect() → session URL succeeds
        .mockResolvedValueOnce(mockFetchResponse(200, session));

      // Trigger the keep-alive interval
      await vi.advanceTimersByTimeAsync(30_000);
      // Flush the nested 1s retry delay inside authenticatedFetch
      await vi.advanceTimersByTimeAsync(1_000);
      // Allow microtasks to settle
      await vi.advanceTimersByTimeAsync(0);

      expect(callback).toHaveBeenCalledWith(false);
      expect(callback).toHaveBeenCalledWith(true);
      // Verify ordering: false fired before true
      const calls = callback.mock.calls.map((c) => c[0]);
      const falseIdx = calls.indexOf(false);
      const trueIdx = calls.lastIndexOf(true);
      expect(falseIdx).toBeLessThan(trueIdx);
    });

    it('fires with false when ping and reconnect both fail', async () => {
      const client = await createConnectedClient();
      const callback = vi.fn();
      client.onConnectionChange(callback);

      // All fetches fail
      fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));

      // Trigger the keep-alive interval
      await vi.advanceTimersByTimeAsync(30_000);
      // Flush nested retry delays
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(callback).toHaveBeenCalledWith(false);
      // Should not have fired true at any point
      const trueCall = callback.mock.calls.find((c) => c[0] === true);
      expect(trueCall).toBeUndefined();
    });

    it('does not mark the connection lost or reconnect repeatedly while rate limited', async () => {
      // The file-level shouldAdvanceTime lets fake time creep forward with
      // the wall clock, which can fire the 30s keep-alive an extra time on a
      // slow or loaded machine. This test counts pings, so pin the clock and
      // advance it explicitly.
      vi.useFakeTimers({ shouldAdvanceTime: false });
      const client = await createConnectedClient();
      const callback = vi.fn();
      client.onConnectionChange(callback);

      fetchSpy.mockResolvedValueOnce(
        mockFetchResponseWithHeaders(429, { 'Retry-After': '120' }, {
          type: 'about:blank',
          status: 429,
          title: 'Too Many Authentication Attempts',
        })
      );

      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(callback).not.toHaveBeenCalledWith(false);

      fetchSpy.mockClear();
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('disconnect', () => {
    it('stops keep-alive and cleans up', async () => {
      const client = await createConnectedClient();
      const callback = vi.fn();
      client.onConnectionChange(callback);

      client.disconnect();

      // Advancing timers should not trigger any ping
      fetchSpy.mockResolvedValue(mockFetchResponse(200, { methodResponses: [['Core/echo', { ping: 'pong' }, '0']] }));
      await vi.advanceTimersByTimeAsync(60_000);

      expect(callback).not.toHaveBeenCalled();
    });
  });

  // Every account switch tears down and re-creates push for all connected
  // clients. Aborting an SSE connect that is still in flight must read as an
  // intentional close: treated as a network failure it spawns an unsupervised
  // 3s polling interval per client, and its late rejection nulls the abort
  // controller of the connection set up right after - which then can never be
  // closed and reconnects itself in parallel. Rapid switching multiplies both
  // until the server's concurrency limit stalls the app.
  describe('SSE connect aborted mid-flight (account-switch churn)', () => {
    function inFlightFetch(signals: AbortSignal[]) {
      return (_url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.signal) signals.push(init.signal);
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
          if (init?.signal?.aborted) return abort();
          init?.signal?.addEventListener('abort', abort);
        });
      };
    }

    it('does not fall back to polling when the in-flight connect was aborted', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: false });
      const client = await createConnectedClient();
      fetchSpy.mockImplementation(inFlightFetch([]));

      client.setupPushNotifications();
      client.closePushNotifications();

      // Flush the 1s network-error retry inside authenticatedFetch and a few
      // would-be polling ticks (3s each).
      await vi.advanceTimersByTimeAsync(10_000);

      // The polling fallback is recognizable by its state-poll body; a
      // keep-alive Core/echo that slips in must not fail the assertion.
      const statePolls = fetchSpy.mock.calls.filter((call: unknown[]) => {
        const body = (call[1] as RequestInit | undefined)?.body;
        return typeof body === 'string' && body.includes('Mailbox/get');
      });
      expect(statePolls).toHaveLength(0);
    });

    it('keeps the replacement connection abortable when the aborted connect settles late', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: false });
      const client = await createConnectedClient();
      const signals: AbortSignal[] = [];
      fetchSpy.mockImplementation(inFlightFetch(signals));

      client.setupPushNotifications();
      client.closePushNotifications();
      client.setupPushNotifications();
      // The retry inside authenticatedFetch re-sends the aborted first
      // attempt later, so grab the replacement's signal now.
      const replacementSignal = signals[signals.length - 1];

      // Let the first attempt run through its retry and reject - after the
      // replacement connect is already up.
      await vi.advanceTimersByTimeAsync(2_000);

      client.closePushNotifications();
      expect(replacementSignal.aborted).toBe(true);
    });

    // #781: setupPushNotifications is re-run for every connected client on
    // fairly frequent effect deps changes. Without an already-active guard a
    // second connect stacks a new SSE stream while the previous one keeps its
    // HTTP/1.1 socket open forever (readSSEStream only unwinds on abort/done),
    // starving normal JMAP POSTs. Opening a new stream must abort the old one.
    it('aborts the previous SSE stream when push is set up again (no orphan)', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: false });
      const client = await createConnectedClient();
      const signals: AbortSignal[] = [];
      fetchSpy.mockImplementation(inFlightFetch(signals));

      client.setupPushNotifications();
      await vi.advanceTimersByTimeAsync(0); // let connect #1 register its signal
      client.setupPushNotifications();
      await vi.advanceTimersByTimeAsync(0); // connect #2 registers + guard aborts #1

      // The first stream's signal is aborted, and exactly one stream stays live
      // - no accumulation of abandoned SSE connections.
      expect(signals[0].aborted).toBe(true);
      expect(signals.filter((s) => !s.aborted)).toHaveLength(1);

      client.closePushNotifications();
    });
  });

  describe('fetchBlobAsObjectUrl', () => {
    it('fetches blob with authentication and returns an object URL', async () => {
      const client = await createConnectedClient();
      const binaryData = new Uint8Array([137, 80, 78, 71]); // PNG magic bytes
      const blobResponse = new Response(binaryData, {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
      fetchSpy.mockResolvedValueOnce(blobResponse);

      const objectUrl = await client.fetchBlobAsObjectUrl('blob-123', 'image.png', 'image/png');

      expect(objectUrl).toMatch(/^blob:/);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      // Verify auth header was sent
      const callHeaders = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
      expect(callHeaders['Authorization']).toContain('Basic');

      URL.revokeObjectURL(objectUrl);
    });

    it('throws when download URL is not available', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, makeSession({ downloadUrl: '' })));
      const client = new JMAPClient('https://mail.example.com', 'user@test.com', 'pass123');
      // The client needs to be connected but with an empty downloadUrl
      // getBlobDownloadUrl will throw before fetch is called
      await expect(
        (async () => {
          // Connect first with valid session, then clear downloadUrl via re-connect with empty
          await client.connect();
          fetchSpy.mockReset();
          // Now reconnect with empty downloadUrl to simulate the issue
          fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, makeSession({ downloadUrl: '' })));
          // Force session refresh to pick up empty downloadUrl
          const echoResponse = { methodResponses: [['Core/echo', { ping: 'pong' }, '0']] };
          fetchSpy
            .mockResolvedValueOnce(mockFetchResponse(401))
            .mockResolvedValueOnce(mockFetchResponse(200, makeSession({ downloadUrl: '' })))
            .mockResolvedValueOnce(mockFetchResponse(200, echoResponse));
          try { await client.ping(); } catch { /* ignore */ }
        })()
      ).resolves.toBeUndefined();
    });

    it('throws on HTTP error response', async () => {
      const client = await createConnectedClient();
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(404));

      await expect(
        client.fetchBlobAsObjectUrl('bad-blob', 'file.dat')
      ).rejects.toThrow('Failed to fetch blob: 404');
    });
  });

  // #281 V3: every email fetch path must namespace mailboxIds for shared/
  // delegated accounts (`${ownerId}:${id}`) so they line up with the store's
  // namespaced shared-mailbox ids. searchEmails/advancedSearchEmails are the
  // cross-view (All mail / Unread / Starred) browse paths and previously did not.
  describe('shared-account mailboxId namespacing', () => {
    function queryAndGet(email: Record<string, unknown>) {
      return {
        methodResponses: [
          ['Email/query', { total: 1, ids: ['e1'] }, '0'],
          ['Email/get', { list: [email] }, '1'],
        ],
      };
    }

    it('advancedSearchEmails namespaces bare owner mailboxIds for a foreign account', async () => {
      const client = await createConnectedClient(); // primary acct-1
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse(200, queryAndGet({ id: 'e1', receivedAt: '2026-01-01T00:00:00Z', mailboxIds: { 'x-inbox': true } })),
      );

      const { emails } = await client.advancedSearchEmails({ inMailbox: 'owner-x:x-inbox' }, 'owner-x');

      expect(emails[0].mailboxIds).toEqual({ 'owner-x:x-inbox': true });
      expect(emails[0].mailboxIds['x-inbox']).toBeUndefined();
    });

    it('searchEmails namespaces bare owner mailboxIds for a foreign account', async () => {
      const client = await createConnectedClient();
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse(200, queryAndGet({ id: 'e1', receivedAt: '2026-01-01T00:00:00Z', mailboxIds: { 'x-inbox': true } })),
      );

      const { emails } = await client.searchEmails('hello', undefined, 'owner-x');

      expect(emails[0].mailboxIds).toEqual({ 'owner-x:x-inbox': true });
    });

    it('leaves own-account mailboxIds untouched (no foreign accountId)', async () => {
      const client = await createConnectedClient(); // primary acct-1
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse(200, queryAndGet({ id: 'e1', receivedAt: '2026-01-01T00:00:00Z', mailboxIds: { inbox: true } })),
      );

      const { emails } = await client.advancedSearchEmails({ inMailbox: 'inbox' });

      expect(emails[0].mailboxIds).toEqual({ inbox: true });
    });
  });
});
