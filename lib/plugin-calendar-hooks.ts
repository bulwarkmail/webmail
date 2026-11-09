import { CalendarEvent } from "./jmap/types";

export function isCalendarEvent(object: unknown): object is CalendarEvent {
    if (!object || typeof object !== 'object') {
        return false;
    }

    const ev = object as Record<string, unknown>;

    return (
        typeof ev.id === 'string' &&
        typeof ev.start === 'string' &&
        typeof ev.calendarIds === 'object' 
    );
}

export function isCalendarEventArray(object: unknown): object is CalendarEvent[] {
    if (!Array.isArray(object)) {
        return false;
    }
    return object.every((item) => isCalendarEvent(item));
}

export function isPartialCalendarEvent(object: unknown): object is Partial<CalendarEvent> {
    if (!object || typeof object !== 'object' || Array.isArray(object)) {
        return false;
    }
    const ev = object as Record<string, unknown>;

    if ('id' in ev && ev.id !== undefined && typeof ev.id !== 'string') return false;
    if ('originalId' in ev && ev.originalId !== undefined && typeof ev.originalId !== 'string') return false;
    if ('baseEventId' in ev && ev.baseEventId !== undefined && ev.baseEventId !== null && typeof ev.baseEventId !== 'string') return false;
    
    if ('isDraft' in ev && ev.isDraft !== undefined && typeof ev.isDraft !== 'boolean') return false;
    if ('isOrigin' in ev && ev.isOrigin !== undefined && typeof ev.isOrigin !== 'boolean') return false;
    
    if ('title' in ev && ev.title !== undefined && typeof ev.title !== 'string') return false;
    if ('description' in ev && ev.description !== undefined && typeof ev.description !== 'string') return false;
    
    if ('sequence' in ev && ev.sequence !== undefined && typeof ev.sequence !== 'number') return false;
    if ('start' in ev && ev.start !== undefined && typeof ev.start !== 'string') return false;
    if ('duration' in ev && ev.duration !== undefined && typeof ev.duration !== 'string') return false;
    
    if ('status' in ev && ev.status !== undefined && !['tentative', 'confirmed', 'cancelled'].includes(ev.status as string)) return false;
    if ('freeBusyStatus' in ev && ev.freeBusyStatus !== undefined && !['free', 'busy'].includes(ev.freeBusyStatus as string)) return false;
    if ('privacy' in ev && ev.privacy !== undefined && !['public', 'private', 'secret'].includes(ev.privacy as string)) return false;

    if ('recurrenceOverrides' in ev && ev.recurrenceOverrides !== undefined && ev.recurrenceOverrides !== null) {
        if (typeof ev.recurrenceOverrides !== 'object') return false;
    }
    return true;
}

/** A { start, end } pair of dates, as onBeforeFetchEvents must return. */
export function isFetchRange(object: unknown): object is { start: string; end: string } {
    if (!object || typeof object !== 'object') return false;
    const { start, end } = object as Record<string, unknown>;
    return typeof start === 'string' && typeof end === 'string'
        && !Number.isNaN(Date.parse(start)) && !Number.isNaN(Date.parse(end));
}
