import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { EventModal } from '../event-modal';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';

// With two logins the editor lists every login's calendars. Moving an existing
// event into another login's calendar sent that calendar's raw id to the
// event's own server, which either moved it into an unrelated calendar there
// or failed. An existing event now moves only within its own login; a new
// event can still go anywhere.

vi.mock('../participant-availability', () => ({ ParticipantAvailability: () => null }));

const rights = {
  mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayWriteOwn: true,
  mayUpdatePrivate: true, mayRSVP: true, mayShare: true, mayDelete: true,
};
const calendars = [
  { id: 'a-personal', name: 'A Personal', color: '#123456', isDefault: true, myRights: rights },
  { id: 'a-work', name: 'A Work', color: '#123456', isDefault: false, myRights: rights },
  { id: 'login-b:b', name: 'B Personal', color: '#654321', isDefault: true, myRights: rights, localAccountId: 'login-b', originalId: 'b' },
] as unknown as Calendar[];

const event = {
  id: 'e1', uid: 'u1', '@type': 'Event', title: 'Planning', description: '', start: '2026-10-12T10:00:00',
  duration: 'PT1H', timeZone: 'Europe/Berlin', showWithoutTime: false, calendarIds: { 'a-personal': true },
  participants: null, alerts: null, recurrenceRules: null,
} as unknown as CalendarEvent;

function options(): string[] {
  const select = document.querySelector('select[id$="calendar_select"]') as HTMLSelectElement | null;
  return select ? within(select).getAllByRole('option').map((o) => o.textContent ?? '') : [];
}

describe('EventModal calendar choice with several logins', () => {
  it("offers only the event's own login's calendars when editing", () => {
    render(<EventModal event={event} calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} currentUserEmails={['me@example.com']} />);
    fireEvent.click(screen.getByText('events.edit'));
    expect(options()).toEqual(['A Personal', 'A Work']);
  });

  it("keeps another login's event in that login", () => {
    const other = { ...event, calendarIds: { 'login-b:b': true } } as CalendarEvent;
    render(<EventModal event={other} calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} currentUserEmails={['me@example.com']} />);
    fireEvent.click(screen.getByText('events.edit'));
    // One calendar left: no select at all.
    expect(options()).toEqual([]);
  });

  it('offers every login for a new event', () => {
    render(<EventModal calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} currentUserEmails={['me@example.com']} />);
    expect(options()).toEqual(['A Personal', 'A Work', 'B Personal']);
  });
});
