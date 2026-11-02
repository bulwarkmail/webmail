import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Calendar } from '@/lib/jmap/types';
import { useCalendarStore } from '@/stores/calendar-store';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';

// The calendar page before its data is there: the boot skeleton while the
// session is restored, then the view's grid in the same shapes while the
// calendars load (components/boot-skeleton/calendar-skeleton.tsx).

vi.mock('@/hooks/use-media-query', () => ({
  useIsMobile: () => false,
  useIsDesktop: () => true,
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
}] as unknown as Calendar[];

const client = {
  getAccountId: () => 'acc',
  getMaxParticipantsPerEvent: () => null,
  supportsCalendars: () => true,
  queryCalendarEvents: vi.fn().mockResolvedValue([]),
  getCalendarEvent: vi.fn().mockResolvedValue(null),
  getCalendarTasks: vi.fn().mockResolvedValue([]),
};

const noop = () => vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  useSettingsStore.setState({ enableCalendarTasks: true, proInterface: false } as never);
  useCalendarStore.setState({
    calendars: [], events: [], supportsCalendar: false, selectedCalendarIds: [], viewMode: 'week',
    selectedDate: new Date(2026, 10, 4), isLoading: false, isLoadingEvents: false, error: null,
    fetchCalendars: noop(), fetchEvents: noop(), refreshAllSubscriptions: noop(),
  } as never);
});

const bootSkeleton = (root: HTMLElement) => root.querySelector('[data-boot-skeleton="calendar"]');
const viewSkeleton = (root: HTMLElement) => root.querySelector('[data-calendar-view-skeleton]');

describe('CalendarApp before its data is there', () => {
  it('draws the calendar skeleton while the sign-in is restored', () => {
    // Still checking: no redirect to the login page yet.
    useAuthStore.setState({ isAuthenticated: false, client: null, isLoading: true, checkAuth: noop() } as never);
    const { container } = render(<CalendarApp />);
    const skeleton = bootSkeleton(container);
    expect(skeleton).not.toBeNull();
    expect(skeleton?.getAttribute('aria-busy')).toBe('true');
    expect(skeleton?.querySelector('[role="status"]')?.textContent).toBe('common.loading');
    // The toolbar's words, from the calendar's own messages.
    expect(skeleton?.textContent).toContain('views.today');
  });

  it('draws the skeleton while the session has not said the account has calendars', () => {
    useAuthStore.setState({ isAuthenticated: true, client: client as never, isLoading: false, activeAccountId: 'acc' } as never);
    const { container } = render(<CalendarApp />);
    expect(bootSkeleton(container)).not.toBeNull();
    expect(container.querySelector('main')).toBeNull();
  });

  it('draws the grid of the view in the skeleton shapes while the calendars load', () => {
    useAuthStore.setState({ isAuthenticated: true, client: client as never, isLoading: false, activeAccountId: 'acc' } as never);
    useCalendarStore.setState({ supportsCalendar: true, isLoading: true, viewMode: 'month' } as never);
    const { container } = render(<CalendarApp />);
    // The real chrome is up; only the grid waits.
    expect(bootSkeleton(container)).toBeNull();
    expect(container.querySelector('main')).not.toBeNull();
    const grid = viewSkeleton(container);
    expect(grid?.getAttribute('data-calendar-view-skeleton')).toBe('month');
    expect(grid?.querySelector('[role="status"]')?.textContent).toBe('status.loading_calendars');
    expect(container.querySelector('.animate-spin')).toBeNull();
  });

  it('draws the real grid, without a spinner over it, while the first events load', () => {
    useAuthStore.setState({ isAuthenticated: true, client: client as never, isLoading: false, activeAccountId: 'acc' } as never);
    useCalendarStore.setState({
      supportsCalendar: true, calendars, selectedCalendarIds: ['cal'], isLoadingEvents: true,
    } as never);
    const { container } = render(<CalendarApp />);
    expect(viewSkeleton(container)).toBeNull();
    expect(container.querySelector('[role="grid"]')).not.toBeNull();
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(Array.from(container.querySelectorAll('[role="status"]')).some((s) => s.textContent === 'status.loading_events')).toBe(true);
  });
});
