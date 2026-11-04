import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Calendar, Mailbox } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useEmailStore } from '@/stores/email-store';
import { useFilterStore } from '@/stores/filter-store';
import { useSettingsStore } from '@/stores/settings-store';
import { FolderSettings } from '../folder-settings';
import { CalendarManagementSettings } from '../calendar-management-settings';
import { FilterSettings } from '../filter-settings';

// R3: what can't be brought back (a folder, a calendar, its events, a
// subscription, a script typed in the raw editor) is confirmed in one
// ConfirmDialog: "Delete …?", Cancel first, the destructive verb last.
// No inline Delete/Cancel strips.

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('../settings-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings-section')>()),
  SettingsSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const initial = {
  auth: useAuthStore.getState(),
  calendar: useCalendarStore.getState(),
  email: useEmailStore.getState(),
  filter: useFilterStore.getState(),
  settings: useSettingsStore.getState(),
};
afterEach(() => {
  useAuthStore.setState(initial.auth, true);
  useCalendarStore.setState(initial.calendar, true);
  useEmailStore.setState(initial.email, true);
  useFilterStore.setState(initial.filter, true);
  useSettingsStore.setState(initial.settings, true);
});

function confirmDialog() {
  return within(screen.getByRole('alertdialog'));
}

describe('deleting a folder', () => {
  const rights = {
    mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true,
    mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true,
  };
  let deleteMailbox: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    deleteMailbox = vi.fn(async () => true);
    useAuthStore.setState({ client: {} } as never);
    useEmailStore.setState({
      mailboxes: [{ id: 'old', name: 'Old stuff', sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, myRights: rights, isSubscribed: true, isShared: false } as Mailbox],
      fetchMailboxes: vi.fn(),
      deleteMailbox,
    } as never);
  });

  it('asks in a dialog and deletes only on the destructive button', async () => {
    render(<FolderSettings />);
    fireEvent.click(screen.getAllByRole('button', { name: 'delete' })[0]);

    const dialog = confirmDialog();
    expect(dialog.getByText('delete_title')).toBeTruthy();
    const [cancel, confirm] = dialog.getAllByRole('button');
    expect(cancel.textContent).toBe('cancel');
    expect(confirm.textContent).toBe('delete');
    fireEvent.click(cancel);
    expect(deleteMailbox).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole('button', { name: 'delete' })[0]);
    fireEvent.click(confirmDialog().getAllByRole('button')[1]);
    await waitFor(() => expect(deleteMailbox).toHaveBeenCalledWith(expect.anything(), 'old'));
  });
});

describe('deleting a calendar and clearing its events', () => {
  const work = {
    id: 'work', name: 'Work', color: '#3b82f6', isDefault: false, isShared: false, shareWith: null,
    myRights: { mayShare: true, mayDelete: true, mayWriteAll: true },
  } as unknown as Calendar;
  let removeCalendar: ReturnType<typeof vi.fn>;
  let clearCalendarEvents: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    removeCalendar = vi.fn(async () => {});
    clearCalendarEvents = vi.fn(async () => 3);
    useAuthStore.setState({ client: { getAccountId: () => 'acct-1' }, serverUrl: null, username: null } as never);
    useCalendarStore.setState({ calendars: [work], icalSubscriptions: [], removeCalendar, clearCalendarEvents } as never);
  });

  it('confirms a delete in a dialog, not an inline strip', async () => {
    render(<CalendarManagementSettings />);
    // Delete and clear live in the row's ⋮ since pim-20.
    fireEvent.click(screen.getByRole('button', { name: 'row_actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'delete_calendar' }));
    expect(confirmDialog().getByText('delete_title')).toBeTruthy();
    fireEvent.click(confirmDialog().getByRole('button', { name: 'delete' }));
    await waitFor(() => expect(removeCalendar).toHaveBeenCalledWith(expect.anything(), 'work'));
  });

  it('confirms clearing the events in a dialog', async () => {
    render(<CalendarManagementSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'row_actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'clear_all_events' }));
    expect(confirmDialog().getByText('clear_title')).toBeTruthy();
    fireEvent.click(confirmDialog().getByRole('button', { name: 'clear_events' }));
    await waitFor(() => expect(clearCalendarEvents).toHaveBeenCalledWith(expect.anything(), 'work'));
  });
});

describe('resetting the raw script to the visual builder', () => {
  it('asks in a dialog before throwing the script away', async () => {
    const updateSieveScript = vi.fn(async () => {});
    useAuthStore.setState({ client: { updateSieveScript, getSieveAccountId: () => 'primary' } as never });
    useEmailStore.setState({ fetchMailboxes: vi.fn(async () => {}) as never });
    useFilterStore.setState({
      rules: [], rawScript: 'keep;', isSupported: true, isLoading: false, isOpaque: true, activeScriptId: 's1',
      selectedAccountId: 'primary', sieveCapabilities: null, selectAccount: vi.fn(async () => {}),
    });
    render(<FilterSettings />);

    fireEvent.click(screen.getByRole('button', { name: /reset_to_visual/ }));
    expect(useFilterStore.getState().isOpaque).toBe(true);
    expect(confirmDialog().getByText('reset_title')).toBeTruthy();

    fireEvent.click(confirmDialog().getByRole('button', { name: 'confirm_reset' }));
    await waitFor(() => expect(useFilterStore.getState().isOpaque).toBe(false));
  });
});
