import { useState, useCallback, useRef, type PointerEvent, type DragEvent } from "react";
import { format, parseISO } from "date-fns";
import { useAuthStore } from "@/stores/auth-store";
import { useCalendarStore } from "@/stores/calendar-store";
import { toast } from "@/stores/toast-store";
import { debug } from "@/lib/debug";
import { formatIsoInTimeZone } from "@/lib/calendar-utils";
import type { Calendar } from "@/lib/jmap/types";

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
  isMobile?: boolean;
}

export function useTimeGridInteractions({
  hourHeight,
  calendars,
  onCreateRange,
  errorMessages,
  isMobile,
}: UseTimeGridInteractionsOptions) {
  const snapToMinutes = useCallback((clientY: number, containerTop: number): number => {
    const raw = ((clientY - containerTop) / hourHeight) * 60;
    return Math.max(0, Math.min(1440, Math.round(raw / 15) * 15));
  }, [hourHeight]);

  const wasDragging = useRef(false);

  // --- Drag-to-create ---
  const dragRef = useRef<{
    dayKey: string;
    dayDate: Date;
    startMinutes: number;
    pointerId: number;
    startY: number;
    captured: boolean;
  } | null>(null);

  const [dragCreate, setDragCreate] = useState<DragCreateState | null>(null);

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

    dragRef.current = {
      dayKey, dayDate, startMinutes: minutes,
      pointerId: e.pointerId, startY: e.clientY, captured: false,
    };
  }, [snapToMinutes, isMobile]);

  const handleGridPointerMove = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;

    if (!dragRef.current.captured) {
      if (Math.abs(e.clientY - dragRef.current.startY) < 5) return;
      dragRef.current.captured = true;
      e.currentTarget.setPointerCapture(dragRef.current.pointerId);
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const currentMinutes = snapToMinutes(e.clientY, rect.top);
    const start = Math.min(dragRef.current.startMinutes, currentMinutes);
    const end = Math.max(dragRef.current.startMinutes, currentMinutes);

    setDragCreate(end > start ? { dayKey: dragRef.current.dayKey, startMinutes: start, endMinutes: end } : null);
  }, [snapToMinutes]);

  const handleGridPointerUp = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragCreate(null);

    if (!drag || !drag.captured) return;

    wasDragging.current = true;
    requestAnimationFrame(() => { wasDragging.current = false; });

    try { e.currentTarget.releasePointerCapture(drag.pointerId); } catch { /* may already be released */ }

    const rect = e.currentTarget.getBoundingClientRect();
    const endMinutes = snapToMinutes(e.clientY, rect.top);
    const start = Math.min(drag.startMinutes, endMinutes);
    const end = Math.max(drag.startMinutes, endMinutes);

    if (end - start < 15) return;

    const startDate = new Date(drag.dayDate);
    startDate.setHours(Math.floor(start / 60), start % 60, 0, 0);
    const endDate = new Date(drag.dayDate);
    endDate.setHours(Math.floor(end / 60), end % 60, 0, 0);
    onCreateRange(startDate, endDate);
  }, [snapToMinutes, onCreateRange]);

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
    const deltaY = clientY - ref.startY;
    const deltaMinutes = Math.round((deltaY / hourHeight) * 60 / 15) * 15;
    const originalEnd = ref.originalStartMinutes + ref.originalDurationMinutes;

    if (ref.edge === "bottom") {
      const newDuration = Math.max(15, ref.originalDurationMinutes + deltaMinutes);
      return { startMinutes: ref.originalStartMinutes, durationMinutes: newDuration };
    }
    // Top edge: move start, keep end fixed. Clamp so duration stays >= 15 and start >= 0.
    let newStart = ref.originalStartMinutes + deltaMinutes;
    newStart = Math.max(0, Math.min(originalEnd - 15, newStart));
    return { startMinutes: newStart, durationMinutes: originalEnd - newStart };
  }, [hourHeight]);

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
      topPx: (startMinutes / 60) * hourHeight,
      heightPx: (durationMinutes / 60) * hourHeight,
      startMinutes,
      durationMinutes,
    });
  }, [hourHeight, computeResize]);

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

    const hours = Math.floor(newDurationMinutes / 60);
    const mins = newDurationMinutes % 60;
    let dur = "PT";
    if (hours > 0) dur += `${hours}H`;
    if (mins > 0) dur += `${mins}M`;
    if (dur === "PT") dur = "PT0M";

    const client = useAuthStore.getState().client;
    if (!client) {
      setResizeVisual(null);
      toast.error(errorMessages.resize);
      return;
    }

    try {
      const event = useCalendarStore.getState().events.find(ev => ev.id === resize.eventId);
      const hasParticipants = event?.participants && Object.keys(event.participants).length > 0;
      const updates: { start?: string; duration: string } = { duration: dur };
      if (startChanged && event?.start) {
        // Shift the event's floating `start` wall-clock by the delta (preserves event.timeZone).
        const deltaMinutes = newStartMinutes - resize.originalStartMinutes;
        const shifted = new Date(parseISO(event.start).getTime() + deltaMinutes * 60000);
        updates.start = format(shifted, "yyyy-MM-dd'T'HH:mm:ss");
      }
      await useCalendarStore.getState().updateEvent(client, resize.eventId, updates, hasParticipants || undefined);
    } catch (error) {
      debug.error("Failed to resize event:", resize.eventId, error);
      toast.error(errorMessages.resize);
    } finally {
      setResizeVisual(null);
    }
  }, [computeResize, errorMessages.resize]);

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
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
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
    const raw = (y / hourHeight) * 60;
    return Math.max(0, Math.min(1425, Math.round(raw / 15) * 15));
  }, [hourHeight]);

  const handleColumnDragOver = useCallback((e: DragEvent<HTMLDivElement>, dayKey: string) => {
    if (!e.dataTransfer.types.includes("application/x-calendar-event")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const minutes = snapDragMinutes(e);
    setDropTarget((prev) =>
      prev?.dayKey === dayKey && prev?.minutes === minutes ? prev : { dayKey, minutes }
    );
  }, [snapDragMinutes]);

  const handleColumnDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    const related = e.relatedTarget as Node | null;
    if (!e.currentTarget.contains(related)) setDropTarget(null);
  }, []);

  const handleColumnDrop = useCallback(async (e: DragEvent<HTMLDivElement>, day: Date) => {
    e.preventDefault();
    setDropTarget(null);
    const json = e.dataTransfer.getData("application/x-calendar-event");
    if (!json) return;
    try {
      const data = JSON.parse(json);
      const minutes = snapDragMinutes(e);
      const newStart = new Date(day);
      newStart.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
      const event = useCalendarStore.getState().events.find(ev => ev.id === data.eventId);
      // Emit `start` as a floating wall-clock in the event's own timeZone.
      // If we used browser-local, the server would reinterpret it in event.timeZone
      // and shift the event by the offset between the two zones.
      const eventTimeZone = event?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
      const newStartISO = formatIsoInTimeZone(newStart, eventTimeZone);
      if (newStartISO === data.originalStart) return;
      const client = useAuthStore.getState().client;
      if (!client) {
        toast.error(errorMessages.move);
        return;
      }
      const hasParticipants = event?.participants && Object.keys(event.participants).length > 0;
      await useCalendarStore.getState().updateEvent(client, data.eventId, { start: newStartISO }, hasParticipants || undefined);
    } catch {
      toast.error(errorMessages.move);
    }
  }, [snapDragMinutes, errorMessages.move]);

  return {
    dragCreate,
    handleGridPointerDown,
    handleGridPointerMove,
    handleGridPointerUp,
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
