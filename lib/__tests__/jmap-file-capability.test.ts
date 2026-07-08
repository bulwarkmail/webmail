import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JMAPClient } from '../jmap/client';

// Session where the SERVER advertises FileNode (session.capabilities) but the
// per-account accountCapabilities can independently include or omit it. This
// models the #563 scenario: a Stalwart role that revokes jmap-file-node-*
// permissions drops the capability from the account while the server still
// advertises it globally.
function makeSession(accountCapabilities: Record<string, unknown>, isPersonal = true) {
  return {
    capabilities: {
      'urn:ietf:params:jmap:core': {},
      'urn:ietf:params:jmap:filenode': {},
    },
    accounts: {
      'acct-1': { name: 'test', isPersonal, accountCapabilities },
    },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acct-1' },
    apiUrl: 'https://mail.example.com/jmap/api',
    downloadUrl: 'https://mail.example.com/jmap/download/{accountId}/{blobId}/{name}',
    uploadUrl: 'https://mail.example.com/jmap/upload/{accountId}/',
    eventSourceUrl: 'https://mail.example.com/jmap/eventsource',
  };
}

function mockFetchResponse(status: number, body?: unknown): Response {
  return new Response(body ? JSON.stringify(body) : null, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function connect(accountCapabilities: Record<string, unknown>, isPersonal = true): Promise<JMAPClient> {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, makeSession(accountCapabilities, isPersonal)));
  const client = new JMAPClient('https://mail.example.com', 'user@test.com', 'pass123');
  await client.connect();
  fetchSpy.mockReset();
  return client;
}

describe('JMAPClient.supportsFiles (#563 - account-scoped capability)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns true when the account advertises the filenode capability', async () => {
    const client = await connect({ 'urn:ietf:params:jmap:filenode': {} });
    expect(client.supportsFiles()).toBe(true);
  });

  it('returns false when the server advertises filenode but the account does not (#563)', async () => {
    // The revoked-permission case: server-wide capability present, account omits it.
    const client = await connect({ 'urn:ietf:params:jmap:mail': {} });
    expect(client.supportsFiles()).toBe(false);
  });

  it('treats non-personal (shared/group) accounts as capable even without per-account advertisement', async () => {
    const client = await connect({}, /* isPersonal */ false);
    expect(client.supportsFiles()).toBe(true);
  });

  it('probeFileNodeSupport does not probe (no network call) when the account is explicitly denied', async () => {
    const client = await connect({ 'urn:ietf:params:jmap:mail': {} });
    fetchSpy.mockClear();
    await expect(client.probeFileNodeSupport()).resolves.toBe(false);
    // Explicit per-account denial must short-circuit before any FileNode/query probe.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
