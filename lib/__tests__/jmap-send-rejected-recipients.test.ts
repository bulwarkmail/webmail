import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JMAPClient, RecipientsRejectedError, formatRejectedRecipients, rejectedRecipients } from '../jmap/client';
import type { DeliveryStatus } from '../jmap/types';

// #1123: Stalwart runs RCPT TO while creating the EmailSubmission. A refused
// recipient does not fail the create; it is recorded on the submission as
// delivered "no", so the send has to read deliveryStatus back to notice.

type MethodCall = [string, Record<string, unknown>, string];

const MAILBOX_GONE = '550 5.1.2 Mailbox does not exist.';

function createClient(): JMAPClient {
  const client = new JMAPClient('https://jmap.example.com', 'user@example.com', 'pass');
  Object.assign(client, {
    apiUrl: 'https://jmap.example.com/api',
    accountId: 'account-1',
    username: 'user@example.com',
  });
  return client;
}

const IDENTITIES = [
  { id: 'identity-1', email: 'user@example.com', mayDelete: false },
];

interface ServerOptions {
  deliveryStatus?: Record<string, DeliveryStatus>;
  /** Answer EmailSubmission/get the way a server without it would. */
  noSubmissionGet?: boolean;
  /** Refuse the submission itself. */
  refuseSubmission?: boolean;
  /** Refuse an envelope MAIL FROM other than the identity's, as Stalwart does. */
  refuseMailFrom?: boolean;
}

function mockServer(options: ServerOptions = {}) {
  const requests: MethodCall[][] = [];
  const destroyed: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const { methodCalls } = JSON.parse((init as { body: string }).body) as { methodCalls: MethodCall[] };
    requests.push(methodCalls);
    const methodResponses: Array<[string, Record<string, unknown>, string]> = [];
    // Creation id -> server id for this request (RFC 8620 §5.3).
    const createdIds = new Map<string, string>();
    for (const [name, args, callId] of methodCalls) {
      if (name === 'Mailbox/get') {
        methodResponses.push([name, { list: [{ id: 'mb-drafts', name: 'Drafts', role: 'drafts' }, { id: 'mb-sent', name: 'Sent', role: 'sent' }] }, callId]);
      } else if (name === 'Identity/get') {
        methodResponses.push([name, { list: IDENTITIES }, callId]);
      } else if (name === 'Email/set' || name === 'Email/import') {
        const ids = Object.keys((args.create ?? args.emails ?? {}) as object);
        destroyed.push(...((args.destroy ?? []) as string[]));
        methodResponses.push([name, {
          created: Object.fromEntries(ids.map((id) => [id, { id: 'email-9' }])),
          destroyed: args.destroy ?? [],
        }, callId]);
      } else if (name === 'EmailSubmission/set') {
        const [creationId, create] = Object.entries(args.create as Record<string, Record<string, unknown>>)[0];
        const mailFrom = (create.envelope as { mailFrom?: { email: string } } | undefined)?.mailFrom?.email;
        if (options.refuseSubmission) {
          methodResponses.push([name, { notCreated: { [creationId]: { type: 'forbiddenToSend', description: 'Sending is disabled.' } } }, callId]);
        } else if (options.refuseMailFrom && mailFrom && mailFrom !== 'user@example.com') {
          methodResponses.push([name, { notCreated: { [creationId]: { type: 'forbiddenFrom' } } }, callId]);
        } else {
          createdIds.set(creationId, 'sub-1');
          methodResponses.push([name, { created: { [creationId]: { id: 'sub-1' } } }, callId]);
        }
      } else if (name === 'EmailSubmission/get' && args['#ids']) {
        // Stalwart evaluates result references into /get, /changes and
        // /query responses only - a pointer into a /set response fails.
        methodResponses.push(['error', { type: 'invalidResultReference' }, callId]);
      } else if (name === 'EmailSubmission/get' && options.noSubmissionGet) {
        methodResponses.push(['error', { type: 'unknownMethod' }, callId]);
      } else if (name === 'EmailSubmission/get') {
        const ids = args.ids as string[];
        if (!ids[0].startsWith('#')) {
          methodResponses.push([name, { list: [{ id: ids[0], sendAt: '2026-09-29T12:00:30Z', undoStatus: 'pending' }] }, callId]);
          continue;
        }
        const submissionId = createdIds.get(ids[0].slice(1));
        methodResponses.push(submissionId
          ? [name, { list: [{ id: submissionId, deliveryStatus: options.deliveryStatus ?? null }], notFound: [] }, callId]
          : ['error', { type: 'invalidResultReference' }, callId]);
      } else {
        methodResponses.push(['error', { type: 'unknownMethod' }, callId]);
      }
    }
    const payload = { methodResponses };
    return {
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(payload)),
      json: () => Promise.resolve(payload),
    } as Response;
  });
  return { requests, destroyed };
}

function send(client: JMAPClient, options: { draftId?: string; envelopeMailFrom?: string; delayedUntil?: string } = {}) {
  return client.sendEmail(
    ['kept@example.net', 'gone@example.com'],
    'Subject',
    'body',
    undefined, undefined, 'identity-1', 'user@example.com',
    options.draftId, undefined, undefined, undefined,
    undefined, undefined,
    options.delayedUntil,
    options.envelopeMailFrom,
  );
}

describe('rejectedRecipients', () => {
  it('lists recipients marked delivered "no" with their SMTP reply', () => {
    expect(rejectedRecipients({
      'kept@example.net': { delivered: 'queued', smtpReply: '250 2.1.5 Queued', displayed: 'unknown' },
      'gone@example.com': { delivered: 'no', smtpReply: `${MAILBOX_GONE}\r\n`, displayed: 'unknown' },
    })).toEqual({ rejected: [{ email: 'gone@example.com', smtpReply: MAILBOX_GONE }], all: false });
  });

  it('says so when every recipient was refused', () => {
    expect(rejectedRecipients({
      'gone@example.com': { delivered: 'no', smtpReply: MAILBOX_GONE, displayed: 'unknown' },
    }).all).toBe(true);
  });

  it('reports nothing without a deliveryStatus', () => {
    expect(rejectedRecipients(null)).toEqual({ rejected: [], all: false });
    expect(rejectedRecipients({})).toEqual({ rejected: [], all: false });
  });

  it('formats recipients with their replies', () => {
    expect(formatRejectedRecipients([
      { email: 'gone@example.com', smtpReply: MAILBOX_GONE },
      { email: 'other@example.com', smtpReply: '' },
    ])).toBe(`gone@example.com (${MAILBOX_GONE}), other@example.com`);
  });
});

describe('JMAPClient.sendEmail refused recipients (#1123)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reads the new submission deliveryStatus back in the send request', async () => {
    const { requests } = mockServer();

    await send(createClient());

    const sendRequest = requests.find((calls) => calls.some(([name]) => name === 'EmailSubmission/set'))!;
    expect(sendRequest.map(([name]) => name)).toEqual(['Email/set', 'EmailSubmission/set', 'EmailSubmission/get']);
    expect(sendRequest[2][1]).toEqual({
      accountId: 'account-1',
      ids: ['#1'],
      properties: ['deliveryStatus'],
    });
  });

  it('returns the refused recipients when the others were accepted', async () => {
    const { destroyed } = mockServer({
      deliveryStatus: {
        'kept@example.net': { delivered: 'queued', smtpReply: '250 2.1.5 Queued', displayed: 'unknown' },
        'gone@example.com': { delivered: 'no', smtpReply: MAILBOX_GONE, displayed: 'unknown' },
      },
    });

    const result = await send(createClient(), { draftId: 'draft-1' });

    expect(result.rejectedRecipients).toEqual([{ email: 'gone@example.com', smtpReply: MAILBOX_GONE }]);
    expect(result.filingError).toBeUndefined();
    // The message went out to the accepted recipient, so the draft is done.
    expect(destroyed).toEqual(['draft-1']);
  });

  it('fails the send and keeps the draft when every recipient was refused', async () => {
    const { destroyed } = mockServer({
      deliveryStatus: {
        'kept@example.net': { delivered: 'no', smtpReply: '550 5.7.1 Relaying denied', displayed: 'unknown' },
        'gone@example.com': { delivered: 'no', smtpReply: MAILBOX_GONE, displayed: 'unknown' },
      },
    });

    const error = await send(createClient(), { draftId: 'draft-1' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RecipientsRejectedError);
    expect((error as RecipientsRejectedError).recipients.map((r) => r.email)).toEqual(['kept@example.net', 'gone@example.com']);
    // The copy filed into Sent never left; the draft stays for a retry.
    expect(destroyed).toEqual(['email-9']);
  });

  it('also fails a delayed send whose recipients were all refused', async () => {
    mockServer({
      deliveryStatus: { 'gone@example.com': { delivered: 'no', smtpReply: MAILBOX_GONE, displayed: 'unknown' } },
    });
    const client = createClient();
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

    await expect(send(client, { delayedUntil: new Date(Date.now() + 30_000).toISOString() }))
      .rejects.toBeInstanceOf(RecipientsRejectedError);
  });

  it('reports a refused submission by its own error, not the dangling read-back', async () => {
    mockServer({ refuseSubmission: true });

    await expect(send(createClient())).rejects.toThrow('Sending is disabled.');
  });

  it('treats a server that cannot answer the read-back as a plain success', async () => {
    mockServer({ noSubmissionGet: true });

    const result = await send(createClient());

    expect(result).toMatchObject({ emailId: 'email-9', emailSubmissionId: 'sub-1' });
    expect(result.filingError).toBeUndefined();
    expect(result.rejectedRecipients).toBeUndefined();
  });

  it('reads the status of the resubmission after a refused MAIL FROM', async () => {
    const { requests } = mockServer({
      refuseMailFrom: true,
      deliveryStatus: {
        'kept@example.net': { delivered: 'queued', smtpReply: '250 2.1.5 Queued', displayed: 'unknown' },
        'gone@example.com': { delivered: 'no', smtpReply: MAILBOX_GONE, displayed: 'unknown' },
      },
    });

    const result = await send(createClient(), { envelopeMailFrom: 'alias@example.com' });

    const submits = requests.filter((calls) => calls.some(([name]) => name === 'EmailSubmission/set'));
    expect(submits).toHaveLength(2);
    expect(submits[1].map(([name]) => name)).toEqual(['EmailSubmission/set', 'EmailSubmission/get']);
    expect(result.rejectedRecipients).toEqual([{ email: 'gone@example.com', smtpReply: MAILBOX_GONE }]);
  });
});

describe('JMAPClient raw sends refused recipients (#1123)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function rawClient(): JMAPClient {
    const client = createClient();
    vi.spyOn(client, 'uploadBlob').mockResolvedValue({ blobId: 'blob-1', size: 10, type: 'message/rfc822' } as never);
    vi.spyOn(client, 'getIdentities').mockResolvedValue(IDENTITIES as never);
    return client;
  }

  it('sendRawEmail returns the refused recipients', async () => {
    mockServer({
      deliveryStatus: {
        'kept@example.net': { delivered: 'queued', smtpReply: '250 2.1.5 Queued', displayed: 'unknown' },
        'gone@example.com': { delivered: 'no', smtpReply: MAILBOX_GONE, displayed: 'unknown' },
      },
    });

    const result = await rawClient().sendRawEmail(new Blob(['raw']), 'identity-1', 'mb-sent', 'mb-drafts');

    expect(result.rejectedRecipients).toEqual([{ email: 'gone@example.com', smtpReply: MAILBOX_GONE }]);
  });

  it('sendRawEmail removes the filed copy when every recipient was refused', async () => {
    const { destroyed } = mockServer({
      deliveryStatus: { 'gone@example.com': { delivered: 'no', smtpReply: MAILBOX_GONE, displayed: 'unknown' } },
    });

    await expect(rawClient().sendRawEmail(new Blob(['raw']), 'identity-1', 'mb-sent', 'mb-drafts'))
      .rejects.toBeInstanceOf(RecipientsRejectedError);
    expect(destroyed).toEqual(['email-9']);
  });

  it('submitRawEmail fails when every recipient was refused', async () => {
    const { requests } = mockServer({
      deliveryStatus: { 'gone@example.com': { delivered: 'no', smtpReply: MAILBOX_GONE, displayed: 'unknown' } },
    });

    await expect(rawClient().submitRawEmail(new Blob(['raw']), 'identity-1'))
      .rejects.toBeInstanceOf(RecipientsRejectedError);
    const submit = requests.find((calls) => calls.some(([name]) => name === 'EmailSubmission/set'))!;
    expect(submit[2][1].ids).toEqual(['#raw-submit']);
  });
});
