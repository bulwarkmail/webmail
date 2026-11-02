import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JMAPClient } from '../jmap/client';

// The client pieces of a phishing report: a send that leaves no copy in
// Sent (onSuccessDestroyEmail instead of the move to Sent), and the move
// to Junk and back with $phishing in the same patch.

function createClient(): JMAPClient {
  const client = new JMAPClient('https://jmap.example.com', 'user@example.com', 'pass');
  Object.assign(client, { apiUrl: 'https://jmap.example.com/api', accountId: 'account-1', username: 'user@example.com' });
  return client;
}

type Call = [string, Record<string, unknown>, string];

function mockServer(answer: (calls: Call[]) => unknown[]) {
  const captured: Call[][] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse((init as { body: string }).body) as { methodCalls: Call[] };
    captured.push(body.methodCalls);
    const payload = { methodResponses: answer(body.methodCalls) };
    return { ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(payload)), json: () => Promise.resolve(payload) } as Response;
  });
  return captured;
}

function sendAnswers(calls: Call[]): unknown[] {
  const name = calls[0][0];
  if (name === 'Mailbox/get') {
    return [['Mailbox/get', { list: [{ id: 'mb-drafts', role: 'drafts' }, { id: 'mb-sent', role: 'sent' }, { id: 'mb-junk', role: 'junk' }] }, '0']];
  }
  if (name === 'Identity/get') return [['Identity/get', { list: [{ id: 'identity-1', email: 'user@example.com' }] }, '0']];
  if (name === 'Email/set' && calls[0][1].create) {
    const id = Object.keys(calls[0][1].create as object)[0];
    return [
      ['Email/set', { created: { [id]: { id: 'copy-1' } } }, '0'],
      ['EmailSubmission/set', { created: { '1': { id: 'sub-1' } } }, '1'],
    ];
  }
  return calls.map(([method, , id]) => [method, { updated: {}, list: [], destroyed: [] }, id]);
}

function submission(captured: Call[][]): Record<string, unknown> {
  for (const calls of captured) {
    const found = calls.find(([name]) => name === 'EmailSubmission/set');
    if (found) return found[1];
  }
  throw new Error('no EmailSubmission/set');
}

describe('sendEmail without a Sent copy', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('files a normal send in Sent', async () => {
    const captured = mockServer(sendAnswers);
    await createClient().sendEmail(['soc@example.org'], 'Phishing: x', 'body', undefined, undefined, 'identity-1', 'user@example.com');
    const sub = submission(captured);
    expect(sub.onSuccessUpdateEmail).toBeTruthy();
    expect(sub.onSuccessDestroyEmail).toBeUndefined();
  });

  it('destroys the copy once submitted with noSentCopy', async () => {
    const captured = mockServer(sendAnswers);
    await createClient().sendEmail(
      ['soc@example.org'], 'Phishing: x', 'body', undefined, undefined, 'identity-1', 'user@example.com',
      undefined, undefined, undefined, [{ blobId: 'orig', name: 'x.eml', type: 'message/rfc822', size: 10, disposition: 'attachment' }],
      undefined, undefined, undefined, undefined, { noSentCopy: true },
    );
    const sub = submission(captured);
    expect(sub.onSuccessDestroyEmail).toEqual(['#1']);
    expect(sub.onSuccessUpdateEmail).toBeUndefined();
  });
});

describe('markAsSpam and undoSpam with more keywords', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('sets $phishing with the move to Junk, and clears it with the move back', async () => {
    const client = createClient();
    vi.spyOn(client, 'getMailboxes').mockResolvedValue([{ id: 'mb-junk', role: 'junk', isShared: false }] as never);
    const captured = mockServer((calls) => calls.map(([method, args, id]) => [method, { updated: Object.fromEntries(Object.keys((args.update as object) ?? {}).map((k) => [k, null])) }, id]));
    await client.markAsSpam('e1', undefined, true, ['$phishing']);
    const patch = (captured[0][0][1].update as Record<string, Record<string, unknown>>).e1;
    expect(patch).toMatchObject({ mailboxIds: { 'mb-junk': true }, 'keywords/$junk': true, 'keywords/$seen': true, 'keywords/$phishing': true });
    await client.undoSpam('e1', 'mb-inbox', undefined, ['$phishing']);
    const back = (captured[1][0][1].update as Record<string, Record<string, unknown>>).e1;
    expect(back).toMatchObject({ mailboxIds: { 'mb-inbox': true }, 'keywords/$junk': null, 'keywords/$notjunk': true, 'keywords/$phishing': null });
  });
});
