import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JMAPClient } from '../jmap/client';

// Minimal valid JMAP session response
function makeSession(overrides?: Record<string, unknown>) {
  return {
    capabilities: { 'urn:ietf:params:jmap:core': {} },
    accounts: { 'acct-1': { name: 'test', isPersonal: true, accountCapabilities: {} } },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acct-1' },
    apiUrl: 'https://mail.example.com/jmap/api',
    downloadUrl: 'https://mail.example.com/jmap/download/{accountId}/{blobId}/{name}',
    uploadUrl: 'https://mail.example.com/jmap/upload/{accountId}/',
    eventSourceUrl: 'https://mail.example.com/jmap/eventsource',
    ...overrides,
  };
}

function mockFetchResponse(status: number, body?: unknown): Response {
  return new Response(body ? JSON.stringify(body) : null, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('JMAPClient truncated body refetch (#884)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  async function createConnectedClient(): Promise<JMAPClient> {
    fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, makeSession()));
    const client = new JMAPClient('https://mail.example.com', 'user@test.com', 'pass123');
    await client.connect();
    fetchSpy.mockReset();
    return client;
  }

  function truncatedEmail() {
    return {
      id: 'email-1',
      threadId: 'thread-1',
      mailboxIds: { mb1: true },
      keywords: {},
      size: 600000,
      receivedAt: '2026-08-01T00:00:00Z',
      from: [{ email: 'a@example.com' }],
      to: [],
      subject: 'Big report',
      preview: '',
      htmlBody: [{ partId: 'html1', blobId: 'b1', size: 600000, type: 'text/html' }],
      textBody: [],
      bodyValues: {
        html1: { value: '<html><img src="data:image/jpeg;base64,AAAA', isTruncated: true },
      },
      attachments: [],
    };
  }

  it('getEmail refetches with a larger cap when the displayed html part is truncated', async () => {
    const client = await createConnectedClient();

    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse(200, {
        methodResponses: [['Email/get', { list: [truncatedEmail()] }, '0']],
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse(200, {
        methodResponses: [
          [
            'Email/get',
            {
              list: [
                {
                  id: 'email-1',
                  bodyValues: { html1: { value: '<html><img src="data:image/jpeg;base64,AAAA...full" />', isTruncated: false } },
                },
              ],
            },
            '0',
          ],
        ],
      }),
    );

    const email = await client.getEmail('email-1');

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const refetchBody = JSON.parse((fetchSpy.mock.calls[1]![1] as RequestInit).body as string);
    expect(refetchBody.methodCalls[0][1].maxBodyValueBytes).toBe(8_000_000);
    expect(refetchBody.methodCalls[0][1].ids).toEqual(['email-1']);
    expect(email?.bodyValues?.html1.value).toContain('full');
    expect(email?.bodyValues?.html1.isTruncated).toBe(false);
  });

  it('getEmail does not refetch when the body is not truncated', async () => {
    const client = await createConnectedClient();
    const email = truncatedEmail();
    email.bodyValues.html1.isTruncated = false;

    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse(200, { methodResponses: [['Email/get', { list: [email] }, '0']] }),
    );

    await client.getEmail('email-1');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('getEmail keeps the truncated value if the refetch fails', async () => {
    const client = await createConnectedClient();

    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse(200, {
        methodResponses: [['Email/get', { list: [truncatedEmail()] }, '0']],
      }),
    );
    fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const email = await client.getEmail('email-1');

    expect(email?.bodyValues?.html1.isTruncated).toBe(true);
    expect(email?.bodyValues?.html1.value).toContain('AAAA');
  });

  it('getThreadEmails batches truncated messages into a single follow-up Email/get', async () => {
    const client = await createConnectedClient();

    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse(200, {
        methodResponses: [['Thread/get', { list: [{ id: 'thread-1', emailIds: ['email-1', 'email-2'] }] }, '0']],
      }),
    );

    const secondTruncated = { ...truncatedEmail(), id: 'email-2' };
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse(200, {
        methodResponses: [['Email/get', { list: [truncatedEmail(), secondTruncated] }, '0']],
      }),
    );

    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse(200, {
        methodResponses: [
          [
            'Email/get',
            {
              list: [
                { id: 'email-1', bodyValues: { html1: { value: 'full-1', isTruncated: false } } },
                { id: 'email-2', bodyValues: { html1: { value: 'full-2', isTruncated: false } } },
              ],
            },
            '0',
          ],
        ],
      }),
    );

    const emails = await client.getThreadEmails('thread-1');

    // Thread/get, Email/get, then exactly ONE batched refetch (not one per message)
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const refetchBody = JSON.parse((fetchSpy.mock.calls[2]![1] as RequestInit).body as string);
    expect(refetchBody.methodCalls[0][1].ids.sort()).toEqual(['email-1', 'email-2']);
    expect(emails.find((e) => e.id === 'email-1')?.bodyValues?.html1.value).toBe('full-1');
    expect(emails.find((e) => e.id === 'email-2')?.bodyValues?.html1.value).toBe('full-2');
  });
});
