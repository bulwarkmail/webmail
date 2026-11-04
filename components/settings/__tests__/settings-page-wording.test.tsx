import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressBook, Calendar } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useContactStore } from '@/stores/contact-store';
import { useThemeStore } from '@/stores/theme-store';
import { ThemesSettings } from '../themes-settings';
import { AddressBookManagementSettings } from '../address-book-management-settings';
import { CalendarManagementSettings } from '../calendar-management-settings';
import { FilesSettingsComponent } from '../files-settings';
import { DownloadsSettings } from '../downloads-settings';

// Usability pass 2026-11-04, settings-11, -33 and -36: settings pages showed
// the server's names ("Stalwart Calendar (me@example.org)"), a raw CalDAV
// address on every calendar, English sample text in every language and a
// "Default" badge on the theme called Default. vitest.setup.ts renders
// strings as their raw keys.

vi.mock('../settings-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings-section')>()),
  SettingsSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const initial = {
  auth: useAuthStore.getState(),
  contacts: useContactStore.getState(),
  calendars: useCalendarStore.getState(),
};
afterEach(() => {
  useAuthStore.setState(initial.auth, true);
  useContactStore.setState(initial.contacts, true);
  useCalendarStore.setState(initial.calendars, true);
  vi.restoreAllMocks();
});

describe('theme gallery', () => {
  beforeEach(() => {
    act(() => {
      useThemeStore.setState({ activeThemeId: null, syncServerThemes: vi.fn().mockResolvedValue(undefined) });
    });
  });

  it('puts no "Default" badge on the theme that is called Default', () => {
    render(<ThemesSettings embedded />);
    const card = document.querySelector('[data-search-label="default_name"]') as HTMLElement;
    expect(card).toBeTruthy();
    expect(within(card).queryByText('default_badge')).toBeNull();
  });
});

describe('server default names', () => {
  const rights = { mayRead: true, mayWrite: true, mayShare: true, mayDelete: true };

  it('shows the address book Stalwart made as "Contacts", and a chosen name as it is', () => {
    useAuthStore.setState({ client: { getAccountId: () => 'acc' } } as never);
    useContactStore.setState({
      addressBooks: [
        { id: 'd', name: 'Stalwart Address Book (me@example.org)', isDefault: true, isShared: false, myRights: rights, shareWith: null },
        { id: 'c', name: 'Club', isDefault: false, isShared: false, myRights: rights, shareWith: null },
      ] as unknown as AddressBook[],
      contacts: [],
      supportsSync: true,
      fetchAddressBooks: vi.fn(async () => {}),
    } as never);
    render(<AddressBookManagementSettings />);
    expect(screen.getByText('default_address_book')).toBeInTheDocument();
    expect(screen.getByText('Club')).toBeInTheDocument();
    expect(screen.queryByText(/Stalwart Address Book/)).toBeNull();
  });

  it('shows the calendar Stalwart made as "Calendar" and keeps its name when saved unchanged', async () => {
    const updateCalendar = vi.fn().mockResolvedValue(undefined);
    useAuthStore.setState({ client: { getAccountId: () => 'acct-1' }, serverUrl: null, username: null } as never);
    useCalendarStore.setState({
      calendars: [{
        id: 'cal', name: 'Stalwart Calendar (me@example.org)', color: '#3b82f6', isDefault: true, isShared: false, shareWith: null,
        myRights: { mayShare: true, mayDelete: true, mayWriteAll: true },
      } as unknown as Calendar],
      icalSubscriptions: [],
      updateCalendar,
    } as never);
    render(<CalendarManagementSettings />);
    expect(screen.getByText('default_calendar')).toBeInTheDocument();
    expect(screen.queryByText(/Stalwart Calendar/)).toBeNull();

    fireEvent.click(screen.getByTitle('edit'));
    fireEvent.click(screen.getByText('save'));
    await vi.waitFor(() => expect(updateCalendar).toHaveBeenCalledTimes(1));
    expect(updateCalendar.mock.calls[0][2]).toEqual({ name: 'Stalwart Calendar (me@example.org)' });
  });
});

describe('calendar address for other apps', () => {
  it('keeps the CalDAV address behind "Use in other apps"', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 502 }));
    useAuthStore.setState({
      client: { getAccountId: () => 'acct-1' }, serverUrl: 'https://host.example/', username: 'alice@example.com',
    } as never);
    useCalendarStore.setState({
      calendars: [{
        id: 'cal', name: 'Home', color: '#3b82f6', isDefault: true, isShared: false, shareWith: null,
        myRights: { mayShare: true, mayDelete: true, mayWriteAll: true },
      } as unknown as Calendar],
      icalSubscriptions: [],
      updateCalendar: vi.fn(),
    } as never);
    render(<CalendarManagementSettings />);

    const button = await screen.findByTestId('calendar-use-in-other-apps');
    expect(button).toHaveTextContent('use_in_other_apps');
    expect(screen.queryByText('https://host.example/.well-known/caldav')).toBeNull();
    fireEvent.click(button);
    expect(screen.getByText('https://host.example/.well-known/caldav')).toBeInTheDocument();
  });
});

describe('previews in the user language', () => {
  it('labels the Files preview through the translations', () => {
    render(<FilesSettingsComponent />);
    for (const key of ['name', 'size', 'modified', 'preview_documents', 'preview_photos']) {
      expect(screen.getAllByText(key).length).toBeGreaterThan(0);
    }
    expect(screen.queryByText('Documents')).toBeNull();
    expect(screen.queryByText('Modified')).toBeNull();
  });

  it('builds the file name preview from a translated sample subject', () => {
    render(<DownloadsSettings />);
    expect(document.body.textContent).toContain('sample_subject');
    expect(document.body.textContent).not.toContain('Benachrichtigung');
  });
});
