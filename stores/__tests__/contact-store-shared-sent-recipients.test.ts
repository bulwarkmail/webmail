import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useContactStore } from '../contact-store';
import { useSettingsStore } from '../settings-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { ContactCard, Email } from '@/lib/jmap/types';

// Sending from a shared mailbox's address, compose autocomplete also offers
// the people that mailbox has written to: its Sent folder is read at sign-in
// (setting sharedSentRecipientSuggestions) and searched on "search the server".

const sentTo = (...to: Array<[string, string]>) =>
  ({ id: Math.random().toString(36), to: to.map(([name, email]) => ({ name, email })), cc: [] }) as unknown as Email;

const contact = (id: string, name: string, email: string): ContactCard => ({
  id,
  addressBookIds: { ab: true },
  name: { full: name },
  emails: { e0: { address: email } },
} as unknown as ContactCard);

beforeEach(() => {
  useContactStore.getState().clearContacts();
  useContactStore.setState({ recentRecipients: [], recentRecipientsLoaded: true, sentMailboxId: null });
  useSettingsStore.setState({ sharedSentRecipientSuggestions: true });
});

describe('loadSharedRecentRecipients', () => {
  it('reads each shared Sent folder once, keeps the recipients per account, and goes on after a failure', async () => {
    const getEmails = vi.fn(async (mailboxId?: string) => {
      if (mailboxId === 'bad-sent') throw new Error('forbidden');
      if (mailboxId === 'a-sent') {
        return { emails: [sentTo(['Ann New', 'ann@x.org']), sentTo(['Ann Old', 'ANN@x.org '], ['Ben', 'ben@x.org'])], hasMore: false, total: 2 };
      }
      return { emails: [sentTo(['Cy', 'cy@y.org'])], hasMore: false, total: 1 };
    });
    const client = { getEmails } as unknown as IJMAPClient;
    const folders = [
      { accountId: 'A', mailboxId: 'a-sent' },
      { accountId: 'BAD', mailboxId: 'bad-sent' },
      { accountId: 'C', mailboxId: 'c-sent' },
    ];

    await useContactStore.getState().loadSharedRecentRecipients(client, folders);
    await useContactStore.getState().loadSharedRecentRecipients(client, folders);

    expect(getEmails).toHaveBeenCalledTimes(3);
    expect(getEmails).toHaveBeenCalledWith('a-sent', 'A', 300, 0);
    expect(getEmails).toHaveBeenCalledWith('c-sent', 'C', 300, 0);
    expect(useContactStore.getState().sharedRecentRecipients).toEqual({
      A: [{ name: 'Ann New', email: 'ann@x.org' }, { name: 'Ben', email: 'ben@x.org' }],
      C: [{ name: 'Cy', email: 'cy@y.org' }],
    });
  });

  it('reads the folders one after the other', async () => {
    let inFlight = 0;
    let most = 0;
    const getEmails = vi.fn(async () => {
      inFlight++;
      most = Math.max(most, inFlight);
      await Promise.resolve();
      inFlight--;
      return { emails: [], hasMore: false, total: 0 };
    });
    await useContactStore.getState().loadSharedRecentRecipients({ getEmails } as unknown as IJMAPClient, [
      { accountId: 'A', mailboxId: 'a' }, { accountId: 'B', mailboxId: 'b' },
    ]);
    expect(getEmails).toHaveBeenCalledTimes(2);
    expect(most).toBe(1);
  });

  it('is forgotten on sign-out, so the next session reads again', async () => {
    const getEmails = vi.fn(async () => ({ emails: [sentTo(['Ann', 'ann@x.org'])], hasMore: false, total: 1 }));
    const client = { getEmails } as unknown as IJMAPClient;
    await useContactStore.getState().loadSharedRecentRecipients(client, [{ accountId: 'A', mailboxId: 'a' }]);
    useContactStore.getState().clearContacts();
    expect(useContactStore.getState().sharedRecentRecipients).toEqual({});
    await useContactStore.getState().loadSharedRecentRecipients(client, [{ accountId: 'A', mailboxId: 'a' }]);
    expect(getEmails).toHaveBeenCalledTimes(2);
  });
});

describe('getAutocomplete with a shared sending account', () => {
  beforeEach(() => {
    useContactStore.setState({
      contacts: [contact('c1', 'Anna Contact', 'anna@x.org')],
      directoryPrincipals: [],
      recentRecipients: [{ name: 'Andy Own', email: 'andy@x.org' }],
      sharedRecentRecipients: {
        A: [
          { name: 'Anna From Shared', email: 'ANNA@x.org' },
          { name: 'Andy Shared', email: 'andy@x.org' },
          { name: 'Anton Shared', email: 'anton@x.org' },
        ],
        B: [{ name: 'Anke Other', email: 'anke@x.org' }],
      },
    });
  });
  const emails = (results: Array<{ email: string }>) => results.map((r) => r.email);

  it('adds the recipients of that account after the own ones, without duplicates', () => {
    const results = useContactStore.getState().getAutocomplete('an', { sendingAccountId: 'A' });
    expect(emails(results)).toEqual(['anna@x.org', 'andy@x.org', 'anton@x.org']);
    expect(results.find((r) => r.email === 'andy@x.org')?.name).toBe('Andy Own');
  });

  it('matches on the name too', () => {
    expect(emails(useContactStore.getState().getAutocomplete('anton', { sendingAccountId: 'A' }))).toEqual(['anton@x.org']);
  });

  it('leaves them out for the own account and never mixes in another shared account', () => {
    expect(emails(useContactStore.getState().getAutocomplete('an'))).toEqual(['anna@x.org', 'andy@x.org']);
    expect(emails(useContactStore.getState().getAutocomplete('an', { sendingAccountId: 'B' })))
      .toEqual(['anna@x.org', 'andy@x.org', 'anke@x.org']);
    expect(emails(useContactStore.getState().getAutocomplete('anton', { sendingAccountId: 'B' }))).toEqual([]);
  });

  it('leaves them out while the setting is off', () => {
    useSettingsStore.setState({ sharedSentRecipientSuggestions: false });
    expect(emails(useContactStore.getState().getAutocomplete('an', { sendingAccountId: 'A' }))).toEqual(['anna@x.org', 'andy@x.org']);
  });
});

describe('searchRecipients with a shared sending account', () => {
  function fakeClient(mailboxesByAccount: Record<string, unknown[] | Error>) {
    return {
      getAccountId: () => 'me',
      getEmails: vi.fn(),
      getMailboxes: vi.fn(async (accountId?: string) => {
        const list = mailboxesByAccount[accountId ?? 'me'] ?? [];
        if (list instanceof Error) throw list;
        return list;
      }),
      searchSentRecipients: vi.fn(async (_q: string, mailboxId: string) =>
        mailboxId === 'own-sent'
          ? [{ name: 'Own', email: 'own@x.org' }, { name: 'Both', email: 'both@x.org' }]
          : [{ name: 'Both Shared', email: 'BOTH@x.org' }, { name: 'Shared', email: 'shared@x.org' }]),
    } as unknown as IJMAPClient & { getMailboxes: ReturnType<typeof vi.fn>; searchSentRecipients: ReturnType<typeof vi.fn> };
  }

  it("also searches that account's Sent folder and puts its hits after the own ones", async () => {
    const client = fakeClient({
      A: [
        { id: 'A:inbox', originalId: 'inbox', role: 'inbox', isShared: true, accountId: 'A' },
        { id: 'A:sent', originalId: 'sent-a', role: 'sent', isShared: true, accountId: 'A' },
      ],
    });
    await useContactStore.getState().loadRecentRecipients(client, 'own-sent');

    const results = await useContactStore.getState().searchRecipients(client, 'b', 'A');

    expect(client.searchSentRecipients).toHaveBeenCalledWith('b', 'own-sent');
    expect(client.searchSentRecipients).toHaveBeenCalledWith('b', 'sent-a', 'A');
    expect(results).toEqual([
      { name: 'Own', email: 'own@x.org' },
      { name: 'Both', email: 'both@x.org' },
      { name: 'Shared', email: 'shared@x.org' },
    ]);
  });

  it('searches only the own Sent folder when the shared account has none, or it cannot be read', async () => {
    const own = [{ name: 'Own', email: 'own@x.org' }, { name: 'Both', email: 'both@x.org' }];
    const noSent = fakeClient({ A: [{ id: 'inbox', role: 'inbox', isShared: true, accountId: 'A' }] });
    await useContactStore.getState().loadRecentRecipients(noSent, 'own-sent');
    expect(await useContactStore.getState().searchRecipients(noSent, 'b', 'A')).toEqual(own);
    expect(noSent.searchSentRecipients).toHaveBeenCalledTimes(1);

    const unreadable = fakeClient({ A: new Error('forbidden') });
    await useContactStore.getState().loadRecentRecipients(unreadable, 'own-sent');
    expect(await useContactStore.getState().searchRecipients(unreadable, 'b', 'A')).toEqual(own);
    expect(unreadable.searchSentRecipients).toHaveBeenCalledTimes(1);
  });

  it('searches only the own Sent folder without a sending account', async () => {
    const client = fakeClient({});
    await useContactStore.getState().loadRecentRecipients(client, 'own-sent');
    await useContactStore.getState().searchRecipients(client, 'b');
    expect(client.searchSentRecipients).toHaveBeenCalledTimes(1);
    expect(client.getMailboxes).not.toHaveBeenCalled();
  });
});
