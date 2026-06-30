import { describe, it, expect } from 'vitest';
import { connectedAccountCandidates } from '../auth-store';
import type { Identity } from '@/lib/jmap/types';

// The account-switch guard force-re-auths only when the connected session
// matches NONE of its server-confirmed identifiers. accountId is generated
// from the primary-identity email (OAuth) OR the login username (basic), so
// the candidate set must cover both: the JMAP Session.username (authenticated
// login) and the primary sending-identity email.

const SERVER = 'https://mail.example.com';

const fakeClient = (opts: {
  sessionUsername?: string;
  constructorUsername?: string;
  identities?: Identity[] | Error;
}) =>
  ({
    getSessionUsername: () => opts.sessionUsername,
    getUsername: () => opts.constructorUsername ?? '',
    getIdentities: async () => {
      if (opts.identities instanceof Error) throw opts.identities;
      return opts.identities ?? [];
    },
  }) as never;

const id = (over: Partial<Identity> = {}): Identity => ({
  id: 'id-1', name: 'Real User', email: 'real@example.com', mayDelete: true, ...over,
});

describe('connectedAccountCandidates (account-switch guard)', () => {
  it('includes the primary-identity email (OAuth registers by email)', async () => {
    const out = await connectedAccountCandidates(
      fakeClient({ sessionUsername: 'preferred_user', identities: [id()] }), SERVER,
    );
    expect(out).toContain('real@example.com@mail.example.com');
  });

  it('includes the session login username (basic auth registers by login)', async () => {
    // support@ case: login is the email, but the primary sending identity is a
    // different address. The login must still be accepted.
    const out = await connectedAccountCandidates(
      fakeClient({ sessionUsername: 'support@linux-hosting.co.il', identities: [id({ email: 'alias@elsewhere.com' })] }),
      SERVER,
    );
    expect(out).toContain('support@linux-hosting.co.il@mail.example.com');
    expect(out).toContain('alias@elsewhere.com@mail.example.com');
  });

  it('excludes the constructor username (cannot mask a desync)', async () => {
    // A desynced slot: client built for support@ but the token resolves to
    // shuki@. Candidates come only from the server (session + identities),
    // never the constructor echo, so support@ is NOT among them.
    const out = await connectedAccountCandidates(
      fakeClient({ sessionUsername: 'shuki@linux-hosting.co.il', constructorUsername: 'support@linux-hosting.co.il', identities: [id({ email: 'shuki@linux-hosting.co.il' })] }),
      SERVER,
    );
    expect(out).not.toContain('support@linux-hosting.co.il@mail.example.com');
    expect(out).toContain('shuki@linux-hosting.co.il@mail.example.com');
  });

  it('returns empty when nothing can be confirmed (caller must not bounce)', async () => {
    const out = await connectedAccountCandidates(
      fakeClient({ sessionUsername: undefined, identities: new Error('no idents') }), SERVER,
    );
    expect(out).toEqual([]);
  });
});
