import { afterEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '../jmap/client';

// The state poll holds two calls per session account plus calendars and
// filters. With seven accounts (Stalwart's default limit is 16 calls) the
// server refused the whole request and change detection stopped silently.

const SERVER = 'https://mail.example.test';
const MAX_CALLS = 16;

function session(accountCount: number) {
  const accounts: Record<string, unknown> = {};
  for (let i = 0; i < accountCount; i++) {
    accounts[`A${i}`] = {
      name: i === 0 ? 'alice@example.test' : `colleague${i}@example.test`,
      isPersonal: i === 0,
      accountCapabilities: { 'urn:ietf:params:jmap:mail': {}, 'urn:ietf:params:jmap:calendars': {}, 'urn:ietf:params:jmap:sieve': {} },
    };
  }
  return {
    username: 'alice@example.test',
    apiUrl: `${SERVER}/jmap/`,
    downloadUrl: `${SERVER}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'A0' },
    accounts,
    capabilities: {
      'urn:ietf:params:jmap:core': { maxCallsInRequest: MAX_CALLS },
      'urn:ietf:params:jmap:calendars': {},
      'urn:ietf:params:jmap:sieve': {},
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('state poll across many accounts', () => {
  it('splits the poll to fit maxCallsInRequest and still reports the change', async () => {
    let emailState = 's1';
    const requestSizes: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (String(url).endsWith('/.well-known/jmap')) return new Response(JSON.stringify(session(7)), { status: 200 });
      const body = JSON.parse(String(init.body));
      requestSizes.push(body.methodCalls.length);
      if (body.methodCalls.length > MAX_CALLS) {
        return new Response(JSON.stringify({ type: 'urn:ietf:params:jmap:error:limit', limit: 'maxCallsInRequest' }), { status: 400 });
      }
      return new Response(JSON.stringify({
        methodResponses: body.methodCalls.map(([name, args, id]: [string, { accountId: string }, string]) => [
          name,
          { accountId: args.accountId, state: name === 'Email/get' && args.accountId === 'A0' ? emailState : 'x', list: [] },
          id,
        ]),
      }), { status: 200 });
    }));

    const client = new JMAPClient(SERVER, 'alice@example.test', 'pw');
    await client.connect();
    const internals = client as unknown as {
      pingInterval?: ReturnType<typeof setInterval>;
      fetchCurrentStates(): Promise<void>;
      checkForStateChanges(): Promise<void>;
    };
    clearInterval(internals.pingInterval);
    const changes: unknown[] = [];
    client.onStateChange((change) => changes.push(change));

    requestSizes.length = 0;
    await internals.fetchCurrentStates();
    emailState = 's2'; // new mail in the primary account
    await internals.checkForStateChanges();

    expect(Math.max(...requestSizes)).toBeLessThanOrEqual(MAX_CALLS);
    expect(changes).toEqual([{ '@type': 'StateChange', changed: { A0: { Email: 's2' } } }]);
    client.disconnect();
  });
});
