import { act, render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';
import { useCalendarStore } from '@/stores/calendar-store';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useToastStore } from '@/stores/toast-store';
import { useTaskStore } from '@/stores/task-store';

// An event or task editor, the event's card and the scope question hold the
// ids of the login they were opened under: the event, its calendar, the
// task. The same ids name other events, calendars and tasks in every other
// login, and a save goes through whichever login is active then. So when the
// active login changes they close, as the contact editor does; nothing is
// saved through the new login.
// Harness of calendar-app.test.tsx.

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
}] as unknown as Calendar[];
const standup = {
  id: 'e1', uid: 'u1', '@type': 'Event', title: 'Standup', description: '', start: '2026-10-12T10:00:00',
  duration: 'PT1H', timeZone: null, showWithoutTime: false, calendarIds: { cal: true },
  participants: null, alerts: null, recurrenceRules: null, isOrigin: true, status: 'confirmed',
} as unknown as CalendarEvent;

const makeClient = (account: string) => ({
  getAccountId: () => account,
  getMaxParticipantsPerEvent: () => null,
  supportsCalendars: () => true,
  queryCalendarEvents: vi.fn().mockResolvedValue([]),
  getCalendarEvent: vi.fn().mockResolvedValue(null),
  getCalendarTasks: vi.fn().mockResolvedValue([]),
});
const clientA = makeClient('acc');
const clientB = makeClient('bcc');
const store = {
  fetchCalendars: vi.fn(),
  fetchEvents: vi.fn(),
  refreshAllSubscriptions: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
  rsvpEvent: vi.fn(),
};

function setUp(viewMode: 'week' | 'tasks' = 'week') {
  for (const fn of Object.values(store)) fn.mockReset();
  store.createEvent.mockImplementation(async (_c: unknown, data: Partial<CalendarEvent>) => ({ ...standup, ...data, id: 'new' }));
  store.updateEvent.mockResolvedValue(true);
  store.deleteEvent.mockResolvedValue(true);
  useAuthStore.setState({ isAuthenticated: true, client: clientA as never, isLoading: false, activeAccountId: 'login-a' });
  useCalendarStore.setState({
    calendars, events: [standup], supportsCalendar: true, selectedCalendarIds: ['cal'], viewMode,
    selectedDate: new Date(2026, 9, 12), isLoading: false, isLoadingEvents: false, error: null,
    ...store,
  } as never);
  useSettingsStore.setState({ calendarHoverPreview: 'instant', enableCalendarTasks: true, proInterface: false } as never);
  useToastStore.setState({ toasts: [] } as never);
  useTaskStore.setState({ tasks: [], createTask: vi.fn().mockResolvedValue(null), updateTask: vi.fn().mockResolvedValue(true) } as never);
}

/** The account switch: another login becomes the active one, the page stays. */
function switchToLoginB() {
  act(() => {
    useAuthStore.setState({ client: clientB as never, activeAccountId: 'login-b' });
  });
}

function openEditorOnStandup() {
  fireEvent.click(screen.getAllByRole('button', { name: /Standup/ })[0]);
  const card = screen.getByRole('dialog', { name: 'Standup' });
  fireEvent.click(within(card).getByRole('button', { name: 'events.edit' }));
}

/** Save, where a save button is still there to press. */
async function saveIfOpen() {
  const save = screen.queryByRole('button', { name: 'form.save' });
  if (save) await act(async () => { fireEvent.click(save); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

beforeEach(() => setUp());

describe('the calendar\'s editors across an account switch', () => {
  it('closes the editor of an event, and saves nothing through the new login', async () => {
    render(<CalendarApp />);
    openEditorOnStandup();
    fireEvent.change(screen.getByPlaceholderText('form.title'), { target: { value: 'Standup moved' } });
    switchToLoginB();
    await waitFor(() => expect(screen.queryByPlaceholderText('form.title')).toBeNull());
    await saveIfOpen();
    expect(store.updateEvent).not.toHaveBeenCalled();
    // No question about the typed changes is left standing either.
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('a Save pressed right after the switch writes nothing through the new login', async () => {
    render(<CalendarApp />);
    openEditorOnStandup();
    fireEvent.change(screen.getByPlaceholderText('form.title'), { target: { value: 'Standup moved' } });
    switchToLoginB();
    await saveIfOpen();
    expect(store.updateEvent.mock.calls.filter((call) => call[0] === clientB)).toEqual([]);
  });

  it('closes the editor of a new event, and creates nothing in the new login\'s calendar with that id', async () => {
    render(<CalendarApp />);
    fireEvent.keyDown(document.body, { key: 'n', code: 'KeyN' });
    fireEvent.change(screen.getByPlaceholderText('form.title'), { target: { value: 'Lunch' } });
    switchToLoginB();
    await waitFor(() => expect(screen.queryByPlaceholderText('form.title')).toBeNull());
    await saveIfOpen();
    expect(store.createEvent).not.toHaveBeenCalled();
  });

  it('closes the event\'s card', async () => {
    render(<CalendarApp />);
    fireEvent.click(screen.getAllByRole('button', { name: /Standup/ })[0]);
    expect(screen.getByRole('dialog', { name: 'Standup' })).toBeInTheDocument();
    switchToLoginB();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Standup' })).toBeNull());
  });

  it('closes the task editor, and saves nothing through the new login', async () => {
    setUp('tasks');
    render(<CalendarApp />);
    fireEvent.keyDown(document.body, { key: 'n', code: 'KeyN' });
    fireEvent.change(screen.getByPlaceholderText('tasks.title_placeholder'), { target: { value: 'Buy milk' } });
    switchToLoginB();
    await waitFor(() => expect(screen.queryByPlaceholderText('tasks.title_placeholder')).toBeNull());
    expect(useTaskStore.getState().createTask).not.toHaveBeenCalled();
  });

  it('keeps an editor open while the same login stays active, as before', async () => {
    render(<CalendarApp />);
    openEditorOnStandup();
    fireEvent.change(screen.getByPlaceholderText('form.title'), { target: { value: 'Standup moved' } });
    act(() => {
      useAuthStore.setState({ username: 'ann@example.org' });
    });
    expect(screen.getByPlaceholderText('form.title')).toHaveValue('Standup moved');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'form.save' })); });
    await waitFor(() => expect(store.updateEvent).toHaveBeenCalled());
    expect(store.updateEvent.mock.calls[0][0]).toBe(clientA);
    expect(store.updateEvent.mock.calls[0][1]).toBe('e1');
  });
});
