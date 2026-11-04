import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';
import { useCalendarStore } from '@/stores/calendar-store';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useTaskStore } from '@/stores/task-store';
import { useAccountStore } from '@/stores/account-store';

// pim-12 review: a series of another login was deleted with the active
// login's addresses, so a meeting the user organizes as that login counted as
// someone else's: no "attendees will be told" note, and truncating the series
// didn't tell them. The event's own login's addresses decide now.

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

const RIGHTS = {
  mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayWriteOwn: true,
  mayUpdatePrivate: true, mayRSVP: true, mayShare: true, mayDelete: true,
};
const calendars = [{
  id: 'cal', name: 'Personal', color: '#123456', isDefault: true, sortOrder: 0, description: null,
  isSubscribed: true, isVisible: true, includeInAvailability: 'all', defaultAlertsWithTime: null,
  defaultAlertsWithoutTime: null, timeZone: null, shareWith: null, myRights: RIGHTS,
}, {
  id: 'login-b:bcal', originalId: 'bcal', localAccountId: 'login-b', name: 'B Personal', color: '#654321', isDefault: true,
  sortOrder: 0, description: null, isSubscribed: true, isVisible: true, includeInAvailability: 'all',
  defaultAlertsWithTime: null, defaultAlertsWithoutTime: null, timeZone: null, shareWith: null, myRights: RIGHTS,
}] as unknown as Calendar[];
const series = {
  id: 'login-b:e1', originalId: 'e1', localAccountId: 'login-b', uid: 'u1', '@type': 'Event', title: 'Team sync',
  description: '', start: '2026-10-12T10:00:00', duration: 'PT1H', timeZone: null, showWithoutTime: false,
  calendarIds: { 'login-b:bcal': true }, organizerCalendarAddress: 'mailto:b@example.org',
  participants: {
    org: { '@type': 'Participant', calendarAddress: 'mailto:b@example.org', roles: { owner: true }, participationStatus: 'accepted' },
    att: { '@type': 'Participant', calendarAddress: 'mailto:carol@example.net', roles: { attendee: true }, participationStatus: 'needs-action' },
  },
  alerts: null, recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly' }], isOrigin: false, status: 'confirmed',
} as unknown as CalendarEvent;
const client = {
  getAccountId: () => 'acc',
  getMaxParticipantsPerEvent: () => null,
  supportsCalendars: () => true,
  queryCalendarEvents: vi.fn().mockResolvedValue([]),
  getCalendarEvent: vi.fn().mockResolvedValue(null),
  getCalendarTasks: vi.fn().mockResolvedValue([]),
};

beforeEach(() => {
  useAuthStore.setState({ isAuthenticated: true, client: client as never, isLoading: false, activeAccountId: 'acc', username: 'me@example.com' } as never);
  useAccountStore.setState({
    accounts: [{ id: 'acc', email: 'me@example.com', username: 'me@example.com' }, { id: 'login-b', email: 'b@example.org', username: 'b@example.org' }],
    activeAccountId: 'acc',
  } as never);
  useCalendarStore.setState({
    calendars, events: [series], supportsCalendar: true, selectedCalendarIds: ['cal', 'login-b:bcal'], viewMode: 'week',
    selectedDate: new Date(2026, 9, 12), isLoading: false, isLoadingEvents: false, error: null,
    fetchCalendars: vi.fn(), fetchEvents: vi.fn(), refreshAllSubscriptions: vi.fn(),
    createEvent: vi.fn(), updateEvent: vi.fn(), deleteEvent: vi.fn(), rsvpEvent: vi.fn(),
  } as never);
  useSettingsStore.setState({ calendarHoverPreview: 'instant', enableCalendarTasks: false, proInterface: false } as never);
  useTaskStore.setState({ tasks: [] } as never);
});

describe('CalendarApp series of another login', () => {
  it("tells attendees when the user organizes it as that login", async () => {
    render(<CalendarApp />);
    const chips = await screen.findAllByText('Team sync');
    fireEvent.contextMenu(chips[0]);
    fireEvent.click(await screen.findByText('events.delete'));
    expect(await screen.findByText('participants.cancel_notification')).toBeInTheDocument();
  });
});
