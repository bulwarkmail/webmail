import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Calendar } from '@/lib/jmap/types';
import { useCalendarStore } from '@/stores/calendar-store';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useTaskStore } from '@/stores/task-store';

// pim-15: the desktop app's File > Import > Calendar…, on the whole calendar page
// with the shell around it stubbed out.

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
const config = vi.hoisted(() => ({ demoMode: false }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => config }));

import { CalendarApp } from '../calendar-app';
import { requestAppCommand } from '@/lib/app-commands';
import { mergedDesktopState, resetDesktopCommands, runDesktopCommand } from '@/lib/desktop/commands';

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

beforeEach(() => {
  config.demoMode = false;
  useAuthStore.setState({ isAuthenticated: true, client: client as never, isLoading: false, activeAccountId: 'acc' });
  useCalendarStore.setState({
    calendars, events: [], supportsCalendar: true, selectedCalendarIds: ['cal'], viewMode: 'week',
    selectedDate: new Date(2026, 9, 12), isLoading: false, isLoadingEvents: false, error: null,
    fetchCalendars: vi.fn(), fetchEvents: vi.fn(), refreshAllSubscriptions: vi.fn(),
  } as never);
  useSettingsStore.setState({ enableCalendarTasks: true, proInterface: false } as never);
  useTaskStore.setState({ tasks: [] } as never);
});

afterEach(() => cleanup());

describe('Calendar in the desktop menus', () => {
  it('File > Import > Calendar… opens the calendar import', () => {
    render(<CalendarApp />);
    expect(screen.queryByRole('dialog', { name: 'title' })).toBeNull();
    let taken = false;
    act(() => { taken = requestAppCommand('import-calendar'); });
    expect(taken).toBe(true);
    expect(screen.getByRole('dialog', { name: 'title' })).toBeInTheDocument();
  });

  it('opens nothing in demo mode, where the toolbar has no import either', () => {
    config.demoMode = true;
    render(<CalendarApp />);
    act(() => { requestAppCommand('import-calendar'); });
    expect(screen.queryByRole('dialog', { name: 'title' })).toBeNull();
  });
});

// pim-p2-9 (2026-11-04): the desktop app's Go menu in Calendar moves through time
// (Today, Next period, Previous period) instead of offering Mail's folders.
describe('Calendar in the desktop Go menu', () => {
  beforeEach(() => {
    resetDesktopCommands();
    (window as unknown as { bulwarkDesktop: unknown }).bulwarkDesktop = { version: 1, platform: 'win32', menu: { setState: vi.fn(), onCommand: vi.fn() } };
  });
  afterEach(() => {
    delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
    resetDesktopCommands();
  });

  it('offers Today, Next period and Previous period, and each moves the week', () => {
    render(<CalendarApp />);
    const state = mergedDesktopState();
    expect(state['go.today']).toBe(true);
    expect(state['go.nextPeriod']).toBe(true);
    expect(state['go.previousPeriod']).toBe(true);
    const day = () => useCalendarStore.getState().selectedDate.toDateString();
    act(() => { expect(runDesktopCommand('go.nextPeriod')).toBe(true); });
    expect(day()).toBe(new Date(2026, 9, 19).toDateString());
    act(() => { runDesktopCommand('go.previousPeriod'); });
    act(() => { runDesktopCommand('go.previousPeriod'); });
    expect(day()).toBe(new Date(2026, 9, 5).toDateString());
    act(() => { runDesktopCommand('go.today'); });
    expect(day()).toBe(new Date().toDateString());
  });
});
