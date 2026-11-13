import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

    // The address waits behind "Use in other apps" (usability pass 2026-11-04).
    fireEvent.click(await screen.findByTestId('calendar-use-in-other-apps'));
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

    fireEvent.click(await screen.findByTestId('calendar-use-in-other-apps'));
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

// pim-p2-3: with two accounts signed in, both accounts' calendars were one
// list with two rows reading "Calendar · Default".
describe('CalendarManagementSettings with two accounts', () => {
  it("lists each account's calendars under its address", async () => {
    const { useAccountStore } = await import('@/stores/account-store');
    useAccountStore.setState({
      accounts: [
        { id: 'login-a', email: 'a@example.org', username: 'a@example.org', displayName: 'Sam', label: 'Sam' },
        { id: 'login-b', email: 'b@example.org', username: 'b@example.org', displayName: 'Sam', label: 'Sam' },
      ] as never,
      activeAccountId: 'login-a',
    });
    useAuthStore.setState({ client: { getAccountId: () => 'acct-1' }, serverUrl: null, username: null } as never);
    const a = { ...appleColored, id: 'login-a::cal', name: 'Home', localAccountId: 'login-a' } as Calendar;
    const b = { ...appleColored, id: 'login-b::cal', name: 'Office', localAccountId: 'login-b' } as Calendar;
    useCalendarStore.setState({ calendars: [b, a], icalSubscriptions: [], updateCalendar: vi.fn() } as never);

    render(<CalendarManagementSettings />);

    const groups = screen.getAllByTestId('calendar-settings-group');
    expect(groups.map((g) => g.querySelector('[data-testid="calendar-settings-account"]')?.textContent)).toEqual(['a@example.org', 'b@example.org']);
    expect(groups.map((g) => Array.from(g.querySelectorAll('[data-testid="calendar-settings-item"]')).map((el) => el.getAttribute('data-calendar-name')))).toEqual([['Home'], ['Office']]);
    useAccountStore.setState({ accounts: [], activeAccountId: null });
  });
});

// pim-p2-3: opened straight away (no visit to Calendar first), Settings
// loaded only the account on screen.
describe('CalendarManagementSettings opened with two accounts signed in', () => {
  it("loads and lists both accounts' calendars", async () => {
    const { useAccountStore } = await import('@/stores/account-store');
    const fake = (name: string) => ({
      supportsCalendars: () => true,
      getAccountId: () => 'acct',
      getAllCalendarsWithFailures: vi.fn(async () => ({ calendars: [{ ...appleColored, id: 'cal', name }], failedAccountIds: [] })),
    });
    const clients: Record<string, unknown> = { 'login-a': fake('Home'), 'login-b': fake('Office') };
    useAccountStore.setState({
      accounts: [
        { id: 'login-a', email: 'a@example.org', username: 'a@example.org', displayName: 'Sam', label: 'Sam', isConnected: true },
        { id: 'login-b', email: 'b@example.org', username: 'b@example.org', displayName: 'Sam', label: 'Sam', isConnected: true },
      ] as never,
      activeAccountId: 'login-a',
    });
    useAuthStore.setState({
      client: clients['login-a'], serverUrl: null, username: null, activeAccountId: 'login-a',
      getClientForAccount: ((id: string) => clients[id]) as never,
    } as never);
    useCalendarStore.setState({ calendars: [], icalSubscriptions: [], updateCalendar: vi.fn() } as never);

    render(<CalendarManagementSettings />);

    await waitFor(() => expect(screen.getAllByTestId('calendar-settings-account').map((el) => el.textContent)).toEqual(['a@example.org', 'b@example.org']));
    useAccountStore.setState({ accounts: [], activeAccountId: null });
    useCalendarStore.getState().setAccountClients(null, null);
  });
});

// #1617: with a group's account picked under Settings → Account, a new
// calendar went to the user's own account.
describe('CalendarManagementSettings for a managed shared account', () => {
  const group = {
    ...appleColored, id: 'group:c', originalId: 'c', name: 'Team', isDefault: false, isShared: true,
    accountId: 'group', accountName: 'team@example.org',
  } as unknown as Calendar;
  const mine = { ...appleColored, accountId: 'own' } as Calendar;
  const clientFor = (mayCreateCalendar: boolean) => ({
    getAccountId: () => 'own',
    getAccountInfo: (id: string) => id === 'group'
      ? { name: 'team@example.org', isPersonal: false, isReadOnly: false, accountCapabilities: { 'urn:ietf:params:jmap:calendars': { mayCreateCalendar } } }
      : null,
  });

  beforeEach(async () => {
    const { useManagedAccountStore } = await import('@/stores/managed-account-store');
    useManagedAccountStore.getState().setManagedAccount({ id: 'group', name: 'team@example.org', isPrimary: false } as never);
  });

  afterEach(async () => {
    const { useManagedAccountStore } = await import('@/stores/managed-account-store');
    useManagedAccountStore.getState().clear();
    vi.restoreAllMocks();
  });

  it('creates the calendar in the managed account, without asking for a kind', async () => {
    const createCalendar = vi.fn().mockResolvedValue(group);
    useAuthStore.setState({ client: clientFor(true), serverUrl: null, username: null } as never);
    useCalendarStore.setState({ calendars: [mine, group], icalSubscriptions: [], createCalendar } as never);

    render(<CalendarManagementSettings />);
    expect(screen.getAllByTestId('calendar-settings-item').map((el) => el.getAttribute('data-calendar-name'))).toEqual(['Team']);
    fireEvent.click(screen.getByText('add_calendar'));
    expect(screen.queryByText('kind')).toBeNull();
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'Rota' } });
    fireEvent.click(screen.getByText('create'));

    await waitFor(() => expect(createCalendar).toHaveBeenCalledTimes(1));
    expect(createCalendar.mock.calls[0][1]).toMatchObject({ name: 'Rota' });
    expect(createCalendar.mock.calls[0][2]).toEqual({ components: undefined });
    expect(createCalendar.mock.calls[0][3]).toBe('group');
  });

  it('says so when the server refuses, instead of reporting it created', async () => {
    const { toast } = await import('@/stores/toast-store');
    const success = vi.spyOn(toast, 'success');
    const error = vi.spyOn(toast, 'error');
    const createCalendar = vi.fn().mockResolvedValue(null);
    useAuthStore.setState({ client: clientFor(true), serverUrl: null, username: null } as never);
    useCalendarStore.setState({ calendars: [group], icalSubscriptions: [], createCalendar } as never);

    render(<CalendarManagementSettings />);
    fireEvent.click(screen.getByText('add_calendar'));
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'Rota' } });
    fireEvent.click(screen.getByText('create'));

    await waitFor(() => expect(error).toHaveBeenCalledWith('error_create'));
    expect(success).not.toHaveBeenCalled();
    expect(screen.getByLabelText('name')).toBeInTheDocument();
  });

  // #1676: account ids repeat across servers, so a calendar of a login on
  // another server under the same id is not the managed account's.
  it("leaves out another server's calendars under the same account id", async () => {
    const { useAccountStore } = await import('@/stores/account-store');
    useAccountStore.setState({
      accounts: [
        { id: 'login-a', email: 'a@one.example', username: 'a@one.example', serverUrl: 'https://one.example' },
        { id: 'login-b', email: 'b@two.example', username: 'b@two.example', serverUrl: 'https://two.example' },
      ] as never,
      activeAccountId: 'login-a',
    });
    useAuthStore.setState({ client: clientFor(true), serverUrl: null, username: null } as never);
    const ours = { ...group, id: 'login-a::group:c', localAccountId: 'login-a' } as Calendar;
    const otherServer = { ...appleColored, id: 'login-b::c', name: 'Elsewhere', accountId: 'group', localAccountId: 'login-b' } as Calendar;
    useCalendarStore.setState({ calendars: [ours, otherServer], icalSubscriptions: [], createCalendar: vi.fn() } as never);

    render(<CalendarManagementSettings />);
    expect(screen.getAllByTestId('calendar-settings-item').map((el) => el.getAttribute('data-calendar-name'))).toEqual(['Team']);
    useAccountStore.setState({ accounts: [], activeAccountId: null });
  });

  it('offers no new calendar where the account may not make one', () => {
    useAuthStore.setState({ client: clientFor(false), serverUrl: null, username: null } as never);
    useCalendarStore.setState({ calendars: [group], icalSubscriptions: [], createCalendar: vi.fn() } as never);

    render(<CalendarManagementSettings />);
    expect(screen.queryByText('add_calendar')).toBeNull();
  });
});

describe('CalendarManagementSettings with shared calendars', () => {
  it("lists the user's own calendars first, then each shared account's under its name", () => {
    useAuthStore.setState({ client: { getAccountId: () => 'own' }, serverUrl: null, username: null } as never);
    const team = { ...appleColored, id: 'group:c', name: 'Team', isDefault: false, isShared: true, accountId: 'group', accountName: 'team@example.org' } as Calendar;
    const boss = { ...appleColored, id: 'boss:c', name: 'Boss', isDefault: false, isShared: true, accountId: 'boss', accountName: 'boss@example.org' } as Calendar;
    useCalendarStore.setState({ calendars: [team, appleColored, boss], icalSubscriptions: [], updateCalendar: vi.fn() } as never);

    render(<CalendarManagementSettings />);

    const groups = screen.getAllByTestId('calendar-settings-group');
    expect(groups.map((g) => g.querySelector('[data-testid="calendar-settings-account"]')?.textContent ?? null)).toEqual([null, 'team@example.org', 'boss@example.org']);
    expect(groups.map((g) => Array.from(g.querySelectorAll('[data-testid="calendar-settings-item"]')).map((el) => el.getAttribute('data-calendar-name')))).toEqual([['Home'], ['Team'], ['Boss']]);
  });
});
