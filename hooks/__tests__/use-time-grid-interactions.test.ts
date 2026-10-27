import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DragEvent, PointerEvent } from "react";
import { useTimeGridInteractions } from "@/hooks/use-time-grid-interactions";
import { useCalendarStore } from "@/stores/calendar-store";
import { useAuthStore } from "@/stores/auth-store";
import { useSettingsStore } from "@/stores/settings-store";
import type { CalendarEvent } from "@/lib/jmap/types";

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


// A drag or a resize of an event the user organizes asks its attendees
// again and tells them, as the editor does for a move; anyone else moves
// their own copy without messages. Live on 1.0 and 0.16.23 a dragged event
// kept "accepted" for the new time, and a dragged occurrence reached no
// attendee who had answered.
describe.each<["0.16" | "1.0"]>([["0.16"], ["1.0"]])("useTimeGridInteractions moves on Stalwart %s", (version) => {
  const client = { id: "client" };
  const original = useCalendarStore.getState().updateEvent;
  let updateEvent: ReturnType<typeof vi.fn>;

  // isOrigin as the server says it: whether the organizer is an address of
  // the account the event is in.
  function meeting(organizer: string, extra: Partial<CalendarEvent> = {}): CalendarEvent {
    return {
      id: "e1", uid: "u1", title: "Planning", start: "2026-09-03T10:00:00", duration: "PT1H",
      timeZone: "Europe/Berlin", showWithoutTime: false, calendarIds: { cal: true },
      organizerCalendarAddress: `mailto:${organizer}`, isOrigin: organizer === "me@example.com",
      ...extra,
      participants: {
        org: { "@type": "Participant", calendarAddress: `mailto:${organizer}`, roles: { owner: true }, participationStatus: "accepted" },
        bob: {
          "@type": "Participant", calendarAddress: "mailto:bob@example.org", participationStatus: "accepted",
          // 0.16.23 drops an attendee's roles, 1.0 keeps them.
          ...(version === "1.0" ? { roles: { attendee: true } } : {}),
        },
      },
    } as unknown as CalendarEvent;
  }

  function interactions() {
    return renderHook(() => useTimeGridInteractions({
      hourHeight: 60, calendars: [], onCreateRange: vi.fn(), errorMessages, currentUserEmails: ["me@example.com"],
    })).result;
  }

  const drop = (eventId: string) => ({
    preventDefault: () => {},
    dataTransfer: { getData: () => JSON.stringify({ eventId, originalStart: "2026-09-03T10:00:00" }) },
    currentTarget: { getBoundingClientRect: () => ({ top: 0 }) },
    clientY: 11 * 60,
  }) as unknown as DragEvent<HTMLDivElement>;

  beforeEach(() => {
    updateEvent = vi.fn().mockResolvedValue(undefined);
    useCalendarStore.setState({ updateEvent: updateEvent as never });
    useAuthStore.setState({ client: client as never });
  });
  afterEach(() => {
    useCalendarStore.setState({ events: [], updateEvent: original });
    useAuthStore.setState({ client: null });
  });

  it("asks the attendees again when the user drags their meeting", async () => {
    useCalendarStore.setState({ events: [meeting("me@example.com")] });
    const result = interactions();

    await act(() => result.current.handleColumnDrop(drop("e1"), new Date(2026, 8, 3)));

    const [, id, updates, send] = updateEvent.mock.calls[0];
    expect(id).toBe("e1");
    expect(updates.start).toMatch(/^2026-09-03T/);
    expect(updates.participants.org.participationStatus).toBe("accepted");
    expect(updates.participants.bob.participationStatus).toBe("needs-action");
    expect(send).toBe(true);
  });

  it("moves someone else's meeting quietly", async () => {
    useCalendarStore.setState({ events: [meeting("boss@example.org")] });
    const result = interactions();

    await act(() => result.current.handleColumnDrop(drop("e1"), new Date(2026, 8, 3)));

    const [, , updates, send] = updateEvent.mock.calls[0];
    expect(updates).not.toHaveProperty("participants");
    expect(send).toBeUndefined();
  });

  // userc's meeting in userc's calendar, shared with the user read & write:
  // Stalwart sends the move from userc. It went out to nobody and the
  // attendees kept the old time (live on 1.0 and 0.16.23).
  it("asks the attendees again when the user drags the owner's meeting in a shared calendar", async () => {
    useCalendarStore.setState({ events: [meeting("userc@example.org", { id: "f:e1", isOrigin: true, isShared: true, accountId: "f" })] });
    const result = interactions();

    await act(() => result.current.handleColumnDrop(drop("f:e1"), new Date(2026, 8, 3)));

    const [, id, updates, send] = updateEvent.mock.calls[0];
    expect(id).toBe("f:e1");
    expect(updates.participants.org.participationStatus).toBe("accepted");
    expect(updates.participants.bob.participationStatus).toBe("needs-action");
    expect(send).toBe(true);
  });

  it("asks the attendees again when the user resizes their meeting", async () => {
    useCalendarStore.setState({ events: [meeting("me@example.com")] });
    const result = interactions();
    const target = { setPointerCapture: () => {}, releasePointerCapture: () => {} };

    act(() => result.current.handleResizePointerDown("e1", "bottom", 600, 60, {
      stopPropagation: () => {}, preventDefault: () => {}, clientY: 0, pointerId: 1, target,
    } as unknown as PointerEvent));
    await act(() => result.current.handleResizePointerUp({ clientY: 30, target } as unknown as PointerEvent));

    const [, , updates, send] = updateEvent.mock.calls[0];
    expect(updates.duration).toBe("PT1H30M");
    expect(updates.participants.bob.participationStatus).toBe("needs-action");
    expect(send).toBe(true);
  });
});

// The grid places events by wall clock (7845b2ca). On 2026-10-25 Berlin's
// 02:00-03:00 happens twice, so a resize across it has to land where the
// edge was dropped, not an hour off (#1348).
describe("useTimeGridInteractions resize on a DST change day (#1348)", () => {
  const original = useCalendarStore.getState().updateEvent;
  const originalTimeZone = useSettingsStore.getState().timeZone;
  const originalTZ = process.env.TZ;
  let updateEvent: ReturnType<typeof vi.fn>;
  const target = { setPointerCapture: () => {}, releasePointerCapture: () => {} };

  function event(start: string, duration: string): CalendarEvent {
    return {
      id: "e1", uid: "u1", title: "Night shift", start, duration, timeZone: "Europe/Berlin",
      showWithoutTime: false, calendarIds: { cal: true },
    } as unknown as CalendarEvent;
  }

  async function resize(edge: "top" | "bottom", startMinutes: number, durationMinutes: number, deltaY: number) {
    const { result } = renderHook(() =>
      useTimeGridInteractions({ hourHeight: 60, calendars: [], onCreateRange: vi.fn(), errorMessages }),
    );
    act(() => result.current.handleResizePointerDown("e1", edge, startMinutes, durationMinutes, {
      stopPropagation: () => {}, preventDefault: () => {}, clientY: 0, pointerId: 1, target,
    } as unknown as PointerEvent));
    await act(() => result.current.handleResizePointerUp({ clientY: deltaY, target } as unknown as PointerEvent));
    return updateEvent.mock.calls[0][2];
  }

  beforeEach(() => {
    process.env.TZ = "Europe/Berlin";
    useSettingsStore.setState({ timeZone: "Europe/Berlin" });
    updateEvent = vi.fn().mockResolvedValue(undefined);
    useCalendarStore.setState({ updateEvent: updateEvent as never });
    useAuthStore.setState({ client: { id: "client" } as never });
  });
  afterEach(() => {
    process.env.TZ = originalTZ;
    useSettingsStore.setState({ timeZone: originalTimeZone });
    useCalendarStore.setState({ events: [], updateEvent: original });
    useAuthStore.setState({ client: null });
  });

  it("moves the end to the dropped clock time", async () => {
    // 01:00-04:00 lasts four hours that day; the grid draws rows 01 to 04.
    useCalendarStore.setState({ events: [event("2026-10-25T01:00:00", "PT4H")] });

    const updates = await resize("bottom", 60, 180, 15);

    expect(updates.duration).toBe("PT4H15M");
    expect(updates).not.toHaveProperty("start");
  });

  it("moves the start to the dropped clock time and keeps the end", async () => {
    useCalendarStore.setState({ events: [event("2026-10-25T04:00:00", "PT1H")] });

    const updates = await resize("top", 240, 60, -180);

    expect(updates.start).toBe("2026-10-25T01:00:00");
    expect(updates.duration).toBe("PT5H");
  });
});
