import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import type { Email } from '@/lib/jmap/types';

type Store = ReturnType<typeof useEmailStore.getState>;

function makeEmail(id: string, extra: Partial<Email> = {}): Email {
  return {
    id, threadId: `t-${id}`, mailboxIds: { inbox: true }, keywords: { $seen: true },
    size: 100, receivedAt: new Date().toISOString(), blobId: `blob-${id}`,
    from: [{ name: 'X', email: 'x@example.com' }], to: [{ name: 'Y', email: 'y@example.com' }],
    subject: id, preview: '', hasAttachment: false, textBody: [], htmlBody: [], bodyValues: {},
    ...extra,
  };
}

function makeClient(jmapAccountId: string) {
  return {
    getAccountId: () => jmapAccountId,
    getEmail: vi.fn(async (id: string) => makeEmail(id)),
    fetchBlob: vi.fn(async () => new Blob(['raw'])),
    importRawEmail: vi.fn(async () => 'imported'),
    deleteEmail: vi.fn(async () => {}),
    copyEmailAcrossAccounts: vi.fn(async () => 'copied'),
  };
}

describe('email-store crossAccountMoveEmails keepOriginal', () => {
  let source: ReturnType<typeof makeClient>;
  let dest: ReturnType<typeof makeClient>;

  beforeEach(() => {
    source = makeClient('jmap-A');
    dest = makeClient('jmap-B');
    const clients: Record<string, unknown> = { 'local-A': source, 'local-B': dest };
    useAuthStore.setState({
      activeAccountId: 'local-A',
      getClientForAccount: (id: string) => clients[id] as never,
    } as never);
    const e1 = makeEmail('e1');
    useEmailStore.setState({
      emails: [e1, makeEmail('e2')],
      selectedEmail: e1,
      selectedEmailKeys: new Set(['e1', 'e2']),
      selectedMailbox: 'inbox',
      viewingAccountId: null,
      mailboxes: [],
      accountMailboxes: {},
      error: null,
      fetchMailboxes: vi.fn(async () => {}) as unknown as Store['fetchMailboxes'],
      fetchAccountMailboxes: vi.fn(async () => {}) as unknown as Store['fetchAccountMailboxes'],
    });
  });

  it('a move imports, deletes the source and drops it from the view', async () => {
    await useEmailStore.getState().crossAccountMoveEmails(new Map([['local-A', ['e1']]]), 'local-B', 'dest-inbox');

    expect(dest.importRawEmail).toHaveBeenCalledWith(expect.any(Blob), { 'dest-inbox': true }, { $seen: true }, undefined, expect.any(String));
    expect(source.deleteEmail).toHaveBeenCalledWith('e1', undefined);
    const state = useEmailStore.getState();
    expect(state.emails.map((e) => e.id)).toEqual(['e2']);
    expect(state.selectedEmail).toBeNull();
    expect(state.selectedEmailKeys.has('e1')).toBe(false);
  });

  it('a copy imports but keeps the source, the view and the selection', async () => {
    await useEmailStore.getState().crossAccountMoveEmails(
      new Map([['local-A', ['e1', 'e2']]]), 'local-B', 'dest-inbox', undefined, undefined, { keepOriginal: true },
    );

    expect(dest.importRawEmail).toHaveBeenCalledTimes(2);
    // Each copy keeps its original date instead of arriving as today's mail.
    const e1 = await source.getEmail.mock.results[0].value;
    expect((dest.importRawEmail.mock.calls[0] as unknown[])[4]).toBe(e1.receivedAt);
    expect(source.deleteEmail).not.toHaveBeenCalled();
    const state = useEmailStore.getState();
    expect(state.emails.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(state.selectedEmail?.id).toBe('e1');
    expect([...state.selectedEmailKeys]).toEqual(['e1', 'e2']);
    expect(state.isLoading).toBe(false);
    // Only the destination's folders changed.
    expect(useEmailStore.getState().fetchAccountMailboxes).toHaveBeenCalledWith(dest, 'local-B');
    expect(useEmailStore.getState().fetchMailboxes).not.toHaveBeenCalled();
  });

  it('a copy through one client asks Email/copy to keep the original', async () => {
    await useEmailStore.getState().crossAccountMoveEmails(
      new Map([['local-A', ['e1']]]), 'local-A', 'team-inbox', 'jmap-team', undefined, { keepOriginal: true },
    );
    expect(source.copyEmailAcrossAccounts).toHaveBeenCalledWith('e1', 'jmap-A', 'jmap-team', 'team-inbox', { keepOriginal: true });
  });

  it('a move through one client keeps calling Email/copy without options', async () => {
    await useEmailStore.getState().crossAccountMoveEmails(
      new Map([['local-A', ['e1']]]), 'local-A', 'team-inbox', 'jmap-team',
    );
    expect(source.copyEmailAcrossAccounts).toHaveBeenCalledWith('e1', 'jmap-A', 'jmap-team', 'team-inbox', undefined);
  });

  it('reports a failed copy as a copy', async () => {
    dest.importRawEmail.mockRejectedValueOnce(new Error('overQuota'));
    await expect(useEmailStore.getState().crossAccountMoveEmails(
      new Map([['local-A', ['e1']]]), 'local-B', 'dest-inbox', undefined, undefined, { keepOriginal: true },
    )).rejects.toThrow('Failed to copy email: overQuota');
    expect(useEmailStore.getState().emails).toHaveLength(2);
  });
});

describe('email-store copyEmailsToAccount', () => {
  let crossSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const clients: Record<string, unknown> = { 'local-A': makeClient('jmap-A'), 'local-B': makeClient('jmap-B') };
    useAuthStore.setState({
      activeAccountId: 'local-A',
      getClientForAccount: (id: string) => clients[id] as never,
    } as never);
    crossSpy = vi.fn().mockResolvedValue(undefined);
    useEmailStore.setState({
      emails: [
        makeEmail('e1'),
        makeEmail('e2', { sourceClientAccountId: 'local-B', sourceAccountId: 'jmap-B' }),
      ],
      selectedEmail: null,
      selectedMailbox: 'inbox',
      viewingAccountId: null,
      mailboxes: [],
      accountMailboxes: {},
      error: null,
      crossAccountMoveEmails: crossSpy as unknown as Store['crossAccountMoveEmails'],
    });
  });

  it('copies through crossAccountMoveEmails with keepOriginal', async () => {
    await useEmailStore.getState().copyEmailsToAccount(['e1'], 'local-B', 'dest-inbox');
    expect(crossSpy).toHaveBeenCalledWith(
      new Map([['local-A', ['e1']]]), 'local-B', 'dest-inbox', undefined, undefined, { keepOriginal: true },
    );
  });

  it('refuses to copy messages into the account they are in', async () => {
    await expect(useEmailStore.getState().copyEmailsToAccount(['e1', 'e2'], 'local-B', 'dest-inbox'))
      .rejects.toThrow('already in that account');
    expect(crossSpy).not.toHaveBeenCalled();
  });
});
