import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CalendarManagementSettings } from '../calendar-management-settings';
import { useCalendarStore } from '@/stores/calendar-store';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useToastStore } from '@/stores/toast-store';
import type { Calendar } from '@/lib/jmap/types';

// #1731: Calendar management offers to hide the shared calendars the user
// hasn't subscribed to, and then a subscribe button on each shared one,
// which sets isSubscribed on the server.

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${Object.values(values).join(' ')}` : key,
  useLocale: () => 'en',
}));

const updateCalendar = vi.fn();
const client = {
  getAccountId: () => 'me',
  getPrincipals: vi.fn().mockResolvedValue([]),
  updateCalendar,
};

const rights = { mayReadItems: true, mayWriteAll: false, mayWriteOwn: false, mayShare: false, mayDelete: false };
const own = {
  id: 'own', name: 'Personal', color: '#3b82f6', sortOrder: 0, isDefault: true, isShared: false, isSubscribed: true,
  shareWith: null, myRights: { ...rights, mayWriteAll: true, mayWriteOwn: true, mayDelete: true },
} as unknown as Calendar;
const room = {
  id: 'owner:room', originalId: 'room', accountId: 'owner', accountName: 'Owner', name: 'Room 2', color: '#22c55e',
  sortOrder: 0, isDefault: false, isShared: true, isSubscribed: false, shareWith: null, myRights: rights,
} as unknown as Calendar;

const shared = () => useCalendarStore.getState().calendars.find((c) => c.id === 'owner:room')!;

beforeEach(() => {
  updateCalendar.mockReset().mockResolvedValue(undefined);
  useAuthStore.setState({ client: client as never, serverUrl: null as never, username: null as never });
  useCalendarStore.setState({ calendars: [own, room], icalSubscriptions: [] } as never);
  useSettingsStore.setState({ hideUnsubscribedCalendars: false } as never);
  useToastStore.setState({ toasts: [] } as never);
});

describe('Calendar management subscriptions', () => {
  it('turns on hiding unsubscribed shared calendars', () => {
    render(<CalendarManagementSettings />);
    fireEvent.click(screen.getByRole('switch', { name: /hide_unsubscribed\.label/ }));
    expect(useSettingsStore.getState().hideUnsubscribedCalendars).toBe(true);
  });

  it('offers no subscribe button while the setting is off', () => {
    render(<CalendarManagementSettings />);
    expect(screen.queryByRole('button', { name: /subscribe_named/ })).toBeNull();
  });

  it('subscribes to a shared calendar on the server, and offers none for an own one', async () => {
    useSettingsStore.setState({ hideUnsubscribedCalendars: true } as never);
    render(<CalendarManagementSettings />);
    expect(screen.queryByRole('button', { name: 'subscribe_named Personal' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'subscribe_named Room 2' }));

    await waitFor(() => expect(updateCalendar).toHaveBeenCalledExactlyOnceWith('room', { isSubscribed: true }, 'owner'));
    expect(shared().isSubscribed).toBe(true);
    expect(screen.getByRole('button', { name: 'unsubscribe_named Room 2' })).toBeInTheDocument();
  });

  it('puts the subscription back and says so when the server refuses', async () => {
    updateCalendar.mockRejectedValue(new Error('You are not allowed to modify this calendar.'));
    useSettingsStore.setState({ hideUnsubscribedCalendars: true } as never);
    render(<CalendarManagementSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'subscribe_named Room 2' }));

    await waitFor(() => expect(useToastStore.getState().toasts.map((t) => t.title)).toContain('error_subscription'));
    expect(shared().isSubscribed).toBe(false);
  });
});
