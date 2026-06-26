import { describe, it, expect, beforeEach } from 'vitest';
import { connectedAccountId } from '../auth-store';
import { useIdentityStore } from '../identity-store';
import type { Identity } from '@/lib/jmap/types';

// Covers the make-or-break bit of the account-switch identity guard: the
// connected session's accountId must be derived with the SAME canonicalisation
// as login (primary-identity email for OAuth, where the JMAP session username
// is often a preferred_username claim, not the address). Comparing the raw
// JMAP username would both false-positive on OAuth and miss real desyncs.

const SERVER = 'https://mail.example.com';

const fakeClient = (jmapUsername: string, identities: Identity[] | Error) =>
  ({
    getUsername: () => jmapUsername,
    getIdentities: async () => {
      if (identities instanceof Error) throw identities;
      return identities;
    },
  }) as never;

const id = (over: Partial<Identity> = {}): Identity => ({
  id: 'id-1',
  name: 'Real User',
  email: 'real@example.com',
  mayDelete: true,
  ...over,
});

describe('connectedAccountId (account-switch guard)', () => {
  beforeEach(() => {
    useIdentityStore.setState({ identities: [], preferredPrimaryId: null } as never);
  });

  it('derives from the primary-identity EMAIL, not the JMAP session username', async () => {
    // OAuth: JMAP username is a preferred_username claim, the real address lives
    // on the identity. The id must be built from the email.
    const result = await connectedAccountId(fakeClient('preferred_user', [id()]), SERVER);
    expect(result).toBe('real@example.com@mail.example.com');
  });

  it('falls back to the JMAP username when identities cannot be fetched', async () => {
    const result = await connectedAccountId(fakeClient('basic@example.com', new Error('no idents')), SERVER);
    expect(result).toBe('basic@example.com@mail.example.com');
  });

  it('returns null when the session identity cannot be determined at all', async () => {
    const broken = { getUsername: () => { throw new Error('disconnected'); } } as never;
    expect(await connectedAccountId(broken, SERVER)).toBeNull();
  });
});
