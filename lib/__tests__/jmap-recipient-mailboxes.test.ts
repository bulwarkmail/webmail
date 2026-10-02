import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JMAPClient } from '../jmap/client';

/**
 * #672: to/cc/bcc reach the client as RFC 5322 mailbox strings. JMAP keeps the
 * display name and the address in separate fields, so the mailbox has to be
 * split before it goes on the wire - handing the whole string (or a quoted
 * name, or a name that repeats the address) to the server makes it emit an
 * invalid To header and derive a malformed envelope recipient from it.
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

interface JMAPMethodCall { 0: string; 1: Record<string, unknown>; 2: string }
interface CapturedRequest { using?: string[]; methodCalls: JMAPMethodCall[] }

/** Mailbox/get (or query+get) → Identity/get → Email/set (+ EmailSubmission/set). */
function mockFlow() {
  const captured: CapturedRequest[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse((init as { body: string }).body) as CapturedRequest;
    captured.push(body);
    const method = body.methodCalls[0][0];

    let payload: unknown;
    if (method === 'Mailbox/get') {
      payload = {
        methodResponses: [[
          'Mailbox/get',
          { list: [{ id: 'mb-drafts', name: 'Drafts', role: 'drafts' }, { id: 'mb-sent', name: 'Sent', role: 'sent' }] },
          '0',
        ]],
      };
    } else if (method === 'Mailbox/query') {
      const firstPage = body.methodCalls[0][1].position === 0;
      payload = {
        methodResponses: [
          ['Mailbox/query', { position: body.methodCalls[0][1].position, ids: firstPage ? ['mb-drafts', 'mb-sent'] : [], queryState: 'state-1', total: 2 }, 'query'],
          [
            'Mailbox/get',
            { list: firstPage ? [{ id: 'mb-drafts', name: 'Drafts', role: 'drafts' }, { id: 'mb-sent', name: 'Sent', role: 'sent' }] : [], notFound: [] },
            'get',
          ],
        ],
      };
    } else if (method === 'Identity/get') {
      payload = {
        methodResponses: [['Identity/get', { list: [{ id: 'identity-1', email: 'user@example.com', mayDelete: false }] }, '0']],
      };
    } else {
      const create = body.methodCalls[0][1].create as Record<string, unknown>;
      payload = {
        methodResponses: [
          ['Email/set', { created: { [Object.keys(create)[0]]: { id: 'email-1' } } }, '0'],
          ['EmailSubmission/set', { created: { '1': { id: 'sub-1' } } }, '1'],
        ],
      };
    }

    return { ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(payload)), json: () => Promise.resolve(payload) } as Response;
  });
  return captured;
}

/** The Email/set create object of the last captured request. */
function createdEmail(captured: CapturedRequest[]): Record<string, unknown> {
  const setCall = captured[captured.length - 1].methodCalls[0];
  expect(setCall[0]).toBe('Email/set');
  return Object.values(setCall[1].create as Record<string, Record<string, unknown>>)[0];
}

describe('outgoing recipient mailboxes', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('splits "Name <addr>" into the JMAP name and email fields when sending', async () => {
    const client = createClient();
    const captured = mockFlow();

    await client.sendEmail(
      ['Jane Doe <jane.doe@example.com>'],
      'Subject', 'body',
      ['"Doe, John" <john@example.com>'], undefined,
      'identity-1', 'user@example.com',
    );

    const draft = createdEmail(captured);
    expect(draft.to).toEqual([{ name: 'Jane Doe', email: 'jane.doe@example.com' }]);
    // The quoting only exists to survive the composer's comma-separated
    // string; the structured field takes the bare name.
    expect(draft.cc).toEqual([{ name: 'Doe, John', email: 'john@example.com' }]);
  });

  it('drops an address the display name repeats instead of sending it as the name (#672)', async () => {
    const client = createClient();
    const captured = mockFlow();

    await client.sendEmail(
      ['"Jane Doe <jane.doe@example.com>" <jane.doe@example.com>'],
      'Subject', 'body',
      undefined, undefined, 'identity-1', 'user@example.com',
    );

    expect(createdEmail(captured).to).toEqual([{ name: 'Jane Doe', email: 'jane.doe@example.com' }]);
  });

  it('recovers the address when the mailbox lost its closing bracket (#672)', async () => {
    const client = createClient();
    const captured = mockFlow();

    await client.sendEmail(
      ['janedoe<jane.doe@example.com'],
      'Subject', 'body',
      undefined, undefined, 'identity-1', 'user@example.com',
    );

    expect(createdEmail(captured).to).toEqual([{ name: 'janedoe', email: 'jane.doe@example.com' }]);
  });

  it('keeps a bare address without a display name', async () => {
    const client = createClient();
    const captured = mockFlow();

    await client.sendEmail(
      ['jane.doe@example.com'],
      'Subject', 'body',
      undefined, undefined, 'identity-1', 'user@example.com',
    );

    expect(createdEmail(captured).to).toEqual([{ email: 'jane.doe@example.com' }]);
  });

  it('splits the mailbox when saving a draft too (#672)', async () => {
    const client = createClient();
    const captured = mockFlow();

    await client.createDraft(
      ['Jane Doe <jane.doe@example.com>'],
      'Subject', 'body',
      ['"Jane Doe <jane.doe@example.com>" <jane.doe@example.com>'],
      ['bob@example.com'],
    );

    const draft = createdEmail(captured);
    expect(draft.to).toEqual([{ name: 'Jane Doe', email: 'jane.doe@example.com' }]);
    expect(draft.cc).toEqual([{ name: 'Jane Doe', email: 'jane.doe@example.com' }]);
    expect(draft.bcc).toEqual([{ email: 'bob@example.com' }]);
  });
});
