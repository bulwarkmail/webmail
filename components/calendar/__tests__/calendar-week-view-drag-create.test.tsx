import { render, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { CalendarWeekView } from '../calendar-week-view';
import { CalendarDayView } from '../calendar-day-view';
import type { CalendarEvent, Calendar } from '@/lib/jmap/types';

// Usability report 2026-11-04: dragging over an empty stretch of a day drew
// a see-through selection the events showed through, and the new event's
// placeholder lay over the events it overlapped ("Lernblock" hidden behind
// it) instead of taking a column beside them.

const calendars = [{ id: 'cal-1', name: 'Work', color: '#123456' }] as unknown as Calendar[];

function timed(id: string, start: string, duration: string): CalendarEvent {
  return {
    id, '@type': 'Event', uid: id, title: id, start, duration, timeZone: null,
    showWithoutTime: false, calendarIds: { 'cal-1': true },
  } as unknown as CalendarEvent;
}

const lernblock = timed('Lernblock', '2026-09-09T12:30:00', 'PT1H');
const draft = {
  start: new Date(2026, 8, 9, 11, 45), end: new Date(2026, 8, 9, 15, 45),
  title: '(No title)', allDay: false, calendarId: 'cal-1',
};

type WeekProps = React.ComponentProps<typeof CalendarWeekView>;

function renderWeek(overrides: Partial<WeekProps> = {}) {
  const props: WeekProps = {
    focus: { date: new Date(2026, 8, 9), nonce: 0 },
    windowKey: 'week:2026-09-07',
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
  return { props, ...render(<CalendarWeekView {...props} />) };
}

/** The time column of a day: the grid cell holding its hour slots. */
function column(key: string): HTMLElement {
  const slot = document.querySelector<HTMLElement>(`[data-slot^="${key}T"]`);
  const cell = slot?.closest<HTMLElement>('[role="gridcell"]');
  if (!cell) throw new Error(`no column for ${key}`);
  return cell;
}

/** The pixel offset of a time in a column whose hours are 60 px tall. */
function yOf(key: string, minutes: number): number {
  const first = Number(document.querySelector(`[data-slot^="${key}T"]`)!.getAttribute('data-slot')!.split('T')[1]);
  return minutes - first * 60;
}

/** The positioned box around the drawn placeholder of the new event. */
function placeholderBox(): HTMLElement {
  const preview = document.querySelector<HTMLElement>('[data-pending-preview]');
  if (!preview) throw new Error('no placeholder');
  return preview.style.width ? preview : preview.parentElement!;
}

function eventBox(id: string): HTMLElement {
  const box = Array.from(document.querySelectorAll<HTMLElement>('[data-calendar-event]'))
    .find((el) => el.textContent?.includes(id));
  if (!box) throw new Error(`no event ${id}`);
  return box;
}

beforeAll(() => {
  // jsdom has no pointer capture.
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

afterEach(() => cleanup());

describe('Week view drag-to-create', () => {
  it('draws the selection opaque and above the events it passes over', () => {
    renderWeek({ events: [lernblock] });
    const col = column('2026-09-09');
    fireEvent.pointerDown(col, { pointerId: 1, pointerType: 'mouse', button: 0, clientY: yOf('2026-09-09', 675) });
    fireEvent.pointerMove(col, { pointerId: 1, pointerType: 'mouse', clientY: yOf('2026-09-09', 975) });

    const selection = col.querySelector<HTMLElement>('[data-drag-selection]');
    expect(selection).not.toBeNull();
    expect(selection!.textContent).toContain('11:15 – 16:15');
    // An opaque fill: the event under it doesn't show through.
    expect(selection!.style.backgroundColor).toContain('var(--color-background)');
    expect(selection!.className).toContain('z-30');
    expect(eventBox('Lernblock').className).toContain('z-10');
  });

  it('creates the range the selection showed', () => {
    const { props } = renderWeek({ events: [lernblock] });
    const col = column('2026-09-09');
    fireEvent.pointerDown(col, { pointerId: 1, pointerType: 'mouse', button: 0, clientY: yOf('2026-09-09', 675) });
    fireEvent.pointerMove(col, { pointerId: 1, pointerType: 'mouse', clientY: yOf('2026-09-09', 975) });
    fireEvent.pointerUp(col, { pointerId: 1, pointerType: 'mouse', clientY: yOf('2026-09-09', 940) });

    expect(props.onCreateAtTime).toHaveBeenCalledWith(new Date(2026, 8, 9, 11, 15), new Date(2026, 8, 9, 16, 15));
  });
});

describe('The new event beside the events it overlaps', () => {
  it('shares the width with them in the week view', () => {
    renderWeek({ events: [lernblock], pendingPreview: draft });
    expect(placeholderBox().style.width).toBe('50%');
    expect(eventBox('Lernblock').style.width).toBe('50%');
    // Each in its own half.
    expect(placeholderBox().style.insetInlineStart).not.toBe(eventBox('Lernblock').style.insetInlineStart);
  });

  it('keeps the whole width where nothing overlaps it', () => {
    renderWeek({ events: [timed('Later', '2026-09-09T17:00:00', 'PT1H')], pendingPreview: draft });
    expect(placeholderBox().style.width).toBe('100%');
  });

  it('shares the width with them in the day view', () => {
    render(
      <CalendarDayView
        focus={{ date: new Date(2026, 8, 9), nonce: 0 }}
        windowKey="day:2026-09-09"
        rangeStart={new Date(2026, 8, 9)}
        rangeEnd={new Date(2026, 8, 9)}
        selectedDate={new Date(2026, 8, 9)}
        events={[lernblock]}
        calendars={calendars}
        onSelectEvent={vi.fn()}
        onCreateAtTime={vi.fn()}
        pendingPreview={draft}
      />,
    );
    expect(placeholderBox().style.width).toBe('50%');
    expect(eventBox('Lernblock').style.width).toBe('50%');
  });
});
