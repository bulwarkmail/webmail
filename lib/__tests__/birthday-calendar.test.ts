import { describe, it, expect } from 'vitest';
import type { ContactCard } from '@/lib/jmap/types';
import {
  createBirthdayCalendar,
  generateBirthdayEvents,
  BIRTHDAY_CALENDAR_ID,
  BIRTHDAY_CALENDAR_COLOR,
} from '@/lib/birthday-calendar';

const contact = (over: Record<string, unknown> = {}): ContactCard =>
  ({
    id: 'c1',
    '@type': 'Card',
    name: { full: 'Alice Smith' },
    anniversaries: { b1: { '@type': 'Anniversary', kind: 'birth', date: '1990-05-15' } },
    ...over,
  } as unknown as ContactCard);

describe('createBirthdayCalendar', () => {
  it('returns the virtual calendar with defaults', () => {
    const cal = createBirthdayCalendar();
    expect(cal).toMatchObject({
      id: BIRTHDAY_CALENDAR_ID,
      name: 'Birthdays',
      color: BIRTHDAY_CALENDAR_COLOR,
      isSubscribed: true,
      myRights: { mayReadItems: true, mayWriteAll: false, mayDelete: false },
    });
  });

  it('honours name/color overrides', () => {
    expect(createBirthdayCalendar('My BDays', '#fff')).toMatchObject({ name: 'My BDays', color: '#fff' });
  });
});

describe('generateBirthdayEvents', () => {
  it('emits one event per year in range, with age and stable ids', () => {
    const events = generateBirthdayEvents([contact()], '2020-01-01', '2022-12-31');
    expect(events.map((e) => e.id)).toEqual([
      'birthday-c1-b1-2020',
      'birthday-c1-b1-2021',
      'birthday-c1-b1-2022',
    ]);
    expect(events[0]).toMatchObject({
      uid: 'birthday-c1-b1',
      title: '🎂 Alice Smith (30)',
      start: '2020-05-15T00:00:00',
      calendarIds: { [BIRTHDAY_CALENDAR_ID]: true },
      showWithoutTime: true,
    });
  });

  it('omits the age when the birthday has no year (partial date)', () => {
    const c = contact({ anniversaries: { b1: { '@type': 'Anniversary', kind: 'birth', date: '--05-15' } } });
    const events = generateBirthdayEvents([c], '2021-01-01', '2021-12-31');
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('🎂 Alice Smith');
  });

  it('parses a Timestamp anniversary date', () => {
    const c = contact({ anniversaries: { b1: { '@type': 'Anniversary', kind: 'birth', date: { '@type': 'Timestamp', utc: '1985-03-10T00:00:00Z' } } } });
    const events = generateBirthdayEvents([c], '2021-01-01', '2021-12-31');
    expect(events[0].start).toBe('2021-03-10T00:00:00');
  });

  it('parses a PartialDate anniversary date', () => {
    const c = contact({ anniversaries: { b1: { '@type': 'Anniversary', kind: 'birth', date: { month: 7, day: 4 } } } });
    const events = generateBirthdayEvents([c], '2021-01-01', '2021-12-31');
    expect(events[0].start).toBe('2021-07-04T00:00:00');
  });

  it('clamps Feb 29 to Feb 28 in a non-leap year', () => {
    const c = contact({ anniversaries: { b1: { '@type': 'Anniversary', kind: 'birth', date: '2000-02-29' } } });
    const events = generateBirthdayEvents([c], '2021-01-01', '2021-12-31');
    expect(events[0].start).toBe('2021-02-28T00:00:00');
  });

  it('excludes occurrences outside the range', () => {
    expect(generateBirthdayEvents([contact()], '2021-01-01', '2021-02-28')).toEqual([]); // May birthday
  });

  it('returns [] for an invalid range', () => {
    expect(generateBirthdayEvents([contact()], 'not-a-date', '2021-12-31')).toEqual([]);
  });

  it('skips non-birth anniversaries', () => {
    const c = contact({ anniversaries: { w1: { '@type': 'Anniversary', kind: 'wedding', date: '2010-06-01' } } });
    expect(generateBirthdayEvents([c], '2021-01-01', '2021-12-31')).toEqual([]);
  });
});
