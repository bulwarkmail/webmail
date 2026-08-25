import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JMAPClient } from '../jmap/client';
import type { FileNodeRights } from '../jmap/types';

function createClient(): JMAPClient {
  const client = new JMAPClient('https://jmap.example.com', 'user', 'pass');
  Object.assign(client, {
    apiUrl: 'https://jmap.example.com/api',
    accountId: 'account-1',
    capabilities: { 'urn:ietf:params:jmap:filenode': {}, 'urn:ietf:params:jmap:principals': {} },
  });
  return client;
}

function mockFetch(response: object, ok = true, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok,
    status,
    text: () => Promise.resolve(JSON.stringify(response)),
    json: () => Promise.resolve(response),
  } as Response);
}

const READ: FileNodeRights = {
  mayRead: true, mayAddChildren: false, mayRename: false,
  mayDelete: false, mayModifyContent: false, mayShare: false,
};

function lastRequestBody(spy: ReturnType<typeof vi.spyOn>): { using: string[]; methodCalls: unknown[][] } {
  const call = spy.mock.calls[spy.mock.calls.length - 1];
  return JSON.parse((call[1] as RequestInit).body as string);
}

describe('JMAPClient.setFileNodeShare', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends a FileNode/set shareWith patch and resolves on success', async () => {
    const spy = mockFetch({
      methodResponses: [['FileNode/set', { updated: { 'node-1': null } }, '0']],
    });
    const client = createClient();

    await client.setFileNodeShare('node-1', 'principal-9', READ);

    const body = lastRequestBody(spy);
    expect(body.using).toContain('urn:ietf:params:jmap:filenode');
    // The fixture advertises only base principals, so the owner
    // sub-capability must not be declared (RFC 8620 section 3.3).
    expect(body.using).not.toContain('urn:ietf:params:jmap:principals:owner');
    const [method, args] = body.methodCalls[0] as [string, Record<string, unknown>];
    expect(method).toBe('FileNode/set');
    expect(args.accountId).toBe('account-1');
    expect(args.update).toEqual({
      'node-1': { 'shareWith/principal-9': READ },
    });
  });

  it('declares principals:owner only when the server advertises it', async () => {
    const spy = mockFetch({
      methodResponses: [['FileNode/set', { updated: { 'node-1': null } }, '0']],
    });
    const client = createClient();
    Object.assign(client, {
      capabilities: {
        'urn:ietf:params:jmap:filenode': {},
        'urn:ietf:params:jmap:principals': {},
        'urn:ietf:params:jmap:principals:owner': {},
      },
    });

    await client.setFileNodeShare('node-1', 'principal-9', READ);

    expect(lastRequestBody(spy).using).toContain('urn:ietf:params:jmap:principals:owner');
  });

  it('sends null to revoke a principal\'s access', async () => {
    const spy = mockFetch({
      methodResponses: [['FileNode/set', { updated: { 'node-1': null } }, '0']],
    });
    const client = createClient();

    await client.setFileNodeShare('node-1', 'principal-9', null);

    const body = lastRequestBody(spy);
    const [, args] = body.methodCalls[0] as [string, Record<string, unknown>];
    expect(args.update).toEqual({ 'node-1': { 'shareWith/principal-9': null } });
  });

  it('throws with the server description when the update is rejected', async () => {
    mockFetch({
      methodResponses: [['FileNode/set', {
        notUpdated: { 'node-1': { type: 'forbidden', description: 'Not allowed' } },
      }, '0']],
    });
    const client = createClient();

    await expect(client.setFileNodeShare('node-1', 'principal-9', READ))
      .rejects.toThrow('Not allowed');
  });

  it('throws when the server does not confirm the update', async () => {
    mockFetch({
      methodResponses: [['FileNode/set', { updated: {} }, '0']],
    });
    const client = createClient();

    await expect(client.setFileNodeShare('node-1', 'principal-9', READ))
      .rejects.toThrow('did not confirm');
  });
});
