import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

type Store = ReturnType<typeof useEmailStore.getState>;

// The routing tests replace it with a spy; the carry-over test needs the real one.
const realCrossAccountMoveEmails = useEmailStore.getState().crossAccountMoveEmails;

function makeMailbox(overrides: Partial<Mailbox>): Mailbox {
  return {
    id: 'inbox',
    name: 'Inbox',
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    myRights: {
      mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true,
      maySetKeywords: true, mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true,
    },
    isSubscribed: true,
    isShared: false,
    ...overrides,
  };
}

function makeEmail(id: string, mailboxServerId: string): Email {
  return {
    id, threadId: `t-${id}`, mailboxIds: { [mailboxServerId]: true }, keywords: {},
    size: 100, receivedAt: new Date().toISOString(),
    from: [{ name: 'X', email: 'x@example.com' }], to: [{ name: 'Y', email: 'y@example.com' }],
    subject: id, preview: '', hasAttachment: false, textBody: [], htmlBody: [], bodyValues: {},
  };
}

// Own account (JMAP acct "jmap-A", reached via local account "local-A") and a
// delegated/shared folder owned by another JMAP account ("jmap-B").
const ownInbox = makeMailbox({ id: 'inbox-A', role: 'inbox', accountId: 'jmap-A', originalId: 'srv-inbox-A' });
const ownArchive = makeMailbox({ id: 'archive-A', role: 'archive', accountId: 'jmap-A', originalId: 'srv-archive-A' });
const sharedTeamA = makeMailbox({ id: 'jmap-B:srv-teamA', name: 'TeamA', accountId: 'jmap-B', originalId: 'srv-teamA', isShared: true });

describe('email-store moveToMailboxCrossAware', () => {
  let crossSpy: ReturnType<typeof vi.fn>;
  let moveSpy: ReturnType<typeof vi.fn>;
  const client = {} as IJMAPClient;

  beforeEach(() => {
    const email = makeEmail('e1', 'srv-inbox-A');
    email.accountId = 'local-A';
    crossSpy = vi.fn().mockResolvedValue(undefined);
    moveSpy = vi.fn().mockResolvedValue(undefined);
    // The login browsed is the active one: its folders are `mailboxes`.
    const loginA = { getAccountId: () => 'jmap-A', getServerUrl: () => 'https://a.example' };
    useAuthStore.setState({
      activeAccountId: 'local-A', client: loginA as never,
      getClientForAccount: ((id: string) => (id === 'local-A' ? loginA : undefined)) as never,
      getAllConnectedClients: (() => new Map([['local-A', loginA]])) as never,
    } as never);
    useEmailStore.setState({
      emails: [email],
      mailboxes: [ownInbox, ownArchive, sharedTeamA],
      selectedMailbox: 'inbox-A',
      viewingAccountId: 'local-A',
      isUnifiedView: false,
      accountMailboxes: {},
      crossAccountMoveEmails: crossSpy as unknown as Store['crossAccountMoveEmails'],
      moveToMailbox: moveSpy as unknown as Store['moveToMailbox'],
    });
  });

  it('routes an own → shared (cross-account) move through crossAccountMoveEmails', async () => {
    await useEmailStore.getState().moveToMailboxCrossAware(client, 'e1', 'jmap-B:srv-teamA');

    expect(moveSpy).not.toHaveBeenCalled();
    // copy into the owner's (jmap-B) TeamA via the viewer's client, using the
    // destination's raw server id; source is own, so no source override.
    expect(crossSpy).toHaveBeenCalledWith(
      new Map([['local-A', ['e1']]]),
      'local-A',
      'srv-teamA',
      'jmap-B',
      undefined,
    );
  });

  it('routes a same-account move through the single-account moveToMailbox', async () => {
    await useEmailStore.getState().moveToMailboxCrossAware(client, 'e1', 'archive-A');

    expect(crossSpy).not.toHaveBeenCalled();
    expect(moveSpy).toHaveBeenCalledWith(client, 'e1', 'archive-A', undefined);
  });

  it('reverse: shared → own also routes cross-account (source override set)', async () => {
    const email = makeEmail('e2', 'srv-teamA');
    email.accountId = 'local-A';
    useEmailStore.setState({ emails: [email], selectedMailbox: 'jmap-B:srv-teamA' });

    await useEmailStore.getState().moveToMailboxCrossAware(client, 'e2', 'inbox-A');

    expect(moveSpy).not.toHaveBeenCalled();
    expect(crossSpy).toHaveBeenCalledWith(
      new Map([['local-A', ['e2']]]),
      'local-A',
      'srv-inbox-A',
      undefined,      // dest (own) not shared
      'jmap-B',       // source shared → override to owner account
    );
  });
});

describe('email-store crossAccountMoveEmails between two servers', () => {
  it('imports the message with every keyword, the Stalwart 1.0 attachment keyword included', async () => {
    const blob = new Blob(['From: x@example.com\r\n\r\nhi']);
    const keywords = { $seen: true, '$label:work': true, $hasattachment: true };
    const source = {
      getEmail: vi.fn().mockResolvedValue({ id: 'e1', blobId: 'blob-1', keywords }),
      fetchBlob: vi.fn().mockResolvedValue(blob),
      deleteEmail: vi.fn().mockResolvedValue(undefined),
    };
    const dest = { importRawEmail: vi.fn().mockResolvedValue('imported-1') };
    useAuthStore.setState({
      activeAccountId: 'login-A',
      getClientForAccount: ((id: string) => (id === 'login-A' ? source : id === 'login-B' ? dest : undefined)) as never,
    } as never);
    useEmailStore.setState({
      emails: [makeEmail('e1', 'srv-inbox-A')],
      crossAccountMoveEmails: realCrossAccountMoveEmails,
      // The background folder refresh after the move is not under test.
      fetchMailboxes: vi.fn().mockResolvedValue(undefined) as unknown as Store['fetchMailboxes'],
      fetchAccountMailboxes: vi.fn().mockResolvedValue(undefined) as unknown as Store['fetchAccountMailboxes'],
    });

    await useEmailStore.getState().crossAccountMoveEmails(new Map([['login-A', ['e1']]]), 'login-B', 'inbox-B');

    expect(dest.importRawEmail).toHaveBeenCalledWith(blob, { 'inbox-B': true }, keywords, undefined, undefined);
    expect(source.deleteEmail).toHaveBeenCalledWith('e1', undefined);
  });
});
