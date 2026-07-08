import { describe, expect, it } from 'vitest';
import { findComposeIdentityId, findReplyIdentityId, resolveReplyFrom } from '../reply-identity';
import type { Identity } from '../jmap/types';

const identities: Identity[] = [
  {
    id: 'primary',
    name: 'Harry Primary',
    email: 'harry@primary.com',
    mayDelete: false,
  },
  {
    id: 'secondary',
    name: 'Harry Secondary',
    email: 'harry@secondary.com',
    mayDelete: false,
  },
];

describe('findReplyIdentityId', () => {
  it('matches the identity that received the original message', () => {
    const selected = findReplyIdentityId(identities, {
      to: [{ email: 'harry@secondary.com' }],
    });

    expect(selected).toBe('secondary');
  });

  it('matches case-insensitively across recipients', () => {
    const selected = findReplyIdentityId(identities, {
      cc: [{ email: 'HARRY@PRIMARY.COM' }],
    });

    expect(selected).toBe('primary');
  });

  it('falls back to sub-address matching when needed', () => {
    const selected = findReplyIdentityId(identities, {
      to: [{ email: 'harry+news@secondary.com' }],
    });

    expect(selected).toBe('secondary');
  });

  it('returns null when no reply recipient matches an identity', () => {
    const selected = findReplyIdentityId(identities, {
      to: [{ email: 'other@example.com' }],
    });

    expect(selected).toBeNull();
  });
});

describe('findComposeIdentityId', () => {
  it('matches the identity of the active mailbox', () => {
    expect(findComposeIdentityId(identities, 'harry@secondary.com')).toBe('secondary');
  });

  it('matches case-insensitively', () => {
    expect(findComposeIdentityId(identities, 'HARRY@PRIMARY.COM')).toBe('primary');
  });

  it('strips +tag before matching', () => {
    expect(findComposeIdentityId(identities, 'harry+news@secondary.com')).toBe('secondary');
  });

  it('returns null when the active mailbox has no matching identity', () => {
    expect(findComposeIdentityId(identities, 'other@example.com')).toBeNull();
  });

  it('returns null when no active mailbox email is given', () => {
    expect(findComposeIdentityId(identities, undefined)).toBeNull();
    expect(findComposeIdentityId(identities, '')).toBeNull();
  });
});

describe('resolveReplyFrom', () => {
  it('returns the matching identity with no override when exact match', () => {
    expect(resolveReplyFrom(identities, { to: [{ email: 'harry@secondary.com' }] }))
      .toEqual({ identityId: 'secondary' });
  });

  it('strips +tag before matching identities', () => {
    expect(resolveReplyFrom(identities, { to: [{ email: 'harry+news@primary.com' }] }))
      .toEqual({ identityId: 'primary' });
  });

  it('surfaces catch-all override when recipient is on an identity domain but not an identity', () => {
    const result = resolveReplyFrom(identities, {
      to: [{ email: 'stripe@primary.com', name: 'Stripe' }],
    });
    expect(result).toEqual({
      identityId: 'primary',
      overrideEmail: 'stripe@primary.com',
      overrideName: 'Stripe',
    });
  });

  it('prefers identity match over catch-all override when both appear', () => {
    const result = resolveReplyFrom(identities, {
      to: [{ email: 'harry@primary.com' }, { email: 'stripe@primary.com' }],
    });
    expect(result).toEqual({ identityId: 'primary' });
  });

  it('returns null when recipients are on foreign domains', () => {
    expect(resolveReplyFrom(identities, { to: [{ email: 'nobody@elsewhere.com' }] }))
      .toBeNull();
  });
});