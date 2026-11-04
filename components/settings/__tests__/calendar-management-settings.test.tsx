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
    // One visible "Edit…" per row (pim-20).
    fireEvent.click(screen.getByRole('button', { name: 'edit_calendar' }));
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

    const url = await screen.findByText('https://host.example/stalwart/.well-known/caldav');
    // Left to right in Arabic too: the start of the address stays in view.
    expect(url).toHaveAttribute('dir', 'ltr');
    // Once for the account, not under each calendar (pim-26).
    expect(screen.getAllByText('https://host.example/stalwart/.well-known/caldav')).toHaveLength(1);
    vi.restoreAllMocks();
  });

  // pim-26: the account's address repeated under every calendar.
  it('shows the account address once, not under each calendar', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 502 }));
    useAuthStore.setState({
      client: { getAccountId: () => 'acct-1' }, serverUrl: 'https://host.example', username: 'alice@example.com',
    } as never);
    const second = { ...appleColored, id: 'cal-2', name: 'Work', isDefault: false } as Calendar;
    useCalendarStore.setState({ calendars: [appleColored, second], icalSubscriptions: [], updateCalendar: vi.fn() } as never);

    render(<CalendarManagementSettings />);

    await screen.findByText('https://host.example/.well-known/caldav');
    expect(screen.getAllByText('https://host.example/.well-known/caldav')).toHaveLength(1);
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

// Seven icons on hover hid what they did and pushed the names aside on a
// phone (pim-20). Each row shows "Edit…" (name, colour, then reminders and
// sharing) and a ⋮ (right-click too) with the order and the destructive
// actions.
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
    expect(items).toEqual(['edit_calendar', 'move_up', 'move_down', 'clear_all_events', 'delete_calendar']);

    fireEvent.click(screen.getByRole('menuitem', { name: 'delete_calendar' }));
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
  });

  it('leaves Delete out of the default calendar menu', async () => {
    render(<CalendarManagementSettings />);
    fireEvent.click(screen.getAllByRole('button', { name: 'row_actions' })[0]);
    const menu = await screen.findByRole('menu');
    expect(Array.from(menu.querySelectorAll('[role="menuitem"]')).map((el) => el.textContent)).not.toContain('delete_calendar');
  });

  it('shows one Edit button per row and no arrows or hover icons', () => {
    render(<CalendarManagementSettings />);
    expect(screen.getAllByRole('button', { name: 'edit_calendar' })).toHaveLength(2);
    for (const name of ['move_up', 'move_down', 'edit', 'default_alerts', 'share', 'clear_events', 'delete']) {
      expect(screen.queryAllByRole('button', { name })).toHaveLength(0);
    }
    expect(screen.getAllByRole('button', { name: 'change_color' }).length).toBeGreaterThan(0);
  });

  it('opens reminders and sharing from the Edit form', () => {
    render(<CalendarManagementSettings />);
    fireEvent.click(screen.getAllByRole('button', { name: 'edit_calendar' })[1]);
    expect(screen.getByRole('button', { name: 'default_alerts_open' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'share_open' })).toBeInTheDocument();
  });
});
