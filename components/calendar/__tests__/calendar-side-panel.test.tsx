import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';
import { useCalendarStore } from '@/stores/calendar-store';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useToastStore } from '@/stores/toast-store';
import { useTaskStore } from '@/stores/task-store';
import { clearSlotOffers, framePropsOf, offerSlots } from '@/components/plugins/__tests__/fake-slot-offer';

// The plugin side panel (app-side-panel) in Calendar: its button at the end
// of the toolbar row, the panel last in the row under it, and the event the
// user opened in its context.

vi.mock('@/components/plugins/plugin-iframe-slot', () => import('@/components/plugins/__tests__/fake-slot-offer'));
const media = vi.hoisted(() => ({ mobile: false, desktop: true }));
vi.mock('@/hooks/use-media-query', () => ({
  useIsMobile: () => media.mobile,
  useIsDesktop: () => !media.mobile,
  // `desktop` is the full desktop: below it the sidebar opens over the page.
  useIsFullDesktop: () => media.desktop,
  useIsTablet: () => !media.mobile && !media.desktop,
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
const lite = vi.hoisted(() => ({ on: false }));
vi.mock('@/lib/lite', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/lite')>()),
  get IS_LITE() { return lite.on; },
}));


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

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'e1', uid: 'u1', '@type': 'Event', title: 'Standup', description: '', start: '2026-10-12T10:00:00',
    duration: 'PT1H', timeZone: null, showWithoutTime: false, calendarIds: { cal: true },
    participants: null, alerts: null, recurrenceRules: null, isOrigin: true, status: 'confirmed',
    ...overrides,
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

const store = {
  fetchCalendars: vi.fn(),
  fetchEvents: vi.fn(),
  refreshAllSubscriptions: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
  rsvpEvent: vi.fn(),
};

function setUp(events: CalendarEvent[] = [makeEvent()], viewMode: 'month' | 'week' | 'day' | 'agenda' | 'tasks' = 'week') {
  for (const fn of Object.values(store)) fn.mockReset();
  store.createEvent.mockImplementation(async (_c: unknown, data: Partial<CalendarEvent>) => ({ ...makeEvent(), ...data, id: 'new' }));
  store.updateEvent.mockResolvedValue(true);
  store.deleteEvent.mockResolvedValue(true);
  useAuthStore.setState({ isAuthenticated: true, client: client as never, isLoading: false, activeAccountId: 'acc' });
  useCalendarStore.setState({
    calendars, events, supportsCalendar: true, selectedCalendarIds: ['cal'], viewMode,
    selectedDate: new Date(2026, 9, 12), isLoading: false, isLoadingEvents: false, error: null,
    ...store,
  } as never);
  useSettingsStore.setState({ calendarHoverPreview: 'instant', enableCalendarTasks: true, proInterface: false } as never);
  useToastStore.setState({ toasts: [] } as never);
  useTaskStore.setState({ tasks: [] } as never);
  client.getCalendarTasks.mockResolvedValue([]);
}


beforeEach(() => {
  media.mobile = false;
  media.desktop = true;
  localStorage.clear();
  setUp();
});
afterEach(() => clearSlotOffers());

const frame = () => screen.queryByTestId('plugin-frame-app-side-panel');

describe('Calendar side panel', () => {
  it('has no button and no panel without a plugin', () => {
    render(<CalendarApp />);
    expect(document.querySelector('[data-plugin-panel-toggle]')).toBeNull();
    expect(frame()).toBeNull();
  });

  it('puts the button at the end of the toolbar row and the panel under it, with the open event', async () => {
    offerSlots('p1', ['app-side-panel']);
    render(<CalendarApp />);
    const toggle = document.querySelector<HTMLElement>('[data-plugin-panel-toggle]')!;
    const row = screen.getByTestId('calendar-view-menu').closest('.h-14')!;
    // The last control of the row: after the view menu.
    const buttons = Array.from(row.querySelectorAll('button'));
    expect(buttons[buttons.length - 1]).toBe(toggle);
    expect(toggle).toHaveAccessibleName('plugin_panel');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');

    // Open by default; the last thing in the row below the toolbar.
    const panel = document.querySelector<HTMLElement>('[data-app-side-panel]')!;
    expect(panel.parentElement!.lastElementChild).toBe(panel);
    expect(panel.parentElement!.getAttribute('data-tour')).toBe('calendar-view');
    expect(framePropsOf(frame()!)).toEqual({ view: 'calendar', context: {}, focusRequest: 0 });

    fireEvent.click(screen.getAllByRole('button', { name: /Standup/ })[0]);
    await screen.findByRole('dialog', { name: 'Standup' });
    await waitFor(() => expect((framePropsOf(frame()!).context as { event?: { title: string } }).event?.title).toBe('Standup'));

    fireEvent.click(toggle);
    expect(frame()).toBeNull();
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  it('has no panel on a phone', () => {
    media.mobile = true;
    media.desktop = false;
    offerSlots('p1', ['app-side-panel']);
    act(() => { render(<CalendarApp />); });
    expect(document.querySelector('[data-plugin-panel-toggle]')).toBeNull();
    expect(frame()).toBeNull();
  });
});
