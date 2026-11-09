import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { MoveToDialogHost, useChooseMoveFolder, useMoveDialogStore } from '../move-to-dialog';

// "Choose folder…" at the end of a long Move menu opens this dialog: a native
// menu has no filter field, the dialog has one.

const box = (id: string, name: string, extra: Partial<Mailbox> = {}) =>
  ({
    id, name, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0,
    myRights: { mayAddItems: true }, isSubscribed: true, accountId: 'A', accountName: 'me@example.org', isShared: false, ...extra,
  }) as Mailbox;

const mailboxes = [box('inbox', 'Inbox', { role: 'inbox' }), box('work', 'Work'), box('travel', 'Travel')];
const email = { id: 'e1', mailboxIds: { inbox: true } } as unknown as Email;

afterEach(() => {
  act(() => useMoveDialogStore.setState({ request: null }));
});

describe('the Move dialog', () => {
  it('is only offered where a host can show it', () => {
    const without = renderHook(() => useChooseMoveFolder());
    expect(without.result.current).toBeUndefined();
    without.unmount();

    render(<MoveToDialogHost mailboxes={mailboxes} selectedMailbox="inbox" />);
    const withHost = renderHook(() => useChooseMoveFolder());
    expect(withHost.result.current).toBeTypeOf('function');
  });

  it('shows the folders with a filter, and moves to the one picked', () => {
    render(<MoveToDialogHost mailboxes={mailboxes} selectedMailbox="inbox" />);
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
    render(<MoveToDialogHost mailboxes={mailboxes} selectedMailbox="inbox" />);
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
