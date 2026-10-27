import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JMAPClient, RescheduleRestoredError } from '../jmap/client';

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
        'urn:ietf:params:jmap:submission': 'submission-account-1',
      },
      accounts: {
        'account-1': {
          accountCapabilities: {
            'urn:ietf:params:jmap:mail': {},
          },
        },
        'submission-account-1': {
          accountCapabilities: {
            'urn:ietf:params:jmap:submission': { maxDelayedSend: 3600, submissionExtensions: { FUTURERELEASE: true } },
          },
        },
      },
    },
  });
}

interface JMAPMethodCall {
  0: string;
  1: Record<string, unknown>;
  2: string;
}

interface CapturedRequest {
  using?: string[];
  methodCalls: JMAPMethodCall[];
}

/**
 * Mock fetch to script three sequential JMAP requests sendEmail makes:
 * Mailbox/get → Identity/get → Email/set + EmailSubmission/set.
 * Returns the captured request bodies for assertions.
 */
function mockSendEmailFlow(draftsId = 'mb-drafts', sentId = 'mb-sent') {
  const captured: CapturedRequest[] = [];
  const fetchSpy = vi.spyOn(globalThis, 'fetch');

  fetchSpy.mockImplementation(async (_url, init) => {
    const body = JSON.parse((init as { body: string }).body) as CapturedRequest;
    captured.push(body);
    const callIdx = captured.length - 1;

    let payload: unknown;
    if (callIdx === 0) {
      payload = {
        methodResponses: [[
          'Mailbox/get',
          {
            list: [
              { id: draftsId, name: 'Drafts', role: 'drafts' },
              { id: sentId, name: 'Sent', role: 'sent' },
            ],
          },
          '0',
        ]],
      };
    } else if (callIdx === 1) {
      payload = {
        methodResponses: [[
          'Identity/get',
          { list: [{ id: 'identity-1', email: 'user@example.com', mayDelete: false }] },
          '0',
        ]],
      };
    } else {
      payload = {
        methodResponses: [
          ['Email/set', { created: { [Object.keys((captured[callIdx].methodCalls[0][1] as { create: Record<string, unknown> }).create)[0]]: { id: 'sent-id-1' } } }, '0'],
          ['EmailSubmission/set', { created: { '1': { id: 'sub-1', sendAt: '2026-05-08T18:00:00Z' } } }, '1'],
        ],
      };
    }

    return {
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(payload)),
      json: () => Promise.resolve(payload),
    } as Response;
  });

  return captured;
}

describe('JMAPClient.sendEmail threading headers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('writes inReplyTo and references on the Email/set create when supplied', async () => {
    const client = createClient();
    const captured = mockSendEmailFlow();

    await client.sendEmail(
      ['recipient@example.com'],
      'Re: testmail',
      'reply body',
      undefined, undefined, 'identity-1', 'user@example.com',
      undefined, undefined, undefined, undefined,
      ['<parent@example.com>'],
      ['<root@example.com>', '<parent@example.com>'],
    );

    // Third request is the Email/set + EmailSubmission/set batch.
    const setCall = captured[2].methodCalls[0];
    expect(setCall[0]).toBe('Email/set');
    const create = setCall[1].create as Record<string, Record<string, unknown>>;
    const draft = Object.values(create)[0];

    // Bare msg-ids per RFC 8621 - angle brackets stripped.
    expect(draft.inReplyTo).toEqual(['parent@example.com']);
    expect(draft.references).toEqual(['root@example.com', 'parent@example.com']);
  });

  it('omits threading fields when no parent ids are supplied', async () => {
    const client = createClient();
    const captured = mockSendEmailFlow();

    await client.sendEmail(
      ['recipient@example.com'],
      'Fresh thread',
      'body',
      undefined, undefined, 'identity-1', 'user@example.com',
    );

    const setCall = captured[2].methodCalls[0];
    const create = setCall[1].create as Record<string, Record<string, unknown>>;
    const draft = Object.values(create)[0];

    expect(draft.inReplyTo).toBeUndefined();
    expect(draft.references).toBeUndefined();
  });

  it('omits cc/bcc when arrays are empty so the server does not emit a bare Cc: header', async () => {
    const client = createClient();
    const captured = mockSendEmailFlow();

    await client.sendEmail(
      ['recipient@example.com'],
      'No copies',
      'body',
      [], [], 'identity-1', 'user@example.com',
    );

    const setCall = captured[2].methodCalls[0];
    const create = setCall[1].create as Record<string, Record<string, unknown>>;
    const draft = Object.values(create)[0];

    expect(draft.cc).toBeUndefined();
    expect(draft.bcc).toBeUndefined();
  });

  it('drops empty / whitespace-only ids rather than sending blank entries', async () => {
    const client = createClient();
    const captured = mockSendEmailFlow();

    await client.sendEmail(
      ['recipient@example.com'],
      'Re: testmail',
      'body',
      undefined, undefined, 'identity-1', 'user@example.com',
      undefined, undefined, undefined, undefined,
      ['<>', '   ', '<real@example.com>'],
      [],
    );

    const setCall = captured[2].methodCalls[0];
    const create = setCall[1].create as Record<string, Record<string, unknown>>;
    const draft = Object.values(create)[0];

    expect(draft.inReplyTo).toEqual(['real@example.com']);
    expect(draft.references).toBeUndefined();
  });

  it('uses FUTURERELEASE envelope and submission capability for scheduled sends', async () => {
    const client = createClient();
    enableDelayedSend(client);
    const captured = mockSendEmailFlow();
    const delayedUntil = new Date(Date.now() + 60_000).toISOString();

    const result = await client.sendEmail(
      ['recipient@example.com'],
      'Scheduled test',
      'body',
      undefined, undefined, 'identity-1', 'user@example.com',
      undefined, undefined, undefined, undefined,
      undefined,
      undefined,
      delayedUntil,
    );

    const identityRequest = captured[1];
    expect(identityRequest.using).toContain('urn:ietf:params:jmap:submission');
    const submissionCall = captured[2].methodCalls.find(call => call[0] === 'EmailSubmission/set');
    expect(submissionCall?.[1].accountId).toBe('submission-account-1');
    expect(submissionCall?.[1].create).toEqual({
      '1': {
        emailId: expect.stringMatching(/^#send-/),
        identityId: 'identity-1',
        envelope: {
          mailFrom: {
            email: 'user@example.com',
            parameters: { HOLDFOR: expect.stringMatching(/^\d+$/) },
          },
          rcptTo: [{ email: 'recipient@example.com' }],
        },
      },
    });
    expect(JSON.stringify(submissionCall?.[1].create)).not.toContain('sendAt');
    expect(result).toMatchObject({ scheduled: true, emailSubmissionId: 'sub-1', sendAt: '2026-05-08T18:00:00Z' });
  });

});

describe('JMAPClient.rescheduleEmailSubmission (#1308)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  type Call = { method: string; args: Record<string, unknown> };
  type CreateArgs = {
    create: { replacement: { emailId: string; envelope?: { mailFrom: { parameters?: Record<string, string> } } } };
    onSuccessUpdateEmail?: Record<string, Record<string, unknown>>;
  };

  const ORIGINAL_SEND_AT_MS = 30 * 60_000;

  /**
   * Scripts the server. `creates` answers each EmailSubmission/set create in
   * turn; 'reject' means the server refuses it with invalidProperties on
   * emailId, like a server that allows one active submission per Email.
   */
  function scriptServer(client: JMAPClient, opts: { cancel?: 'ok' | 'fail'; creates: Array<'ok' | 'reject'> }) {
    enableDelayedSend(client);
    vi.spyOn(client, 'getMailboxes').mockResolvedValue([
      { id: 'mb-drafts', name: 'Drafts', role: 'drafts' },
      { id: 'mb-sent', name: 'Sent', role: 'sent' },
    ] as never);
    const originalSendAt = new Date(Date.now() + ORIGINAL_SEND_AT_MS).toISOString();
    const calls: Call[] = [];
    let createCount = 0;
    vi.spyOn(client as unknown as { request: JMAPClient['request'] }, 'request')
      .mockImplementation(async (methodCalls) => {
        const [method, args] = methodCalls[0] as unknown as [string, Record<string, unknown>];
        calls.push({ method, args });
        if (method === 'Identity/get') {
          return { methodResponses: [[method, { list: [{ id: 'identity-1', email: 'user@example.com' }] }, '0']] };
        }
        if (method === 'EmailSubmission/get') {
          // Only the properties asked for, as the servers answer.
          const wanted = (args.properties as string[] | undefined) ?? ['identityId', 'sendAt', 'envelope'];
          const record: Record<string, unknown> = { id: 'sub-old', identityId: 'identity-1', sendAt: originalSendAt, envelope: { rcptTo: [{ email: 'rcpt@example.com' }] } };
          return { methodResponses: [[method, { list: [Object.fromEntries(Object.entries(record).filter(([key]) => key === 'id' || wanted.includes(key)))] }, '0']] };
        }
        if (method === 'EmailSubmission/set' && args.update) {
          return opts.cancel === 'fail'
            ? { methodResponses: [[method, { notUpdated: { 'sub-old': { type: 'cannotUnsend' } } }, '0']] }
            : { methodResponses: [[method, { updated: { 'sub-old': null } }, '0']] };
        }
        if (method === 'EmailSubmission/set' && args.destroy) {
          return { methodResponses: [[method, { destroyed: args.destroy }, '0']] };
        }
        if (method === 'EmailSubmission/set' && args.create) {
          const outcome = opts.creates[createCount++];
          if (outcome === 'reject') {
            return { methodResponses: [[method, { notCreated: { replacement: { type: 'invalidProperties', properties: ['emailId'] } } }, '0']] };
          }
          return { methodResponses: [[method, { created: { replacement: { id: `sub-new-${createCount}`, sendAt: '2026-10-21T12:00:00Z' } } }, '0']] };
        }
        if (method === 'Email/set') {
          return { methodResponses: [[method, { updated: { 'email-1': null } }, '0']] };
        }
        throw new Error(`unexpected call ${method}`);
      });
    // Without the destroy of a canceled record.
    const submissionSets = () => calls.filter(c => c.method === 'EmailSubmission/set' && !c.args.destroy);
    return { calls, submissionSets };
  }

  const inTenMinutes = () => new Date(Date.now() + 10 * 60_000).toISOString();

  it('cancels the original before creating the replacement', async () => {
    const client = createClient();
    const { submissionSets } = scriptServer(client, { creates: ['ok'] });

    const result = await client.rescheduleEmailSubmission('sub-old', 'email-1', 'identity-1', inTenMinutes());

    const sets = submissionSets();
    expect(sets).toHaveLength(2);
    expect(sets[0].args.update).toEqual({ 'sub-old': { undoStatus: 'canceled' } });
    const create = sets[1].args as unknown as CreateArgs;
    expect(create.create.replacement.emailId).toBe('email-1');
    // The replacement files the message in Sent again: on servers that undo
    // onSuccessUpdateEmail at cancel, the cancel just put it back in Drafts.
    expect(create.onSuccessUpdateEmail?.['#replacement']).toEqual({ mailboxIds: { 'mb-sent': true }, 'keywords/$draft': null });
    expect(result).toMatchObject({ scheduled: true, emailSubmissionId: 'sub-new-1' });
  });

  // The undo toast's "Send now" passes the composer's identity, an id in the
  // login's own account. A group identity's message is submitted in the group
  // account, where that id names nothing (Stalwart 1.0: "Identity not found")
  // or another identity, and the message dropped out of the schedule.
  it('submits the replacement with the identity of the original submission', async () => {
    const client = createClient();
    const { calls, submissionSets } = scriptServer(client, { creates: ['ok'] });

    await client.rescheduleEmailSubmission('sub-old', 'email-1', 'own-identity-of-group-address', inTenMinutes());

    const create = submissionSets().find(c => c.args.create)?.args.create as Record<string, { identityId: string }>;
    expect(create.replacement.identityId).toBe('identity-1');
    expect(calls.find(c => c.method === 'Identity/get')?.args.ids).toEqual(['identity-1']);
  });

  it('changes nothing when the original cannot be canceled', async () => {
    const client = createClient();
    const { submissionSets } = scriptServer(client, { cancel: 'fail', creates: ['ok'] });

    await expect(client.rescheduleEmailSubmission('sub-old', 'email-1', 'identity-1', inTenMinutes()))
      .rejects.toThrow('cannotUnsend');

    expect(submissionSets().filter(c => c.args.create)).toHaveLength(0);
  });

  it('puts the original back at its old time when the replacement is rejected', async () => {
    const client = createClient();
    const { calls, submissionSets } = scriptServer(client, { creates: ['reject', 'ok'] });

    const error = await client.rescheduleEmailSubmission('sub-old', 'email-1', 'identity-1', inTenMinutes())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RescheduleRestoredError);
    expect((error as RescheduleRestoredError).restoredSubmissionId).toBe('sub-new-2');
    const creates = submissionSets().filter(c => c.args.create).map(c => c.args as unknown as CreateArgs);
    expect(creates).toHaveLength(2);
    // The restore holds for the time left until the original sendAt (30 min),
    // not the requested 10 minutes.
    const holdFor = Number(creates[1].create.replacement.envelope?.mailFrom.parameters?.HOLDFOR);
    expect(holdFor).toBeGreaterThan(ORIGINAL_SEND_AT_MS / 1000 - 60);
    expect(holdFor).toBeLessThanOrEqual(ORIGINAL_SEND_AT_MS / 1000);
    expect(creates[1].onSuccessUpdateEmail?.['#replacement']).toEqual({ mailboxIds: { 'mb-sent': true }, 'keywords/$draft': null });
    expect(calls.some(c => c.method === 'Email/set')).toBe(false);
  });

  it('moves the message back to Drafts when neither the replacement nor the restore goes through', async () => {
    const client = createClient();
    const { calls } = scriptServer(client, { creates: ['reject', 'reject'] });

    await expect(client.rescheduleEmailSubmission('sub-old', 'email-1', 'identity-1', inTenMinutes()))
      .rejects.toThrow('no longer scheduled');

    const draftUpdate = calls.find(c => c.method === 'Email/set')?.args.update as Record<string, Record<string, unknown>> | undefined;
    expect(draftUpdate?.['email-1']).toMatchObject({ mailboxIds: { 'mb-drafts': true }, 'keywords/$draft': true });
  });
});

describe('JMAPClient post-send mailbox filing', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function sentFilingPatch(captured: CapturedRequest[]): Record<string, unknown> {
    const submissionCall = captured[2].methodCalls.find(call => call[0] === 'EmailSubmission/set');
    expect(submissionCall).toBeDefined();
    const onSuccess = (submissionCall![1] as {
      onSuccessUpdateEmail: Record<string, Record<string, unknown>>;
    }).onSuccessUpdateEmail;
    return Object.values(onSuccess)[0];
  }

  it('files the sent message via a full mailboxIds replacement, never mailboxIds/<id> pointers', async () => {
    const client = createClient();
    const captured = mockSendEmailFlow();

    await client.sendEmail(
      ['recipient@example.com'], 'subject', 'body',
      undefined, undefined, 'identity-1', 'user@example.com',
    );

    const patch = sentFilingPatch(captured);
    // A `mailboxIds/<id>` JSON-pointer whose token is purely numeric (e.g. a
    // Drafts folder whose JMAP id is "0") is rejected by Stalwart, silently
    // stranding already-delivered mail in Drafts. The move must use a full
    // `mailboxIds` replacement, which has no per-id pointer token.
    expect(Object.keys(patch).some(key => key.startsWith('mailboxIds/'))).toBe(false);
    expect(patch.mailboxIds).toEqual({ 'mb-sent': true });
    expect(patch['keywords/$draft']).toBeNull();
  });

  it('files correctly when the Drafts mailbox id is a purely numeric string (Stalwart numeric-id bug)', async () => {
    const client = createClient();
    // Drafts id "0", Sent id "e": the old pointer form emitted `mailboxIds/0`,
    // which Stalwart rejects with invalidProperties "Invalid patch value".
    const captured = mockSendEmailFlow('0', 'e');

    await client.sendEmail(
      ['recipient@example.com'], 'subject', 'body',
      undefined, undefined, 'identity-1', 'user@example.com',
    );

    const patch = sentFilingPatch(captured);
    expect(Object.keys(patch).some(key => key.startsWith('mailboxIds/'))).toBe(false);
    expect(patch.mailboxIds).toEqual({ e: true });
  });

  it('restoreEmailToDraft places the message in Drafts only via a full mailboxIds replacement', async () => {
    const client = createClient();
    let capturedUpdate: Record<string, unknown> | undefined;
    vi.spyOn(client as unknown as { request: JMAPClient['request'] }, 'request')
      .mockImplementation(async (methodCalls) => {
        const args = methodCalls[0][1] as { update?: Record<string, Record<string, unknown>> };
        capturedUpdate = args.update?.['email-1'];
        return { methodResponses: [['Email/set', { updated: { 'email-1': null } }, '0']] };
      });

    // Third arg (Sent mailbox id) is intentionally ignored — the message must
    // end up in Drafts only, with no leftover Sent membership. Drafts id "0"
    // also exercises the numeric-id path in the reverse direction.
    await client.restoreEmailToDraft('email-1', '0', 'e');

    expect(capturedUpdate).toBeDefined();
    expect(Object.keys(capturedUpdate!).some(key => key.startsWith('mailboxIds/'))).toBe(false);
    expect(capturedUpdate!.mailboxIds).toEqual({ '0': true });
    expect(capturedUpdate!['keywords/$draft']).toBe(true);
  });

  // Mail sent from a group identity lives in the group's account (Stalwart 1.0
  // and 0.16.23 alike), and ids repeat across accounts: restoring it in the own
  // account moved an unrelated message there into Drafts.
  it('restoreEmailToDraft updates the message in the account it was sent from', async () => {
    const client = createClient();
    const calls: Array<Record<string, unknown>> = [];
    vi.spyOn(client as unknown as { request: JMAPClient['request'] }, 'request')
      .mockImplementation(async (methodCalls) => {
        calls.push(methodCalls[0][1] as Record<string, unknown>);
        return { methodResponses: [['Email/set', { updated: { eaaaaab: null } }, '0']] };
      });

    await client.restoreEmailToDraft('eaaaaab', 'd', 'e', 'c');
    await client.restoreEmailToDraft('eaaaaab', 'd', 'e');

    expect(calls.map(call => call.accountId)).toEqual(['c', 'account-1']);
    expect(calls[0].update).toEqual({ eaaaaab: { mailboxIds: { d: true }, 'keywords/$draft': true, 'keywords/$seen': true } });
  });

  it('restoreEmailToDraft fails when the server refuses the call or the message', async () => {
    const client = createClient();
    const request = vi.spyOn(client as unknown as { request: JMAPClient['request'] }, 'request');
    // The whole call refused, e.g. access to the group account taken away.
    request.mockResolvedValueOnce({ methodResponses: [['error', { type: 'forbidden', description: 'You do not have access to account c' }, '0']] });
    request.mockResolvedValueOnce({ methodResponses: [['Email/set', { notUpdated: { eaaaaab: { type: 'notFound' } } }, '0']] });

    await expect(client.restoreEmailToDraft('eaaaaab', 'd', 'e', 'c')).rejects.toMatchObject({ jmapType: 'forbidden' });
    await expect(client.restoreEmailToDraft('eaaaaab', 'd', 'e', 'c')).rejects.toMatchObject({ jmapType: 'notFound', jmapSetError: true });
  });
});
