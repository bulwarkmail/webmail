import { describe, it, expect, vi } from 'vitest';
import { JMAPClient, sendMethodErrors } from '../jmap/client';

// JMAP names a failed method call "error" (RFC 8620 §3.6.2); the client used
// to test for "<Method>/error", which never matches.

function clientResponding(methodResponses: unknown[]): JMAPClient {
  const client = new JMAPClient('https://jmap.example.com', 'user@example.com', 'pass');
  Object.assign(client, { apiUrl: 'https://jmap.example.com/api', accountId: 'a1' });
  vi.spyOn(client as unknown as { request: () => Promise<unknown> }, 'request')
    .mockResolvedValue({ methodResponses });
  return client;
}

describe('sendMethodErrors', () => {
  it('reports an error before the submission as a failed send', () => {
    const { failure, filing } = sendMethodErrors([
      ['error', { type: 'forbidden', description: 'nope' }, '0'],
      ['error', { type: 'invalidResultReference' }, '1'],
    ]);
    expect(failure).toEqual({ type: 'forbidden', description: 'nope' });
    expect(filing).toBeUndefined();
  });

  it('reports an error after a created submission as a filing problem', () => {
    const { failure, filing } = sendMethodErrors([
      ['Email/set', { created: { draft: { id: 'e1' } } }, '0'],
      ['EmailSubmission/set', { created: { 1: { id: 's1' } } }, '1'],
      ['error', { type: 'serverFail' }, '1'],
    ]);
    expect(failure).toBeUndefined();
    expect(filing).toEqual({ type: 'serverFail' });
  });

  it('treats a submission that created nothing as not sent', () => {
    const { failure } = sendMethodErrors([
      ['EmailSubmission/set', { created: {}, notCreated: { 1: { type: 'forbiddenFrom' } } }, '1'],
      ['error', { type: 'serverFail' }, '1'],
    ]);
    expect(failure).toEqual({ type: 'serverFail' });
  });
});

describe('search method errors', () => {
  const unsupported = ['error', { type: 'unsupportedFilter', description: 'Unsupported filter' }, '0'];

  it('searchEmails throws instead of returning "no results"', async () => {
    const client = clientResponding([unsupported, ['error', { type: 'invalidResultReference' }, '1']]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(client.searchEmails('x')).rejects.toThrow('Search failed: Unsupported filter');
  });

  it('advancedSearchEmails throws on a failed Email/query', async () => {
    const client = clientResponding([unsupported]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(client.advancedSearchEmails({ text: 'x' })).rejects.toThrow('Search failed: Unsupported filter');
  });
});
