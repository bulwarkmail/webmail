import { describe, it, expect } from 'vitest';
import { formatTimeOfDay, isFinishedTimeOfDay, parseTimeOfDay, stepTimeOfDay } from '../time-of-day';

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

  it('reads a comma or a space between hour and minute', () => {
    expect(parseTimeOfDay('14,30')).toBe('14:30');
    expect(parseTimeOfDay('14 30')).toBe('14:30');
    expect(parseTimeOfDay('2 30 pm')).toBe('14:30');
  });

  it('reads full-width and Arabic-Indic digits', () => {
    expect(parseTimeOfDay('１４：３０')).toBe('14:30');
    expect(parseTimeOfDay('١٤:٣٠')).toBe('14:30');
    expect(parseTimeOfDay('۰۹:۰۵')).toBe('09:05');
    expect(parseTimeOfDay('٢:٣٠ pm')).toBe('14:30');
  });

  it('turns down what is not a time', () => {
    for (const text of ['', 'noon', '24:00', '14:60', '13 pm', '0 am', '12345', '1:2:3']) {
      expect(parseTimeOfDay(text)).toBeNull();
    }
  });
});

describe('isFinishedTimeOfDay', () => {
  it('knows a whole time from one still being typed', () => {
    for (const text of ['15:30', '9.05', '14h30', '14,30', '14 30', '1530', '0930', '2pm', '2 p', '2:30 pm', '１５：３０']) {
      expect(isFinishedTimeOfDay(text), text).toBe(true);
    }
    for (const text of ['', '1', '15', '15:', '153', '15:3', '930', '14h', 'soon', '25:00']) {
      expect(isFinishedTimeOfDay(text), text).toBe(false);
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
