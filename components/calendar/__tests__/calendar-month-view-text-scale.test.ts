import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';

vi.mock('next-intl', () => ({
  useTranslations: () => (k: string) => k,
  useLocale: () => 'en',
  useFormatter: () => ({ dateTime: (d: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en', options).format(d) }),
}));

const { CalendarMonthView, monthGridMetrics } = await import('../calendar-month-view');
const { useSettingsStore } = await import('@/stores/settings-store');

describe('monthGridMetrics', () => {
  it('keeps the 24px chip with a mouse at normal text size', () => {
    const m = monthGridMetrics(false, 1);
    expect(m.chipHeight).toBe(24);
    expect(m.overlayTop).toBe(30);
    expect(m.baseRowMinHeight).toBe(30 + 4 + 8 + 4 * 26);
  });

  it('grows the rows and the day number strip with larger text', () => {
    const m = monthGridMetrics(false, 2);
    expect(m.chipHeight).toBe(50);
    expect(m.overlayTop).toBe(60);
    expect(m.baseRowMinHeight).toBe(60 + 4 + 8 + 4 * 52);
  });

  it('does not shrink chips below the target size for smaller text', () => {
    expect(monthGridMetrics(false, 0.875).chipHeight).toBe(24);
  });
});

describe('CalendarMonthView text size', () => {
  const original = useSettingsStore.getState().fontSize;
  afterEach(() => useSettingsStore.setState({ fontSize: original }));

  const chipAt = (fontSize: 'medium' | 'huge') => {
    useSettingsStore.setState({ fontSize });
    render(createElement(CalendarMonthView, {
      focus: { date: new Date(2026, 9, 7), nonce: 0 },
      windowKey: 'month:2026-10-07',
      rangeStart: new Date(2026, 8, 28),
      rangeEnd: new Date(2026, 10, 1),
      selectedDate: new Date(2026, 9, 7),
      events: [{
        id: 'e1', uid: 'u1', title: 'Birthday', start: '2026-10-07T00:00:00', duration: 'P1D', showWithoutTime: true,
        calendarIds: { 'cal-1': true }, status: 'confirmed',
      } as unknown as CalendarEvent],
      calendars: [{ id: 'cal-1', name: 'Work', color: '#123456' }] as unknown as Calendar[],
      onSelectDate: vi.fn(),
      onSelectEvent: vi.fn(),
    }));
    return screen.getByRole('button', { name: /Birthday/ }).parentElement as HTMLElement;
  };

  it('keeps the normal chip at the normal text size', () => {
    const chip = chipAt('medium');
    expect(chip.style.height).toBe('24px');
    expect(chip.style.top).toBe('30px');
  });

  it('sizes the chips from the text size the user chose', () => {
    const chip = chipAt('huge');
    expect(chip.style.height).toBe('50px');
    expect(chip.style.top).toBe('60px');
  });
});
