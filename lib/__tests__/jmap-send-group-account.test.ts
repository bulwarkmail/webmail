import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JMAPClient } from '../jmap/client';

// #1090: a message sent as a group (shared) mailbox identity must be created,
// submitted and filed in Sent in the GROUP account, not the member's own. The
// account used to be found only by matching its session name against the From
// address, which misses a group whose account name is a bare principal name,
// an alias identity of the group, and a sub-addressed From. Stalwart also lists
// the group's identity among the member's own, so the send silently went
// through the member's account.

type MethodCall = [string, Record<string, unknown>, string];

const SUBMISSION = 'urn:ietf:params:jmap:submission';

const IDENTITIES: Record<string, Array<{ id: string; email: string }>> = {
  // The member's own list mirrors the group's send-as identity (Stalwart).
  me: [{ id: 'b', email: 'team@example.org' }, { id: 'c', email: 'carol@example.org' }],
  grp: [{ id: 'b', email: 'team@example.org' }, { id: 'x', email: 'info@example.org' }],
  alice: [{ id: 'a', email: 'alice@example.org' }],
  wild: [{ id: 'w', email: '*@lists.example.org' }],
};

function createClient(accounts: Record<string, string>): JMAPClient {
  const client = new JMAPClient('https://jmap.example.org', 'carol@example.org', 'pass');
  Object.assign(client, {
    apiUrl: 'https://jmap.example.org/api',
    accountId: 'me',
    username: 'carol@example.org',
    accounts: Object.fromEntries(Object.entries(accounts).map(([id, name]) => [id, { name }])),
    session: {
      primaryAccounts: { 'urn:ietf:params:jmap:mail': 'me', [SUBMISSION]: 'me' },
      accounts: Object.fromEntries(Object.keys(accounts).map((id) => [id, {
        accountCapabilities: { 'urn:ietf:params:jmap:mail': {}, [SUBMISSION]: {} },
      }])),
    },
  });
  return client;
}

interface Recorded {
  emailSetAccount?: string;
  createdMailbox?: string;
  destroyAccount?: string;
  submissionAccount?: string;
  sentMailbox?: string;
  identityId?: string;
}

function mockServer(): Recorded {
  const rec: Recorded = {};
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const { methodCalls } = JSON.parse((init as { body: string }).body) as { methodCalls: MethodCall[] };
    const methodResponses = methodCalls.map(([name, args, callId]) => {
      const accountId = args.accountId as string;
      if (name === 'Mailbox/get') {
        return [name, { list: [
          { id: `${accountId}-drafts`, name: 'Drafts', role: 'drafts' },
          { id: `${accountId}-sent`, name: 'Sent', role: 'sent' },
        ] }, callId];
      }
      if (name === 'Identity/get') return [name, { list: IDENTITIES[accountId] ?? [] }, callId];
      if (name === 'Email/set') {
        if (args.create) {
          rec.emailSetAccount = accountId;
          const created = Object.values(args.create as Record<string, { mailboxIds?: Record<string, boolean> }>)[0];
          rec.createdMailbox = Object.keys(created?.mailboxIds ?? {})[0];
        }
        if (args.destroy) rec.destroyAccount = accountId;
        const created = Object.keys((args.create ?? {}) as object);
        return [name, { created: Object.fromEntries(created.map((id) => [id, { id: 'email-9' }])) }, callId];
      }
      if (name === 'EmailSubmission/set') {
        rec.submissionAccount = accountId;
        rec.identityId = (args.create as Record<string, { identityId: string }>)['1'].identityId;
        const update = (args.onSuccessUpdateEmail as Record<string, { mailboxIds?: Record<string, boolean> }>)['#1'];
        rec.sentMailbox = Object.keys(update.mailboxIds ?? {})[0];
        return [name, { created: { '1': { id: 'sub-1' } } }, callId];
      }
      return ['error', { type: 'unknownMethod' }, callId];
    });
    const payload = { methodResponses };
    return {
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(payload)),
      json: () => Promise.resolve(payload),
    } as Response;
  });
  return rec;
}

function send(client: JMAPClient, fromEmail: string, identityId = 'b') {
  return client.sendEmail(['rcpt@example.net'], 'Subject', 'body', undefined, undefined, identityId, fromEmail);
}

describe('JMAPClient.sendEmail picks the account that owns the From identity (#1090)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const expectAccount = (rec: Recorded, account: string) => {
    expect(rec.emailSetAccount).toBe(account);
    expect(rec.submissionAccount).toBe(account);
    expect(rec.sentMailbox).toBe(`${account}-sent`);
  };

  it('sends a group identity through the group account when its name is a bare principal name', async () => {
    const rec = mockServer();
    await send(createClient({ me: 'carol@example.org', grp: 'team' }), 'team@example.org');
    expectAccount(rec, 'grp');
  });

  it('sends an alias identity of the group through the group account', async () => {
    const rec = mockServer();
    await send(createClient({ me: 'carol@example.org', grp: 'team' }), 'info@example.org', 'x');
    expectAccount(rec, 'grp');
    expect(rec.identityId).toBe('x');
  });

  it('sends a sub-addressed group From through the group account', async () => {
    const rec = mockServer();
    await send(createClient({ me: 'carol@example.org', grp: 'team' }), 'team+news@example.org');
    expectAccount(rec, 'grp');
  });

  it('matches a wildcard identity of a delegated account for its domain', async () => {
    const rec = mockServer();
    await send(createClient({ me: 'carol@example.org', wild: 'lists' }), 'announce@lists.example.org', 'w');
    expectAccount(rec, 'wild');
  });

  it('keeps the member’s own address (and its sub-addresses) on the primary account', async () => {
    const own = mockServer();
    await send(createClient({ me: 'carol@example.org', grp: 'team', alice: 'alice@example.org' }), 'carol@example.org', 'c');
    expectAccount(own, 'me');

    vi.restoreAllMocks();
    const sub = mockServer();
    await send(createClient({ me: 'carol-renamed', grp: 'team' }), 'carol+x@example.org', 'c');
    expectAccount(sub, 'me');
  });

  it('still prefers an account named exactly like the From address', async () => {
    const rec = mockServer();
    await send(createClient({ me: 'carol@example.org', grp: 'team@example.org' }), 'team@example.org');
    expectAccount(rec, 'grp');
  });

  describe('drafts', () => {
    const draft = (client: JMAPClient, fromEmail: string, draftId?: string, options?: { accountId?: string; previousDraftAccountId?: string }) =>
      client.createDraft(['rcpt@example.net'], 'Subject', 'body', undefined, undefined, 'b', fromEmail, draftId,
        undefined, undefined, undefined, options);

    it('saves a group identity’s draft in the group account’s Drafts', async () => {
      const rec = mockServer();
      await draft(createClient({ me: 'carol@example.org', grp: 'team' }), 'team@example.org');
      expect(rec.emailSetAccount).toBe('grp');
      expect(rec.createdMailbox).toBe('grp-drafts');
    });

    it('keeps the member’s own drafts in the primary account', async () => {
      const rec = mockServer();
      await draft(createClient({ me: 'carol@example.org', grp: 'team' }), 'carol@example.org');
      expect(rec.emailSetAccount).toBe('me');
      expect(rec.createdMailbox).toBe('me-drafts');
    });

    it('destroys the replaced version in the account it lives in', async () => {
      const rec = mockServer();
      // Identity switched from carol to team: the new version goes to the
      // group, the old one is destroyed in carol's account.
      await draft(createClient({ me: 'carol@example.org', grp: 'team' }), 'team@example.org', 'old-1', { previousDraftAccountId: 'me' });
      expect(rec.emailSetAccount).toBe('grp');
      expect(rec.destroyAccount).toBe('me');

      vi.restoreAllMocks();
      const again = mockServer();
      await draft(createClient({ me: 'carol@example.org', grp: 'team' }), 'team@example.org', 'old-2', { previousDraftAccountId: 'grp' });
      expect(again.destroyAccount).toBe('grp');
    });

    it('sendEmail destroys the sent draft in the account named by draftAccountId', async () => {
      const rec = mockServer();
      await createClient({ me: 'carol@example.org', grp: 'team' }).sendEmail(
        ['rcpt@example.net'], 'Subject', 'body', undefined, undefined, 'b', 'team@example.org', 'draft-7',
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, { draftAccountId: 'grp' },
      );
      expectAccount(rec, 'grp');
      expect(rec.destroyAccount).toBe('grp');
    });
  });
});
