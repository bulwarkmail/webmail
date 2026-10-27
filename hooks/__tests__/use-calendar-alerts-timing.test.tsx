import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useCalendarAlerts } from '../use-calendar-alerts';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useCalendarNotificationStore } from '@/stores/calendar-notification-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useToastStore } from '@/stores/toast-store';
import { emitPushStateChange } from '@/lib/push-events';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { CalendarEvent } from '@/lib/jmap/types';

// Reminders were only checked once a minute, and an event created elsewhere
// reached them only through a 24-hour prefetch throttled to five minutes
// (#1349): a reminder came up to a minute late, or several minutes late for
// an event made shortly before it.

function eventWithAlertAt(id: string, fireAt: number): CalendarEvent {
  const start = new Date(fireAt + 10 * 60_000);
  return {
    id,
    uid: `uid-${id}`,
    title: `Meeting ${id}`,
    start: start.toISOString().slice(0, 19),
    utcStart: start.toISOString(),
    duration: 'PT1H',
    calendarIds: { c1: true },
    useDefaultAlerts: false,
    alerts: {
      a1: { '@type': 'Alert', action: 'display', trigger: { '@type': 'AbsoluteTrigger', when: new Date(fireAt).toISOString() } },
    },
  } as unknown as CalendarEvent;
}

const toastTitles = () => useToastStore.getState().toasts.map((t) => t.title);

beforeEach(() => {
  useToastStore.setState({ toasts: [] });
  useCalendarNotificationStore.getState().clearAll();
  useAuthStore.setState({ isAuthenticated: true, client: null });
  useSettingsStore.setState({ calendarNotificationsEnabled: true, calendarNotificationSound: false, enableCalendarTasks: false });
  useCalendarStore.setState({ events: [], calendars: [], supportsCalendar: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('reminder timing', () => {
  it('shows a reminder at its fire time, not on the next periodic check', () => {
    vi.useFakeTimers();
    const now = Date.now();
    useCalendarStore.setState({ events: [eventWithAlertAt('e1', now + 20_000)] });

    renderHook(() => useCalendarAlerts());
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(toastTitles()).toEqual([]);

    act(() => { vi.advanceTimersByTime(20_000); });
    expect(toastTitles()).toEqual(['Meeting e1']);
  });

  it('re-reads upcoming events when push reports an event change', async () => {
    const due = eventWithAlertAt('e2', Date.now() - 30_000);
    const queryCalendarEvents = vi.fn<IJMAPClient['queryCalendarEvents']>()
      .mockResolvedValueOnce([])
      .mockResolvedValue([due]);
    const client = { queryCalendarEvents, getAccountId: () => 'own' } as unknown as IJMAPClient;
    useAuthStore.setState({ client });

    renderHook(() => useCalendarAlerts());
    await waitFor(() => expect(queryCalendarEvents).toHaveBeenCalledTimes(1));
    expect(toastTitles()).toEqual([]);

    // Another session created an event whose reminder is due now.
    act(() => {
      emitPushStateChange({ '@type': 'StateChange', changed: { own: { CalendarEvent: 's2' } } }, client, 'active');
    });
    await waitFor(() => expect(toastTitles()).toEqual(['Meeting e2']));
    expect(queryCalendarEvents).toHaveBeenCalledTimes(2);
  });
});
