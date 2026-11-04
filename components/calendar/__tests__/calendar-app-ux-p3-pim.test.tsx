import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';
import { useCalendarStore } from '@/stores/calendar-store';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useToastStore } from '@/stores/toast-store';
import { useTaskStore } from '@/stores/task-store';

// Pass 3 of the PIM usability audit, on the whole calendar page (harness as
// in calendar-app.test.tsx). The Day view is a stub that reports a sideways
// scroll, which jsdom can't lay out.

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
vi.mock('@/components/calendar/calendar-day-view', () => ({
  CalendarDayView: (props: { onVisibleDateChange?: (date: Date) => void }) => (
    <button type="button" onClick={() => props.onVisibleDateChange?.(new Date(2026, 9, 15))}>swipe-stub</button>
  ),
}));
const config = vi.hoisted(() => ({ demoMode: false }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => config }));
const lite = vi.hoisted(() => ({ on: false }));
vi.mock('@/lib/lite', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/lite')>()),
  get IS_LITE() { return lite.on; },
}));

import { CalendarApp } from '../calendar-app';

// The first render loads the whole page and is slow under load.
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

function renderApp() {
  return render(<CalendarApp />);
}

beforeEach(() => {
  media.mobile = false;
  media.desktop = true;
  setUp();
});


const sameDay = (a: Date, y: number, m: number, d: number) => a.getFullYear() === y && a.getMonth() === m && a.getDate() === d;

describe('the mini calendar (pim-p3-4)', () => {
  it('pages only itself with its arrows; a picked day moves the view', async () => {
    renderApp();
    const before = useCalendarStore.getState().selectedDate;
    const shown = () => Array.from(document.querySelectorAll<HTMLElement>('[data-mini-day]')).map((b) => b.dataset.miniDay!);
    const firstMonth = shown()[10].slice(0, 7);
    fireEvent.click(screen.getByRole('button', { name: 'mini_next_month' }));
    await waitFor(() => expect(shown()[10].slice(0, 7)).not.toBe(firstMonth));
    // The week on screen stays.
    expect(useCalendarStore.getState().selectedDate).toEqual(before);
    const target = shown()[10];
    fireEvent.click(document.querySelector<HTMLElement>(`[data-mini-day="${target}"]`)!);
    const [y, m, d] = target.split('-').map(Number);
    expect(sameDay(useCalendarStore.getState().selectedDate, y, m - 1, d)).toBe(true);
  });
});

describe('leaving the event editor (pim-p3-8)', () => {
  it.each(['cancel', 'escape'] as const)('returns to the grid from an editor opened on the card (%s), with the event focused', async (how) => {
    renderApp();
    fireEvent.click(screen.getAllByRole('button', { name: /Standup/ })[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'events.edit' }));
    await screen.findByRole('dialog', { name: 'events.edit' });
    if (how === 'cancel') fireEvent.click(screen.getByRole('button', { name: 'form.cancel' }));
    else fireEvent.keyDown(window, { key: 'Escape' });
    // No panel showing the event, and no card for it either.
    await waitFor(() => expect(screen.queryByTestId('event-panel')).toBeNull());
    expect(screen.queryByRole('dialog', { name: 'Standup' })).toBeNull();
    await waitFor(() => expect((document.activeElement as HTMLElement | null)?.getAttribute('data-event-id')).toBe('e1'));
  });
});

describe('a sideways scroll in Day view (pim-p3-9)', () => {
  it('moves the selection, the address and the mini calendar to the day it rests on', async () => {
    setUp([makeEvent()], 'day');
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'swipe-stub' }));
    await waitFor(() => expect(sameDay(useCalendarStore.getState().selectedDate, 2026, 9, 15)).toBe(true));
    await waitFor(() => expect(window.location.pathname).toContain('/calendar/day/2026-10-15'));
    expect(document.querySelector('[data-mini-day="2026-10-15"]')?.closest('[role="gridcell"]')?.getAttribute('aria-selected')).toBe('true');
  });
});

describe('an event without a title (pim-p3-12)', () => {
  it('saves from the full editor too, with an empty title', async () => {
    renderApp();
    fireEvent.keyDown(document.body, { key: 'n', code: 'KeyN' });
    const save = await screen.findByRole('button', { name: 'form.save' });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(store.createEvent).toHaveBeenCalledTimes(1));
    expect(store.createEvent.mock.calls[0][1]).toMatchObject({ title: '' });
  });
});
