import { describe, expect, it } from 'vitest';
import { eventToICS } from '@/lib/calendar-ics-export';
import type { CalendarEvent } from '@/lib/jmap/types';

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'e1', uid: 'export-test@example.com', title: 'Sync', start: '2026-11-20T09:00:00',
    timeZone: 'Europe/Berlin', duration: 'PT1H', showWithoutTime: false, calendarIds: { c: true },
    ...overrides,
  } as CalendarEvent;
}

// As the downloaded file holds it: UTF-8, where half an emoji on each side
// of a fold turns into two U+FFFD.
const asFile = (ics: string) => new TextDecoder().decode(new TextEncoder().encode(ics));
const unfold = (ics: string) => asFile(ics).replace(/\r\n /g, '');
const line = (ics: string, name: string) => unfold(ics).split('\r\n').find((l) => l.startsWith(name)) ?? '';

describe('eventToICS', () => {
  // Stalwart 0.16 and 1.0 both read a title folded inside an emoji back
  // with two U+FFFD in its place.
  it('folds lines between characters, at most 75 octets long', () => {
    const title = `${'A'.repeat(64)} 🎉🎉🎉 Launch party 🎉 ${'Ünïcödé '.repeat(12)}`;
    const ics = eventToICS(event({ title }));

    expect(line(ics, 'SUMMARY:')).toBe(`SUMMARY:${title}`);
    for (const physical of ics.split('\r\n')) {
      expect(new TextEncoder().encode(physical).length).toBeLessThanOrEqual(75);
    }
  });

  // A colon in an unquoted CN ended the parameters there: both servers read
  // the organizer's address as " Alice:mailto:...".
  it('quotes participant names that hold a colon, semicolon or comma', () => {
    const ics = eventToICS(event({
      participants: {
        o: { '@type': 'Participant', email: 'alice@example.com', name: 'Ops: Alice', roles: { owner: true } },
        p: { '@type': 'Participant', email: 'john@example.com', name: 'Doe, John; "JD"', roles: { attendee: true } },
      } as unknown as CalendarEvent['participants'],
    }));

    expect(line(ics, 'ORGANIZER')).toBe('ORGANIZER;CN="Ops: Alice":mailto:alice@example.com');
    expect(line(ics, 'ATTENDEE')).toBe('ATTENDEE;CN="Doe, John; \'JD\'";PARTSTAT=NEEDS-ACTION:mailto:john@example.com');
  });

  it('leaves a plain name unquoted', () => {
    const ics = eventToICS(event({
      participants: {
        o: { '@type': 'Participant', email: 'alice@example.com', name: 'Alice', roles: { owner: true } },
      } as unknown as CalendarEvent['participants'],
    }));

    expect(line(ics, 'ORGANIZER')).toBe('ORGANIZER;CN=Alice:mailto:alice@example.com');
  });

  // DESCRIPTION is plain text: an HTML description goes out as its text.
  it('writes an HTML description as text', () => {
    const ics = eventToICS(event({
      description: '<p>Budget &amp; plans<br>Room 2</p>',
      descriptionContentType: 'text/html',
    }));

    expect(line(ics, 'DESCRIPTION:')).toBe('DESCRIPTION:Budget & plans\\nRoom 2');
  });

  // Stalwart 1.0 keeps a participant's address only in calendarAddress, and
  // its organizer participant may carry no roles: the file had no ORGANIZER
  // and no ATTENDEE lines.
  it('reads participants and the organizer as Stalwart 1.0 holds them', () => {
    const ics = eventToICS(event({
      organizerCalendarAddress: 'mailto:alice@example.com',
      participants: {
        o: { '@type': 'Participant', calendarAddress: 'mailto:alice@example.com', name: 'Alice' },
        p: { '@type': 'Participant', calendarAddress: 'mailto:john@example.com', name: 'John', roles: { attendee: true }, participationStatus: 'accepted' },
      } as unknown as CalendarEvent['participants'],
    }));

    expect(line(ics, 'ORGANIZER')).toBe('ORGANIZER;CN=Alice:mailto:alice@example.com');
    expect(unfold(ics).split('\r\n').filter((l) => l.startsWith('ATTENDEE'))).toEqual(['ATTENDEE;CN=John;PARTSTAT=ACCEPTED:mailto:john@example.com']);
  });

  it('writes METHOD:REQUEST for a forwarded invitation, PUBLISH otherwise', () => {
    expect(line(eventToICS(event()), 'METHOD:')).toBe('METHOD:PUBLISH');
    expect(line(eventToICS(event(), { method: 'REQUEST' }), 'METHOD:')).toBe('METHOD:REQUEST');
  });

  it('leaves the days taken out of a series out of the file too', () => {
    const ics = eventToICS(event({
      recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly' }] as CalendarEvent['recurrenceRules'],
      recurrenceOverrides: {
        '2026-11-27T09:00:00': { excluded: true } as never,
        '2026-12-04T09:00:00': { title: 'Moved' },
      },
    }));

    expect(unfold(ics).split('\r\n').filter((l) => l.startsWith('EXDATE'))).toEqual(['EXDATE;TZID=Europe/Berlin:20261127T090000']);
  });

  it('writes a plain-text description as it is', () => {
    const ics = eventToICS(event({ description: 'a <b> c', descriptionContentType: 'text/plain' }));

    expect(line(ics, 'DESCRIPTION:')).toBe('DESCRIPTION:a <b> c');
  });
});
