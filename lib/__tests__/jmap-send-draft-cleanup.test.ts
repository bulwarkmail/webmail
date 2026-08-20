import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JMAPClient } from '../jmap/client';

/**
 * Sending an edited draft must never destroy it before the send is confirmed:
 * JMAP method calls are not transactional, so a destroy riding in the same
 * request as a failing create/submission still executes - the draft is gone
 * AND nothing was sent (total-loss report, 20.8.2026, blobNotFound on a
 * stale attachment blobId). The cleanup has to be a separate request issued
 * only after the send succeeded.
 */

function createClient(): JMAPClient {
  const client = new JMAPClient('https://jmap.example.com', 'user@example.com', 'pass');
  Object.assign(client, {
    apiUrl: 'https://jmap.example.com/api',
    accountId: 'account-1',
    username: 'user@example.com',
  });
  return client;
}

interface CapturedRequest {
  methodCalls: Array<[string, Record<string, unknown>, string]>;
}

function mockSendFlow(opts: { failCreate?: boolean } = {}) {
  const captured: CapturedRequest[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse((init as { body: string }).body) as CapturedRequest;
    captured.push(body);
    const idx = captured.length - 1;

    let payload: unknown;
    if (idx === 0) {
      payload = {
        methodResponses: [[
          'Mailbox/get',
          { list: [
            { id: 'mb-drafts', name: 'Drafts', role: 'drafts' },
            { id: 'mb-sent', name: 'Sent', role: 'sent' },
          ] },
          '0',
        ]],
      };
    } else if (idx === 1) {
      payload = {
        methodResponses: [[
          'Identity/get',
          { list: [{ id: 'identity-1', email: 'user@example.com', mayDelete: false }] },
          '0',
        ]],
      };
    } else if (idx === 2) {
      const createKey = Object.keys(
        (body.methodCalls[0][1] as { create: Record<string, unknown> }).create,
      )[0];
      payload = opts.failCreate
        ? {
            methodResponses: [[
              'Email/set',
              { notCreated: { [createKey]: { type: 'blobNotFound', description: 'blobId x does not exist on this server' } } },
              '0',
            ]],
          }
        : {
            methodResponses: [
              ['Email/set', { created: { [createKey]: { id: 'sent-1' } } }, '0'],
              ['EmailSubmission/set', { created: { '1': { id: 'sub-1' } } }, '1'],
            ],
          };
    } else {
      // The follow-up draft-cleanup request.
      payload = { methodResponses: [['Email/set', { destroyed: ['draft-old'] }, '0']] };
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

const hasDestroy = (req: CapturedRequest) =>
  req.methodCalls.some(([name, args]) => name === 'Email/set' && 'destroy' in args);

describe('sendEmail draft cleanup (total-loss guard)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('destroys the edited draft only after the confirmed send, in its own request', async () => {
    const client = createClient();
    const captured = mockSendFlow();

    await client.sendEmail(
      ['r@example.com'], 'subj', 'body',
      undefined, undefined, 'identity-1', 'user@example.com',
      'draft-old',
    );

    // No destroy rides along with the create/submission batch.
    expect(hasDestroy(captured[2])).toBe(false);
    // The cleanup is a separate follow-up request targeting the old draft.
    expect(captured.length).toBeGreaterThan(3);
    expect(captured[3].methodCalls[0][0]).toBe('Email/set');
    expect((captured[3].methodCalls[0][1] as { destroy?: string[] }).destroy).toEqual(['draft-old']);
  });

  it('keeps the draft untouched when the send fails', async () => {
    const client = createClient();
    const captured = mockSendFlow({ failCreate: true });

    await expect(client.sendEmail(
      ['r@example.com'], 'subj', 'body',
      undefined, undefined, 'identity-1', 'user@example.com',
      'draft-old',
    )).rejects.toThrow(/blobNotFound|blobId/);

    // Not a single destroy was issued in any request.
    for (const req of captured) {
      expect(hasDestroy(req)).toBe(false);
    }
  });
});
