import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { CalendarWeekView } from '../calendar-week-view';
import { CalendarDayView } from '../calendar-day-view';
import { useSettingsStore } from '@/stores/settings-store';
import type { Calendar } from '@/lib/jmap/types';

/** The empty hour slots of the time grid (buttons inside the day cells). */
const slots = () => Array.from(document.querySelectorAll<HTMLElement>('[role="button"][data-slot]'));

const calendars = [{ id: 'cal-1', name: 'Work', color: '#123456' }] as unknown as Calendar[];
const initialSettings = useSettingsStore.getState();

type WeekProps = React.ComponentProps<typeof CalendarWeekView>;

function renderWeek(overrides: Partial<WeekProps> = {}) {
  const props: WeekProps = {
    focus: { date: new Date(2026, 8, 9), nonce: 0 },
    windowKey: 'week:2026-09-07',
    // Monday 7 Sep to Sunday 13 Sep 2026
    rangeStart: new Date(2026, 8, 7),
    rangeEnd: new Date(2026, 8, 13),
    selectedDate: new Date(2026, 8, 9),
    events: [],
    calendars,
    onSelectDate: vi.fn(),
    onSelectEvent: vi.fn(),
    onCreateAtTime: vi.fn(),
    ...overrides,
  };
  render(<CalendarWeekView {...props} />);
  return props;
}

function tabStops(): HTMLElement[] {
  return slots().filter((cell) => cell.tabIndex === 0);
}

function focusedSlot(): string | null {
  return (document.activeElement as HTMLElement | null)?.getAttribute('data-slot') ?? null;
}

describe('keyboard access to the time grid (CAL-13)', () => {
  beforeEach(() => {
    useSettingsStore.setState(initialSettings, true);
  });

  afterEach(() => {
    cleanup();
  });

  it('gives the week grid one tab stop on the selected day', () => {
    renderWeek();
    const stops = tabStops();
    expect(stops).toHaveLength(1);
    expect(stops[0].getAttribute('data-slot')).toMatch(/^2026-09-09T\d+$/);
    // The slot is read out with its date and time (the test formatter
    // prints the whole Date), not just "Wed 08:00"
    expect(stops[0]).toHaveAccessibleName(/Sep 09 2026.*, \d\d:00$/);
    // ...and one date in the header, not each loaded day's
    const dates = screen.getAllByRole('columnheader').map((h) => h.querySelector('button')!);
    expect(dates.filter((b) => b.tabIndex === 0)).toHaveLength(1);
  });

  it('moves by hour and day with the arrows and Home/End', () => {
    renderWeek();
    const start = tabStops()[0];
    start.focus();
    fireEvent.keyDown(start, { key: 'Home' });
    expect(focusedSlot()).toBe('2026-09-09T8');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(focusedSlot()).toBe('2026-09-09T9');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(focusedSlot()).toBe('2026-09-10T9');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(focusedSlot()).toBe('2026-09-08T9');
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(focusedSlot()).toBe('2026-09-08T19');
    // The edge of the visible hours stops the arrow
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(focusedSlot()).toBe('2026-09-08T19');
    // The tab stop follows the focus
    expect(tabStops().map((cell) => cell.getAttribute('data-slot'))).toEqual(['2026-09-08T19']);
  });

  it('keeps the arrows from paging the calendar', () => {
    renderWeek();
    const start = tabStops()[0];
    start.focus();
    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    start.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('creates an event at the focused slot with Enter or n', () => {
    const props = renderWeek();
    const start = tabStops()[0];
    start.focus();
    fireEvent.keyDown(start, { key: 'Home' });
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(props.onCreateAtTime).toHaveBeenLastCalledWith(new Date(2026, 8, 9, 8, 0, 0, 0));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'n', code: 'KeyN' });
    expect(props.onCreateAtTime).toHaveBeenLastCalledWith(new Date(2026, 8, 9, 9, 0, 0, 0));
    // Not with a modifier: Ctrl+N belongs to the browser
    fireEvent.keyDown(document.activeElement!, { key: 'n', code: 'KeyN', ctrlKey: true });
    expect(props.onCreateAtTime).toHaveBeenCalledTimes(2);
  });

  it('leaves the slots out of the tab order on phones', () => {
    renderWeek({ isMobile: true });
    expect(tabStops()).toHaveLength(0);
  });

  it('works the same in the day view', () => {
    const onCreateAtTime = vi.fn();
    render(
      <CalendarDayView
        focus={{ date: new Date(2026, 8, 9), nonce: 0 }}
        windowKey="day:2026-09-08"
        rangeStart={new Date(2026, 8, 8)}
        rangeEnd={new Date(2026, 8, 10)}
        selectedDate={new Date(2026, 8, 9)}
        events={[]}
        calendars={calendars}
        onSelectEvent={vi.fn()}
        onCreateAtTime={onCreateAtTime}
      />,
    );
    const stops = tabStops();
    expect(stops).toHaveLength(1);
    expect(stops[0]).toHaveAccessibleName(/Sep 09 2026.*, \d\d:00$/);
    stops[0].focus();
    fireEvent.keyDown(stops[0], { key: 'End' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(focusedSlot()).toBe('2026-09-10T19');
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(onCreateAtTime).toHaveBeenCalledWith(new Date(2026, 8, 10, 19, 0, 0, 0));
  });
});

describe('quick editor focus (CAL-13)', () => {
  afterEach(() => {
    cleanup();
  });

  it('returns focus to the slot it was opened from', async () => {
    const { QuickCreatePopover } = await import('../quick-create-popover');
    const slot = document.createElement('div');
    slot.tabIndex = -1;
    document.body.appendChild(slot);
    slot.focus();
    const { unmount } = render(
      <QuickCreatePopover
        draft={{ start: new Date(2026, 8, 9, 10), end: new Date(2026, 8, 9, 11), title: '', allDay: false, calendarId: 'cal-1' }}
        calendars={calendars}
        onChange={vi.fn()}
        onSave={vi.fn()}
        onMoreOptions={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    (screen.getAllByRole('textbox')[0] as HTMLElement).focus();
    unmount();
    expect(document.activeElement).toBe(slot);
    slot.remove();
  });
});
