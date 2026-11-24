import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #716: iCal subscriptions refreshed only while the calendar page was open.
// The app-wide provider now looks for due ones on load and every few minutes,
// on any page. The calendar page isn't rendered here.

vi.mock('@/hooks/use-calendar-alerts', () => ({ useCalendarAlerts: () => {} }));
vi.mock('@/hooks/use-store-reminders', () => ({ useStoreReminders: () => {} }));
vi.mock('@/components/calendar/missed-reminders-dialog', () => ({ MissedRemindersDialog: () => null }));
vi.mock('@/components/ui/toast', () => ({ ToastContainer: () => null }));
vi.mock('@/components/ui/live-regions', () => ({ LiveRegions: () => null }));

const { CalendarAlertProvider } = await import('../calendar-alert-provider');
const { useAuthStore } = await import('@/stores/auth-store');
const { useCalendarStore } = await import('@/stores/calendar-store');

const client = { id: 'client' };
const refreshAllSubscriptions = vi.fn(async () => {});

beforeEach(() => {
  vi.useFakeTimers();
  refreshAllSubscriptions.mockClear();
  useAuthStore.setState({ client, isAuthenticated: true } as never);
  useCalendarStore.setState({
    supportsCalendar: true,
    refreshAllSubscriptions,
    icalSubscriptions: [{ id: 's1', url: 'https://feeds.example/a.ics', calendarId: 'cal', name: 'A', color: '#f00', refreshInterval: 60, lastRefreshed: null }] as never,
  } as never);
});

afterEach(() => {
  vi.useRealTimers();
  useAuthStore.setState({ client: null, isAuthenticated: false } as never);
  useCalendarStore.setState({ icalSubscriptions: [] } as never);
});

describe('iCal subscriptions on any page (#716)', () => {
  it('are checked when the app loads and again every five minutes', () => {
    render(<CalendarAlertProvider><p>Inbox</p></CalendarAlertProvider>);
    expect(refreshAllSubscriptions).toHaveBeenCalledTimes(1);
    expect(refreshAllSubscriptions).toHaveBeenCalledWith(client);

    act(() => { vi.advanceTimersByTime(5 * 60 * 1000); });
    expect(refreshAllSubscriptions).toHaveBeenCalledTimes(2);
  });

  it('are left alone without subscriptions', () => {
    useCalendarStore.setState({ icalSubscriptions: [] } as never);
    render(<CalendarAlertProvider><p>Inbox</p></CalendarAlertProvider>);
    act(() => { vi.advanceTimersByTime(5 * 60 * 1000); });
    expect(refreshAllSubscriptions).not.toHaveBeenCalled();
  });
});
