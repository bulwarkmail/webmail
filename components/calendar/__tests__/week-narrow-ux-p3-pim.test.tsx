import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { CalendarWeekView } from '../calendar-week-view';
import { useSettingsStore } from '@/stores/settings-store';
import type { Calendar } from '@/lib/jmap/types';

// pim-p3-13: at 800px the week's seven columns turned overlapping events
// into 30px slivers. A pane under 1000px shows three days a page, as Google
// Calendar does; a toggle in the corner brings back the whole week.

const calendars = [{ id: 'cal-1', name: 'Work', color: '#123456' }] as unknown as Calendar[];

function renderAt(width: number) {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width);
  render(
    <CalendarWeekView
      focus={{ date: new Date(2026, 8, 9), nonce: 0 }}
      windowKey="week:2026-09-07"
      rangeStart={new Date(2026, 8, 7)}
      rangeEnd={new Date(2026, 8, 13)}
      selectedDate={new Date(2026, 8, 9)}
      events={[]}
      calendars={calendars}
      onSelectDate={vi.fn()}
      onSelectEvent={vi.fn()}
      onCreateAtTime={vi.fn()}
    />,
  );
}

/** The width of one day column, from the header row's grid. */
const columnWidth = () => {
  const grid = Array.from(document.querySelectorAll<HTMLElement>('.grid')).find((el) => el.style.gridTemplateColumns);
  return parseFloat(/,\s*([\d.]+)px/.exec(grid!.style.gridTemplateColumns)![1]);
};

describe('Week view in a narrow pane', () => {
  beforeEach(() => useSettingsStore.setState({ calendarNarrowWeekAllDays: false }));
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows three days a page under 1000px, and the whole week on demand', () => {
    renderAt(800);
    expect(columnWidth()).toBeCloseTo((800 - 56) / 3);
    const toggle = screen.getByRole('button', { name: 'week_all_days' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(useSettingsStore.getState().calendarNarrowWeekAllDays).toBe(true);
    expect(columnWidth()).toBeCloseTo((800 - 56) / 7);
    expect(screen.getByRole('button', { name: 'week_all_days' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps seven days and no toggle in a wide pane', () => {
    renderAt(1366);
    expect(columnWidth()).toBeCloseTo((1366 - 56) / 7);
    expect(screen.queryByRole('button', { name: 'week_all_days' })).toBeNull();
  });
});
