import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CalendarManagementSettings } from '../calendar-management-settings';
import { useCalendarStore } from '@/stores/calendar-store';
import { useAuthStore } from '@/stores/auth-store';
import { CALENDAR_COLORS } from '@/lib/shared-calendar-colors';
import type { Calendar } from '@/lib/jmap/types';

// Stalwart 1.0 accepts a calendar colour only as #rgb, #rrggbb or a CSS name
// (calendar/set.rs); 0.16 took anything shorter than 16 characters. Renaming
// a calendar another client coloured with an 8-digit hex (Apple Calendar)
// sent that colour back and failed on 1.0.

vi.mock('../settings-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings-section')>()),
  SettingsSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const appleColored = {
  id: 'cal', name: 'Home', color: '#FF2968FF', isDefault: true, isShared: false, shareWith: null,
  myRights: { mayShare: true, mayDelete: true, mayWriteAll: true },
} as unknown as Calendar;

describe('CalendarManagementSettings rename', () => {
  let updateCalendar: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    updateCalendar = vi.fn().mockResolvedValue(undefined);
    // No server URL: the CalDAV discovery stays out of it.
    useAuthStore.setState({ client: { getAccountId: () => 'acct-1' }, serverUrl: null, username: null } as never);
    useCalendarStore.setState({ calendars: [appleColored], icalSubscriptions: [], updateCalendar } as never);
  });

  function openEditor() {
    render(<CalendarManagementSettings />);
    fireEvent.click(screen.getByTitle('edit'));
  }

  it('sends the new name without the colour it did not change, for Stalwart 1.0', async () => {
    openEditor();
    fireEvent.change(screen.getByDisplayValue('Home'), { target: { value: 'Family' } });
    fireEvent.click(screen.getByText('save'));

    await waitFor(() => expect(updateCalendar).toHaveBeenCalledTimes(1));
    expect(updateCalendar.mock.calls[0].slice(1)).toEqual(['cal', { name: 'Family' }]);
  });

  it('sends a colour the user picked', async () => {
    openEditor();
    fireEvent.click(screen.getByLabelText(CALENDAR_COLORS[0]));
    fireEvent.click(screen.getByText('save'));

    await waitFor(() => expect(updateCalendar).toHaveBeenCalledTimes(1));
    expect(updateCalendar.mock.calls[0].slice(1)).toEqual(['cal', { name: 'Home', color: CALENDAR_COLORS[0] }]);
  });
});

// When discovery fails, the CalDAV address falls back to the server's
// well-known path. Built from the origin, it dropped the path of a server
// mounted below the root (https://host/stalwart).
describe('CalendarManagementSettings CalDAV fallback address', () => {
  it('keeps the path of a server mounted below the root', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 502 }));
    useAuthStore.setState({
      client: { getAccountId: () => 'acct-1' }, serverUrl: 'https://host.example/stalwart/', username: 'alice@example.com',
    } as never);
    useCalendarStore.setState({ calendars: [appleColored], icalSubscriptions: [], updateCalendar: vi.fn() } as never);

    render(<CalendarManagementSettings />);

    // The address waits behind "Use in other apps" (usability pass 2026-11-04).
    fireEvent.click(await screen.findByTestId('calendar-use-in-other-apps'));
    const url = await screen.findByText('https://host.example/stalwart/.well-known/caldav');
    // Left to right in Arabic too: the start of the address stays in view.
    expect(url).toHaveAttribute('dir', 'ltr');
    vi.restoreAllMocks();
  });

  it('shows a subscription address left to right', () => {
    useAuthStore.setState({ client: { getAccountId: () => 'acct-1' }, serverUrl: null, username: null } as never);
    useCalendarStore.setState({
      calendars: [appleColored],
      icalSubscriptions: [{ id: 's', name: 'Holidays', url: 'https://example.com/holidays.ics', color: '#ff0000', calendarId: 'x' }],
      updateCalendar: vi.fn(),
    } as never);
    render(<CalendarManagementSettings />);
    expect(screen.getByText('https://example.com/holidays.ics')).toHaveAttribute('dir', 'ltr');
  });
});

// Phone: seven icons in a row hid the calendar names. The row actions are
// also in a ⋮ menu (right-click too), the same list as the icons, and every
// icon is a named button with the touch hit area.
describe('CalendarManagementSettings row actions', () => {
  const work = {
    id: 'work', name: 'Work', color: '#ff0000', isDefault: false, isShared: false, shareWith: null, sortOrder: 1,
    myRights: { mayShare: true, mayDelete: true, mayWriteAll: true },
  } as unknown as Calendar;
  const home = { ...appleColored, color: '#00ff00', sortOrder: 0 } as Calendar;

  beforeEach(() => {
    useAuthStore.setState({ client: { getAccountId: () => 'acct-1' }, serverUrl: null, username: null } as never);
    useCalendarStore.setState({ calendars: [home, work], icalSubscriptions: [], updateCalendar: vi.fn() } as never);
  });

  it('offers the row actions from a named ⋮ menu, Delete last and only where it applies', async () => {
    render(<CalendarManagementSettings />);
    const more = screen.getAllByRole('button', { name: 'row_actions' });
    expect(more).toHaveLength(2);

    fireEvent.click(more[1]); // Work, not the default calendar
    const menu = await screen.findByRole('menu');
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]')).map((el) => el.textContent);
    expect(items).toEqual(['edit', 'default_alerts', 'share', 'clear_events', 'move_up', 'move_down', 'delete']);

    fireEvent.click(screen.getByRole('menuitem', { name: 'delete' }));
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
  });

  it('leaves Delete out of the default calendar menu', async () => {
    render(<CalendarManagementSettings />);
    fireEvent.click(screen.getAllByRole('button', { name: 'row_actions' })[0]);
    const menu = await screen.findByRole('menu');
    expect(Array.from(menu.querySelectorAll('[role="menuitem"]')).map((el) => el.textContent)).not.toContain('delete');
  });

  it('names every row icon', () => {
    render(<CalendarManagementSettings />);
    for (const name of ['move_up', 'move_down', 'edit', 'default_alerts', 'share', 'clear_events', 'delete', 'change_color']) {
      expect(screen.getAllByRole('button', { name }).length).toBeGreaterThan(0);
    }
  });
});
