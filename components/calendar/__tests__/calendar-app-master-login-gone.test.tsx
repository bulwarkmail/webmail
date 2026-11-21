import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';
import { useCalendarStore } from '@/stores/calendar-store';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useTaskStore } from '@/stores/task-store';
import { useAccountStore } from '@/stores/account-store';

/**
 * An occurrence of a series names its base event in its own login and
 * account. "Delete all events" (and the other scope actions) read that base
 * event first (findMasterEvent in calendar-app.tsx): by its id for an
 * occurrence the server expanded, by its uid for one the browser expanded.
 * The base event is read through the occurrence's own login only. When that
 * login has no client (it was signed out, or has not come back after a
 * reconnect) it must not be read through the active login instead: its id
 * names another event, or none, there, and a uid is the same in every
 * calendar that got the invitation.
 *
 * Harness of calendar-app-login-series-ux-pim.test.tsx.
 */

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
const WEEKLY = [{ '@type': 'RecurrenceRule', frequency: 'weekly' }];
// One occurrence the server expanded from login b's weekly series e1.
const occurrence = {
  id: 'login-b:e1-20261012', originalId: 'e1-20261012', baseEventId: 'e1', localAccountId: 'login-b', accountId: 'bacc',
  uid: 'u1', '@type': 'Event', title: 'Team sync', recurrenceId: '2026-10-12T10:00:00',
  description: '', start: '2026-10-12T10:00:00', duration: 'PT1H', timeZone: null, showWithoutTime: false,
  calendarIds: { 'login-b:bcal': true }, participants: null,
  alerts: null, recurrenceRules: null, isOrigin: true, status: 'confirmed',
} as unknown as CalendarEvent;
// The same occurrence as the browser expands it from the series the store holds.
const expanded = {
  id: 'login-b::e1:2026-10-12T10:00:00', originalId: 'e1', localAccountId: 'login-b', accountId: 'bacc',
  uid: 'u1', '@type': 'Event', title: 'Team sync', recurrenceId: '2026-10-12T10:00:00',
  description: '', start: '2026-10-12T10:00:00', duration: 'PT1H', timeZone: null, showWithoutTime: false,
  calendarIds: { 'login-b:bcal': true }, participants: null,
  alerts: null, recurrenceRules: WEEKLY, isOrigin: true, status: 'confirmed',
} as unknown as CalendarEvent;
// The active login's own series with the same uid (both logins got the invitation).
const ownSeries = {
  id: 'e1', uid: 'u1', '@type': 'Event', title: 'Own sync', description: '', start: '2026-10-13T08:00:00',
  duration: 'PT1H', timeZone: null, showWithoutTime: false, calendarIds: { cal: true }, participants: null,
  alerts: null, recurrenceRules: WEEKLY, isOrigin: true, status: 'confirmed',
} as unknown as CalendarEvent;
const client = {
  getAccountId: () => 'acc',
  getMaxParticipantsPerEvent: () => null,
  supportsCalendars: () => true,
  queryCalendarEvents: vi.fn().mockResolvedValue([]),
  // The active login has an event e1 of its own.
  getCalendarEvent: vi.fn().mockResolvedValue({ id: 'e1', title: 'Own e1', recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'daily' }], calendarIds: { cal: true } }),
  getCalendarTasks: vi.fn().mockResolvedValue([]),
};
const clientB = {
  getAccountId: () => 'bacc',
  getMaxParticipantsPerEvent: () => null,
  supportsCalendars: () => true,
  queryCalendarEvents: vi.fn().mockResolvedValue([{ id: 'e1', uid: 'u1', title: 'Team sync', start: '2026-10-05T10:00:00', recurrenceRules: WEEKLY, calendarIds: { bcal: true } }]),
  getCalendarEvent: vi.fn().mockResolvedValue({ id: 'e1', uid: 'u1', title: 'Team sync', start: '2026-10-05T10:00:00', recurrenceRules: WEEKLY, calendarIds: { bcal: true } }),
  getCalendarTasks: vi.fn().mockResolvedValue([]),
};
let deleteEvent: ReturnType<typeof vi.fn>;

function setUp(events: CalendarEvent[], withB: boolean) {
  client.getCalendarEvent.mockClear();
  client.queryCalendarEvents.mockClear();
  clientB.getCalendarEvent.mockClear();
  clientB.queryCalendarEvents.mockClear();
  deleteEvent = vi.fn().mockResolvedValue(true);
  // Login b is listed; it has a client here only when `withB`.
  useAuthStore.setState({
    isAuthenticated: true, client: client as never, isLoading: false, activeAccountId: 'acc', username: 'me@example.com',
    getClientForAccount: ((id: string) => (withB && id === 'login-b' ? clientB : undefined)) as never,
  } as never);
  useAccountStore.setState({
    accounts: [{ id: 'acc', email: 'me@example.com', username: 'me@example.com' }, { id: 'login-b', email: 'b@example.org', username: 'b@example.org' }],
    activeAccountId: 'acc',
  } as never);
  useCalendarStore.setState({
    calendars, events, supportsCalendar: true, selectedCalendarIds: ['cal', 'login-b:bcal'], viewMode: 'week',
    selectedDate: new Date(2026, 9, 12), isLoading: false, isLoadingEvents: false, error: null,
    fetchCalendars: vi.fn(), fetchEvents: vi.fn(), refreshAllSubscriptions: vi.fn(),
    createEvent: vi.fn(), updateEvent: vi.fn(), deleteEvent, rsvpEvent: vi.fn(),
  } as never);
  useSettingsStore.setState({ calendarHoverPreview: 'instant', enableCalendarTasks: false, proInterface: false } as never);
  useTaskStore.setState({ tasks: [] } as never);
}

async function deleteAllOf(title: string) {
  render(<CalendarApp />);
  const chips = await screen.findAllByText(title);
  fireEvent.contextMenu(chips[0]);
  fireEvent.click(await screen.findByText('events.delete'));
  fireEvent.click(await screen.findByText('all_events'));
  const confirm = (await screen.findAllByText('delete')).find((el) => el.closest('button'));
  await act(async () => { fireEvent.click(confirm!.closest('button')!); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  await waitFor(() => expect(screen.queryByText('all_events')).toBeNull());
}

const deletedIds = () => deleteEvent.mock.calls.map((call) => call[1]);
const askedForUid = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.some((call) => (call[0] as { uid?: string } | undefined)?.uid === 'u1');

describe('CalendarApp, a server occurrence of a login without a client', () => {
  beforeEach(() => setUp([occurrence], false));

  it('does not read its base event through the active login on "Delete all events"', async () => {
    await deleteAllOf('Team sync');
    expect(client.getCalendarEvent).not.toHaveBeenCalled();
    expect(deleteEvent).not.toHaveBeenCalled();
  });
});

describe('CalendarApp, a server occurrence of a connected login', () => {
  beforeEach(() => setUp([occurrence], true));

  it('reads its base event through that login and deletes it there', async () => {
    await deleteAllOf('Team sync');
    expect(clientB.getCalendarEvent).toHaveBeenCalledWith('e1', 'bacc');
    expect(client.getCalendarEvent).not.toHaveBeenCalled();
    expect(deletedIds()).toEqual(['login-b:e1']);
  });
});

describe('CalendarApp, an occurrence the browser expanded, of another login', () => {
  it('looks its series up by uid through that login, in its account, and deletes it there', async () => {
    setUp([expanded], true);
    await deleteAllOf('Team sync');
    expect(clientB.queryCalendarEvents).toHaveBeenCalledWith({ uid: 'u1' }, undefined, undefined, 'bacc');
    expect(askedForUid(client.queryCalendarEvents)).toBe(false);
    expect(deletedIds()).toEqual(['login-b::e1']);
  });

  it('does not take the active login\'s series with the same uid for its own', async () => {
    setUp([expanded, ownSeries], true);
    await deleteAllOf('Team sync');
    expect(deletedIds()).toEqual(['login-b::e1']);
  });

  it('while that login has no client, looks nothing up through the active login and deletes nothing', async () => {
    setUp([expanded], false);
    await deleteAllOf('Team sync');
    expect(askedForUid(client.queryCalendarEvents)).toBe(false);
    expect(deleteEvent).not.toHaveBeenCalled();
  });
});
