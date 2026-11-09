import { useState, useCallback, useEffect, useRef, type PointerEvent, type DragEvent } from "react";
import { format } from "date-fns";
import { useAuthStore } from "@/stores/auth-store";
import { useCalendarStore } from "@/stores/calendar-store";
import { toast } from "@/stores/toast-store";
import { debug } from "@/lib/debug";
import { formatIsoInTimeZone, getEventEndDate, getEventStartDate } from "@/lib/calendar-utils";
import { eventDragGrab } from "@/lib/calendar/event-drag-grab";
import { fromDisplayDate, getEffectiveTimeZone } from "@/lib/timezone";
import { movedEventUpdates } from "@/lib/calendar-participants";
import { useEventUserEmails } from "@/hooks/use-event-user-emails";
import type { Calendar, CalendarEvent } from "@/lib/jmap/types";

/** Saves a dragged or resized event; `kind` says which, for the message. */
export type MoveEventHandler = (
  event: CalendarEvent,
  updates: Partial<CalendarEvent>,
  sendSchedulingMessages: boolean | undefined,
  kind: "move" | "resize",
) => Promise<unknown> | void;

interface DragCreateState {
  dayKey: string;
  startMinutes: number;
  endMinutes: number;
}

export type ResizeEdge = "top" | "bottom";

interface ResizeState {
  eventId: string;
  topPx: number;
  heightPx: number;
  startMinutes: number;
  durationMinutes: number;
}

export interface QuickCreateState {
  dayKey: string;
  day: Date;
  hour: number;
  top: number;
}

interface DropTargetState {
  dayKey: string;
  minutes: number;
  /** The dragged event's length, to draw it where it will land; absent for a line only. */
  durationMinutes?: number;
}

interface UseTimeGridInteractionsOptions {
  hourHeight: number;
  calendars: Calendar[];
  onCreateRange: (startDate: Date, endDate?: Date) => void;
  errorMessages: {
    resize: string;
    move: string;
    created: string;
    error: string;
  };
  /** The message for a refused move or resize, `fallback` when there is nothing more to say. */
  describeError?: (error: unknown, fallback: string) => string;
  /** The user's calendar addresses: moving an event they organize asks its attendees again. */
  currentUserEmails?: string[];
  isMobile?: boolean;
  /**
   * The minutes from midnight at the top and bottom of the grid, when it
   * shows only part of the day (#1164). Pointer positions and the drawn
   * offsets are relative to `gridStartMinutes`.
   */
  gridStartMinutes?: number;
  gridEndMinutes?: number;
  /** Save a drop or resize (the page asks the scope of a series); else the store directly. */
  onMoveEvent?: MoveEventHandler;
}

/**
 * The range a drag from `anchorMinutes` to `currentMinutes` (both snapped)
 * selects, or null when it is shorter than a quarter of an hour. The
 * drawn selection, its label and the event it creates all come from this.
 */
export function dragCreateRange(anchorMinutes: number, currentMinutes: number): { startMinutes: number; endMinutes: number } | null {
  const startMinutes = Math.min(anchorMinutes, currentMinutes);
  const endMinutes = Math.max(anchorMinutes, currentMinutes);
  return endMinutes - startMinutes >= 15 ? { startMinutes, endMinutes } : null;
}

/** `date` moved by `minutes` on the local clock, not by elapsed time. */
function addWallClockMinutes(date: Date, minutes: number): Date {
  const shifted = new Date(date);
  shifted.setMinutes(shifted.getMinutes() + minutes);
  return shifted;
}

/**
 * Below this a drag or resize is a nudge and changes nothing, as the platform's own drag
 * threshold is for a click (pim-p3-2).
 */
export const MOVE_THRESHOLD_PX = 4;

/** The minutes a pointer moved `deltaY` pixels stands for, in quarter hours; 0 for a nudge. */
export function draggedMinutes(deltaY: number, hourHeight: number): number {
  if (Math.abs(deltaY) < MOVE_THRESHOLD_PX) return 0;
  // `|| 0`: no -0, so a nudge up compares equal to no move.
  return Math.round((deltaY / hourHeight) * 60 / 15) * 15 || 0;
}

function dayOfKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Where a dragged event starts after a drop: moved by the distance dragged since it was
 * grabbed (and by the days between the columns), as Google Calendar and Outlook do, not
 * to the slot under the pointer (pim-p3-2). Null when that is no move at all.
 */
export function movedEventStart(
  eventStart: Date,
  grab: { dayKey: string; columnY: number },
  drop: { dayKey: string; columnY: number },
  hourHeight: number,
): Date | null {
  const days = Math.round((dayOfKey(drop.dayKey).getTime() - dayOfKey(grab.dayKey).getTime()) / 86_400_000);
  const minutes = draggedMinutes(drop.columnY - grab.columnY, hourHeight);
  if (days === 0 && minutes === 0) return null;
  const moved = new Date(eventStart);
  moved.setDate(moved.getDate() + days);
  return addWallClockMinutes(moved, minutes);
}

export function useTimeGridInteractions({
  hourHeight,
  calendars,
  onCreateRange,
  errorMessages,
  describeError,
  currentUserEmails,
  isMobile,
  gridStartMinutes = 0,
  gridEndMinutes = 1440,
  onMoveEvent,
}: UseTimeGridInteractionsOptions) {
  // A move of another signed-in login's event: that login's addresses (pim-12).
  const userEmailsFor = useEventUserEmails(currentUserEmails ?? []);
  const snapToMinutes = useCallback((clientY: number, containerTop: number): number => {
    const raw = gridStartMinutes + ((clientY - containerTop) / hourHeight) * 60;
    return Math.max(gridStartMinutes, Math.min(gridEndMinutes, Math.round(raw / 15) * 15));
  }, [hourHeight, gridStartMinutes, gridEndMinutes]);

  const wasDragging = useRef(false);

  // --- Drag-to-create ---
  // The range on screen is the range created: the release commits the
  // selection last drawn rather than measuring the pointer again, and a
  // scroll during the drag redraws it under the pointer.
  const dragRef = useRef<{
    dayKey: string;
    dayDate: Date;
    startMinutes: number;
    pointerId: number;
    startY: number;
    captured: boolean;
    column: HTMLElement;
    lastY: number;
    range: { startMinutes: number; endMinutes: number } | null;
    stopScrollWatch?: () => void;
  } | null>(null);

  const [dragCreate, setDragCreate] = useState<DragCreateState | null>(null);

  const updateDragRange = useCallback((clientY: number) => {
    const drag = dragRef.current;
    if (!drag) return;
    drag.lastY = clientY;
    const range = dragCreateRange(drag.startMinutes, snapToMinutes(clientY, drag.column.getBoundingClientRect().top));
    drag.range = range;
    setDragCreate(range ? { dayKey: drag.dayKey, ...range } : null);
  }, [snapToMinutes]);

  const endDrag = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    drag?.stopScrollWatch?.();
    setDragCreate(null);
    return drag;
  }, []);

  const handleGridPointerDown = useCallback((
    e: PointerEvent<HTMLDivElement>,
    dayKey: string,
    dayDate: Date,
  ) => {
    if (isMobile) return;
    if (e.pointerType === "touch") return;
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("[data-calendar-event], [data-resize-handle]")) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const minutes = snapToMinutes(e.clientY, rect.top);

    dragRef.current?.stopScrollWatch?.();
    dragRef.current = {
      dayKey, dayDate, startMinutes: minutes,
      pointerId: e.pointerId, startY: e.clientY, captured: false,
      column: e.currentTarget, lastY: e.clientY, range: null,
    };
  }, [snapToMinutes, isMobile]);

  const handleGridPointerMove = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;

    if (!drag.captured) {
      if (Math.abs(e.clientY - drag.startY) < 5) return;
      drag.captured = true;
      e.currentTarget.setPointerCapture(drag.pointerId);
      // The wheel or the browser's autoscroll moves the grid under a
      // pointer that stands still: follow it.
      const onScroll = () => updateDragRange(drag.lastY);
      window.addEventListener("scroll", onScroll, true);
      drag.stopScrollWatch = () => window.removeEventListener("scroll", onScroll, true);
    }

    updateDragRange(e.clientY);
  }, [updateDragRange]);

  const handleGridPointerUp = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const drag = endDrag();
    if (!drag || !drag.captured) return;

    wasDragging.current = true;
    requestAnimationFrame(() => { wasDragging.current = false; });

    try { e.currentTarget.releasePointerCapture(drag.pointerId); } catch { /* may already be released */ }

    const range = drag.range;
    if (!range) return;

    const startDate = new Date(drag.dayDate);
    startDate.setHours(Math.floor(range.startMinutes / 60), range.startMinutes % 60, 0, 0);
    const endDate = new Date(drag.dayDate);
    endDate.setHours(Math.floor(range.endMinutes / 60), range.endMinutes % 60, 0, 0);
    onCreateRange(startDate, endDate);
  }, [endDrag, onCreateRange]);

  useEffect(() => () => dragRef.current?.stopScrollWatch?.(), []);

  /** The browser took the pointer over (a touch scroll, a system gesture): nothing is created. */
  const handleGridPointerCancel = useCallback(() => {
    endDrag();
  }, [endDrag]);

  // --- Resize ---
  const resizeRef = useRef<{
    eventId: string;
    edge: ResizeEdge;
    startY: number;
    originalStartMinutes: number;
    originalDurationMinutes: number;
    pointerId: number;
  } | null>(null);

  const [resizeVisual, setResizeVisual] = useState<ResizeState | null>(null);

  const computeResize = useCallback((
    ref: NonNullable<typeof resizeRef.current>,
    clientY: number,
  ): { startMinutes: number; durationMinutes: number } => {
    const deltaMinutes = draggedMinutes(clientY - ref.startY, hourHeight);
    const originalEnd = ref.originalStartMinutes + ref.originalDurationMinutes;

    if (ref.edge === "bottom") {
      const newDuration = Math.max(15, ref.originalDurationMinutes + deltaMinutes);
      return { startMinutes: ref.originalStartMinutes, durationMinutes: newDuration };
    }
    // Top edge: move start, keep end fixed. Clamp so duration stays >= 15 and
    // start stays on the grid.
    let newStart = ref.originalStartMinutes + deltaMinutes;
    newStart = Math.max(Math.min(gridStartMinutes, ref.originalStartMinutes), Math.min(originalEnd - 15, newStart));
    return { startMinutes: newStart, durationMinutes: originalEnd - newStart };
  }, [hourHeight, gridStartMinutes]);

  const handleResizePointerDown = useCallback((
    eventId: string,
    edge: ResizeEdge,
    originalStartMinutes: number,
    originalDurationMinutes: number,
    e: PointerEvent,
  ) => {
    e.stopPropagation();
    e.preventDefault();

    resizeRef.current = {
      eventId,
      edge,
      startY: e.clientY,
      originalStartMinutes,
      originalDurationMinutes,
      pointerId: e.pointerId,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handleResizePointerMove = useCallback((e: PointerEvent) => {
    if (!resizeRef.current) return;
    const { startMinutes, durationMinutes } = computeResize(resizeRef.current, e.clientY);
    setResizeVisual({
      eventId: resizeRef.current.eventId,
      topPx: ((startMinutes - gridStartMinutes) / 60) * hourHeight,
      heightPx: (durationMinutes / 60) * hourHeight,
      startMinutes,
      durationMinutes,
    });
  }, [hourHeight, computeResize, gridStartMinutes]);

  const handleResizePointerUp = useCallback(async (e: PointerEvent) => {
    const resize = resizeRef.current;
    resizeRef.current = null;

    if (!resize) return;

    wasDragging.current = true;
    requestAnimationFrame(() => { wasDragging.current = false; });

    try { (e.target as HTMLElement).releasePointerCapture(resize.pointerId); } catch { /* may already be released */ }

    const { startMinutes: newStartMinutes, durationMinutes: newDurationMinutes } = computeResize(resize, e.clientY);

    const startChanged = newStartMinutes !== resize.originalStartMinutes;
    const durationChanged = newDurationMinutes !== resize.originalDurationMinutes;
    if (!startChanged && !durationChanged) {
      setResizeVisual(null);
      return;
    }

    const client = useAuthStore.getState().client;
    if (!client) {
      setResizeVisual(null);
      toast.error(errorMessages.resize);
      return;
    }

    try {
      const event = useCalendarStore.getState().events.find(ev => ev.id === resize.eventId);
      let durationMinutes = newDurationMinutes;
      let start: string | undefined;
      if (event?.start) {
        // The grid counts wall-clock minutes. Move the edges by clock time
        // and measure the duration between the real instants, so a resize
        // across a DST change lands where the edge was dropped (#1348).
        const newStart = addWallClockMinutes(getEventStartDate(event), newStartMinutes - resize.originalStartMinutes);
        const newEnd = addWallClockMinutes(newStart, newDurationMinutes);
        const startInstant = fromDisplayDate(newStart);
        durationMinutes = Math.round((fromDisplayDate(newEnd).getTime() - startInstant.getTime()) / 60000);
        // Emit `start` in the event's own timeZone, as a drop does.
        if (startChanged) start = formatIsoInTimeZone(startInstant, event.timeZone || getEffectiveTimeZone());
      }
      const hours = Math.floor(durationMinutes / 60);
      const mins = durationMinutes % 60;
      let dur = "PT";
      if (hours > 0) dur += `${hours}H`;
      if (mins > 0) dur += `${mins}M`;
      if (dur === "PT") dur = "PT0M";
      const updates: { start?: string; duration: string } = { duration: dur };
      if (start) updates.start = start;
      const moved = movedEventUpdates(event, updates, userEmailsFor(event));
      if (event && onMoveEvent) await onMoveEvent(event, moved.updates, moved.sendSchedulingMessages, "resize");
      else await useCalendarStore.getState().updateEvent(client, resize.eventId, moved.updates, moved.sendSchedulingMessages);
    } catch (error) {
      debug.error("Failed to resize event:", resize.eventId, error);
      toast.error(describeError ? describeError(error, errorMessages.resize) : errorMessages.resize);
    } finally {
      setResizeVisual(null);
    }
  }, [computeResize, errorMessages.resize, describeError, userEmailsFor, onMoveEvent]);

  // --- Click / Double-click / Quick-create ---
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [quickCreate, setQuickCreate] = useState<QuickCreateState | null>(null);

  // Pass an explicit end alongside the clicked slot: the event modal only
  // honors a timed `defaultDate` when `defaultEndDate` is present — without it
  // the modal falls back to "next hour from now" (meant for date-only month
  // clicks) and discards the clicked time (#435).
  const slotToRange = useCallback((day: Date, hour: number): [Date, Date] => {
    const start = new Date(day);
    start.setHours(hour, 0, 0, 0);
    const end = new Date(day);
    end.setHours(hour + 1, 0, 0, 0);
    return [start, end];
  }, []);

  const handleSlotClick = useCallback((day: Date, hour: number) => {
    if (wasDragging.current) return;
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      return;
    }
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null;
      onCreateRange(...slotToRange(day, hour));
    }, 250);
  }, [onCreateRange, slotToRange]);

  const handleSlotDoubleClick = useCallback((day: Date, hour: number) => {
    if (wasDragging.current) return;
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    onCreateRange(...slotToRange(day, hour));
  }, [onCreateRange, slotToRange]);

  const handleQuickCreateSubmit = useCallback(async (title: string) => {
    if (!quickCreate) return;
    const client = useAuthStore.getState().client;
    if (!client) {
      setQuickCreate(null);
      toast.error(errorMessages.error);
      return;
    }
    try {
      const startDate = new Date(quickCreate.day);
      startDate.setHours(quickCreate.hour, 0, 0, 0);
      const startStr = format(startDate, "yyyy-MM-dd'T'HH:mm:ss");
      const timeZone = getEffectiveTimeZone();
      const defaultCal = calendars.find(c => c.isDefault) || calendars[0];
      const created = await useCalendarStore.getState().createEvent(client, {
        title,
        start: startStr,
        duration: "PT1H",
        timeZone,
        calendarIds: defaultCal ? { [defaultCal.id]: true } : {},
        status: "confirmed",
        freeBusyStatus: "busy",
        privacy: "public",
      });
      setQuickCreate(null);
      if (created) toast.success(errorMessages.created);
      else toast.error(errorMessages.error);
    } catch (error) {
      debug.error("Failed to quick-create event:", error);
      setQuickCreate(null);
      toast.error(errorMessages.error);
    }
  }, [quickCreate, calendars, errorMessages.created, errorMessages.error]);

  const handleQuickCreateCancel = useCallback(() => {
    setQuickCreate(null);
  }, []);

  // --- DnD drop ---
  const [dropTarget, setDropTarget] = useState<DropTargetState | null>(null);

  const snapDragMinutes = useCallback((e: DragEvent<HTMLDivElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const raw = gridStartMinutes + (y / hourHeight) * 60;
    return Math.max(gridStartMinutes, Math.min(gridEndMinutes - 15, Math.round(raw / 15) * 15));
  }, [hourHeight, gridStartMinutes, gridEndMinutes]);

  /**
   * Where the event being dragged would start if dropped here: moved by the distance
   * dragged when the card said where it was grabbed (pim-p3-2), else the pointer's slot
   * (an all-day bar or a drag from elsewhere). `start` null: it stays where it is; absent: no grab known.
   */
  const dropPlacement = useCallback((e: DragEvent<HTMLDivElement>, dayKey: string, eventId?: string): { event?: CalendarEvent; start?: Date | null; slotMinutes: number } => {
    const slotMinutes = snapDragMinutes(e);
    const grab = eventDragGrab(eventId);
    const event = grab ? useCalendarStore.getState().events.find((ev) => ev.id === grab.eventId) : undefined;
    if (!grab || !event?.start) return { event, slotMinutes };
    const columnY = e.clientY - e.currentTarget.getBoundingClientRect().top;
    return { event, start: movedEventStart(getEventStartDate(event), grab, { dayKey, columnY }, hourHeight), slotMinutes };
  }, [snapDragMinutes, hourHeight]);

  const handleColumnDragOver = useCallback((e: DragEvent<HTMLDivElement>, dayKey: string) => {
    if (!e.dataTransfer.types.includes("application/x-calendar-event")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const { event, start, slotMinutes } = dropPlacement(e, dayKey);
    let next: DropTargetState = { dayKey, minutes: slotMinutes };
    if (event && start !== undefined) {
      // The event itself, drawn where it will land; where it is now when that's no move.
      const at = start ?? getEventStartDate(event);
      const durationMinutes = Math.max(15, Math.round((getEventEndDate(event).getTime() - getEventStartDate(event).getTime()) / 60000));
      const sameDay = format(at, "yyyy-MM-dd") === dayKey;
      next = { dayKey, minutes: sameDay ? at.getHours() * 60 + at.getMinutes() : gridStartMinutes, durationMinutes };
    }
    setDropTarget((prev) =>
      prev?.dayKey === next.dayKey && prev?.minutes === next.minutes && prev?.durationMinutes === next.durationMinutes ? prev : next
    );
  }, [dropPlacement, gridStartMinutes]);

  const handleColumnDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    const related = e.relatedTarget as Node | null;
    if (!e.currentTarget.contains(related)) setDropTarget(null);
  }, []);

  const handleColumnDrop = useCallback(async (e: DragEvent<HTMLDivElement>, day: Date) => {
    // Anything else (a Pro tab or message moving to this pane) is not ours.
    const json = e.dataTransfer.getData("application/x-calendar-event");
    if (!json) return;
    e.preventDefault();
    setDropTarget(null);
    try {
      const data = JSON.parse(json);
      const placement = dropPlacement(e, format(day, "yyyy-MM-dd"), data.eventId);
      // A nudge, or dropped where it was: nothing to save.
      if (placement.event && placement.start === null) return;
      let newStart = placement.start;
      if (!newStart) {
        newStart = new Date(day);
        newStart.setHours(Math.floor(placement.slotMinutes / 60), placement.slotMinutes % 60, 0, 0);
      }
      const event = useCalendarStore.getState().events.find(ev => ev.id === data.eventId);
      // Emit `start` as a floating wall-clock in the event's own timeZone.
      // If we used browser-local, the server would reinterpret it in event.timeZone
      // and shift the event by the offset between the two zones.
      const eventTimeZone = event?.timeZone || getEffectiveTimeZone();
      // `newStart` is a display date (grid space); turn it back into the real
      // instant before expressing it in the event's zone (#755).
      const newStartISO = formatIsoInTimeZone(fromDisplayDate(newStart), eventTimeZone);
      if (newStartISO === data.originalStart) return;
      const client = useAuthStore.getState().client;
      if (!client) {
        toast.error(errorMessages.move);
        return;
      }
      const moved = movedEventUpdates(event, { start: newStartISO }, userEmailsFor(event));
      if (event && onMoveEvent) await onMoveEvent(event, moved.updates, moved.sendSchedulingMessages, "move");
      else await useCalendarStore.getState().updateEvent(client, data.eventId, moved.updates, moved.sendSchedulingMessages);
    } catch (error) {
      toast.error(describeError ? describeError(error, errorMessages.move) : errorMessages.move);
    }
  }, [dropPlacement, errorMessages.move, describeError, userEmailsFor, onMoveEvent]);

  return {
    dragCreate,
    handleGridPointerDown,
    handleGridPointerMove,
    handleGridPointerUp,
    handleGridPointerCancel,
    resizeVisual,
    handleResizePointerDown,
    handleResizePointerMove,
    handleResizePointerUp,
    wasDragging,
    quickCreate,
    handleSlotClick,
    handleSlotDoubleClick,
    handleQuickCreateSubmit,
    handleQuickCreateCancel,
    dropTarget,
    handleColumnDragOver,
    handleColumnDragLeave,
    handleColumnDrop,
  };
}
