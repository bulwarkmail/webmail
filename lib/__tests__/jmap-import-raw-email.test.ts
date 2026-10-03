import { describe, it, expect, vi } from 'vitest';
import { JMAPClient } from '../jmap/client';

type Call = [string, Record<string, unknown>, string];

function client() {
  const c = new JMAPClient('https://jmap.example.com', 'user@example.com', 'pass');
  Object.assign(c, { accountId: 'me' });
  vi.spyOn(c, 'uploadBlob').mockResolvedValue({ blobId: 'b1' } as never);
  const calls: Call[] = [];
  vi.spyOn(c as unknown as { request: (c: Call[]) => Promise<unknown> }, 'request')
    .mockImplementation(async (reqCalls: Call[]) => {
      calls.push(reqCalls[0]);
      return { methodResponses: [['Email/import', { created: { 'smime-import': { id: 'new1' } } }, '0']] };
    });
  return { c, calls };
}

describe('importRawEmail', () => {
  it('keeps the original date when one is given', async () => {
    const { c, calls } = client();
    await c.importRawEmail(new Blob(['x']), { inbox: true }, {}, undefined, '2020-01-01T00:00:00Z');
    const emails = calls[0][1].emails as Record<string, Record<string, unknown>>;
    expect(emails['smime-import'].receivedAt).toBe('2020-01-01T00:00:00Z');
  });

  it('lets the server stamp the date otherwise', async () => {
    const { c, calls } = client();
    await c.importRawEmail(new Blob(['x']), { inbox: true });
    const emails = calls[0][1].emails as Record<string, Record<string, unknown>>;
    expect(emails['smime-import']).not.toHaveProperty('receivedAt');
  });
});
