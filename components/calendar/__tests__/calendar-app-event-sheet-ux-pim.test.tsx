import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';
import { useCalendarStore } from '@/stores/calendar-store';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useTaskStore } from '@/stores/task-store';

// pim-25: the event editor sat beside the week grid and squeezed its seven
// columns to ~85 px at 1366x768. It now opens as a sheet over the grid from
// the right, and the grid keeps its width.

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
const event = {
  id: 'e1', uid: 'u1', '@type': 'Event', title: 'Standup', description: '', start: '2026-10-12T10:00:00',
  duration: 'PT1H', timeZone: null, showWithoutTime: false, calendarIds: { cal: true },
  participants: null, alerts: null, recurrenceRules: null, isOrigin: true, status: 'confirmed',
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
  useAuthStore.setState({ isAuthenticated: true, client: client as never, isLoading: false, activeAccountId: 'acc' });
  useCalendarStore.setState({
    calendars, events: [event], supportsCalendar: true, selectedCalendarIds: ['cal'], viewMode: 'week',
    selectedDate: new Date(2026, 9, 12), isLoading: false, isLoadingEvents: false, error: null,
    fetchCalendars: vi.fn(), fetchEvents: vi.fn(), refreshAllSubscriptions: vi.fn(),
    createEvent: vi.fn(), updateEvent: vi.fn(), deleteEvent: vi.fn(), rsvpEvent: vi.fn(),
  } as never);
  useSettingsStore.setState({ calendarHoverPreview: 'instant', enableCalendarTasks: true, proInterface: false } as never);
  useTaskStore.setState({ tasks: [] } as never);
});

describe('CalendarApp event editor (pim-25)', () => {
  it('opens over the grid instead of beside it', async () => {
    render(<CalendarApp />);
    fireEvent.keyDown(document.body, { key: 'n', code: 'KeyN' });
    const editor = await screen.findByRole('dialog', { name: 'events.create' });
    const sheet = editor.parentElement!;
    // Out of the row's flow, pinned to its end edge, above the grid.
    expect(sheet.className).toMatch(/\babsolute\b/);
    expect(sheet.className).toMatch(/\binset-y-0\b/);
    expect(sheet.className).toMatch(/\bend-0\b/);
    expect(sheet.className).not.toMatch(/\bflex-shrink-0\b/);
    expect(sheet.parentElement!.className).toMatch(/\brelative\b/);
  });
});
