import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';
import { buildMoveMenu } from '@/lib/move-menu';
import { readRecentMoveTargets } from '@/lib/move-recent';
import { MoveFolderList } from '../move-target-list';

// The Move lists show the names the sidebar shows (Stalwart's "Sent Items" /
// "Junk Mail" are Sent and Spam, in the user's language), nest subfolders,
// and get a filter field once they're long.

const writable = { mayAddItems: true } as Mailbox['myRights'];
const box = (id: string, name: string, extra: Partial<Mailbox> = {}) =>
  ({
    id, name, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0,
    myRights: writable, isSubscribed: true, accountId: 'A', accountName: 'me@example.org', isShared: false, ...extra,
  }) as Mailbox;

const short = [
  box('inbox', 'Inbox', { role: 'inbox' }),
  box('sent', 'Sent Items', { role: 'sent' }),
  box('junk', 'Junk Mail', { role: 'junk' }),
  box('archive', 'Archive', { role: 'archive' }),
  box('y2025', '2025', { parentId: 'archive' }),
];

const long = [
  ...short,
  ...Array.from({ length: 12 }, (_, i) => box(`f${i}`, `Folder ${i}`)),
  box('acme', 'Acme', { parentId: 'f3' }),
];

afterEach(() => localStorage.clear());

describe('MoveFolderList', () => {
  it('shows the localized folder names and moves on a pick', () => {
    const onPick = vi.fn();
    render(<MoveFolderList model={buildMoveMenu(short, { currentMailboxId: 'inbox' })} onPick={onPick} />);
    // The i18n mock returns the key: the role's name, not the server's.
    expect(screen.queryByText('Junk Mail')).toBeNull();
    expect(screen.getByText('mailboxes.archive')).toBeTruthy();
    // Sent is no Move target (pass 2 p2-18).
    expect(screen.queryByText('mailboxes.sent')).toBeNull();
    fireEvent.click(screen.getByText('mailboxes.spam'));
    expect(onPick).toHaveBeenCalledWith('junk');
  });

  it('greys the open folder and keeps the pick as a recent folder', () => {
    const onPick = vi.fn();
    render(<MoveFolderList model={buildMoveMenu(short, { currentMailboxId: 'inbox' })} onPick={onPick} />);
    expect(screen.getByTestId('move-to:inbox')).toBeDisabled();
    fireEvent.click(screen.getByTestId('move-to:inbox'));
    expect(onPick).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('move-to:y2025'));
    expect(readRecentMoveTargets('A')).toEqual(['y2025']);
  });

  it('puts recent folders at the top, with where they live', () => {
    render(
      <MoveFolderList
        model={buildMoveMenu(short, { currentMailboxId: 'inbox', recentIds: () => ['y2025'] })}
        onPick={vi.fn()}
      />,
    );
    expect(screen.getByText('recent')).toBeTruthy();
    expect(screen.getByText('Archive / 2025')).toBeTruthy();
  });

  it('nests subfolders in a group the desktop app makes a submenu of', () => {
    render(<MoveFolderList model={buildMoveMenu(short, {})} onPick={vi.fn()} />);
    const group = screen.getByTestId('move-to:archive').closest('[data-native-submenu]')!;
    expect(group).not.toBeNull();
    expect(group.contains(screen.getByTestId('move-to:y2025'))).toBe(true);
  });

  it('has no filter while short', () => {
    render(<MoveFolderList model={buildMoveMenu(short, {})} onPick={vi.fn()} onChooseFolder={vi.fn()} />);
    expect(screen.queryByTestId('move-filter')).toBeNull();
    expect(screen.queryByTestId('move-choose-folder')).toBeNull();
  });

  it('a long list gets a filter that keeps the folders above a match, and Enter moves to the first', () => {
    const onPick = vi.fn();
    const onChooseFolder = vi.fn();
    render(<MoveFolderList model={buildMoveMenu(long, {})} onPick={onPick} onChooseFolder={onChooseFolder} />);
    fireEvent.click(screen.getByTestId('move-choose-folder'));
    expect(onChooseFolder).toHaveBeenCalled();

    const filter = screen.getByTestId('move-filter');
    fireEvent.change(filter, { target: { value: 'acm' } });
    expect(screen.getByTestId('move-to:f3')).toBeTruthy();
    expect(screen.getByTestId('move-to:acme')).toBeTruthy();
    expect(screen.queryByTestId('move-to:f4')).toBeNull();
    fireEvent.keyDown(filter, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('f3');

    fireEvent.change(filter, { target: { value: 'nothing like it' } });
    expect(screen.getByText('no_match')).toBeTruthy();
  });

  it('indents subfolders on the reading side in the phone panel', () => {
    render(<MoveFolderList variant="panel" model={buildMoveMenu(short, {})} onPick={vi.fn()} />);
    const row = screen.getByTestId('move-to:y2025');
    expect(row.parentElement!.className).toContain('ps-6');
  });
});
