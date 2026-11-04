import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CalendarSidebarPanel } from '../calendar-sidebar-panel';
import { useCalendarStore } from '@/stores/calendar-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Calendar } from '@/lib/jmap/types';

// pim-20: renaming a calendar only worked from Settings, through a pencil
// that showed on hover. The calendar's menu has "Rename…" now, and calls
// clearing "Clear all events…" and deleting "Delete…" (both ask first).

const work = {
  id: 'work', name: 'Work', color: '#3b82f6', sortOrder: 0, isSubscribed: true, isVisible: true,
  isDefault: false, includeInAvailability: 'all', timeZone: null, shareWith: null,
  myRights: { mayReadItems: true, mayWriteAll: true, mayWriteOwn: true, mayUpdatePrivate: true, mayRSVP: true, mayShare: true, mayDelete: true },
} as unknown as Calendar;
const shared = { ...work, id: 'x:team', name: 'Team', isShared: true, accountId: 'x', accountName: 'b@example.org' } as Calendar;
const client = { getAccountId: () => 'a' } as unknown as IJMAPClient;
let updateCalendar: ReturnType<typeof vi.fn>;

beforeEach(() => {
  updateCalendar = vi.fn().mockResolvedValue(undefined);
  useCalendarStore.setState({ updateCalendar, viewMode: 'month', icalSubscriptions: [] } as never);
});

function openMenu(name: string) {
  render(<CalendarSidebarPanel calendars={[work, shared]} selectedCalendarIds={['work', 'x:team']} onToggleVisibility={() => {}} onClearCalendar={() => {}} onDeleteCalendar={() => {}} client={client} />);
  fireEvent.contextMenu(screen.getAllByTestId('calendar-item').find((el) => el.dataset.calendarName === name)!);
}

describe('calendar menu Rename (pim-20)', () => {
  it('renames the calendar from its menu', async () => {
    openMenu('Work');
    const items = screen.getAllByRole('menuitem').map((el) => el.textContent);
    expect(items).toContain('rename_calendar');
    expect(items).toContain('clear_all_events');
    expect(items).toContain('delete_calendar');
    fireEvent.click(screen.getByRole('menuitem', { name: 'rename_calendar' }));
    const field = await screen.findByDisplayValue('Work');
    fireEvent.change(field, { target: { value: 'Office' } });
    fireEvent.click(screen.getByRole('button', { name: 'rename_confirm' }));
    await waitFor(() => expect(updateCalendar).toHaveBeenCalledWith(client, 'work', { name: 'Office' }));
  });

  it('offers no Rename for a calendar someone shared', () => {
    openMenu('Team');
    expect(screen.getAllByRole('menuitem').map((el) => el.textContent)).not.toContain('rename_calendar');
  });
});
