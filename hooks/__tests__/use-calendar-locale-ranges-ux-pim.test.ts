import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

// pim-13: the German week title read "2. Nov. – 8, 2026", an English pattern
// with German names. Every range now comes from Intl's formatRange.

let locale = 'en';
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => locale,
}));

import { useCalendarLocale } from '../use-calendar-locale';
import { formatDateRange } from '@/lib/format-date-range';

// Intl puts thin and narrow no-break spaces around the dash.
const plain = (text: string) => text.replace(/\s/g, ' ');

function hookIn(code: string) {
  locale = code;
  const hook = renderHook(() => useCalendarLocale()).result.current;
  return {
    formatWeekRange: (d: Date) => plain(hook.formatWeekRange(d)),
    formatWeekRangeShort: (d: Date) => plain(hook.formatWeekRangeShort(d)),
    formatMonthYear: (d: Date) => plain(hook.formatMonthYear(d)),
    formatMonthYearShort: (d: Date) => plain(hook.formatMonthYearShort(d)),
    formatDateRangeLabel: (a: Date, b: Date, o: Intl.DateTimeFormatOptions) => plain(hook.formatDateRangeLabel(a, b, o)),
  };
}

const sameMonth = new Date(2026, 10, 2); // Mon 2 Nov 2026 .. Sun 8 Nov
const acrossMonths = new Date(2026, 9, 26); // 26 Oct .. 1 Nov
const acrossYears = new Date(2026, 11, 28); // 28 Dec 2026 .. 3 Jan 2027

describe('week title (pim-13)', () => {
  it('writes the German range the German way', () => {
    const { formatWeekRange, formatWeekRangeShort } = hookIn('de');
    expect(formatWeekRange(sameMonth)).toBe('2.–8. Nov. 2026');
    expect(formatWeekRange(acrossMonths)).toBe('26. Okt. – 1. Nov. 2026');
    expect(formatWeekRange(acrossYears)).toBe('28. Dez. 2026 – 3. Jan. 2027');
    expect(formatWeekRangeShort(sameMonth)).toBe('2.–8. Nov.');
  });

  it('keeps the English title', () => {
    const { formatWeekRange, formatWeekRangeShort } = hookIn('en');
    expect(formatWeekRange(sameMonth)).toBe('Nov 2 – 8, 2026');
    expect(formatWeekRange(acrossMonths)).toBe('Oct 26 – Nov 1, 2026');
    expect(formatWeekRange(acrossYears)).toBe('Dec 28, 2026 – Jan 3, 2027');
    expect(formatWeekRangeShort(acrossMonths)).toBe('Oct 26 – Nov 1');
  });

  it('follows French, Japanese and Arabic', () => {
    expect(hookIn('fr').formatWeekRange(sameMonth)).toBe('2–8 nov. 2026');
    expect(hookIn('fr').formatWeekRange(acrossYears)).toBe('28 déc. 2026 – 3 janv. 2027');
    // Japanese writes the year first and never "2, 2026".
    const ja = hookIn('ja').formatWeekRange(sameMonth);
    expect(ja.startsWith('2026')).toBe(true);
    expect(ja).toBe(plain(formatDateRange('ja', sameMonth, new Date(2026, 10, 8), { day: 'numeric', month: 'short', year: 'numeric' })));
    expect(hookIn('ar').formatWeekRange(acrossMonths)).toBe(
      plain(formatDateRange('ar', acrossMonths, new Date(2026, 10, 1), { day: 'numeric', month: 'short', year: 'numeric' })),
    );
    expect(hookIn('ar').formatWeekRange(acrossMonths)).not.toContain(',');
  });

  it('puts month and year in the language order', () => {
    expect(hookIn('ja').formatMonthYear(sameMonth)).toBe('2026年11月');
    expect(hookIn('de').formatMonthYear(sameMonth)).toBe('November 2026');
    expect(hookIn('en').formatMonthYearShort(sameMonth)).toBe('Nov 2026');
  });

  it('formats a multi-day range once', () => {
    const { formatDateRangeLabel } = hookIn('de');
    const label = formatDateRangeLabel(new Date(2026, 10, 2), new Date(2026, 10, 4), {
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    });
    expect(label).toBe('Mo., 2. – Mi., 4. Nov. 2026');
  });
});

describe('formatDateRange', () => {
  it('falls back to two dates without formatRange', () => {
    const original = Intl.DateTimeFormat.prototype.formatRange;
    // @ts-expect-error simulate an engine without formatRange
    delete Intl.DateTimeFormat.prototype.formatRange;
    try {
      expect(plain(formatDateRange('en-US', sameMonth, new Date(2026, 10, 8), { day: 'numeric', month: 'short' }))).toBe('Nov 2 – Nov 8');
    } finally {
      Intl.DateTimeFormat.prototype.formatRange = original;
    }
  });
});
