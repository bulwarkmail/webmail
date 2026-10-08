import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FolderSettings } from '../folder-settings';
import { useEmailStore } from '@/stores/email-store';
import { useAuthStore } from '@/stores/auth-store';
import type { Mailbox } from '@/lib/jmap/types';

// #1173: tick several folders (Shift+click for a range) and move them under
// one parent in a single step.

vi.mock('../settings-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings-section')>()),
  SettingsSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

function makeMailbox(overrides: Partial<Mailbox>): Mailbox {
  return {
    id: 'mb',
    name: 'Folder',
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    myRights: {
      mayReadItems: true,
      mayAddItems: true,
      mayRemoveItems: true,
      maySetSeen: true,
      maySetKeywords: true,
      mayCreateChild: true,
      mayRename: true,
      mayDelete: true,
      maySubmit: true,
    },
    isSubscribed: true,
    isShared: false,
    ...overrides,
  } as Mailbox;
}

const client = {};
let moveMailboxes: ReturnType<typeof vi.fn>;

// The folder name appears in the row and in the role dropdowns; the row's
// label is the span next to the checkbox.
function rowFor(name: string): HTMLElement {
  const label = screen.getAllByText(name).find(el => el.tagName === 'SPAN')!;
  return label.parentElement!;
}

const checkboxFor = (name: string) => within(rowFor(name)).getByRole('checkbox');
const isTicked = (name: string) => checkboxFor(name).getAttribute('aria-checked') === 'true';

function destinationOptions(): string[] {
  const select = screen.getByRole('combobox', { name: 'move_to' });
  return within(select).getAllByRole('option').map(o => (o as HTMLOptionElement).value);
}

describe('FolderSettings bulk move (#1173)', () => {
  beforeEach(() => {
    moveMailboxes = vi.fn().mockResolvedValue([]);
    useAuthStore.setState({ client } as never);
    useEmailStore.setState({
      mailboxes: [
        makeMailbox({ id: 'inbox', name: 'Inbox', role: 'inbox' }),
        makeMailbox({ id: 'a1', name: 'A1' }),
        makeMailbox({ id: 'a2', name: 'A2' }),
        makeMailbox({ id: 'a2-child', name: 'A2 child', parentId: 'a2' }),
        makeMailbox({ id: 'a3', name: 'A3' }),
        makeMailbox({ id: 'a4', name: 'A4' }),
        makeMailbox({ id: 'old', name: 'Old mailbox' }),
      ],
      fetchMailboxes: vi.fn(),
      moveMailboxes,
    } as never);
  });

  it('ticks the visible range on Shift+click', () => {
    render(<FolderSettings />);
    expect(screen.queryByRole('combobox', { name: 'move_to' })).toBeNull();

    fireEvent.click(checkboxFor('A1'));
    fireEvent.click(checkboxFor('A3'), { shiftKey: true });

    expect(['A1', 'A2', 'A3'].map(isTicked)).toEqual([true, true, true]);
    expect(['Inbox', 'A4', 'Old mailbox'].map(isTicked)).toEqual([false, false, false]);
    expect(screen.getByText('selected_count')).toBeTruthy();
  });

  it('unticks the range when the Shift+clicked folder was ticked', () => {
    render(<FolderSettings />);

    fireEvent.click(checkboxFor('A1'));
    fireEvent.click(checkboxFor('A4'), { shiftKey: true });
    fireEvent.click(checkboxFor('A3'));
    fireEvent.click(checkboxFor('A2'), { shiftKey: true });

    expect(['A1', 'A2', 'A3', 'A4'].map(isTicked)).toEqual([true, false, false, true]);
  });

  it('moves the ticked folders and leaves them out of the destinations', async () => {
    render(<FolderSettings />);

    fireEvent.click(checkboxFor('A1'));
    fireEvent.click(checkboxFor('A3'), { shiftKey: true });

    // A2's child would put A2 inside itself.
    expect(destinationOptions()).toEqual(['', '__top__', 'inbox', 'a4', 'old']);

    fireEvent.change(screen.getByRole('combobox', { name: 'move_to' }), { target: { value: 'old' } });
    fireEvent.click(screen.getByRole('button', { name: 'move' }));

    await waitFor(() => expect(moveMailboxes).toHaveBeenCalledWith(client, ['a1', 'a2', 'a3'], 'old'));
    await waitFor(() => expect(isTicked('A1')).toBe(false));
  });

  it('moves a ticked subfolder together with its ticked parent', async () => {
    render(<FolderSettings />);

    fireEvent.click(within(rowFor('A2')).getAllByRole('button')[0]); // expand
    fireEvent.click(checkboxFor('A2'));
    fireEvent.click(checkboxFor('A2 child'));
    fireEvent.change(screen.getByRole('combobox', { name: 'move_to' }), { target: { value: 'old' } });
    fireEvent.click(screen.getByRole('button', { name: 'move' }));

    await waitFor(() => expect(moveMailboxes).toHaveBeenCalledWith(client, ['a2'], 'old'));
  });

  it('keeps the refused folders ticked', async () => {
    moveMailboxes.mockResolvedValue(['a2']);
    render(<FolderSettings />);

    fireEvent.click(checkboxFor('A1'));
    fireEvent.click(checkboxFor('A2'), { shiftKey: true });
    fireEvent.change(screen.getByRole('combobox', { name: 'move_to' }), { target: { value: '__top__' } });
    fireEvent.click(screen.getByRole('button', { name: 'move' }));

    // Both are already top-level, so nothing needs to move.
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'move_to' })).toBeNull());
    expect(moveMailboxes).not.toHaveBeenCalled();

    fireEvent.click(checkboxFor('A1'));
    fireEvent.click(checkboxFor('A2'), { shiftKey: true });
    fireEvent.change(screen.getByRole('combobox', { name: 'move_to' }), { target: { value: 'old' } });
    fireEvent.click(screen.getByRole('button', { name: 'move' }));

    await waitFor(() => expect(moveMailboxes).toHaveBeenCalledWith(client, ['a1', 'a2'], 'old'));
    await waitFor(() => expect(isTicked('A1')).toBe(false));
    expect(isTicked('A2')).toBe(true);
  });
});
