import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JMAPClient } from '../jmap/client';

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

  it('cleans up replacement submission if canceling the original fails during reschedule', async () => {
    const client = createClient();
    enableDelayedSend(client);
    vi.spyOn(client, 'getMailboxes').mockResolvedValue([
      { id: 'mb-drafts', name: 'Drafts', role: 'drafts' },
      { id: 'mb-sent', name: 'Sent', role: 'sent' },
    ] as never);
    vi.spyOn(client, 'getIdentities').mockResolvedValue([
      { id: 'identity-1', name: 'User', email: 'user@example.com', mayDelete: false },
    ]);
    const requestSpy = vi.spyOn(client as unknown as { request: JMAPClient['request'] }, 'request')
      .mockImplementation(async (methodCalls) => {
        const args = methodCalls[0][1] as { create?: unknown; update?: Record<string, unknown> };
        if (args.create) {
          return { methodResponses: [['EmailSubmission/set', { created: { replacement: { id: 'sub-new' } } }, '0']] };
        }
        if (args.update?.['sub-old']) {
          return { methodResponses: [['EmailSubmission/set', { notUpdated: { 'sub-old': { type: 'cannotUnsend' } } }, '0']] };
        }
        return { methodResponses: [['EmailSubmission/set', { updated: { 'sub-new': null } }, '0']] };
      });

    await expect(client.rescheduleEmailSubmission('sub-old', 'email-1', 'identity-1', new Date(Date.now() + 60_000).toISOString()))
      .rejects.toThrow('could not cancel the original');

    expect(requestSpy).toHaveBeenCalledWith(expect.arrayContaining([
      expect.arrayContaining(['EmailSubmission/set', expect.objectContaining({ update: { 'sub-new': { undoStatus: 'canceled' } } })]),
    ]));
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
});
