import { render, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CalendarAgendaView } from '../calendar-agenda-view';
import { EventCard } from '../event-card';
import { EventModal } from '../event-modal';
import { CalendarSearchResults } from '../calendar-search';
import { ContactDuplicatesView } from '@/components/contacts/contact-duplicates-view';
import type { AddressBook, Calendar, CalendarEvent, ContactCard } from '@/lib/jmap/types';

// pim-p2-3, pim-p3-5: Stalwart names a new account's calendar and address book
// "Stalwart Calendar (<address>)" and "Stalwart Address Book (<address>)". Every
// view says "Calendar" and "Contacts" instead (one helper, useCollectionNames),
// in visible text and in screen-reader names alike.

vi.mock('../participant-availability', () => ({ ParticipantAvailability: () => null }));
vi.mock('@/hooks/use-display-date-formatter', () => ({
  useDisplayDateFormatter: () => ({ dateTime: (d: Date) => d.toISOString().slice(0, 10) }),
}));

class FakeIntersectionObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}
globalThis.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;

const calendar = {
  id: 'cal', name: 'Stalwart Calendar (sam@example.org)', color: '#123456', isDefault: true,
  myRights: {
    mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayWriteOwn: true,
    mayUpdatePrivate: true, mayRSVP: true, mayShare: true, mayDelete: true,
  },
} as unknown as Calendar;

const event = {
  id: 'e1', uid: 'u1', '@type': 'Event', title: 'Planning', description: '', start: '2026-10-12T10:00:00',
  duration: 'PT1H30M', timeZone: null, showWithoutTime: false, calendarIds: { cal: true },
  locations: { l: { name: 'Room 2' } }, participants: null, alerts: null, recurrenceRules: null,
} as unknown as CalendarEvent;

const book = { id: 'b', name: 'Stalwart Address Book (sam@example.org)', isDefault: true } as unknown as AddressBook;
const card = (id: string) => ({
  id, addressBookIds: { b: true }, name: { full: 'Alice Example' }, emails: { e: { address: 'alice@example.org' } },
}) as unknown as ContactCard;

/** Everything a person or a screen reader gets: the text and every attribute. */
function rendered(container: HTMLElement): string {
  return container.innerHTML;
}

afterEach(cleanup);

describe('no raw server name for the default calendar or address book', () => {
  it('Agenda', () => {
    const { container } = render(
      <CalendarAgendaView
        focus={{ date: new Date(2026, 9, 12), nonce: 0 }}
        windowKey="agenda:2026-10-12"
        events={[event]}
        calendars={[calendar]}
        rangeStart={new Date(2026, 9, 12)}
        rangeEnd={new Date(2026, 9, 20)}
        onSelectEvent={vi.fn()}
      />,
    );
    expect(rendered(container)).toContain('Planning');
    expect(rendered(container)).not.toContain('Stalwart Calendar');
    expect(rendered(container)).toContain('default_calendar');
  });

  it('event blocks, their screen-reader names included', () => {
    const { container } = render(<EventCard event={event} calendar={calendar} variant="block" />);
    expect(rendered(container)).not.toContain('Stalwart Calendar');
    expect(container.querySelector('[aria-label]')?.getAttribute('aria-label')).toContain('default_calendar');
  });

  it('the event side panel, with the length as the popover writes it', () => {
    const { container } = render(<EventModal event={event} calendars={[calendar]} onSave={vi.fn()} onClose={vi.fn()} currentUserEmails={['sam@example.org']} />);
    expect(rendered(container)).toContain('Planning');
    expect(rendered(container)).not.toContain('Stalwart Calendar');
    expect(rendered(container)).not.toContain('1h30min');
  });

  it('calendar search results', () => {
    const { container } = render(
      <CalendarSearchResults
        query="Planning"
        results={{ upcoming: [event], past: [], searching: false } as never}
        calendars={[calendar]}
        onSelectEvent={vi.fn()}
        onClearSearch={vi.fn()}
      />,
    );
    expect(rendered(container)).toContain('Planning');
    expect(rendered(container)).not.toContain('Stalwart Calendar');
  });

  it('Contacts > Possible duplicates', () => {
    const { container } = render(
      <ContactDuplicatesView groups={[[card('c1'), card('c2')]]} addressBooks={[book]} onMerge={vi.fn()} onOpen={vi.fn()} />,
    );
    expect(rendered(container)).toContain('Alice Example');
    expect(rendered(container)).not.toContain('Stalwart Address Book');
    expect(rendered(container)).toContain('default_address_book');
  });
});
