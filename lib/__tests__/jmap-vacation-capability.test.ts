import { describe, it, expect, vi, afterEach } from 'vitest';
import { JMAPClient } from '../jmap/client';

const VACATION = 'urn:ietf:params:jmap:vacationresponse';

// Stalwart lists vacationresponse in the session capabilities for everyone,
// and in the account's own only when the user may read the reply (#1488).
async function connect(accountCapabilities: Record<string, unknown>): Promise<JMAPClient> {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
    capabilities: {
      'urn:ietf:params:jmap:core': {},
      'urn:ietf:params:jmap:mail': {},
      [VACATION]: {},
    },
    accounts: {
      'acct-1': { name: 'user@test.com', isPersonal: true, accountCapabilities },
    },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acct-1' },
    apiUrl: 'https://mail.example.com/jmap/api',
    downloadUrl: 'https://mail.example.com/jmap/download/{accountId}/{blobId}/{name}',
    uploadUrl: 'https://mail.example.com/jmap/upload/{accountId}/',
    eventSourceUrl: 'https://mail.example.com/jmap/eventsource',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const client = new JMAPClient('https://mail.example.com', 'user@test.com', 'pass123');
  await client.connect();
  return client;
}

describe('JMAPClient.supportsVacationResponse', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is true when the account lists the capability', async () => {
    const client = await connect({ 'urn:ietf:params:jmap:mail': {}, [VACATION]: {} });
    expect(client.supportsVacationResponse()).toBe(true);
  });

  it('is false when only the session lists it (permission revoked)', async () => {
    const client = await connect({ 'urn:ietf:params:jmap:mail': {} });
    expect(client.supportsVacationResponse()).toBe(false);
  });
});
