import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '../jmap/client';
import { ArchiveEmailsError } from '../jmap/archive-error';
import type { Mailbox } from '../jmap/types';

const emails = [
  { id: 'accepted-email', receivedAt: '2026-09-01T12:00:00Z' },
  { id: 'refused-email', receivedAt: '2026-09-02T12:00:00Z' },
];
const json = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});

describe('JMAP archive confirmed results', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => { fetchMock = vi.spyOn(globalThis, 'fetch'); });
  afterEach(() => vi.restoreAllMocks());

  async function connect(maxObjectsInSet = 100) {
    fetchMock.mockResolvedValueOnce(json({
      capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInSet } },
      accounts: { primary: { name: 'Primary', isPersonal: true, accountCapabilities: {} } },
      primaryAccounts: { 'urn:ietf:params:jmap:mail': 'primary' },
      apiUrl: 'https://mail.example.test/jmap/api',
      downloadUrl: 'https://mail.example.test/download/{accountId}/{blobId}/{name}',
      uploadUrl: 'https://mail.example.test/upload/{accountId}',
      eventSourceUrl: 'https://mail.example.test/events',
    }));
    const client = JMAPClient.withBearer('https://mail.example.test', 'test-token', 'test@example.test');
    await client.connect();
    fetchMock.mockReset();
    return client;
  }

  it.each(['single', 'year', 'month'] as const)('retains confirmed updates alongside notUpdated in %s mode', async mode => {
    const client = await connect();
    const methodResponses: unknown[] = [];
    if (mode !== 'single') methodResponses.push(['Mailbox/set', {
      created: { 'year-2026': { id: 'year-folder' }, 'month-2026-09': { id: 'month-folder' } },
    }, '0']);
    methodResponses.push(['Email/set', {
      updated: { 'accepted-email': null },
      notUpdated: { 'refused-email': { type: 'notFound' } },
    }, String(methodResponses.length)]);
    fetchMock.mockResolvedValueOnce(json({ methodResponses }));

    const error = await client.batchArchiveEmails(emails, 'shared-archive', mode, [], 'shared').catch(e => e);

    expect(error).toBeInstanceOf(ArchiveEmailsError);
    expect(error.updatedIds).toEqual(['accepted-email']);
    expect(error.message).toMatch(/notFound/);
    const request = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(request.methodCalls.every((call: [string, { accountId: string }]) => call[1].accountId === 'shared')).toBe(true);
    expect(request.methodCalls.at(-1)[1].update).toEqual({
      'accepted-email': { mailboxIds: { [mode === 'single' ? 'shared-archive' : mode === 'year' ? '#year-2026' : '#month-2026-09']: true } },
      'refused-email': { mailboxIds: { [mode === 'single' ? 'shared-archive' : mode === 'year' ? '#year-2026' : '#month-2026-09']: true } },
    });
  });

  it.each(['single', 'year', 'month'] as const)('preserves earlier batch successes when a later %s request fails', async mode => {
    const client = await connect(1);
    const methodResponses: unknown[] = [];
    if (mode !== 'single') methodResponses.push(['Mailbox/set', {
      created: { 'year-2026': { id: 'year-folder' }, 'month-2026-09': { id: 'month-folder' } },
    }, '0']);
    methodResponses.push(['Email/set', { updated: { 'accepted-email': null } }, String(methodResponses.length)]);
    fetchMock.mockResolvedValueOnce(json({ methodResponses })).mockRejectedValueOnce(new Error('connection lost'));

    const error = await client.batchArchiveEmails(emails, 'archive', mode, []).catch(e => e);

    expect(error.updatedIds).toEqual(['accepted-email']);
    expect(error.message).toBe('connection lost');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = JSON.parse(fetchMock.mock.calls[1][1]?.body as string);
    expect(second.methodCalls[0][1].update['refused-email'].mailboxIds).toEqual({
      [mode === 'single' ? 'archive' : mode === 'year' ? 'year-folder' : 'month-folder']: true,
    });
  });

  it.each(['single', 'year', 'month'] as const)('rejects method errors without confirming rows in %s mode', async mode => {
    const client = await connect();
    const methodResponses: unknown[] = mode === 'single' ? [] : [['Mailbox/set', { created: {} }, '0']];
    methodResponses.push(['error', { type: 'forbidden' }, String(methodResponses.length)]);
    fetchMock.mockResolvedValueOnce(json({ methodResponses }));
    const error = await client.batchArchiveEmails(emails, 'archive', mode, []).catch(e => e);
    expect(error.updatedIds).toEqual([]);
    expect(error.message).toMatch(/forbidden/);
  });

  it('does not infer success for IDs omitted from updated', async () => {
    const client = await connect();
    fetchMock.mockResolvedValueOnce(json({ methodResponses: [['Email/set', { updated: {} }, '0']] }));
    const error = await client.batchArchiveEmails(emails, 'archive', 'single', []).catch(e => e);
    expect(error.updatedIds).toEqual([]);
    expect(error.message).toMatch(/not confirmed/);
  });

  it.each(['year', 'month'] as const)('retains Email/set successes when %s folder creation partially fails', async mode => {
    const client = await connect();
    fetchMock.mockResolvedValueOnce(json({ methodResponses: [
      ['Mailbox/set', { notCreated: { 'year-2026': { type: 'forbidden' } } }, '0'],
      ['Email/set', {
        updated: { 'accepted-email': null }, notUpdated: { 'refused-email': { type: 'invalidProperties' } },
      }, '1'],
    ] }));

    const error = await client.batchArchiveEmails(emails, 'archive', mode, []).catch(e => e);

    expect(error).toBeInstanceOf(ArchiveEmailsError);
    expect(error.updatedIds).toEqual(['accepted-email']);
    expect(error.message).toMatch(/Failed to create archive folder.*forbidden/);
  });

  it.each(['year', 'month'] as const)('reuses existing %s folders and resolves success', async mode => {
    const client = await connect();
    const folders = [
      { id: 'year-folder', name: '2026', parentId: 'archive', accountId: 'primary' },
      { id: 'month-folder', name: '09', parentId: 'year-folder', accountId: 'primary' },
    ] as Mailbox[];
    fetchMock.mockResolvedValueOnce(json({ methodResponses: [['Email/set', {
      updated: { 'accepted-email': null, 'refused-email': null },
    }, '0']] }));

    await expect(client.batchArchiveEmails(emails, 'archive', mode, folders)).resolves.toBeUndefined();

    const request = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(request.methodCalls).toEqual([['Email/set', {
      accountId: 'primary',
      update: Object.fromEntries(emails.map(e => [e.id, { mailboxIds: { [mode === 'year' ? 'year-folder' : 'month-folder']: true } }])),
    }, '0']]);
  });
});
