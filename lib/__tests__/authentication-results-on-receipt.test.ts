import { describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '../jmap/client';

type Call = [string, Record<string, unknown>, string];

const AR = ' mx.example.org; dkim=pass header.d=shop.example; dmarc=pass header.from=shop.example';
const RECEIVED = ' from mail.shop.example by mx.example.org (Stalwart SMTP) with ESMTPS id 1';

function clientReturning(headers: { name: string; value: string }[]) {
  const client = new JMAPClient('https://jmap.example.com', 'user@example.com', 'pass');
  Object.assign(client, { accountId: 'me', capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInGet: 50 } } });
  vi.spyOn(client as unknown as { request: (c: Call[]) => Promise<unknown> }, 'request')
    .mockImplementation(async (calls: Call[]) => ({
      methodResponses: calls.map(([method, , id]) => [method, {
        list: [{ id: 'm1', threadId: 't1', receivedAt: '2026-10-30T09:00:00Z', from: [{ email: 'orders@shop.example' }], headers }],
      }, id]),
    }));
  return client;
}

// Booking cards need the order of Received and Authentication-Results, which
// the header record built by getEmail no longer has.
describe('getEmail', () => {
  it('records that a receiving server wrote the Authentication-Results', async () => {
    const email = await clientReturning([{ name: 'Received', value: RECEIVED }, { name: 'Authentication-Results', value: AR }]).getEmail('m1');
    expect(email?.authenticationResultsOnReceipt).toBe(true);
    expect(email?.authenticationResults).toMatchObject({ dkim: { result: 'pass' } });
  });

  it('records a header with no Received above it as not written on receipt', async () => {
    const email = await clientReturning([{ name: 'Authentication-Results', value: AR }, { name: 'Received', value: RECEIVED }]).getEmail('m1');
    expect(email?.authenticationResultsOnReceipt).toBe(false);
  });
});
