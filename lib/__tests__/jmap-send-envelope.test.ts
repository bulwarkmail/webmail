import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JMAPClient } from '../jmap/client';

// #1009: a From override is asked for as the envelope MAIL FROM, so the
// Return-Path doesn't reveal the identity's address where the server allows it.

type MethodCall = [string, Record<string, unknown>, string];

function createClient(): JMAPClient {
  const client = new JMAPClient('https://jmap.example.com', 'user@example.com', 'pass');
  Object.assign(client, {
    apiUrl: 'https://jmap.example.com/api',
    accountId: 'account-1',
    username: 'user@example.com',
  });
  return client;
}

function enableDelayedSend(client: JMAPClient) {
  Object.assign(client, {
    capabilities: {
      'urn:ietf:params:jmap:core': {},
      'urn:ietf:params:jmap:mail': {},
      'urn:ietf:params:jmap:submission': {},
    },
    session: {
      primaryAccounts: {
        'urn:ietf:params:jmap:mail': 'account-1',
        'urn:ietf:params:jmap:submission': 'account-1',
      },
      accounts: {
        'account-1': {
          accountCapabilities: {
            'urn:ietf:params:jmap:mail': {},
            'urn:ietf:params:jmap:submission': { maxDelayedSend: 3600, submissionExtensions: { FUTURERELEASE: true } },
          },
        },
      },
    },
  });
}

const IDENTITIES = [
  { id: 'identity-1', email: 'user@example.com', mayDelete: false },
  { id: 'identity-2', email: 'Sales@example.com', mayDelete: true, replyTo: [{ email: 'team@example.com' }] },
];

/**
 * Answers the requests sendEmail makes; `refuseMailFrom` makes every
 * EmailSubmission/set whose envelope asks for another MAIL FROM than the
 * identity's fail the way Stalwart does.
 */
function mockServer(options: { refuseMailFrom?: boolean } = {}) {
  const submissions: Array<Record<string, unknown>> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const { methodCalls } = JSON.parse((init as { body: string }).body) as { methodCalls: MethodCall[] };
    const methodResponses = methodCalls.map(([name, args, callId]) => {
      if (name === 'Mailbox/get') {
        return [name, { list: [{ id: 'mb-drafts', name: 'Drafts', role: 'drafts' }, { id: 'mb-sent', name: 'Sent', role: 'sent' }] }, callId];
      }
      if (name === 'Identity/get') return [name, { list: IDENTITIES }, callId];
      if (name === 'Email/set') {
        const created = Object.keys((args.create ?? {}) as object);
        return [name, { created: Object.fromEntries(created.map((id) => [id, { id: 'email-9' }])) }, callId];
      }
      if (name === 'EmailSubmission/set') {
        const create = (args.create as Record<string, Record<string, unknown>>)['1'];
        submissions.push(create);
        const identity = IDENTITIES.find((i) => i.id === create.identityId);
        const mailFrom = (create.envelope as { mailFrom?: { email: string } } | undefined)?.mailFrom?.email;
        if (options.refuseMailFrom && mailFrom && mailFrom.toLowerCase() !== identity?.email.toLowerCase()) {
          return [name, { notCreated: { '1': { type: 'forbiddenFrom', description: 'Envelope mailFrom does not match identity email address.' } } }, callId];
        }
        return [name, { created: { '1': { id: `sub-${submissions.length}` } } }, callId];
      }
      return ['error', { type: 'unknownMethod' }, callId];
    });
    const payload = { methodResponses };
    return {
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(payload)),
      json: () => Promise.resolve(payload),
    } as Response;
  });
  return submissions;
}

function send(client: JMAPClient, fromEmail: string, envelopeMailFrom?: string, delayedUntil?: string) {
  return client.sendEmail(
    ['Recipient <rcpt@example.net>'],
    'Subject',
    'body',
    undefined, undefined, 'identity-1', fromEmail,
    undefined, undefined, undefined, undefined,
    undefined, undefined,
    delayedUntil,
    envelopeMailFrom,
  );
}

describe('JMAPClient.sendEmail envelope MAIL FROM (#1009)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('asks for the From override as MAIL FROM', async () => {
    const submissions = mockServer();

    const result = await send(createClient(), 'alias@example.com', 'alias@example.com');

    expect(submissions).toEqual([{
      emailId: expect.stringMatching(/^#send-/),
      identityId: 'identity-1',
      envelope: { mailFrom: { email: 'alias@example.com' }, rcptTo: [{ email: 'rcpt@example.net' }] },
    }]);
    expect(result).toMatchObject({ emailId: 'email-9', emailSubmissionId: 'sub-1' });
  });

  it("submits again with the identity's address when the server refuses the override", async () => {
    const submissions = mockServer({ refuseMailFrom: true });

    const result = await send(createClient(), 'alias@example.com', 'alias@example.com');

    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toEqual({ emailId: 'email-9', identityId: 'identity-1' });
    expect(result).toMatchObject({ emailId: 'email-9', emailSubmissionId: 'sub-2' });
  });

  it('sends through the identity that owns the override address', async () => {
    const submissions = mockServer({ refuseMailFrom: true });

    await send(createClient(), 'sales@example.com', 'sales@example.com');

    expect(submissions).toEqual([{ emailId: expect.stringMatching(/^#send-/), identityId: 'identity-2' }]);
  });

  it("keeps the identity's address as MAIL FROM of a sub-addressed scheduled send", async () => {
    const client = createClient();
    enableDelayedSend(client);
    const submissions = mockServer({ refuseMailFrom: true });

    await send(client, 'user+shop@example.com', undefined, new Date(Date.now() + 60_000).toISOString());

    expect(submissions).toHaveLength(1);
    expect(submissions[0].envelope).toMatchObject({ mailFrom: { email: 'user@example.com' } });
  });
});
