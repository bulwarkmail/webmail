import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTimeGridInteractions } from "@/hooks/use-time-grid-interactions";

const errorMessages = { resize: "resize", move: "move", created: "created", error: "error" };

function renderInteractions(onCreateRange = vi.fn()) {
  const { result } = renderHook(() =>
    useTimeGridInteractions({ hourHeight: 60, calendars: [], onCreateRange, errorMessages }),
  );
  return { result, onCreateRange };
}

describe("useTimeGridInteractions slot clicks (#435)", () => {
  beforeEach(() => {
    // Freeze "now" far from the clicked slot so a regression to the modal's
    // next-hour-from-now fallback would produce a different time than asserted.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 21, 12, 2, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("single click creates a range at the clicked hour, not near the current time", () => {
    const { result, onCreateRange } = renderInteractions();
    const day = new Date(2026, 8, 3);

    act(() => result.current.handleSlotClick(day, 16));
    act(() => vi.advanceTimersByTime(300));

    expect(onCreateRange).toHaveBeenCalledTimes(1);
    const [start, end] = onCreateRange.mock.calls[0];
    expect(start).toEqual(new Date(2026, 8, 3, 16, 0, 0, 0));
    expect(end).toEqual(new Date(2026, 8, 3, 17, 0, 0, 0));
  });

  it("double click creates a range at the clicked hour immediately", () => {
    const { result, onCreateRange } = renderInteractions();
    const day = new Date(2026, 8, 3);

    act(() => result.current.handleSlotClick(day, 9));
    act(() => result.current.handleSlotDoubleClick(day, 9));

    expect(onCreateRange).toHaveBeenCalledTimes(1);
    const [start, end] = onCreateRange.mock.calls[0];
    expect(start).toEqual(new Date(2026, 8, 3, 9, 0, 0, 0));
    expect(end).toEqual(new Date(2026, 8, 3, 10, 0, 0, 0));

    // The pending single-click timer must have been cancelled by the double click.
    act(() => vi.advanceTimersByTime(500));
    expect(onCreateRange).toHaveBeenCalledTimes(1);
  });

  it("drag-to-create measures from the first visible hour (#1164)", () => {
    const onCreateRange = vi.fn();
    const { result } = renderHook(() =>
      useTimeGridInteractions({
        hourHeight: 60, calendars: [], onCreateRange, errorMessages,
        gridStartMinutes: 480, gridEndMinutes: 1200,
      }),
    );
    const day = new Date(2026, 8, 3);
    const column = {
      getBoundingClientRect: () => ({ top: 100 }),
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
    };
    const pointer = (clientY: number) => ({
      pointerType: "mouse", button: 0, pointerId: 1, clientY,
      target: { closest: () => null }, currentTarget: column,
    }) as unknown as React.PointerEvent<HTMLDivElement>;

    // 60 px below the grid top is 09:00 on an 08:00 grid; past the bottom
    // clamps to the last visible minute.
    act(() => result.current.handleGridPointerDown(pointer(160), "2026-09-03", day));
    act(() => result.current.handleGridPointerMove(pointer(400)));
    expect(result.current.dragCreate).toEqual({ dayKey: "2026-09-03", startMinutes: 540, endMinutes: 780 });
    act(() => result.current.handleGridPointerUp(pointer(2000)));

    const [start, end] = onCreateRange.mock.calls[0];
    expect(start).toEqual(new Date(2026, 8, 3, 9, 0, 0, 0));
    expect(end).toEqual(new Date(2026, 8, 3, 20, 0, 0, 0));
  });

  it("a 23:00 click ends at midnight of the next day", () => {
    const { result, onCreateRange } = renderInteractions();
    const day = new Date(2026, 8, 3);

    act(() => result.current.handleSlotDoubleClick(day, 23));

    const [start, end] = onCreateRange.mock.calls[0];
    expect(start).toEqual(new Date(2026, 8, 3, 23, 0, 0, 0));
    expect(end).toEqual(new Date(2026, 8, 4, 0, 0, 0, 0));
  });
});
