import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Email } from '@/lib/jmap/types';
import type { AccountEntry } from '@/stores/account-store';

const mocks = vi.hoisted(() => {
  const source = { getAccountId: () => 'source-owner', getMailboxes: vi.fn() };
  const destination = { getAccountId: () => 'destination-owner', getMailboxes: vi.fn() };
  const clients: Record<string, typeof source> = { source, destination };
  const auth = { activeAccountId: 'source', client: null, getClientForAccount: (id: string) => clients[id] };
  const email = { viewingAccountId: null as string | null, mailboxes: [] as { id: string; isShared?: boolean; accountId?: string }[],
    accountMailboxes: {} as Record<string, { id: string; isShared?: boolean; accountId?: string }[]>, selectedMailbox: 'inbox' };
  return { source, destination, clients, auth, email, collect: vi.fn(), transfer: vi.fn() };
});
vi.mock('next-intl', () => {
  const translate = (key: string) => key;
  return { useTranslations: () => translate };
});
vi.mock('@/stores/auth-store', () => ({ useAuthStore: Object.assign((selector: (s: typeof mocks.auth) => unknown) => selector(mocks.auth), { getState: () => mocks.auth }) }));
vi.mock('@/stores/email-store', () => ({ useEmailStore: { getState: () => mocks.email } }));
vi.mock('@/lib/account-state-manager', () => ({ evictAccount: vi.fn() }));
vi.mock('@/lib/email-transfer', () => ({ collectTransferMessages: mocks.collect, transferMessages: mocks.transfer }));
import { useAccountStore } from '@/stores/account-store';
import { AccountTransferDialog, resolveTransferSelection } from '../account-transfer-dialog';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.activeAccountId = 'source';
  mocks.email.viewingAccountId = null;
  mocks.email.mailboxes = [];
  mocks.email.accountMailboxes = {};
  mocks.source.getMailboxes.mockResolvedValue([{ id: 'inbox', name: 'Inbox' }]);
  mocks.destination.getMailboxes.mockResolvedValue([
    { id: 'dest-inbox', name: 'Destination Inbox', role: 'inbox', myRights: { mayAddItems: true } },
    { id: 'read-only', name: 'Read only', myRights: { mayAddItems: false } },
  ]);
  useAccountStore.setState({ accounts: ['source', 'destination', 'offline'].map(id => ({
    id, email: `${id}@example.test`, username: id, isConnected: id !== 'offline',
  } as AccountEntry)) });
});

describe('transfer dialog', () => {
  it('excludes source, disables offline accounts, and requires review before copying', async () => {
    const messages = [{ id: 'e1', client: mocks.source, accountId: 'source-owner', localAccountId: 'source' }];
    mocks.collect.mockResolvedValue(messages);
    mocks.transfer.mockResolvedValue({ total: 1, completed: 1, copied: 1, moved: 0 });
    render(<AccountTransferDialog onClose={vi.fn()} />);
    const destination = screen.getByLabelText('destination');
    expect(within(destination).queryByText('source@example.test')).not.toBeInTheDocument();
    expect(within(destination).getByText('offline@example.test (offline)')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'prepare' })).toBeDisabled();
    fireEvent.change(destination, { target: { value: 'destination' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'prepare' })).toBeEnabled());
    expect(screen.queryByText('Read only')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'prepare' }));
    await screen.findByRole('button', { name: 'confirm_copy' });
    expect(mocks.collect).toHaveBeenCalledWith(mocks.source, 'source', undefined, expect.any(AbortSignal));
    expect(mocks.transfer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'confirm_copy' }));
    await screen.findByText('complete');
    expect(mocks.transfer).toHaveBeenCalledWith(expect.objectContaining({ messages, destination: mocks.destination, mailboxId: 'dest-inbox', mode: 'copy' }));
  });
  it('reports that both copies remain after a failed source deletion', async () => {
    mocks.collect.mockResolvedValue([{ id: 'e1', client: mocks.source, accountId: 'source-owner', localAccountId: 'source' }]);
    mocks.transfer.mockResolvedValue({ total: 1, completed: 0, copied: 1, moved: 0, failure: { emailId: 'e1', copied: true, message: 'forbidden' } });
    render(<AccountTransferDialog onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('destination'), { target: { value: 'destination' } });
    fireEvent.click(screen.getByRole('radio', { name: /^move$/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'prepare' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'prepare' }));
    fireEvent.click(await screen.findByRole('button', { name: 'confirm_move' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('delete_failed');
    expect(screen.getByText('stopped')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'confirm_move' })).not.toBeInTheDocument();
  });
  it('deduplicates messages present in both the list and expanded conversation cache', () => {
    const email = { id: 'e1' } as Email;
    const cached = { ...email, sourceClientAccountId: 'source', sourceAccountId: 'source-owner' };
    expect(resolveTransferSelection([email, cached])).toHaveLength(1);
    expect(resolveTransferSelection([cached, { ...cached, sourceClientAccountId: 'destination' }])).toHaveLength(2);
  });
  it('resolves shared and unified message owners without falling back to the active account', () => {
    const email = { id: 'e1', sourceClientAccountId: 'destination', sourceAccountId: 'shared-owner' } as Email;
    expect(resolveTransferSelection([email])[0]).toMatchObject({ client: mocks.destination, accountId: 'shared-owner', localAccountId: 'destination' });
    expect(() => resolveTransferSelection([{ ...email, sourceClientAccountId: 'missing' }])).toThrow('disconnected');
    mocks.email.mailboxes = [{ id: 'inbox', isShared: true, accountId: 'delegated-owner' }];
    expect(resolveTransferSelection([{ id: 'e2' } as Email])[0].accountId).toBe('delegated-owner');
  });
});
