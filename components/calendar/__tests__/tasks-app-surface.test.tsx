import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Calendar, CalendarTask } from '@/lib/jmap/types';
import { useCalendarStore } from '@/stores/calendar-store';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useTaskStore } from '@/stores/task-store';

// #1698: Tasks as an app of their own (/tasks), and the calendar without its
// Tasks view while that option is on.

vi.mock('@/hooks/use-media-query', () => ({
  useIsMobile: () => false,
  useIsDesktop: () => true,
  useIsFullDesktop: () => true,
  useIsTablet: () => false,
  useMediaQuery: () => false,
}));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/tasks',
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
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
const task = (id: string, title: string, extra: Partial<CalendarTask> = {}) => ({
  id, '@type': 'Task', title, progress: 'needs-action', calendarIds: { cal: true }, ...extra,
}) as unknown as CalendarTask;
const tasks = [
  task('t1', 'Water the plants'),
  task('t2', 'File the expenses', { due: '2020-01-02T00:00:00', showWithoutTime: true }),
  task('t3', 'Book the flights', { progress: 'completed' }),
];
const client = {
  getAccountId: () => 'acc',
  getMaxParticipantsPerEvent: () => null,
  supportsCalendars: () => true,
  queryCalendarEvents: vi.fn().mockResolvedValue([]),
  getCalendarEvent: vi.fn().mockResolvedValue(null),
  getCalendarTasks: vi.fn().mockResolvedValue(tasks),
};

beforeEach(() => {
  router.push.mockClear();
  router.replace.mockClear();
  useAuthStore.setState({ isAuthenticated: true, client: client as never, isLoading: false, activeAccountId: 'acc' });
  useCalendarStore.setState({
    calendars, events: [], supportsCalendar: true, selectedCalendarIds: ['cal'], viewMode: 'week',
    selectedDate: new Date(2026, 9, 12), isLoading: false, isLoadingEvents: false, error: null,
    hiddenTaskListIds: [],
    fetchCalendars: vi.fn(), fetchEvents: vi.fn(), refreshAllSubscriptions: vi.fn(),
  } as never);
  useSettingsStore.setState({ enableCalendarTasks: true, showTasksApp: true, proInterface: false } as never);
  useTaskStore.setState({ tasks, filter: 'all', fetchTasks: vi.fn() } as never);
});

afterEach(() => cleanup());

const viewMenuItems = () => {
  fireEvent.click(screen.getByTestId('calendar-view-menu'));
  // The label without the shortcut letter beside it.
  return screen.getAllByRole('menuitemradio').map((item) => item.textContent?.replace(/[A-Z]$/, ''));
};

describe('the Tasks app', () => {
  it('shows the task list with its own name, and no calendar views or dates', () => {
    render(<CalendarApp surface="tasks" />);
    expect(screen.getByPlaceholderText('tasks.quick_add_placeholder')).toBeInTheDocument();
    expect(screen.getByText('Water the plants')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'tasks' })).toBeInTheDocument();
    expect(screen.queryByTestId('calendar-view-menu')).toBeNull();
    expect(screen.queryByText('views.today')).toBeNull();
    // The calendar's own view is left as it was.
    expect(useCalendarStore.getState().viewMode).toBe('week');
  });

  it('lists the filters in the sidebar with their counts, and picks one there', () => {
    render(<CalendarApp surface="tasks" />);
    const filters = screen.getByTestId('tasks-sidebar-filters');
    const entries = Array.from(filters.querySelectorAll('button')).map((b) => b.textContent);
    expect(entries).toEqual(['tasks.filter_all3', 'tasks.filter_pending2', 'tasks.filter_overdue1', 'tasks.filter_completed1']);
    fireEvent.click(screen.getByRole('button', { name: /tasks\.filter_overdue/ }));
    expect(useTaskStore.getState().filter).toBe('overdue');
    expect(screen.queryByText('Water the plants')).toBeNull();
    expect(screen.getByText('File the expenses')).toBeInTheDocument();
  });

  it('makes a task with N', () => {
    render(<CalendarApp surface="tasks" />);
    fireEvent.keyDown(document.body, { key: 'n', code: 'KeyN' });
    expect(screen.getByRole('textbox', { name: 'tasks.title_placeholder' })).toBeInTheDocument();
  });

  it('goes back to the calendar when tasks are turned off', () => {
    useSettingsStore.setState({ enableCalendarTasks: false });
    render(<CalendarApp surface="tasks" />);
    expect(router.replace).toHaveBeenCalledWith('/calendar');
  });
});

describe('the calendar while Tasks have their own app', () => {
  it('offers its four views, without Tasks', () => {
    render(<CalendarApp />);
    expect(viewMenuItems()).toEqual(['views.day', 'views.week', 'views.month', 'views.agenda']);
  });

  it('opens the Tasks app for K instead of a view of its own', () => {
    render(<CalendarApp />);
    act(() => { fireEvent.keyDown(document.body, { key: 'k', code: 'KeyK' }); });
    expect(router.push).toHaveBeenCalledWith('/tasks');
    expect(useCalendarStore.getState().viewMode).toBe('week');
  });

  it('shows the month where the Tasks view was left open', () => {
    useCalendarStore.setState({ viewMode: 'tasks' });
    render(<CalendarApp />);
    expect(screen.getByTestId('calendar-view-menu').textContent).toContain('views.month');
    expect(screen.queryByPlaceholderText('tasks.quick_add_placeholder')).toBeNull();
  });

  it('keeps the Tasks view while the option is off', () => {
    useSettingsStore.setState({ showTasksApp: false });
    render(<CalendarApp />);
    act(() => { fireEvent.keyDown(document.body, { key: 'k', code: 'KeyK' }); });
    expect(router.push).not.toHaveBeenCalledWith('/tasks');
    expect(useCalendarStore.getState().viewMode).toBe('tasks');
    expect(viewMenuItems()).toContain('views.tasks');
  });
});
