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
});
