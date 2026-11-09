import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';
import { useCalendarStore } from '@/stores/calendar-store';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useToastStore } from '@/stores/toast-store';
import { useTaskStore } from '@/stores/task-store';

// The whole calendar page, with the shell around it stubbed out and the
// stores holding a fixed set of calendars and events.

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
  setUp([makeEvent({
    description: 'Agenda in the doc',
    locations: { l: { '@type': 'Location', name: 'Room 4' } },
    participants: {
      me: { '@type': 'Participant', email: 'me@example.com', roles: { owner: true, attendee: true }, participationStatus: 'accepted' },
      ben: { '@type': 'Participant', email: 'ben@example.com', name: 'Ben', roles: { attendee: true }, participationStatus: 'needs-action' },
    },
  } as never)]);
  useCalendarStore.setState({ participantIdentities: [{ id: 'pi', name: 'Me', calendarAddress: 'mailto:me@example.com', isDefault: true }] } as never);
});

// pim-p2-17: Duplicate saved a copy one day later at once and opened it to
// view, so a mistaken click left an event behind. Google and Outlook open the
// editor with an unsaved copy at the same time instead.
describe('Duplicate opens an unsaved copy in the editor', () => {
  async function duplicateFromMenu() {
    renderApp();
    fireEvent.contextMenu(screen.getAllByRole('button', { name: /Standup/ })[0], { clientX: 50, clientY: 50 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'events.duplicate' }));
    return screen.findByRole('dialog', { name: 'events.create' });
  }

  it('saves nothing until Save, and the form holds the copy at the same date and time', async () => {
    await duplicateFromMenu();
    expect((screen.getByLabelText('form.title') as HTMLInputElement).value).toBe('Standup');
    expect((screen.getByLabelText('form.start_date') as HTMLInputElement).value).toBe('2026-10-12');
    expect((screen.getByLabelText('form.start_time') as HTMLInputElement).value).toBe('10:00');
    expect(store.createEvent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'form.save' }));
    await waitFor(() => expect(store.createEvent).toHaveBeenCalledTimes(1));
    const data = store.createEvent.mock.calls[0][1] as Partial<CalendarEvent>;
    expect(data).toMatchObject({ title: 'Standup', start: '2026-10-12T10:00:00', calendarIds: { cal: true }, description: 'Agenda in the doc' });
    expect(data.uid).toBeTruthy();
    expect(data.uid).not.toBe('u1');
    expect(Object.values(data.locations ?? {})[0]?.name).toBe('Room 4');
    const emails = Object.values(data.participants ?? {}).map((p) => p.email);
    expect(emails).toContain('ben@example.com');
    // The copy is the user's own: the user organizes it.
    const owner = Object.values(data.participants ?? {}).find((p) => p.roles?.owner);
    expect(owner?.email).toBe('me@example.com');
  });

  it('leaves nothing behind when the copy is closed', async () => {
    await duplicateFromMenu();
    fireEvent.click(screen.getByRole('button', { name: 'form.cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'events.create' })).toBeNull());
    expect(store.createEvent).not.toHaveBeenCalled();
  });
});
