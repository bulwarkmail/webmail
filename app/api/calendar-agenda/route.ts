import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { fetchJmapSession, postJmap, rebaseApiUrl } from '@/lib/stalwart/jmap-api';
import { normalizeCalendarEventLike } from '@/lib/calendar-event-normalization';
import { expandRecurringEvents } from '@/lib/recurrence-expansion';
import { parseISO } from 'date-fns';
import type { CalendarEvent } from '@/lib/jmap/types';

/**
 * POST /api/calendar-agenda
 *
 * Sidecar for the "Calendar Agenda" plugin. Resolves the caller's calendar
 * account from the stored Stalwart auth context, queries upcoming
 * CalendarEvents over JMAP, expands recurring series server-side, and returns
 * a slim, structured-cloneable agenda the plugin can render directly.
 *
 * Credentials never leave the server — the sandboxed plugin only ever sees
 * the resulting agenda DTOs.
 *
 * Body: { days?: number (1-90, default 7), limit?: number (1-200, default 50) }
 */

const CALENDAR_CAP = 'urn:ietf:params:jmap:calendars';
const PRINCIPALS_OWNER_CAP = 'urn:ietf:params:jmap:principals:owner';

// Mirror of lib/jmap/client.ts CALENDAR_EVENT_PROPERTIES, trimmed to what the
// agenda actually needs (start/recurrence/display fields).
const EVENT_PROPERTIES = [
  'id', '@type', 'uid', 'calendarIds', 'title', 'start', 'duration', 'timeZone',
  'showWithoutTime', 'utcStart', 'utcEnd', 'status', 'freeBusyStatus', 'color',
  'locations', 'recurrenceId', 'recurrenceIdTimeZone', 'recurrenceRule',
  'recurrenceOverrides', 'excludedRecurrenceRule',
] as const;

interface AgendaEvent {
  id: string;
  uid: string | null;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  status: string | null;
  color: string | null;
  location: string | null;
  calendarId: string | null;
}

// Pure, server-safe equivalents of lib/calendar-utils' getEventStartDate /
// getEventEndDate. We can't import that module here because it transitively
// pulls in a "use client" calendar component (which throws at load on the
// server). Logic mirrors the originals.
function parseDurationMinutes(duration: string | undefined): number {
  if (!duration) return 0;
  let total = 0;
  const week = duration.match(/(\d+)W/);
  const day = duration.match(/(\d+)D/);
  const hour = duration.match(/(\d+)H/);
  const min = duration.match(/(\d+)M/);
  if (week) total += parseInt(week[1], 10) * 7 * 24 * 60;
  if (day) total += parseInt(day[1], 10) * 24 * 60;
  if (hour) total += parseInt(hour[1], 10) * 60;
  if (min) total += parseInt(min[1], 10);
  return total;
}

function eventStart(event: Partial<CalendarEvent>): Date {
  if (!event.showWithoutTime && event.utcStart) {
    const utc = parseISO(event.utcStart);
    if (!isNaN(utc.getTime())) return utc;
  }
  return parseISO(event.start as string);
}

function eventEnd(event: Partial<CalendarEvent>): Date {
  if (!event.showWithoutTime && event.utcEnd) {
    const utc = parseISO(event.utcEnd);
    if (!isNaN(utc.getTime())) return utc;
  }
  const start = eventStart(event);
  if (!event.duration) return start;
  return new Date(start.getTime() + parseDurationMinutes(event.duration) * 60000);
}

function firstLocationName(event: Partial<CalendarEvent>): string | null {
  const locations = event.locations;
  if (!locations || typeof locations !== 'object') return null;
  for (const loc of Object.values(locations)) {
    const name = (loc as { name?: unknown })?.name;
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  return null;
}

function firstCalendarId(event: Partial<CalendarEvent>): string | null {
  const ids = event.calendarIds;
  if (!ids || typeof ids !== 'object') return null;
  const keys = Object.keys(ids);
  return keys.length > 0 ? keys[0] : null;
}

export async function POST(request: NextRequest) {
  try {
    const creds = await getStalwartCredentials(request);
    if (!creds) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    let body: { days?: unknown; limit?: unknown } = {};
    try {
      body = await request.json();
    } catch {
      /* empty body is fine */
    }
    const days = clampInt(body.days, 1, 90, 7);
    const limit = clampInt(body.limit, 1, 200, 50);

    // ── Resolve the calendar account from the JMAP session ──
    // Hit Stalwart's canonical session endpoint on the SAME host as serverUrl.
    // We deliberately avoid /.well-known/jmap: it 301s to the server's
    // configured public hostname, which the host process may not be able to
    // resolve (the browser client rewrites those URLs back to the origin for
    // the same reason). Fall back to /.well-known/jmap for non-Stalwart servers.
    const session = await fetchJmapSession(creds.serverUrl, creds.authHeader);
    if (!session) {
      return NextResponse.json({ error: 'JMAP session fetch failed' }, { status: 502 });
    }
    const accountId = session.primaryAccounts?.[CALENDAR_CAP];
    if (!accountId) {
      // No calendar account for this user — return an empty agenda, not an error.
      return NextResponse.json({ events: [], generatedAt: new Date().toISOString() });
    }

    const using = ['urn:ietf:params:jmap:core', CALENDAR_CAP];
    if (session.capabilities && PRINCIPALS_OWNER_CAP in session.capabilities) {
      using.push(PRINCIPALS_OWNER_CAP);
    }

    // Send method calls to the session's apiUrl rebased onto serverUrl's host
    // — never to session.apiUrl's (possibly unreachable) public host.
    const apiUrl = rebaseApiUrl(session, creds.serverUrl) ?? `${creds.serverUrl}/jmap/`;

    const now = new Date();
    const horizon = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    // Expand from the start of today so all-day / already-running events still
    // show in the agenda.
    const windowStart = new Date(now);
    windowStart.setHours(0, 0, 0, 0);

    // ── 1) Query event IDs in range + load calendars (colours) ──
    const queryReq = {
      using,
      methodCalls: [
        [
          'CalendarEvent/query',
          {
            accountId,
            // Mirror the app's calendar store: an { after, before } window lets
            // Stalwart evaluate recurrence so masters with occurrences in range
            // are returned (a `before`-only filter can drop unbounded series).
            filter: { after: windowStart.toISOString(), before: horizon.toISOString() },
            limit: 1000,
          },
          '0',
        ],
        [
          'Calendar/get',
          { accountId, ids: null, properties: ['id', 'name', 'color'] },
          'c',
        ],
      ],
    };

    const queryRes = await jmapPost(apiUrl, creds.authHeader, queryReq);
    const queryResp = findResponse(queryRes, 'CalendarEvent/query', '0');
    if (!queryResp) {
      const err = findResponse(queryRes, 'error', '0');
      return NextResponse.json(
        { error: (err?.description as string) || 'CalendarEvent/query failed' },
        { status: 502 },
      );
    }
    const ids = (queryResp.ids as string[]) || [];

    const calColors = new Map<string, { name: string; color: string | null }>();
    const calResp = findResponse(queryRes, 'Calendar/get', 'c');
    for (const cal of ((calResp?.list as Array<Record<string, unknown>>) || [])) {
      if (typeof cal.id === 'string') {
        calColors.set(cal.id, {
          name: typeof cal.name === 'string' ? cal.name : '',
          color: typeof cal.color === 'string' ? cal.color : null,
        });
      }
    }

    if (ids.length === 0) {
      return NextResponse.json({ events: [], generatedAt: now.toISOString() });
    }

    // ── 2) Fetch full event objects (batched) ──
    const raw: Array<Record<string, unknown>> = [];
    const BATCH = 100;
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      const getRes = await jmapPost(apiUrl, creds.authHeader, {
        using,
        methodCalls: [
          ['CalendarEvent/get', { accountId, ids: batch, properties: EVENT_PROPERTIES }, '0'],
        ],
      });
      const getResp = findResponse(getRes, 'CalendarEvent/get', '0');
      if (getResp?.list) raw.push(...(getResp.list as Array<Record<string, unknown>>));
    }

    // ── 3) Normalize + expand recurrences server-side ──
    const normalized = raw
      .map((e) => normalizeCalendarEventLike(e as Partial<CalendarEvent>))
      .filter((e) => (e['@type'] ?? 'Event') === 'Event')
      // Drop malformed events without a parseable start (would crash format()/
      // parseISO downstream) — mirrors the calendar store guard (#316).
      .filter((e) => typeof e.start === 'string' && e.start && !isNaN(parseISO(e.start).getTime())) as CalendarEvent[];

    const expanded = expandRecurringEvents(
      normalized,
      windowStart.toISOString(),
      horizon.toISOString(),
    );

    // ── 4) Keep ongoing/upcoming, sort, slice, map to DTOs ──
    const agenda: AgendaEvent[] = expanded
      .filter((e) => eventEnd(e).getTime() >= now.getTime())
      .sort((a, b) => eventStart(a).getTime() - eventStart(b).getTime())
      .slice(0, limit)
      .map((e) => {
        const calId = firstCalendarId(e);
        const cal = calId ? calColors.get(calId) : undefined;
        return {
          id: String(e.id ?? ''),
          uid: e.uid ?? null,
          title: (e.title ?? '').trim() || '(no title)',
          start: eventStart(e).toISOString(),
          end: eventEnd(e).toISOString(),
          allDay: !!e.showWithoutTime,
          status: e.status ?? null,
          color: e.color || cal?.color || null,
          location: firstLocationName(e),
          calendarId: calId,
        };
      });

    return NextResponse.json({ events: agenda, generatedAt: now.toISOString() });
  } catch (error) {
    // `fetch failed` from undici is too generic to debug — the real reason
    // (ENOTFOUND, ECONNREFUSED, self-signed TLS, …) lives on `error.cause`.
    const err = error as Error & { cause?: { code?: string; message?: string } };
    logger.error('Calendar agenda error', {
      error: err?.message ?? 'Unknown',
      causeCode: err?.cause?.code,
      causeMessage: err?.cause?.message,
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

async function jmapPost(
  apiUrl: string,
  authHeader: string,
  payload: unknown,
): Promise<unknown> {
  const res = await postJmap(apiUrl, authHeader, JSON.stringify(payload));
  if (!res.ok) {
    throw new Error(`JMAP request failed (${res.status})`);
  }
  return res.json();
}

function findResponse(
  res: unknown,
  name: string,
  callId: string,
): Record<string, unknown> | null {
  const responses = (res as { methodResponses?: unknown[] })?.methodResponses;
  if (!Array.isArray(responses)) return null;
  for (const entry of responses) {
    if (Array.isArray(entry) && entry[0] === name && entry[2] === callId) {
      return entry[1] as Record<string, unknown>;
    }
  }
  return null;
}
