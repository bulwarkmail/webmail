import { afterEach, expect, it, vi } from 'vitest';
import { JMAPClient } from '../jmap/client';
afterEach(() => vi.restoreAllMocks());
it('sends the original receivedAt on Email/import and returns the acknowledged ID', async () => {
  const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const fetch = vi.spyOn(globalThis, 'fetch');
  fetch.mockResolvedValueOnce(response({
    capabilities: { 'urn:ietf:params:jmap:core': {} },
    accounts: { dest: { name: 'Destination', isPersonal: true, accountCapabilities: {} } },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'dest' },
    apiUrl: 'https://mail.example.test/jmap/api',
    downloadUrl: 'https://mail.example.test/download/{accountId}/{blobId}/{name}',
    uploadUrl: 'https://mail.example.test/upload/{accountId}/',
    eventSourceUrl: 'https://mail.example.test/events',
  }));
  const client = JMAPClient.withBearer('https://mail.example.test', 'test-token', 'test@example.test');
  await client.connect();
  fetch.mockImplementationOnce(async (_url, init) => {
    const call = JSON.parse(init?.body as string).methodCalls[0];
    expect(call[0]).toBe('Email/import');
    expect(call[1].accountId).toBe('dest');
    const [creationId, email] = Object.entries(call[1].emails)[0];
    expect(email).toEqual({ blobId: 'blob', mailboxIds: { inbox: true }, keywords: {}, receivedAt: '2019-01-01T00:00:00Z' });
    return response({ methodResponses: [['Email/import', { created: { [creationId]: { id: 'confirmed' } } }, '0']] });
  });
  await expect(client.importEmail('blob', { inbox: true }, {}, 'dest', '2019-01-01T00:00:00Z')).resolves.toBe('confirmed');
});
