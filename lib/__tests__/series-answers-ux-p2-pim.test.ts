import { describe, expect, it } from 'vitest';
import { isSeriesInvitation, seriesAnswers } from '../calendar-invitation';
import type { CalendarEvent } from '@/lib/jmap/types';

// pim-p2-8: the series' own answer, and the occurrences declined on their own.
// Stalwart 1.0 stores an occurrence's answer as a pointer patch, 0.16 as the
// whole participants map.

const me = { '@type': 'Participant', email: 'me@example.org', roles: { attendee: true }, participationStatus: 'accepted' };
const ben = { '@type': 'Participant', email: 'ben@example.org', roles: { owner: true }, participationStatus: 'accepted' };

function series(overrides: Record<string, unknown>): Partial<CalendarEvent> {
  return {
    uid: 'w', start: '2026-11-03T16:00:00', recurrenceRules: [{ frequency: 'weekly' }],
    participants: { me, ben }, recurrenceOverrides: overrides,
  } as unknown as Partial<CalendarEvent>;
}

describe('seriesAnswers', () => {
  it('reads a pointer patch (Stalwart 1.0)', () => {
    const result = seriesAnswers(series({
      '2026-11-17T16:00:00': { 'participants/me/participationStatus': 'declined' },
      '2026-11-03T16:00:00': { 'participants/me/participationStatus': 'declined' },
      '2026-11-10T16:00:00': { title: 'Moved room' },
    }), ['me@example.org']);
    expect(result).toEqual({ status: 'accepted', declined: ['2026-11-03T16:00:00', '2026-11-17T16:00:00'] });
  });

  it('reads a whole participants map (Stalwart 0.16) and skips removed weeks', () => {
    const result = seriesAnswers(series({
      '2026-11-03T16:00:00': { participants: { me: { ...me, participationStatus: 'declined' }, ben } },
      '2026-11-10T16:00:00': { excluded: true },
    }), ['ME@example.org']);
    expect(result).toEqual({ status: 'accepted', declined: ['2026-11-03T16:00:00'] });
  });

  it('lists none when the whole series is declined', () => {
    const declined = { ...me, participationStatus: 'declined' };
    const event = { ...series({ '2026-11-03T16:00:00': { 'participants/me/participationStatus': 'declined' } }), participants: { me: declined, ben } };
    expect(seriesAnswers(event as unknown as Partial<CalendarEvent>, ['me@example.org'])).toEqual({ status: 'declined', declined: [] });
  });

  it('tells a series invitation from one for a single occurrence', () => {
    expect(isSeriesInvitation(series({}))).toBe(true);
    expect(isSeriesInvitation({ ...series({}), recurrenceId: '2026-11-03T16:00:00' } as Partial<CalendarEvent>)).toBe(false);
    expect(isSeriesInvitation({ uid: 'x' })).toBe(false);
  });
});
