import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import type { Email, Mailbox } from '@/lib/jmap/types';

// #1888: Copy to a folder of the message's own login, the login's own
// folders and the shared accounts' (a team mailbox), keeping the original.

type Store = ReturnType<typeof useEmailStore.getState>;

function makeEmail(id: string, extra: Partial<Email> = {}): Email {
  return {
    id, threadId: `t-${id}`, mailboxIds: { inbox: true }, keywords: { $seen: true },
    size: 100, receivedAt: '2026-11-20T10:00:00Z', blobId: `blob-${id}`,
    from: [{ name: 'X', email: 'x@example.com' }], to: [{ name: 'Y', email: 'y@example.com' }],
    subject: id, preview: '', hasAttachment: false, textBody: [], htmlBody: [], bodyValues: {},
    ...extra,
  };
}

const folder = (id: string, accountId: string, extra: Partial<Mailbox> = {}) => ({
  id, name: id, role: undefined, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0,
  isSubscribed: true, accountId, ...extra,
}) as unknown as Mailbox;

const own = [folder('inbox', 'jmap-A', { role: 'inbox' }), folder('projects', 'jmap-A')];
// The team's folders, reached through the same login: namespaced ids.
const team = [
  folder('jmap-team:t-inbox', 'jmap-team', { isShared: true, originalId: 't-inbox', role: 'inbox' }),
  folder('jmap-team:t-sub', 'jmap-team', { isShared: true, originalId: 't-sub' }),
];

let client: {
  getAccountId: () => string;
  getServerUrl: () => string;
  addEmailToMailbox: ReturnType<typeof vi.fn>;
  copyEmailAcrossAccounts: ReturnType<typeof vi.fn>;
  moveEmail: ReturnType<typeof vi.fn>;
  deleteEmail: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  client = {
    getAccountId: () => 'jmap-A',
    getServerUrl: () => 'https://mail.example.com',
    addEmailToMailbox: vi.fn(async () => {}),
    copyEmailAcrossAccounts: vi.fn(async () => 'copied'),
    moveEmail: vi.fn(async () => {}),
    deleteEmail: vi.fn(async () => {}),
  };
  useAuthStore.setState({
    activeAccountId: 'local-A',
    client: client as never,
    getClientForAccount: (id: string) => (id === 'local-A' ? client : undefined) as never,
    getAllConnectedClients: () => new Map([['local-A', client]]) as never,
  } as never);
  const e1 = makeEmail('e1');
  useEmailStore.setState({
    emails: [e1, makeEmail('e2')],
    selectedEmail: e1,
    selectedEmailKeys: new Set(),
    selectedMailbox: 'inbox',
    viewingAccountId: null,
    mailboxes: [...own, ...team],
    accountMailboxes: {},
    error: null,
    fetchMailboxes: vi.fn(async () => {}) as unknown as Store['fetchMailboxes'],
    fetchAccountMailboxes: vi.fn(async () => {}) as unknown as Store['fetchAccountMailboxes'],
  });
});

describe('copyToFolder (#1888)', () => {
  it("copies into a team mailbox's folder with Email/copy, keeping the original", async () => {
    const e1 = useEmailStore.getState().emails[0];
    await useEmailStore.getState().copyToFolder([e1], 'jmap-team:t-sub');
    expect(client.copyEmailAcrossAccounts).toHaveBeenCalledWith('e1', 'jmap-A', 'jmap-team', 't-sub', { keepOriginal: true });
    expect(client.deleteEmail).not.toHaveBeenCalled();
    expect(client.moveEmail).not.toHaveBeenCalled();
    const state = useEmailStore.getState();
    expect(state.emails.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(state.selectedEmail?.id).toBe('e1');
  });

  it('puts it in another folder of the same account too, and the row says so', async () => {
    const e1 = useEmailStore.getState().emails[0];
    await useEmailStore.getState().copyToFolder([e1], 'projects');
    expect(client.addEmailToMailbox).toHaveBeenCalledWith('e1', 'projects', undefined);
    expect(client.copyEmailAcrossAccounts).not.toHaveBeenCalled();
    expect(client.moveEmail).not.toHaveBeenCalled();
    const state = useEmailStore.getState();
    expect(state.emails[0].mailboxIds).toEqual({ inbox: true, projects: true });
    expect(state.selectedEmail?.mailboxIds).toEqual({ inbox: true, projects: true });
    expect(state.emails[1].mailboxIds).toEqual({ inbox: true });
    expect(state.fetchMailboxes).toHaveBeenCalledWith(client);
  });

  it("copies from a team mailbox into the user's own folder", async () => {
    const shared = makeEmail('s1', { mailboxIds: { 't-inbox': true } });
    useEmailStore.setState({ emails: [shared], selectedEmail: shared, selectedMailbox: 'jmap-team:t-inbox' });
    await useEmailStore.getState().copyToFolder([shared], 'projects');
    expect(client.copyEmailAcrossAccounts).toHaveBeenCalledWith('s1', 'jmap-team', 'jmap-A', 'projects', { keepOriginal: true });
    expect(client.addEmailToMailbox).not.toHaveBeenCalled();
  });

  it("adds a team folder within the team's own account", async () => {
    const shared = makeEmail('s1', { mailboxIds: { 't-inbox': true } });
    useEmailStore.setState({ emails: [shared], selectedEmail: shared, selectedMailbox: 'jmap-team:t-inbox' });
    await useEmailStore.getState().copyToFolder([shared], 'jmap-team:t-sub');
    expect(client.addEmailToMailbox).toHaveBeenCalledWith('s1', 't-sub', 'jmap-team');
    expect(client.copyEmailAcrossAccounts).not.toHaveBeenCalled();
  });

  it("refuses a folder that isn't among the login's folders", async () => {
    const e1 = useEmailStore.getState().emails[0];
    await expect(useEmailStore.getState().copyToFolder([e1], 'nowhere')).rejects.toThrow();
    expect(client.addEmailToMailbox).not.toHaveBeenCalled();
    expect(client.copyEmailAcrossAccounts).not.toHaveBeenCalled();
  });
});
