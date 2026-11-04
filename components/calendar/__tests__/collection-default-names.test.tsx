import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { CalendarSidebarPanel } from '../calendar-sidebar-panel';
import { ContactsSidebar } from '@/components/contacts/contacts-sidebar';
import { collectionLabel } from '@/lib/default-collection-name';
import type { AddressBook, Calendar } from '@/lib/jmap/types';

// next-intl is mocked globally in vitest.setup: t returns the key.
vi.mock('@/stores/account-store', () => {
  const state = { accounts: [], activeAccountId: null };
  const hook = (sel?: (s: typeof state) => unknown) => (typeof sel === 'function' ? sel(state) : state);
  hook.getState = () => state;
  return { useAccountStore: hook };
});

function cal(overrides: Partial<Calendar>): Calendar {
  return {
    id: 'c', name: 'Cal', color: '#3b82f6', sortOrder: 0, isSubscribed: true, isVisible: true,
    isDefault: false, includeInAvailability: 'all', timeZone: null, shareWith: null,
    myRights: { mayWriteOwn: true, mayShare: false, mayDelete: true },
    ...overrides,
  } as unknown as Calendar;
}

function book(overrides: Partial<AddressBook>): AddressBook {
  return {
    id: 'b', name: 'Book', isDefault: false, isSubscribed: true, sortOrder: 0, shareWith: null,
    myRights: { mayRead: true, mayWrite: true, mayShare: false, mayDelete: true },
    ...overrides,
  } as unknown as AddressBook;
}

describe('the server\'s default calendar and address book names (settings-36)', () => {
  it('reads "Calendar" in the calendar sidebar, as in Settings, and keeps names the user chose', () => {
    render(
      <CalendarSidebarPanel
        calendars={[
          cal({ id: 'd', name: 'Stalwart Calendar (sam@example.org)', isDefault: true }),
          cal({ id: 'w', name: 'Work' }),
        ]}
        selectedCalendarIds={['d', 'w']}
        onToggleVisibility={() => {}}
      />,
    );
    expect(screen.queryByText('Stalwart Calendar (sam@example.org)')).toBeNull();
    expect(screen.getByText('default_calendar')).toBeInTheDocument();
    expect(screen.getByText('Work')).toBeInTheDocument();
  });

  it('reads "Contacts" in the contacts sidebar', () => {
    render(
      <ContactsSidebar
        groups={[]}
        individuals={[]}
        addressBooks={[
          book({ id: 'd', name: 'Stalwart Address Book (sam@example.org)', isDefault: true }),
          book({ id: 'f', name: 'Family' }),
        ]}
        activeCategory="all"
        onSelectCategory={vi.fn()}
        onCreateGroup={vi.fn()}
        onCreateContact={vi.fn()}
        onEditGroup={vi.fn()}
        onDeleteGroup={vi.fn()}
        onComposeGroup={vi.fn()}
      />,
    );
    expect(screen.queryByText('Stalwart Address Book (sam@example.org)')).toBeNull();
    expect(screen.getAllByText('default_address_book').length).toBeGreaterThan(0);
    expect(screen.getByText('Family')).toBeInTheDocument();
  });

  it('keeps whose a colleague\'s shared default calendar is', () => {
    expect(collectionLabel({ name: 'Stalwart Calendar (bob@example.org)', isShared: true }, 'calendar', 'Calendar')).toBe('Calendar (bob@example.org)');
    expect(collectionLabel({ name: 'Stalwart Calendar (sam@example.org)' }, 'calendar', 'Calendar')).toBe('Calendar');
    expect(collectionLabel({ name: 'Team', isShared: true }, 'calendar', 'Calendar')).toBe('Team');
  });
});
