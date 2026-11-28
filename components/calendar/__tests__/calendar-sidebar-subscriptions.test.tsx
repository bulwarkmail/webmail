import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CalendarSidebarPanel } from '../calendar-sidebar-panel';
import { useCalendarStore } from '@/stores/calendar-store';
import { useSettingsStore } from '@/stores/settings-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Calendar } from '@/lib/jmap/types';

// #1731: while unsubscribed shared calendars are hidden, a shared calendar's
// menu in the sidebar unsubscribes from it.

const team = {
  id: 'owner:team', originalId: 'team', accountId: 'owner', isShared: true,
  name: 'Team', color: '#22c55e', sortOrder: 0, isSubscribed: true, isVisible: true, isDefault: false,
  includeInAvailability: 'all', timeZone: null, shareWith: null,
  myRights: { mayReadItems: true, mayWriteAll: false, mayWriteOwn: false, mayDelete: false },
} as unknown as Calendar;

const updateCalendar = vi.fn();
const client = { getAccountId: () => 'me', updateCalendar } as unknown as IJMAPClient;

function openMenu() {
  render(
    <CalendarSidebarPanel
      calendars={[team]}
      selectedCalendarIds={[team.id]}
      onToggleVisibility={() => {}}
      onColorChange={() => {}}
      client={client}
    />,
  );
  fireEvent.contextMenu(screen.getByTestId('calendar-item'), { clientX: 20, clientY: 20 });
}

beforeEach(() => {
  updateCalendar.mockReset().mockResolvedValue(undefined);
  useCalendarStore.setState({ calendars: [team] } as never);
});

describe('CalendarSidebarPanel unsubscribe from a shared calendar', () => {
  it('unsubscribes on the server', async () => {
    useSettingsStore.setState({ hideUnsubscribedCalendars: true } as never);
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'unsubscribe' }));
    await waitFor(() => expect(updateCalendar).toHaveBeenCalledExactlyOnceWith('team', { isSubscribed: false }, 'owner'));
    expect(useCalendarStore.getState().calendars[0].isSubscribed).toBe(false);
  });

  it('offers it only while unsubscribed calendars are hidden', async () => {
    useSettingsStore.setState({ hideUnsubscribedCalendars: false } as never);
    openMenu();
    await screen.findAllByRole('menuitem');
    expect(screen.queryByRole('menuitem', { name: 'unsubscribe' })).toBeNull();
  });
});
