import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { CalendarSidebarPanel } from '../calendar-sidebar-panel';
import { createCompanyCalendar } from '@/lib/company-calendars';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Calendar } from '@/lib/jmap/types';

// Company calendars sit under "Organisation", apart from the user's own,
// and can only be shown or hidden: no menu to recolour, share or delete.

const own = {
  id: 'b', name: 'Mine', color: '#2563eb', sortOrder: 0, isSubscribed: true, isVisible: true, isDefault: true,
  includeInAvailability: 'all', timeZone: null, shareWith: null,
  myRights: { mayReadItems: true, mayWriteAll: true, mayWriteOwn: true, mayDelete: true, mayShare: true },
} as unknown as Calendar;
const company = createCompanyCalendar({ id: 'hol', name: 'Holidays', color: '#16a34a' });

describe('CalendarSidebarPanel company calendars', () => {
  it('lists them under Organisation, toggles them and offers no menu', () => {
    const onToggle = vi.fn();
    render(
      <CalendarSidebarPanel
        calendars={[own, company]}
        selectedCalendarIds={['b', company.id]}
        onToggleVisibility={onToggle}
        client={{ getAccountId: () => 'me' } as unknown as IJMAPClient}
      />,
    );
    const section = screen.getByTestId('company-calendars-section');
    expect(section).toHaveTextContent('section');
    const item = within(section).getByText('Holidays');
    fireEvent.click(item);
    expect(onToggle).toHaveBeenCalledWith(company.id);
    expect(within(section).queryByRole('button', { name: 'calendar_options' })).toBeNull();
    // The user's own calendar is not in the section.
    expect(within(section).queryByText('Mine')).toBeNull();
  });
});
