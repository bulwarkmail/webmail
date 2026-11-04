import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { CalendarSidebarPanel } from '../calendar-sidebar-panel';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Calendar } from '@/lib/jmap/types';

// On phones and tablets a calendar's actions (share, colour, default,
// delete) were behind a ⋮ that only showed on hover, and nothing opened on a
// long press.

const work = {
  id: 'work', name: 'Work', color: '#3b82f6', sortOrder: 0, isSubscribed: true, isVisible: true,
  isDefault: false, includeInAvailability: 'all', timeZone: null, shareWith: null,
  myRights: { mayReadItems: true, mayWriteAll: true, mayWriteOwn: true, mayDelete: true, mayShare: true },
} as unknown as Calendar;
const client = { getAccountId: () => 'acct' } as unknown as IJMAPClient;

describe('CalendarSidebarPanel on touch screens', () => {
  it('keeps the row ⋮ visible on touch and keyboard focus', () => {
    render(<CalendarSidebarPanel calendars={[work]} selectedCalendarIds={['work']} onToggleVisibility={() => {}} client={client} />);
    const more = screen.getByRole('button', { name: 'calendar_options' });
    expect(more.className).toContain('pointer-coarse:opacity-100');
    expect(more.className).toContain('group-focus-within/cal:opacity-100');
  });

  it('opens a calendar\'s menu on a long press', async () => {
    render(<CalendarSidebarPanel calendars={[work]} selectedCalendarIds={['work']} onToggleVisibility={() => {}} onDeleteCalendar={() => {}} client={client} />);
    fireEvent.touchStart(screen.getByTestId('calendar-item'), { touches: [{ clientX: 20, clientY: 20 }] });
    // "Delete…" in the menu, as it opens a dialog (pim-20).
    expect(await screen.findByRole('menuitem', { name: 'delete_calendar' }, { timeout: 2000 })).toBeInTheDocument();
  });
});
