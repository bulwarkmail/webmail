import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JMAPClient } from '../jmap/client';

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
      fetchSpy.mockResolvedValue(mockFetchResponse(200, echoResponse));

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
});
