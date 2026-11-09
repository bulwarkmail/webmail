import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JMAPClient } from '../jmap/client';

// The client writes a classification label's headers on send (over any
// plugin header of the same name) and keeps the pick in a draft.

function createClient(): JMAPClient {
  const client = new JMAPClient('https://jmap.example.com', 'user@example.com', 'pass');
  Object.assign(client, { apiUrl: 'https://jmap.example.com/api', accountId: 'account-1', username: 'user@example.com' });
  return client;
}

type Call = [string, Record<string, unknown>, string];

function mockServer() {
  const captured: Call[][] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const calls = (JSON.parse((init as { body: string }).body) as { methodCalls: Call[] }).methodCalls;
    captured.push(calls);
    const name = calls[0][0];
    let responses: unknown[];
    if (name === 'Mailbox/get') responses = [['Mailbox/get', { list: [{ id: 'mb-drafts', role: 'drafts' }, { id: 'mb-sent', role: 'sent' }] }, '0']];
    else if (name === 'Identity/get') responses = [['Identity/get', { list: [{ id: 'identity-1', email: 'user@example.com' }] }, '0']];
    else if (name === 'Email/set' && calls[0][1].create) {
      const id = Object.keys(calls[0][1].create as object)[0];
      responses = [['Email/set', { created: { [id]: { id: 'new-1' } } }, '0'], ['EmailSubmission/set', { created: { '1': { id: 'sub-1' } } }, '1']];
    } else responses = calls.map(([method, , id]) => [method, {}, id]);
    const payload = { methodResponses: responses };
    return { ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(payload)), json: () => Promise.resolve(payload) } as Response;
  });
  return captured;
}

function created(captured: Call[][]): Record<string, unknown> {
  for (const calls of captured) {
    const set = calls.find(([name, args]) => name === 'Email/set' && args.create);
    if (set) return Object.values(set[1].create as Record<string, Record<string, unknown>>)[0];
  }
  throw new Error('no create');
}

describe('label headers', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('are written on send, and win over a plugin header of the same name', async () => {
    const captured = mockServer();
    await createClient().sendEmail(
      ['bob@example.org'], '[Confidential] x', 'body', undefined, undefined, 'identity-1', 'user@example.com',
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      {
        headers: { Sensitivity: 'Personal', 'X-Other': 'kept' },
        labelHeaders: { 'header:SIO-Label:asRaw': ' marking="CONFIDENTIAL"', 'header:Sensitivity:asText': 'Company-Confidential' },
      },
    );
    const email = created(captured);
    expect(email['header:SIO-Label:asRaw']).toBe(' marking="CONFIDENTIAL"');
    expect(email['header:Sensitivity:asText']).toBe('Company-Confidential');
    expect(email['header:X-Other:asText']).toBe('kept');
    expect(Object.keys(email).filter((k) => k.toLowerCase().startsWith('header:sensitivity'))).toHaveLength(1);
  });

  it('are kept in a draft as the pick', async () => {
    const captured = mockServer();
    await createClient().createDraft(['bob@example.org'], 'x', 'body', undefined, undefined, 'identity-1', 'user@example.com',
      undefined, undefined, undefined, undefined, undefined, undefined, { classification: 'confidential' });
    expect(created(captured)['header:X-Bulwark-Label:asText']).toBe('confidential');
    const again = mockServer();
    await createClient().createDraft(['bob@example.org'], 'x', 'body', undefined, undefined, 'identity-1', 'user@example.com',
      undefined, undefined, undefined, undefined, undefined, undefined, { classification: null });
    expect(created(again)['header:X-Bulwark-Label:asText']).toBe('none');
  });
});
