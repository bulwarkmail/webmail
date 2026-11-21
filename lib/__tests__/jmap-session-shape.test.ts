import { afterEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '@/lib/jmap/client';

// A session object with the wrong types was taken as a sign-in: the app showed
// the mail view with an account id of "0" and an empty list instead of an error.

const SERVER = 'https://mail.example.com';
const minimal = {
  capabilities: { 'urn:ietf:params:jmap:core': {}, 'urn:ietf:params:jmap:mail': {} },
  accounts: { 'acct-1': { name: 'alice', isPersonal: true, accountCapabilities: {} } },
  primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acct-1' },
  apiUrl: `${SERVER}/jmap/api`,
  downloadUrl: `${SERVER}/jmap/download/{accountId}/{blobId}/{name}`,
};

function serve(session: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(session), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('signing in with a session of the wrong shape', () => {
  it.each([
    ['accounts that are not an object', { ...minimal, accounts: 'x' }],
    ['an API URL that is not a string', { ...minimal, apiUrl: 7 }],
    ['no download URL', { ...minimal, downloadUrl: undefined }],
    ['accounts as a list', { ...minimal, accounts: [] }],
    ['all of it wrong at once', { capabilities: [], accounts: 'x', apiUrl: 7 }],
    ['no session object', null],
  ])('is refused for %s', async (_, session) => {
    serve(session);
    const client = new JMAPClient(SERVER, 'alice', 'pw');
    await expect(client.connect()).rejects.toThrow('No mail account found in session');
    client.disconnect();
  });

  it('accepts a minimal well-formed session', async () => {
    serve(minimal);
    const client = new JMAPClient(SERVER, 'alice', 'pw');
    await expect(client.connect()).resolves.toBeUndefined();
    expect(client.getAccountId()).toBe('acct-1');
    client.disconnect();
  });
});
