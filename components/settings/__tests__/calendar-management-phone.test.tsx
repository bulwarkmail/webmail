import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Calendar } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';

// Settings > Calendar on a phone: no right-click hint on a touch screen, a
// colour dot that can be hit, and no Import or Subscribe in the demo, which
// Calendar itself hides there too.

const env = vi.hoisted(() => ({ touch: false, demoMode: false }));
vi.mock('@/hooks/use-media-query', () => ({
  useMediaQuery: (query: string) => (query === '(pointer: coarse)' ? env.touch : false),
  useIsMobile: () => env.touch,
  useIsDesktop: () => !env.touch,
}));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ demoMode: env.demoMode }) }));

const { CalendarManagementSettings } = await import('../calendar-management-settings');

const work = {
  id: 'c', name: 'Work', color: '#3b82f6', isDefault: true, isShared: false, shareWith: null,
  myRights: { mayShare: true, mayDelete: true, mayWriteAll: true },
} as unknown as Calendar;

const initial = { auth: useAuthStore.getState(), calendar: useCalendarStore.getState() };
beforeEach(() => {
  env.touch = false;
  env.demoMode = false;
  useAuthStore.setState({ client: { getAccountId: () => 'acc' }, serverUrl: null, username: null } as never);
  useCalendarStore.setState({ calendars: [work], icalSubscriptions: [] } as never);
});
afterEach(() => {
  useAuthStore.setState(initial.auth, true);
  useCalendarStore.setState(initial.calendar, true);
});

describe('Settings > Calendar on a phone', () => {
  it('mentions right-click only where there is a mouse', () => {
    const { unmount } = render(<CalendarManagementSettings />);
    expect(screen.getByText('description')).toBeInTheDocument();
    unmount();

    env.touch = true;
    render(<CalendarManagementSettings />);
    expect(screen.queryByText('description')).toBeNull();
    expect(screen.getByText('description_touch')).toBeInTheDocument();
  });

  it('gives the colour dot a 44px hit area on touch', () => {
    render(<CalendarManagementSettings />);
    const dot = screen.getByRole('button', { name: 'change_color' });
    expect(dot.className).toContain('large-targets:after:min-h-11');
    expect(dot.className).toContain('large-targets:after:min-w-11');
  });

  it('offers Import and Subscribe only outside the demo', () => {
    const { unmount } = render(<CalendarManagementSettings />);
    // Both dialogs' titles are "title" here: one button each.
    expect(screen.getAllByRole('button', { name: 'title' })).toHaveLength(2);
    unmount();

    env.demoMode = true;
    render(<CalendarManagementSettings />);
    expect(screen.queryByRole('button', { name: 'title' })).toBeNull();
    expect(screen.getByRole('button', { name: 'add_calendar' })).toBeInTheDocument();
  });

  // settings-p2-21: at 800 px the three buttons ran 4 px past the edge.
  it('lets the New, Import and Subscribe buttons wrap when a row is too narrow', () => {
    render(<CalendarManagementSettings />);
    const row = screen.getByTestId('calendar-create-buttons');
    expect(row.className).toMatch(/(^|\s)sm:flex-wrap(\s|$)/);
    expect(row.querySelectorAll('button')).toHaveLength(3);
  });
});
