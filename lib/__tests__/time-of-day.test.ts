import { describe, it, expect } from 'vitest';
import { formatTimeOfDay, parseTimeOfDay, stepTimeOfDay } from '../time-of-day';

describe('parseTimeOfDay', () => {
  it('reads 24-hour times in the usual spellings', () => {
    expect(parseTimeOfDay('14:30')).toBe('14:30');
    expect(parseTimeOfDay('1430')).toBe('14:30');
    expect(parseTimeOfDay('930')).toBe('09:30');
    expect(parseTimeOfDay('14.30')).toBe('14:30');
    expect(parseTimeOfDay('14h30')).toBe('14:30');
    expect(parseTimeOfDay('14h')).toBe('14:00');
    expect(parseTimeOfDay('9')).toBe('09:00');
    expect(parseTimeOfDay(' 0:05 ')).toBe('00:05');
  });

  it('reads 12-hour times with am and pm', () => {
    expect(parseTimeOfDay('2:30 PM')).toBe('14:30');
    expect(parseTimeOfDay('2:30pm')).toBe('14:30');
    expect(parseTimeOfDay('2p')).toBe('14:00');
    expect(parseTimeOfDay('2 p.m.')).toBe('14:00');
    expect(parseTimeOfDay('930am')).toBe('09:30');
    expect(parseTimeOfDay('12:15 am')).toBe('00:15');
    expect(parseTimeOfDay('12 pm')).toBe('12:00');
  });

  it('turns down what is not a time', () => {
    for (const text of ['', 'noon', '24:00', '14:60', '13 pm', '0 am', '12345', '1:2:3']) {
      expect(parseTimeOfDay(text)).toBeNull();
    }
  });
});

describe('formatTimeOfDay', () => {
  it('shows the value as the calendar does in each setting', () => {
    expect(formatTimeOfDay('14:30', '24h')).toBe('14:30');
    expect(formatTimeOfDay('14:30', '12h')).toBe('2:30 PM');
    expect(formatTimeOfDay('00:05', '12h')).toBe('12:05 AM');
    expect(formatTimeOfDay('12:00', '12h')).toBe('12:00 PM');
    expect(formatTimeOfDay('', '12h')).toBe('');
  });
});

describe('stepTimeOfDay', () => {
  it('moves by the step, snaps to it and wraps round midnight', () => {
    expect(stepTimeOfDay('09:00', 15)).toBe('09:15');
    expect(stepTimeOfDay('09:10', 15)).toBe('09:15');
    expect(stepTimeOfDay('09:10', -15)).toBe('09:00');
    expect(stepTimeOfDay('23:45', 15)).toBe('00:00');
    expect(stepTimeOfDay('00:00', -15)).toBe('23:45');
  });
});
