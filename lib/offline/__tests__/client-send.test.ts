import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '@/lib/jmap/client';

// The outbox (#523) may only try a send again when nothing reached the
// server: the client says so with SendNotStartedError for failures before
// the submission request, and never for one during or after it.

const SERVER = 'https://mail.example.org';
const SESSION = {
  apiUrl: `${SERVER}/jmap/`,
  downloadUrl: `${SERVER}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
  uploadUrl: `${SERVER}/jmap/upload/{accountId}/`,
  accounts: { j1: { name: 'alice', isPersonal: true, accountCapabilities: { 'urn:ietf:params:jmap:submission': { maxDelayedSend: 3600, submissionExtensions: { FUTURERELEASE: [] } } } } },
  primaryAccounts: { 'urn:ietf:params:jmap:mail': 'j1', 'urn:ietf:params:jmap:submission': 'j1' },
  capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInGet: 500 }, 'urn:ietf:params:jmap:submission': { maxDelayedSend: 3600 } },
  username: 'alice@example.org',
};

type Mode = { mailboxFails?: boolean; submissionFails?: boolean; readBackFails?: boolean };
let mode: Mode = {};
const submissions: unknown[] = [];

function answer(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  mode = {};
  submissions.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/.well-known/jmap')) return answer(SESSION);
    const request = JSON.parse(String(init?.body ?? '{}')) as { methodCalls: Array<[string, Record<string, unknown>, string]> };
    const names = request.methodCalls.map(([name]) => name);
    if (names.includes('EmailSubmission/set')) {
      submissions.push(request);
      if (mode.submissionFails) throw new TypeError('Failed to fetch');
      const create = request.methodCalls.find(([name]) => name === 'Email/set')?.[1].create as Record<string, unknown>;
      const key = Object.keys(create)[0];
      return answer({ methodResponses: [
        ['Email/set', { accountId: 'j1', created: { [key]: { id: 'e1' } } }, '0'],
        ['EmailSubmission/set', { accountId: 'j1', created: { 1: { id: 'sub1' } } }, '1'],
      ] });
    }
    if (names[0] === 'Mailbox/get') {
      if (mode.mailboxFails) throw new TypeError('Failed to fetch');
      return answer({ methodResponses: [['Mailbox/get', { accountId: 'j1', list: [{ id: 's', role: 'sent' }, { id: 'd', role: 'drafts' }] }, '0']] });
    }
    if (names[0] === 'Identity/get') {
      return answer({ methodResponses: [['Identity/get', { accountId: 'j1', list: [{ id: 'i1', email: 'alice@example.org', name: 'Alice' }] }, '0']] });
    }
    if (names[0] === 'EmailSubmission/get') {
      if (mode.readBackFails) throw new TypeError('Failed to fetch');
      return answer({ methodResponses: [['EmailSubmission/get', { accountId: 'j1', list: [{ id: 'sub1', sendAt: '2030-01-01T00:00:00Z' }] }, '0']] });
    }
    return answer({ methodResponses: names.map((name, i) => [name, { accountId: 'j1' }, String(i)]) });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function client(): Promise<JMAPClient> {
  const c = new JMAPClient(SERVER, 'alice@example.org', 'pw');
  await c.connect();
  return c;
}

const send = (c: JMAPClient, delayedUntil?: string) => c.sendEmail(['bob@example.org'], 'Hi', 'Body', undefined, undefined, 'i1', 'alice@example.org', undefined, 'Alice', undefined, undefined, undefined, undefined, delayedUntil);

describe('telling a send that never started from one that may have gone', () => {
  it('a dead network before the submission: SendNotStartedError, nothing submitted', async () => {
    const c = await client();
    mode.mailboxFails = true;
    await expect(send(c)).rejects.toMatchObject({ name: 'SendNotStartedError' });
    expect(submissions).toHaveLength(0);
  });

  it('a dead network during the submission: not "not started"', async () => {
    const c = await client();
    mode.submissionFails = true;
    const error = await send(c).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).not.toBe('SendNotStartedError');
    expect(submissions).toHaveLength(1);
  });

  it('a held send whose hold can’t be read back afterwards still counts as sent', async () => {
    const c = await client();
    mode.readBackFails = true;
    const result = await send(c, new Date(Date.now() + 120_000).toISOString());
    expect(result.scheduled).toBe(true);
    expect(result.emailSubmissionId).toBe('sub1');
  });
});
