import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DragEvent, PointerEvent } from "react";
import { useTimeGridInteractions } from "@/hooks/use-time-grid-interactions";
import { endEventDragGrab, startEventDragGrab } from "@/lib/calendar/event-drag-grab";
import { useCalendarStore } from "@/stores/calendar-store";
import { useAuthStore } from "@/stores/auth-store";
import { useSettingsStore } from "@/stores/settings-store";
import type { CalendarEvent } from "@/lib/jmap/types";

// pim-p3-2: dragging an event moves it by the distance dragged, as Google
// Calendar and Outlook do, not to the slot under the pointer; a nudge moves
// nothing. The grid here starts at midnight, 60 px an hour.

const errorMessages = { resize: "resize", move: "move", created: "created", error: "error" };
const originalUpdate = useCalendarStore.getState().updateEvent;
const originalTimeZone = useSettingsStore.getState().timeZone;
const originalTZ = process.env.TZ;
let updateEvent: ReturnType<typeof vi.fn>;

const meeting = {
  id: "e1", uid: "u1", title: "Move me", start: "2026-11-04T15:30:00", duration: "PT1H", timeZone: "Europe/Berlin",
  showWithoutTime: false, calendarIds: { cal: true },
} as unknown as CalendarEvent;

/** A day column at the top of the window, as the grid marks it. */
function column(dayKey: string) {
  const el = document.createElement("div");
  el.dataset.timeColumn = dayKey;
  el.getBoundingClientRect = () => ({ top: 0, left: 0, right: 100, bottom: 1440, width: 100, height: 1440, x: 0, y: 0, toJSON: () => ({}) });
  const card = document.createElement("div");
  el.appendChild(card);
  document.body.appendChild(el);
  return { el, card };
}

function render(hourHeight = 60) {
  return renderHook(() => useTimeGridInteractions({ hourHeight, calendars: [], onCreateRange: vi.fn(), errorMessages })).result;
}

function dropOn(el: HTMLElement, clientY: number) {
  const json = JSON.stringify({ type: "calendar-event", eventId: "e1", originalStart: meeting.start, duration: meeting.duration });
  return {
    preventDefault: () => {},
    clientY,
    currentTarget: el,
    dataTransfer: { types: ["application/x-calendar-event"], getData: () => json, dropEffect: "" },
  } as unknown as DragEvent<HTMLDivElement>;
}

beforeEach(() => {
  process.env.TZ = "Europe/Berlin";
  useSettingsStore.setState({ timeZone: "Europe/Berlin" });
  updateEvent = vi.fn().mockResolvedValue(undefined);
  useCalendarStore.setState({ events: [meeting], updateEvent: updateEvent as never });
  useAuthStore.setState({ client: { id: "client" } as never });
});

afterEach(() => {
  endEventDragGrab();
  document.body.innerHTML = "";
  process.env.TZ = originalTZ;
  useSettingsStore.setState({ timeZone: originalTimeZone });
  useCalendarStore.setState({ events: [], updateEvent: originalUpdate });
  useAuthStore.setState({ client: null });
});

describe("moving an event by dragging (pim-p3-2)", () => {
  // Grabbed near its bottom: 16:15 on a 15:30-16:30 event.
  const grabY = 16.25 * 60;

  it("moves nothing for a small nudge", async () => {
    const { el, card } = column("2026-11-04");
    const result = render();
    startEventDragGrab("e1", card, grabY);
    await act(() => result.current.handleColumnDrop(dropOn(el, grabY + 6), new Date(2026, 10, 4)));
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it("moves it by the distance dragged, down and up", async () => {
    const { el, card } = column("2026-11-04");
    const result = render();
    startEventDragGrab("e1", card, grabY);
    await act(() => result.current.handleColumnDrop(dropOn(el, grabY + 60), new Date(2026, 10, 4)));
    expect(updateEvent.mock.calls[0][2].start).toBe("2026-11-04T16:30:00");

    startEventDragGrab("e1", card, grabY);
    await act(() => result.current.handleColumnDrop(dropOn(el, grabY - 60), new Date(2026, 10, 4)));
    expect(updateEvent.mock.calls[1][2].start).toBe("2026-11-04T14:30:00");
  });

  it("keeps the time when dragged sideways to another day", async () => {
    const from = column("2026-11-04");
    const to = column("2026-11-06");
    const result = render();
    startEventDragGrab("e1", from.card, grabY);
    await act(() => result.current.handleColumnDrop(dropOn(to.el, grabY + 2), new Date(2026, 10, 6)));
    expect(updateEvent.mock.calls[0][2].start).toBe("2026-11-06T15:30:00");
  });

  it("shows the event where it will land while dragging", () => {
    const { el, card } = column("2026-11-04");
    const result = render();
    startEventDragGrab("e1", card, grabY);
    act(() => result.current.handleColumnDragOver(dropOn(el, grabY + 30), "2026-11-04"));
    expect(result.current.dropTarget).toEqual({ dayKey: "2026-11-04", minutes: 16 * 60, durationMinutes: 60 });
  });
});

describe("resizing an event (pim-p3-2)", () => {
  it("changes nothing for a nudge of the edge, even on a compact grid", async () => {
    // 24 px an hour: 3 px is 7.5 minutes, which used to round up to a quarter hour.
    const result = render(24);
    const target = { setPointerCapture: () => {}, releasePointerCapture: () => {} };
    act(() => result.current.handleResizePointerDown("e1", "bottom", 15.5 * 60, 60, {
      stopPropagation: () => {}, preventDefault: () => {}, clientY: 500, pointerId: 1, target,
    } as unknown as PointerEvent));
    await act(() => result.current.handleResizePointerUp({ clientY: 503, target } as unknown as PointerEvent));
    expect(updateEvent).not.toHaveBeenCalled();
  });
});
