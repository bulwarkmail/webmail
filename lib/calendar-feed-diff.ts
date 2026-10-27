import type { CalendarEvent } from '@/lib/jmap/types';
import { normalizeAllDayDuration } from '@/lib/calendar-utils';
import { sanitizeOutgoingCalendarEventData } from '@/lib/calendar-event-normalization';

/**
 * What a subscribed iCal feed decides about an event it still carries, in
 * the form the subscription import writes it. Refreshing a subscription
 * writes these, and only when the feed changed one of them: alerts,
 * participants and anything else stay as the server holds them.
 */
export function feedFields(event: Partial<CalendarEvent>): Partial<CalendarEvent> {
  const src = sanitizeOutgoingCalendarEventData(event);
  const allDay = !!src.showWithoutTime;
  return {
    title: src.title ?? '',
    description: src.description ?? '',
    start: src.start,
    // As importEventsUnhooked: CalendarEvent/parse drops a DTEND equal to
    // DTSTART, the servers store that event with PT0S.
    duration: allDay ? normalizeAllDayDuration(src.duration) : (src.duration || 'PT0S'),
    timeZone: allDay ? null : (src.timeZone ?? null),
    showWithoutTime: allDay,
    status: src.status ?? 'confirmed',
    locations: src.locations ?? null,
    virtualLocations: src.virtualLocations ?? null,
    recurrenceRules: src.recurrenceRules ?? null,
    // Not excludedRecurrenceRules: 0.16 refuses that property even as null,
    // and RFC 5545 has retired EXRULE.
    recurrenceOverrides: src.recurrenceOverrides ?? null,
  };
}

const RULE_DEFAULTS: Record<string, unknown> = { interval: 1, rscale: 'gregorian', skip: 'omit', firstDayOfWeek: 'mo' };

/** JSON with sorted keys, without `@type` and a rule's default values. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      if (k === '@type' || RULE_DEFAULTS[k] === (v as Record<string, unknown>)[k]) continue;
      out[k] = (v as Record<string, unknown>)[k];
    }
    return out;
  });
}

// What an override may change and both servers give back as is. 0.16 adds
// `updated` (its own time) and repeats the base duration; 1.0 leaves out
// what equals the series, so a missing value is the series' value.
const OVERRIDE_FIELDS = ['title', 'description', 'start', 'duration', 'timeZone', 'showWithoutTime', 'status'] as const;

function overridesKey(fields: Partial<CalendarEvent>): string {
  const out: Record<string, unknown> = {};
  for (const [recurrenceId, patch] of Object.entries(fields.recurrenceOverrides ?? {})) {
    const p = (patch ?? {}) as Record<string, unknown>;
    out[recurrenceId] = p.excluded
      ? 'excluded'
      : OVERRIDE_FIELDS.map((k) => (k in p ? p[k] : fields[k]) ?? null);
  }
  return canonical(out);
}

const names = (map: Record<string, { name?: string; uri?: string }> | null | undefined, key: 'name' | 'uri') =>
  Object.values(map ?? {}).map((entry) => entry?.[key] ?? '').sort();

/** Whether the feed's copy of an event differs from the stored one in what the feed decides. */
export function feedChanged(incoming: Partial<CalendarEvent>, stored: Partial<CalendarEvent>): boolean {
  const a = feedFields(incoming);
  const b = feedFields(stored);
  const scalar = ['title', 'description', 'start', 'duration', 'timeZone', 'showWithoutTime', 'status'] as const;
  if (scalar.some((k) => (a[k] ?? null) !== (b[k] ?? null))) return true;
  if (canonical(names(a.locations as never, 'name')) !== canonical(names(b.locations as never, 'name'))) return true;
  if (canonical(names(a.virtualLocations as never, 'uri')) !== canonical(names(b.virtualLocations as never, 'uri'))) return true;
  if (canonical(a.recurrenceRules) !== canonical(b.recurrenceRules)) return true;
  return overridesKey(a) !== overridesKey(b);
}
