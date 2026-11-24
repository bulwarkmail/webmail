import { describe, expect, it } from 'vitest';
import { getEventColor, sanitizeColor } from '../event-card';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';

const calendar = { id: 'c1', name: 'Work', color: '#00aa00' } as Calendar;
const event = (color: string | null) => ({ id: 'e1', color }) as CalendarEvent;

// Other calendar apps write an event's colour as a CSS name (JSCalendar
// color, iCalendar COLOR). The webmail dropped it for the calendar's.
describe('an event colour given as a CSS name', () => {
  it('shows as its hex value, in any case', () => {
    expect(getEventColor(event('red'), calendar)).toBe('#ff0000');
    expect(getEventColor(event('RebeccaPurple'), calendar)).toBe('#663399');
    expect(sanitizeColor(' teal ')).toBe('#008080');
  });

  it('still falls back to the calendar for a value that is no colour', () => {
    expect(getEventColor(event('url(x)'), calendar)).toBe('#00aa00');
    expect(getEventColor(event('notacolor'), calendar)).toBe('#00aa00');
  });
});
