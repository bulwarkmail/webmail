import { describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '../jmap/client';

// Stalwart answers SieveScript/set with onSuccessActivateScript: null without
// an error but leaves the active script active (checked on 0.16 and 1.0), so
// undoing the first filter rule, which deletes the script it created, failed
// with "scriptIsActive". RFC 9661 deactivates with onSuccessDeactivateScript.

describe('JMAPClient.deactivateSieveScript', () => {
  it('asks the server to deactivate with onSuccessDeactivateScript', async () => {
    const client = new JMAPClient('https://mail.example.com', 'user@test.com', 'pw');
    const request = vi.fn(async () => ({ methodResponses: [['SieveScript/set', { accountId: 'a1' }, '0']] }));
    Object.assign(client as unknown as Record<string, unknown>, { request, sieveUsing: () => ['urn:ietf:params:jmap:sieve'] });
    await client.deactivateSieveScript('a1');
    const [[calls]] = request.mock.calls as unknown as [[[string, Record<string, unknown>, string][]]];
    expect(calls[0][1]).toEqual({ accountId: 'a1', onSuccessDeactivateScript: true });
  });
});
