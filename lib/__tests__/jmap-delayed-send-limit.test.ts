import { describe, it, expect } from 'vitest';
import { JMAPClient, ScheduleTooLateError, parseHoldLimit } from '../jmap/client';

const THIRTY_DAYS = 30 * 24 * 60 * 60;
const SEVEN_DAYS = 7 * 24 * 60 * 60;

function clientWith(maxDelayedSend: number, stalwart: boolean): JMAPClient {
  const client = new JMAPClient('https://jmap.example.com', 'user@example.com', 'pass');
  const accountCapabilities: Record<string, unknown> = {
    'urn:ietf:params:jmap:submission': { maxDelayedSend, submissionExtensions: { FUTURERELEASE: [] } },
  };
  if (stalwart) accountCapabilities['urn:stalwart:jmap'] = {};
  Object.assign(client, {
    accountId: 'a1',
    capabilities: { 'urn:ietf:params:jmap:submission': {} },
    session: {
      primaryAccounts: { 'urn:ietf:params:jmap:submission': 'a1' },
      accounts: { a1: { accountCapabilities } },
    },
  });
  return client;
}

describe('scheduled send limit', () => {
  it('clamps the fixed 30 days Stalwart advertises to its 7-day hold limit', () => {
    expect(clientWith(THIRTY_DAYS, true).getMaxDelayedSend()).toBe(SEVEN_DAYS);
  });

  it('trusts the advertised limit on other servers and other values', () => {
    expect(clientWith(THIRTY_DAYS, false).getMaxDelayedSend()).toBe(THIRTY_DAYS);
    expect(clientWith(3600, true).getMaxDelayedSend()).toBe(3600);
  });

  it('learns the limit from a rejected submission', () => {
    const client = clientWith(THIRTY_DAYS, false);
    const reject = () => (client as unknown as { throwIfHoldTooLong(e: { description?: string }): void })
      .throwIfHoldTooLong({
        description: 'Server rejected MAIL-FROM: 501 5.5.4 Requested hold time exceeds maximum of 172800 seconds.',
      });
    expect(reject).toThrow(ScheduleTooLateError);
    expect(client.getMaxDelayedSend()).toBe(172800);
  });

  it('parses only hold-limit rejections', () => {
    expect(parseHoldLimit('501 5.5.4 Requested hold time exceeds maximum of 604800 seconds.')).toBe(604800);
    expect(parseHoldLimit('Server rejected MAIL-FROM: 550 nope')).toBeNull();
    expect(parseHoldLimit(undefined)).toBeNull();
  });
});
