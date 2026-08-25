import { describe, expect, it } from 'vitest';
import { findComposeIdentityId, findDraftIdentityId, findReplyIdentityId, resolveComposeAccountEmail, resolveReplyFrom } from '../reply-identity';
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

describe('findDraftIdentityId', () => {
  // Two identities on the SAME address, differing only by display name — the
  // reopen-draft regression: an email-only match picks the default, not the one
  // the draft was written with.
  const sameAddress: Identity[] = [
    { id: 'default', name: 'Harry Primary', email: 'harry@primary.com', mayDelete: false },
    { id: 'team', name: 'Harry Team', email: 'harry@primary.com', mayDelete: false },
  ];

  it('restores the exact identity by name when several share an address', () => {
    expect(findDraftIdentityId(sameAddress, { name: 'Harry Team', email: 'harry@primary.com' })).toBe('team');
    expect(findDraftIdentityId(sameAddress, { name: 'Harry Primary', email: 'harry@primary.com' })).toBe('default');
  });

  it('matches by email (normalized) when the name is absent or unique', () => {
    expect(findDraftIdentityId(identities, { email: 'HARRY@Secondary.com' })).toBe('secondary');
    expect(findDraftIdentityId(identities, { name: 'Whatever', email: 'harry@secondary.com' })).toBe('secondary');
  });

  it('falls back to the +tag-stripped base address', () => {
    expect(findDraftIdentityId(identities, { email: 'harry+promo@secondary.com' })).toBe('secondary');
  });

  it('returns null when nothing matches or there is no From', () => {
    expect(findDraftIdentityId(identities, { email: 'nobody@elsewhere.com' })).toBeNull();
    expect(findDraftIdentityId(identities, null)).toBeNull();
    expect(findDraftIdentityId([], { email: 'harry@primary.com' })).toBeNull();
  });
});

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

describe('resolveComposeAccountEmail', () => {
  // Selecting a shared/group folder in the "Shared" sidebar does not move the
  // active account, so the composer used to preselect the reaching login's
  // primary identity and start every new message as the wrong sender.
  const mailboxes = [
    { id: 'a-inbox' },
    { id: 'owner-x:x-inbox', isShared: true, accountName: 'team@shared.example' },
    { id: 'owner-y:y-inbox', isShared: true, accountName: 'Support Team' },
  ];

  it('uses the shared folder owner address when a shared folder is selected', () => {
    expect(resolveComposeAccountEmail(mailboxes, 'owner-x:x-inbox', 'me@primary.example'))
      .toBe('team@shared.example');
  });

  it('keeps the active account address for an own folder', () => {
    expect(resolveComposeAccountEmail(mailboxes, 'a-inbox', 'me@primary.example'))
      .toBe('me@primary.example');
  });

  it('falls back to the active account when the account name is not an address', () => {
    // RFC 8620 suggests the address for Account.name, but a server may put a
    // human label there; that must not become a From address.
    expect(resolveComposeAccountEmail(mailboxes, 'owner-y:y-inbox', 'me@primary.example'))
      .toBe('me@primary.example');
  });

  it('handles an unknown or empty selection', () => {
    expect(resolveComposeAccountEmail(mailboxes, 'nope', 'me@primary.example')).toBe('me@primary.example');
    expect(resolveComposeAccountEmail(mailboxes, null, 'me@primary.example')).toBe('me@primary.example');
    expect(resolveComposeAccountEmail(mailboxes, 'owner-x:x-inbox', null)).toBe('team@shared.example');
    expect(resolveComposeAccountEmail(mailboxes, 'a-inbox', null)).toBeUndefined();
  });

  it('preselects the shared identity end-to-end (the reported repro)', () => {
    // Shared folder selected -> resolved address -> matching send-as identity.
    const identities: Identity[] = [
      { id: 'primary', name: 'D R', email: 'me@primary.example', mayDelete: false },
      { id: 'shared', name: 'D R', email: 'team@shared.example', mayDelete: false },
    ];
    const address = resolveComposeAccountEmail(mailboxes, 'owner-x:x-inbox', 'me@primary.example');
    expect(findComposeIdentityId(identities, address)).toBe('shared');

    // Same call on an own folder keeps the primary identity.
    const own = resolveComposeAccountEmail(mailboxes, 'a-inbox', 'me@primary.example');
    expect(findComposeIdentityId(identities, own)).toBe('primary');
  });
});
