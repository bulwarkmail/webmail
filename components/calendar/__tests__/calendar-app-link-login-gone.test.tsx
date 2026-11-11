import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Calendar } from '@/lib/jmap/types';
import { useCalendarStore } from '@/stores/calendar-store';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useTaskStore } from '@/stores/task-store';
import { useAccountStore } from '@/stores/account-store';
import { setClientLookup } from '@/stores/client-registry';
import { setPendingDeepLink } from '@/lib/deep-link-handoff';

// A link to an event of another login (a search hit) is read through that
// login only. While it has no client nothing opens: the active login holds
// another event under the same id.

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

const calendars = [{
  id: 'cal', name: 'Personal', color: '#123456', isDefault: true, sortOrder: 0, description: null,
  isSubscribed: true, isVisible: true, includeInAvailability: 'all', defaultAlertsWithTime: null,
  defaultAlertsWithoutTime: null, timeZone: null, shareWith: null, myRights: { mayReadItems: true },
}] as unknown as Calendar[];

let client: Record<string, ReturnType<typeof vi.fn> | (() => unknown)>;
let other: typeof client | undefined;

beforeEach(() => {
  client = {
    getAccountId: () => 'acc',
    getMaxParticipantsPerEvent: () => null,
    supportsCalendars: () => true,
    queryCalendarEvents: vi.fn().mockResolvedValue([]),
    getCalendarEvent: vi.fn().mockResolvedValue({ id: 'eaaaaab', title: 'A own event', start: '2026-10-12T10:00:00', duration: 'PT1H', calendarIds: { cal: true } }),
    getCalendarTasks: vi.fn().mockResolvedValue([]),
  };
  other = undefined;
  setClientLookup((id) => (id === 'acc' ? client : id === 'login-b' ? other : undefined) as never);
  useAuthStore.setState({ isAuthenticated: true, client: client as never, isLoading: false, activeAccountId: 'acc', username: 'me@example.com' } as never);
  useAccountStore.setState({
    accounts: [{ id: 'acc', email: 'me@example.com', username: 'me@example.com' }, { id: 'login-b', email: 'b@example.org', username: 'b@example.org' }],
    activeAccountId: 'acc',
  } as never);
  useCalendarStore.setState({
    calendars, events: [], supportsCalendar: true, selectedCalendarIds: ['cal'], viewMode: 'week',
    selectedDate: new Date(2026, 9, 12), isLoading: false, isLoadingEvents: false, error: null,
    fetchCalendars: vi.fn(), fetchEvents: vi.fn(), refreshAllSubscriptions: vi.fn(),
  } as never);
  useSettingsStore.setState({ enableCalendarTasks: false, proInterface: false } as never);
  useTaskStore.setState({ tasks: [] } as never);
});

afterEach(() => {
  setClientLookup(() => undefined);
});

describe('a link to an event of another login', () => {
  it('reads nothing through the active login while that login has no client', async () => {
    setPendingDeepLink('calendar', ['event', 'eaaaaab'], '?account=bacc&login=login-b');
    render(<CalendarApp />);
    await screen.findByText('Personal');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(client.getCalendarEvent).not.toHaveBeenCalled();
  });

  it('is read through that login once it has a client', async () => {
    other = { ...client, getCalendarEvent: vi.fn().mockResolvedValue(null) };
    setPendingDeepLink('calendar', ['event', 'eaaaaab'], '?account=bacc&login=login-b');
    render(<CalendarApp />);
    await screen.findByText('Personal');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(other.getCalendarEvent).toHaveBeenCalledWith('eaaaaab', 'bacc');
    expect(client.getCalendarEvent).not.toHaveBeenCalled();
  });
});
