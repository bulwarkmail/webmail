import { describe, expect, it, vi } from 'vitest';
import { getManagementCapability } from '@/lib/stalwart/management-capability';

const STALWART = 'urn:stalwart:jmap';
const INBUXA = 'urn:inbuxa:jmap:registry';

function client(accounts: Record<string, string[]>, primary = 'own') {
  return {
    getAccountId: () => primary,
    hasAccountCapability: vi.fn((capability: string, accountId?: string) =>
      (accounts[accountId ?? primary] ?? []).includes(capability)),
  };
}

describe('account management capability selection', () => {
  it.each([STALWART, INBUXA])('selects the advertised %s capability', (capability) => {
    const target = client({ own: [capability] });
    expect(getManagementCapability(target)).toBe(capability);
    expect(target.hasAccountCapability).toHaveBeenCalledWith(capability, 'own');
  });

  it('prefers Stalwart when the account advertises both', () => {
    expect(getManagementCapability(client({ own: [INBUXA, STALWART] }))).toBe(STALWART);
  });

  it.each([
    { capabilities: [] },
    { capabilities: ['urn:inbuxa:jmap'] },
    { capabilities: ['urn:ietf:params:jmap:mail'] },
  ])(
    'rejects unsupported capabilities $capabilities', ({ capabilities }) => {
      expect(getManagementCapability(client({ own: capabilities }))).toBeNull();
    },
  );

  it('does not borrow the primary or another account capability', () => {
    const target = client({ own: [STALWART], other: [INBUXA], unsupported: [] });
    expect(getManagementCapability(target, 'other')).toBe(INBUXA);
    expect(getManagementCapability(target, 'unsupported')).toBeNull();
    expect(getManagementCapability(target, 'missing')).toBeNull();
  });

  it('does not cache a namespace by account id across servers', () => {
    expect(getManagementCapability(client({ own: [INBUXA] }))).toBe(INBUXA);
    expect(getManagementCapability(client({ own: [STALWART] }))).toBe(STALWART);
    expect(getManagementCapability(client({ own: [] }))).toBeNull();
  });
});
