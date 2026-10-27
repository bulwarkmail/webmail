import { NextRequest, NextResponse } from 'next/server';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { logger } from '@/lib/logger';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { loginClientAddress } from '@/lib/auth/client-address';
import { fetchJmapSession, postJmap, rebaseApiUrl } from '@/lib/stalwart/jmap-api';
import { normalizeCalendarEventLike } from '@/lib/calendar-event-normalization';
import { RECURRENCE_BASE_PROPERTIES, hydrateRecurrenceInstances, isServerRecurrenceInstance } from '@/lib/recurrence-instances';
import { parseISO } from 'date-fns';
import type { CalendarEvent } from '@/lib/jmap/types';
import { UpstreamBodyTooLargeError, readJsonCapped } from '@/lib/security/capped-body';

/**
 * POST /api/calendar-agenda
 *
 * Sidecar for the "Calendar Agenda" plugin. Resolves the caller's calendar
 * accounts from the stored Stalwart auth context, queries upcoming
 * CalendarEvents over JMAP with Stalwart expanding recurring series into
 * occurrences, and returns a slim, structured-cloneable agenda the plugin
 * can render directly.
 *
 * Events come from every account that has calendars: the primary calendar
 * account plus shared and group accounts (a family or team calendar), the
 * same set the calendar app shows. Ids are scoped by account, since event
 * and calendar ids repeat across accounts.
 *
 * Credentials never leave the server — the sandboxed plugin only ever sees
 * the resulting agenda DTOs.
 *
 * Body: { days?: number (1-90, default 7), limit?: number (1-200, default 50) }
 */

const CALENDAR_CAP = 'urn:ietf:params:jmap:calendars';
const PRINCIPALS_OWNER_CAP = 'urn:ietf:params:jmap:principals:owner';

// Mirror of lib/jmap/client.ts CALENDAR_EVENT_PROPERTIES, trimmed to what the
// agenda shows of an occurrence. The server expands the series, so no rule or
// overrides are needed - and Stalwart 1.0 refuses a get that asks for
// `recurrenceOverrides` together with utcStart/utcEnd.
const EVENT_PROPERTIES = [
  'id', '@type', 'uid', 'calendarIds', 'title', 'start', 'duration', 'timeZone',
  'showWithoutTime', 'utcStart', 'utcEnd', 'status', 'freeBusyStatus', 'color',
  'locations', 'recurrenceId', 'recurrenceIdTimeZone', 'baseEventId',
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const GET_BATCH = 100;
// Stalwart's default maxCallsInRequest, for a session that names none.
const MAX_CALLS_FALLBACK = 16;
// One answer holds at most maxCallsInRequest x GET_BATCH slim events.
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

interface AgendaEvent {
  /** Unique across accounts: `<accountId>:<event id>`. */
  id: string;
  accountId: string;
  uid: string | null;
  title: string;
  /** An instant (`...Z`); for an all-day event the date-time without an offset. */
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

/**
 * An all-day event's start and end as the dates it is stored with
 * (`2026-10-27T00:00:00`, no offset). As an instant it would be midnight in
 * this server's time zone, which anyone west of the server reads as the day
 * before; `new Date()` reads a date-time without an offset as the viewer's
 * own local time.
 */
function allDayRange(event: Partial<CalendarEvent>): { start: string; end: string } {
  const start = (event.start as string).slice(0, 19);
  const startMs = Date.parse(`${start}Z`);
  const end = new Date(startMs + parseDurationMinutes(event.duration) * 60000).toISOString().slice(0, 19);
  return { start, end };
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
  // CSRF gate (GHSA-9mvj-98f5-9q6g): this handler acts with the caller's
  // session cookie, which SameSite=Lax still sends from a same-site page.
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
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
    const fetchOptions = { trusted: creds.trusted, clientIp: loginClientAddress(request) };
    const session = await fetchJmapSession(creds.serverUrl, creds.authHeader, fetchOptions);
    if (!session) {
      return NextResponse.json({ error: 'JMAP session fetch failed' }, { status: 502 });
    }
    const accountIds = calendarAccountIds(session);
    if (accountIds.length === 0) {
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
    let horizon = new Date(now.getTime() + days * DAY_MS);
    // Expand from the start of today so all-day / already-running events still
    // show in the agenda.
    const windowStart = new Date(now);
    windowStart.setHours(0, 0, 0, 0);

    // ── 1–3) Per account: query the occurrences in range, load calendars
    // (colours), fetch the occurrences and hydrate them from their bases ──
    // expandRecurrences returns one id per occurrence (it needs both bounds),
    // the earliest first so the limit keeps the next ones. A range the server
    // will not expand - more occurrences than it allows in one query, or
    // longer than its maxExpandedQueryDuration - is refused; the agenda then
    // looks less far ahead instead of failing.
    const calColors = new Map<string, { name: string; color: string | null }>();
    const expanded: Array<CalendarEvent & { accountId: string }> = [];

    const coreCapability = session.capabilities?.['urn:ietf:params:jmap:core'] as { maxCallsInRequest?: unknown } | undefined;
    const maxCalls = typeof coreCapability?.maxCallsInRequest === 'number' && coreCapability.maxCallsInRequest > 0
      ? coreCapability.maxCallsInRequest
      : MAX_CALLS_FALLBACK;
    // Batched, several gets per request.
    const getEvents = async (accountId: string, eventIds: string[], properties: readonly string[]) => {
      const list: Array<Record<string, unknown>> = [];
      const batches: string[][] = [];
      for (let i = 0; i < eventIds.length; i += GET_BATCH) batches.push(eventIds.slice(i, i + GET_BATCH));
      for (let first = 0; first < batches.length; first += maxCalls) {
        const group = batches.slice(first, first + maxCalls);
        const getRes = await jmapPost(apiUrl, creds.authHeader, {
          using,
          methodCalls: group.map((ids, i) => ['CalendarEvent/get', { accountId, ids, properties }, String(i)]),
        }, fetchOptions);
        for (const [i] of group.entries()) {
          const getResp = findResponse(getRes, 'CalendarEvent/get', String(i));
          if (!getResp) {
            const err = findResponse(getRes, 'error', String(i));
            throw new AgendaFetchError((err?.description as string) || 'CalendarEvent/get failed');
          }
          list.push(...((getResp.list as Array<Record<string, unknown>>) || []));
        }
      }
      return list;
    };

    for (const accountId of accountIds) {
      const isPrimary = accountId === accountIds[0];
      let queryRes: unknown;
      let queryResp: Record<string, unknown> | null;
      let queryErr: Record<string, unknown> | null = null;
      for (;;) {
        queryRes = await jmapPost(apiUrl, creds.authHeader, {
          using,
          methodCalls: [
            [
              'CalendarEvent/query',
              {
                accountId,
                filter: { after: windowStart.toISOString(), before: horizon.toISOString() },
                expandRecurrences: true,
                sort: [{ property: 'start', isAscending: true }],
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
        }, fetchOptions);
        queryResp = findResponse(queryRes, 'CalendarEvent/query', '0');
        if (queryResp) break;
        queryErr = findResponse(queryRes, 'error', '0');
        const span = horizon.getTime() - now.getTime();
        if ((isOccurrenceLimit(queryErr) || queryErr?.type === 'expandDurationTooLarge') && span > DAY_MS) {
          horizon = new Date(now.getTime() + Math.max(DAY_MS, Math.floor(span / 2)));
          continue;
        }
        break;
      }
      if (!queryResp) {
        if (!isPrimary) {
          // A shared account the caller can see but not read calendars from
          // (Stalwart answers forbidden/accountNotSupported) must not empty
          // the agenda for the accounts that do work.
          logger.debug('Calendar agenda: skipping account', {
            accountId,
            error: (queryErr?.type as string) || 'CalendarEvent/query failed',
          });
          continue;
        }
        return NextResponse.json(
          { error: (queryErr?.description as string) || 'CalendarEvent/query failed' },
          { status: 502 },
        );
      }
      const ids = (queryResp.ids as string[]) || [];

      const calResp = findResponse(queryRes, 'Calendar/get', 'c');
      for (const cal of ((calResp?.list as Array<Record<string, unknown>>) || [])) {
        if (typeof cal.id === 'string') {
          calColors.set(scopedId(accountId, cal.id), {
            name: typeof cal.name === 'string' ? cal.name : '',
            color: typeof cal.color === 'string' ? cal.color : null,
          });
        }
      }

      if (ids.length === 0) continue;

      let occurrences: Partial<CalendarEvent>[];
      const bases = new Map<string, Partial<CalendarEvent>>();
      try {
        occurrences = (await getEvents(accountId, ids, EVENT_PROPERTIES))
          .map((e) => normalizeCalendarEventLike(e as Partial<CalendarEvent>));

        // Hydrate occurrences from their base events: an expanded all-day
        // occurrence comes back without showWithoutTime, and the base event
        // has the duration an override leaves out.
        const baseIds = Array.from(new Set(occurrences
          .filter((e) => isServerRecurrenceInstance(e as CalendarEvent) && e.recurrenceId)
          .map((e) => e.baseEventId as string)));
        for (const base of await getEvents(accountId, baseIds, RECURRENCE_BASE_PROPERTIES)) {
          if (typeof base.id === 'string') bases.set(base.id, normalizeCalendarEventLike(base as Partial<CalendarEvent>));
        }
      } catch (error) {
        if (!(error instanceof AgendaFetchError)) throw error;
        if (!isPrimary) {
          logger.debug('Calendar agenda: skipping account', { accountId, error: error.message });
          continue;
        }
        return NextResponse.json({ error: error.message }, { status: 502 });
      }

      const valid = occurrences
        .filter((e) => (e['@type'] ?? 'Event') === 'Event')
        // Drop malformed events without a parseable start (would crash format()/
        // parseISO downstream) — mirrors the calendar store guard (#316).
        .filter((e) => typeof e.start === 'string' && e.start && !isNaN(parseISO(e.start).getTime())) as CalendarEvent[];

      for (const e of hydrateRecurrenceInstances(valid, bases)) {
        expanded.push({ ...e, accountId });
      }
    }
    // ── 4) Keep ongoing/upcoming, sort, slice, map to DTOs ──
    const agenda: AgendaEvent[] = expanded
      .filter((e) => eventEnd(e).getTime() >= now.getTime())
      .sort((a, b) => eventStart(a).getTime() - eventStart(b).getTime())
      .slice(0, limit)
      .map((e) => {
        const calId = firstCalendarId(e);
        const cal = calId ? calColors.get(scopedId(e.accountId, calId)) : undefined;
        return {
          id: scopedId(e.accountId, String(e.id ?? '')),
          accountId: e.accountId,
          uid: e.uid ?? null,
          title: (e.title ?? '').trim() || '(no title)',
          ...(e.showWithoutTime
            ? allDayRange(e)
            : { start: eventStart(e).toISOString(), end: eventEnd(e).toISOString() }),
          allDay: !!e.showWithoutTime,
          status: e.status ?? null,
          color: e.color || cal?.color || null,
          location: firstLocationName(e),
          calendarId: calId,
        };
      });

    return NextResponse.json({ events: agenda, generatedAt: now.toISOString() });
  } catch (error) {
    if (error instanceof UpstreamBodyTooLargeError) {
      logger.warn('Calendar agenda: JMAP response too large', { maxBytes: error.maxBytes });
      return NextResponse.json({ error: 'JMAP server response is too large' }, { status: 502 });
    }
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

/** A method error on one of the agenda's gets: 502 on the primary account. */
class AgendaFetchError extends Error {}

/**
 * Whether the query failed on the server's cap on expanded occurrences:
 * `cannotCalculateOccurrences` on Stalwart 1.0, `invalidArguments` ("The
 * number of expanded recurrences exceeds the server limit") on 0.16.
 */
function isOccurrenceLimit(err: Record<string, unknown> | null): boolean {
  if (err?.type === 'cannotCalculateOccurrences') return true;
  return err?.type === 'invalidArguments' && /exceeds/i.test(String(err.description ?? ''));
}

/**
 * The accounts to read calendars from, primary first. Mirrors the client's
 * getCalendarCapableAccountIds(): shared and group accounts count even when
 * Stalwart does not advertise the calendar capability on them.
 */
function calendarAccountIds(session: {
  primaryAccounts?: Record<string, string>;
  accounts?: Record<string, unknown>;
}): string[] {
  const primary = session.primaryAccounts?.[CALENDAR_CAP];
  const ids: string[] = primary ? [primary] : [];
  for (const [id, value] of Object.entries(session.accounts ?? {})) {
    if (id === primary || !value || typeof value !== 'object') continue;
    const account = value as { isPersonal?: unknown; accountCapabilities?: Record<string, unknown> };
    if (account.accountCapabilities?.[CALENDAR_CAP] || account.isPersonal === false) {
      ids.push(id);
    }
  }
  return ids;
}

function scopedId(accountId: string, id: string): string {
  return `${accountId}:${id}`;
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
  options: { trusted?: boolean } = {},
): Promise<unknown> {
  const res = await postJmap(apiUrl, authHeader, JSON.stringify(payload), options);
  if (!res.ok) {
    throw new Error(`JMAP request failed (${res.status})`);
  }
  return readJsonCapped(res, MAX_RESPONSE_BYTES);
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
