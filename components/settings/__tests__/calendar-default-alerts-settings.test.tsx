import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CalendarManagementSettings } from '../calendar-management-settings';
import { useCalendarStore } from '@/stores/calendar-store';
import { useAuthStore } from '@/stores/auth-store';
import type { Calendar, CalendarEventAlert } from '@/lib/jmap/types';

// #1209: each calendar the user owns gets editable default reminders for
// timed and all-day events.

const absolute: CalendarEventAlert = {
  '@type': 'Alert',
  trigger: { '@type': 'AbsoluteTrigger', when: '2026-11-19T08:00:00Z' },
  action: 'display',
  acknowledged: null,
  relatedTo: null,
};

function makeCalendar(overrides: Partial<Calendar>): Calendar {
  return {
    id: 'cal-1',
    name: 'Work',
    color: '#3b82f6',
    isDefault: true,
    isShared: false,
    shareWith: null,
    myRights: { mayWriteAll: true, mayWriteOwn: true, mayShare: true, mayDelete: true },
    defaultAlertsWithTime: null,
    defaultAlertsWithoutTime: null,
    ...overrides,
  } as unknown as Calendar;
}

const client = { getAccountId: () => 'acct' };
let updateCalendar: ReturnType<typeof vi.fn>;

beforeEach(() => {
  updateCalendar = vi.fn().mockResolvedValue(undefined);
  useAuthStore.setState({ client: client as never, serverUrl: null as never, username: null as never });
  useCalendarStore.setState({
    calendars: [
      makeCalendar({ defaultAlertsWithoutTime: { abs: absolute } }),
      makeCalendar({ id: 'cal-2', name: 'Team', isDefault: false, isShared: true }),
    ],
    icalSubscriptions: [],
    updateCalendar,
  } as never);
});

// The reminders open from the calendar's "Edit…" form (pim-20).
function openReminders(index = 0) {
  fireEvent.click(screen.getAllByRole('button', { name: 'edit_calendar' })[index]);
  fireEvent.click(screen.getByRole('button', { name: 'default_alerts_open' }));
}

describe('Calendar default reminders settings', () => {
  it('offers default reminders only for calendars the user owns', () => {
    render(<CalendarManagementSettings />);
    fireEvent.click(screen.getAllByRole('button', { name: 'edit_calendar' })[0]);
    expect(screen.getByRole('button', { name: 'default_alerts_open' })).toBeInTheDocument();
    fireEvent.click(screen.getByText('cancel'));
    fireEvent.click(screen.getAllByRole('button', { name: 'edit_calendar' })[1]);
    expect(screen.queryByRole('button', { name: 'default_alerts_open' })).toBeNull();
  });

  it('saves both lists with their actions and keeps alerts it cannot show', async () => {
    render(<CalendarManagementSettings />);
    openReminders();

    // Timed list first, then all-day.
    const [addTimed, addAllDay] = screen.getAllByText('alerts.add');
    fireEvent.click(addTimed);
    fireEvent.change(screen.getByLabelText('alerts.action'), { target: { value: 'email' } });
    fireEvent.click(addAllDay);
    fireEvent.change(screen.getAllByLabelText('alerts.unit')[1], { target: { value: 'days' } });
    fireEvent.change(screen.getAllByLabelText('alerts.amount')[1], { target: { value: '1' } });
    fireEvent.click(screen.getByText('save'));

    await waitFor(() => expect(updateCalendar).toHaveBeenCalledTimes(1));
    const [, calendarId, updates] = updateCalendar.mock.calls[0];
    expect(calendarId).toBe('cal-1');
    expect(Object.values(updates.defaultAlertsWithTime)).toEqual([
      expect.objectContaining({ action: 'email', trigger: { '@type': 'OffsetTrigger', offset: '-PT10M', relativeTo: 'start' } }),
    ]);
    expect(updates.defaultAlertsWithoutTime.abs).toBe(absolute);
    expect(Object.values(updates.defaultAlertsWithoutTime)).toContainEqual(
      expect.objectContaining({ action: 'display', trigger: expect.objectContaining({ offset: '-P1D' }) }),
    );
  });

  // #1435: Stalwart 1.0 refuses a default alert id that the other list or
  // another calendar of the account already uses.
  it('gives new default alerts ids no other list or calendar uses', async () => {
    const offset = { ...absolute, trigger: { '@type': 'OffsetTrigger' as const, offset: '-PT5M', relativeTo: 'start' as const } };
    useCalendarStore.setState({
      calendars: [
        makeCalendar({}),
        makeCalendar({ id: 'cal-2', isDefault: false, defaultAlertsWithTime: { alert1: offset, 'cal-1-timed-1': offset } }),
      ],
    } as never);
    render(<CalendarManagementSettings />);
    openReminders(0);

    const [addTimed, addAllDay] = screen.getAllByText('alerts.add');
    fireEvent.click(addTimed);
    fireEvent.click(addAllDay);
    fireEvent.click(screen.getByText('save'));

    await waitFor(() => expect(updateCalendar).toHaveBeenCalledTimes(1));
    const [, calendarId, updates] = updateCalendar.mock.calls[0];
    expect(calendarId).toBe('cal-1');
    const ids = [...Object.keys(updates.defaultAlertsWithTime), ...Object.keys(updates.defaultAlertsWithoutTime)];
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids).not.toContain('alert1');
    expect(ids).not.toContain('cal-1-timed-1');
  });

  it('clears a list by sending an empty map, which Stalwart accepts where it refuses null', async () => {
    useCalendarStore.setState({
      calendars: [makeCalendar({
        defaultAlertsWithTime: {
          a: { ...absolute, trigger: { '@type': 'OffsetTrigger', offset: '-PT15M', relativeTo: 'start' } },
        },
      })],
    } as never);
    render(<CalendarManagementSettings />);
    openReminders();

    fireEvent.click(screen.getByLabelText('alerts.remove'));
    fireEvent.click(screen.getByText('save'));

    await waitFor(() => expect(updateCalendar).toHaveBeenCalledTimes(1));
    expect(updateCalendar.mock.calls[0][2]).toEqual({ defaultAlertsWithTime: {}, defaultAlertsWithoutTime: {} });
  });
});
