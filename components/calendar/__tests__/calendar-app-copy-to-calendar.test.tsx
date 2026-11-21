import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';
import { useCalendarStore } from '@/stores/calendar-store';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useTaskStore } from '@/stores/task-store';

// "Copy to calendar…" (#1513): an event of a calendar the user can't change
// is copied into one of their own, as a new event with its own UID.

vi.mock('@/hooks/use-media-query', () => ({
  useIsMobile: () => false,
  useIsDesktop: () => true,
  useIsFullDesktop: () => true,
  useIsTablet: () => false,
  useMediaQuery: () => false,
}));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => null }));
vi.mock('@/components/layout/sidebar-apps-modal', () => ({ SidebarAppsModal: () => null }));
vi.mock('@/components/layout/inline-app-view', () => ({ InlineAppView: () => null }));
vi.mock('@/components/layout/mv-top-bar', () => ({ MvTopBar: () => null }));
vi.mock('@/components/plugins/app-top-banner-slot', () => ({ AppTopBannerSlot: () => null }));
vi.mock('@/hooks/use-refresh-gesture', () => ({ useRefreshGesture: () => ({ indicator: null }) }));
vi.mock('@/hooks/use-calendar-push-refresh', () => ({ useCalendarPushRefresh: () => {} }));
vi.mock('@/hooks/use-account-principal-emails', () => ({ useAccountPrincipalEmails: () => [] }));
vi.mock('../participant-availability', () => ({ ParticipantAvailability: () => null }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ demoMode: false }) }));

import { CalendarApp } from '../calendar-app';

vi.setConfig({ testTimeout: 30000 });

const WRITE = {
  mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayWriteOwn: true,
  mayUpdatePrivate: true, mayRSVP: true, mayShare: true, mayDelete: true,
};
const READ_ONLY = {
  mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: false, mayWriteOwn: false,
  mayUpdatePrivate: false, mayRSVP: false, mayShare: false, mayDelete: false,
};
const base = {
  color: '#123456', sortOrder: 0, description: null, isSubscribed: true, isVisible: true,
  includeInAvailability: 'all', defaultAlertsWithTime: null, defaultAlertsWithoutTime: null,
  timeZone: null, shareWith: null,
};
const calendars = [
  { ...base, id: 'cal', name: 'Personal', isDefault: true, myRights: WRITE },
  { ...base, id: 'holidays', name: 'Team', isDefault: false, isShared: true, myRights: READ_ONLY },
] as unknown as Calendar[];

function makeEvent(id: string, calendarId: string): CalendarEvent {
  return {
    id, uid: `uid-${id}`, '@type': 'Event', title: `Event ${id}`, description: '', start: '2026-10-12T10:00:00',
    duration: 'PT1H', timeZone: null, showWithoutTime: false, calendarIds: { [calendarId]: true },
    participants: null, alerts: null, recurrenceRules: null, status: 'confirmed', freeBusyStatus: 'busy',
    locations: { loc1: { '@type': 'Location', name: 'Hall' } },
  } as unknown as CalendarEvent;
}

const client = {
  getAccountId: () => 'acc',
  getMaxParticipantsPerEvent: () => null,
  supportsCalendars: () => true,
  queryCalendarEvents: vi.fn().mockResolvedValue([]),
  getCalendarEvent: vi.fn().mockResolvedValue(null),
  getCalendarTasks: vi.fn().mockResolvedValue([]),
};
let createEvent: ReturnType<typeof vi.fn>;

beforeEach(() => {
  createEvent = vi.fn().mockResolvedValue({ id: 'new' });
  useAuthStore.setState({ isAuthenticated: true, client: client as never, isLoading: false, activeAccountId: 'acc' });
  useCalendarStore.setState({
    calendars, events: [makeEvent('theirs', 'holidays'), makeEvent('mine', 'cal')], supportsCalendar: true,
    selectedCalendarIds: ['cal', 'holidays'], viewMode: 'week',
    selectedDate: new Date(2026, 9, 12), isLoading: false, isLoadingEvents: false, error: null,
    fetchCalendars: vi.fn(), fetchEvents: vi.fn(), refreshAllSubscriptions: vi.fn(),
    createEvent, updateEvent: vi.fn(), deleteEvent: vi.fn(), rsvpEvent: vi.fn(),
  } as never);
  useSettingsStore.setState({ calendarHoverPreview: 'instant', enableCalendarTasks: true, proInterface: false } as never);
  useTaskStore.setState({ tasks: [] } as never);
});

function openMenu(eventId: string) {
  const card = document.querySelector(`[data-calendar-event][data-event-id="${eventId}"]`)!;
  fireEvent.contextMenu(card, { clientX: 10, clientY: 10 });
}

describe('CalendarApp copy to calendar (#1513)', () => {
  it('copies a read-only event into the picked calendar under a new UID', async () => {
    render(<CalendarApp />);
    openMenu('theirs');
    fireEvent.click(await screen.findByTestId('event-copy-to-calendar'));

    const dialog = await screen.findByTestId('copy-to-calendar-dialog');
    // Only the user's own calendars are offered.
    const options = Array.from(dialog.querySelectorAll('option')).map((o) => o.value);
    expect(options).toEqual(['cal']);
    fireEvent.click(screen.getByRole('button', { name: 'copy_button' }));

    await waitFor(() => expect(createEvent).toHaveBeenCalledTimes(1));
    const data = createEvent.mock.calls[0][1] as Partial<CalendarEvent>;
    expect(data.calendarIds).toEqual({ cal: true });
    expect(data.uid).toBeTruthy();
    expect(data.uid).not.toBe('uid-theirs');
    expect(data.title).toBe('Event theirs');
    expect(data.start).toBe('2026-10-12T10:00:00');
    expect(Object.values(data.locations ?? {})[0]?.name).toBe('Hall');
    await waitFor(() => expect(screen.queryByTestId('copy-to-calendar-dialog')).toBeNull());
  });

  it('is not offered for an event the user can change', async () => {
    render(<CalendarApp />);
    openMenu('mine');
    await screen.findByText('events.duplicate');
    expect(screen.queryByTestId('event-copy-to-calendar')).toBeNull();
  });
});
