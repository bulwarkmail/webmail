import { describe, it, expect } from 'vitest';
import { formatContactDate } from '../contact-dates';

describe('contact dates in the UI language', () => {
  it('writes a birthday the German way in German, not "Mar 15 1988"', () => {
    expect(formatContactDate({ year: 1988, month: 3, day: 15 }, 'de')).toBe('15. März 1988');
    expect(formatContactDate('1988-03-15', 'de')).toBe('15. März 1988');
  });

  it('leaves out what the date does not name', () => {
    expect(formatContactDate('--03-15', 'en')).toBe('March 15');
    expect(formatContactDate({ year: 1988 }, 'en')).toBe('1988');
    expect(formatContactDate('--02-29', 'fr')).toBe('29 février');
  });

  // #1616: "Day/Month/Year" in the region settings, with English as the language.
  it('follows the date order picked in the region settings', () => {
    expect(formatContactDate({ year: 1988, month: 3, day: 15 }, 'en', 'en-GB')).toBe('15/03/1988');
    expect(formatContactDate('--03-15', 'en', 'en-GB')).toBe('15/03');
    expect(formatContactDate('1988-03-15', 'de', 'iso')).toBe('1988-03-15');
    expect(formatContactDate('1988-03-15', 'de', 'en-US')).toBe('03/15/1988');
  });

  it('keeps the long date of the language when the order follows the language', () => {
    expect(formatContactDate('1988-03-15', 'en', 'auto')).toBe('March 15, 1988');
  });
});
