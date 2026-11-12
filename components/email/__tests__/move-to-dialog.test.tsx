import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useToastStore } from '@/stores/toast-store';
import { MoveToDialogHost, useChooseMoveFolder, useMoveDialogStore } from '../move-to-dialog';

// "Choose folder…" at the end of a long Move menu opens this dialog: a native
// menu has no filter field, the dialog has one. Without folders of its own,
// a request lists the folders of the login its messages are in.

const box = (id: string, name: string, extra: Partial<Mailbox> = {}) =>
  ({
    id, name, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0,
    myRights: { mayAddItems: true }, isSubscribed: true, accountId: 'A', accountName: 'me@example.org', isShared: false, ...extra,
  }) as Mailbox;

const mailboxes = [box('inbox', 'Inbox', { role: 'inbox' }), box('work', 'Work'), box('travel', 'Travel')];
const email = { id: 'e1', mailboxIds: { inbox: true } } as unknown as Email;
const original = { auth: useAuthStore.getState(), email: useEmailStore.getState() };

beforeEach(() => {
  useEmailStore.setState({ mailboxes, viewingAccountId: null, accountMailboxes: {} } as never);
  useToastStore.setState({ toasts: [] });
});
afterEach(() => {
  act(() => useMoveDialogStore.setState({ request: null }));
  useAuthStore.setState(original.auth);
  useEmailStore.setState(original.email);
});

describe('the Move dialog', () => {
  it('is only offered where a host can show it', () => {
    const without = renderHook(() => useChooseMoveFolder());
    expect(without.result.current).toBeUndefined();
    without.unmount();

    render(<MoveToDialogHost selectedMailbox="inbox" />);
    const withHost = renderHook(() => useChooseMoveFolder());
    expect(withHost.result.current).toBeTypeOf('function');
  });

  it('shows the folders with a filter, and moves to the one picked', () => {
    render(<MoveToDialogHost selectedMailbox="inbox" />);
    const onMove = vi.fn();
    act(() => useMoveDialogStore.getState().open({ emails: [email], onMove }));

    expect(screen.getByTestId('move-to:inbox')).toBeDisabled();
    fireEvent.change(screen.getByTestId('move-filter'), { target: { value: 'tra' } });
    expect(screen.queryByTestId('move-to:work')).toBeNull();
    fireEvent.click(screen.getByTestId('move-to:travel'));

    expect(onMove).toHaveBeenCalledWith('travel');
    expect(useMoveDialogStore.getState().request).toBeNull();
  });

  // A Pro folder tab's reader files within its own account: the dialog lists
  // the folders its Move menu listed, not the ones Mail has open.
  it('lists the folders the asking menu listed, not those of the host', () => {
    render(<MoveToDialogHost selectedMailbox="inbox" />);
    const other = [
      box('inbox', 'Inbox', { role: 'inbox', accountId: 'B' }),
      box('projects', 'Projects', { accountId: 'B' }),
    ];
    const onMove = vi.fn();
    act(() => useMoveDialogStore.getState().open({ emails: [email], onMove, mailboxes: other, selectedMailbox: '' }));

    expect(screen.queryByTestId('move-to:work')).toBeNull();
    expect(screen.queryByTestId('move-to:travel')).toBeNull();
    fireEvent.click(screen.getByTestId('move-to:projects'));
    expect(onMove).toHaveBeenCalledWith('projects');
  });
});

describe('the Move dialog with two logins', () => {
  const theirs = [box('inbox', 'Inbox', { role: 'inbox', accountId: 'B' }), box('work', 'Payroll', { accountId: 'B' })];
  beforeEach(() => {
    const client = { getAccountId: () => 'A' };
    const other = { getAccountId: () => 'B' };
    useAuthStore.setState({
      activeAccountId: 'login-a', client: client as never,
      getClientForAccount: ((id: string) => (id === 'login-a' ? client : id === 'login-b' ? other : undefined)) as never,
    });
  });

  it('lists the folders of the login the message is in, not the active login\'s with the same ids', () => {
    useEmailStore.setState({ viewingAccountId: 'login-b', accountMailboxes: { 'login-b': theirs } } as never);
    render(<MoveToDialogHost selectedMailbox="inbox" />);
    act(() => useMoveDialogStore.getState().open({ emails: [email], onMove: vi.fn() }));
    expect(screen.getByText('Payroll')).toBeInTheDocument();
    expect(screen.queryByText('Work')).toBeNull();
    expect(screen.queryByText('Travel')).toBeNull();
  });

  it('opens nothing for messages of two logins, and says why', () => {
    useEmailStore.setState({ accountMailboxes: { 'login-b': theirs } } as never);
    render(<MoveToDialogHost selectedMailbox="inbox" />);
    const ofB = { ...email, id: 'e2', sourceClientAccountId: 'login-b', sourceAccountId: 'B' } as Email;
    act(() => useMoveDialogStore.getState().open({ emails: [email, ofB], onMove: vi.fn() }));
    expect(screen.queryByTestId('move-dialog')).toBeNull();
    expect(useMoveDialogStore.getState().request).toBeNull();
    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toContain('rules.cross_account');
  });

  it('opens nothing while the login of the message has no folders loaded, and says why', () => {
    useEmailStore.setState({ viewingAccountId: 'login-b', accountMailboxes: {} } as never);
    render(<MoveToDialogHost selectedMailbox="inbox" />);
    act(() => useMoveDialogStore.getState().open({ emails: [email], onMove: vi.fn() }));
    expect(screen.queryByTestId('move-dialog')).toBeNull();
    expect(screen.queryByText('Work')).toBeNull();
    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toContain('not_connected');
  });
});
