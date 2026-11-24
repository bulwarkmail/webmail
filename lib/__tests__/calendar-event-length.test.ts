import { describe, expect, it } from 'vitest';
import { endAfterEventLength, eventLengthDuration } from '@/lib/calendar-event-length';

// #1318: the length a new event gets, picked in Settings > Calendar.
describe('the default length for new events', () => {
  it('is written as a JSCalendar duration', () => {
    expect(eventLengthDuration(15)).toBe('PT15M');
    expect(eventLengthDuration(60)).toBe('PT1H');
    expect(eventLengthDuration(90)).toBe('PT1H30M');
    expect(eventLengthDuration(120)).toBe('PT2H');
  });

  it('falls back to an hour for a value the setting does not offer', () => {
    expect(eventLengthDuration(7)).toBe('PT1H');
    expect(eventLengthDuration('30')).toBe('PT1H');
    expect(endAfterEventLength(new Date(2026, 8, 3, 9, 0), undefined)).toEqual(new Date(2026, 8, 3, 10, 0));
  });

  it('ends a new event that long after its start', () => {
    expect(endAfterEventLength(new Date(2026, 8, 3, 9, 0), 45)).toEqual(new Date(2026, 8, 3, 9, 45));
    expect(endAfterEventLength(new Date(2026, 8, 3, 23, 30), 90)).toEqual(new Date(2026, 8, 4, 1, 0));
  });
});
