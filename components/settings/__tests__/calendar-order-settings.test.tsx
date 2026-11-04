import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CalendarManagementSettings } from '../calendar-management-settings';
import { useCalendarStore } from '@/stores/calendar-store';
import { useAuthStore } from '@/stores/auth-store';
import type { Calendar } from '@/lib/jmap/types';

function makeCalendar(overrides: Partial<Calendar>): Calendar {
  return {
    id: 'cal-1',
    name: 'Work',
    color: '#3b82f6',
    sortOrder: 0,
    isDefault: false,
    isShared: false,
    shareWith: null,
    myRights: { mayWriteAll: true, mayWriteOwn: true, mayShare: true, mayDelete: true },
    ...overrides,
  } as unknown as Calendar;
}

const client = { getAccountId: () => 'acct', getPrincipals: vi.fn().mockResolvedValue([]) };
let reorderCalendars: ReturnType<typeof vi.fn>;

beforeEach(() => {
  reorderCalendars = vi.fn().mockResolvedValue(undefined);
  useAuthStore.setState({ client: client as never, serverUrl: null as never, username: null as never });
  useCalendarStore.setState({
    calendars: [
      makeCalendar({ id: 'work', name: 'Work', sortOrder: 1 }),
      makeCalendar({ id: 'home', name: 'Home', sortOrder: 2 }),
      makeCalendar({ id: 'holidays', name: 'Holidays', sortOrder: 3 }),
      makeCalendar({ id: 'x:team', name: 'Team', isShared: true, accountId: 'x' }),
    ],
    icalSubscriptions: [],
    reorderCalendars,
  } as never);
});

const row = (name: string) => screen.getAllByTestId('calendar-settings-item').find((el) => el.dataset.calendarName === name)!;
const buttonIn = (name: string, label: string) =>
  Array.from(row(name).querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === label)!;
// Up and down left the row for its ⋮ menu (pim-20): the drag handle stays.
async function menuItemFor(name: string, label: string) {
  fireEvent.click(buttonIn(name, 'row_actions'));
  const menu = await screen.findByRole('menu');
  return Array.from(menu.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent === label) as HTMLElement | undefined;
}

describe('Calendar order in settings', () => {
  it('moves a calendar up past its neighbour', async () => {
    render(<CalendarManagementSettings />);
    fireEvent.click((await menuItemFor('Holidays', 'move_up'))!);
    await waitFor(() => expect(reorderCalendars).toHaveBeenCalledWith(client, ['work', 'holidays', 'home']));
  });

  it('moves a calendar down past its neighbour', async () => {
    render(<CalendarManagementSettings />);
    fireEvent.click((await menuItemFor('Work', 'move_down'))!);
    await waitFor(() => expect(reorderCalendars).toHaveBeenCalledWith(client, ['home', 'work', 'holidays']));
  });

  it('disables moving the first calendar up and the last one down', async () => {
    const { unmount } = render(<CalendarManagementSettings />);
    expect(await menuItemFor('Work', 'move_up')).toBeDisabled();
    unmount();
    render(<CalendarManagementSettings />);
    expect(await menuItemFor('Holidays', 'move_down')).toBeDisabled();
  });

  it('offers no reordering for a calendar shared with the user', async () => {
    render(<CalendarManagementSettings />);
    expect(await menuItemFor('Team', 'move_up')).toBeUndefined();
    expect(row('Team')).not.toHaveAttribute('draggable', 'true');
  });

  it('reorders by drag and drop', async () => {
    render(<CalendarManagementSettings />);
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn() };
    fireEvent.dragStart(row('Holidays'), { dataTransfer });
    // Firefox starts no drag unless data is set.
    expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', 'holidays');
    fireEvent.dragOver(row('Work'), { dataTransfer });
    fireEvent.drop(row('Work'), { dataTransfer });
    await waitFor(() => expect(reorderCalendars).toHaveBeenCalledWith(client, ['holidays', 'work', 'home']));
  });
});
