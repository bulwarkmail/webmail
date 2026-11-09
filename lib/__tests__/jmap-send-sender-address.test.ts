import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JMAPClient } from '../jmap/client';

// #1377: a composer that lost its identities (a short outage) sends no From
// address, and an OAuth login has no username to fall back on. The message
// went out with an empty From and an @localhost Message-ID, and the server
// refused it only after it was saved and submitted.

type MethodCall = [string, Record<string, unknown>, string];

function createClient(username: string): JMAPClient {
  const client = new JMAPClient('https://jmap.example.com', username, 'pass');
  Object.assign(client, { apiUrl: 'https://jmap.example.com/api', accountId: 'account-1' });
  return client;
}

function mockServer(identities: Array<{ id: string; email: string; name?: string }>) {
  const calls: string[] = [];
  const created: Array<Record<string, unknown>> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const { methodCalls } = JSON.parse((init as { body: string }).body) as { methodCalls: MethodCall[] };
    const methodResponses = methodCalls.map(([name, args, callId]) => {
      calls.push(name);
      if (name === 'Mailbox/get') {
        return [name, { list: [{ id: 'mb-drafts', role: 'drafts' }, { id: 'mb-sent', role: 'sent' }] }, callId];
      }
      if (name === 'Identity/get') return [name, { list: identities }, callId];
      if (name === 'Email/set') {
        const create = (args.create ?? {}) as Record<string, Record<string, unknown>>;
        created.push(...Object.values(create));
        return [name, { created: Object.fromEntries(Object.keys(create).map((id) => [id, { id: 'email-9' }])) }, callId];
      }
      if (name === 'EmailSubmission/set') return [name, { created: { '1': { id: 'sub-1' } } }, callId];
      return ['error', { type: 'unknownMethod' }, callId];
    });
    const payload = { methodResponses };
    return { ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(payload)), json: () => Promise.resolve(payload) } as Response;
  });
  return { calls, created };
}

const send = (client: JMAPClient) => client.sendEmail(['friend@example.org'], 'Hi', 'Hello');

describe('sendEmail without a From address from the composer (#1377)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends from the identity the server lists when the login has no username', async () => {
    const client = createClient('');
    const { created } = mockServer([{ id: 'identity-1', email: 'admin@kisaanu.org', name: 'Kisaanu Admin' }]);

    await send(client);

    expect(created[0].from).toEqual([{ name: 'Kisaanu Admin', email: 'admin@kisaanu.org' }]);
    expect((created[0].messageId as string[])[0]).toMatch(/@kisaanu\.org$/);
  });

  it('saves and submits nothing when no address can be found', async () => {
    const client = createClient('');
    const { calls } = mockServer([]);

    await expect(send(client)).rejects.toThrow(/sender address/);
    expect(calls).not.toContain('Email/set');
    expect(calls).not.toContain('EmailSubmission/set');
  });

  it('keeps the address the composer passed', async () => {
    const client = createClient('');
    const { created } = mockServer([
      { id: 'identity-1', email: 'admin@kisaanu.org' },
      { id: 'identity-2', email: 'sales@kisaanu.org' },
    ]);

    await client.sendEmail(['friend@example.org'], 'Hi', 'Hello', undefined, undefined, 'identity-2', 'sales@kisaanu.org', undefined, 'Sales');

    expect(created[0].from).toEqual([{ name: 'Sales', email: 'sales@kisaanu.org' }]);
  });
});

describe('sendEmail names the account the sent message lies in', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('the own account, or the group account a group identity sends from', async () => {
    const client = createClient('me@example.com');
    mockServer([{ id: 'identity-1', email: 'me@example.com' }]);
    expect(await send(client)).toMatchObject({ emailId: 'email-9', emailAccountId: 'account-1' });

    vi.spyOn(client, 'resolveSendAccountId').mockResolvedValue('group-1');
    expect(await send(client)).toMatchObject({ emailId: 'email-9', emailAccountId: 'group-1' });
  });
});
