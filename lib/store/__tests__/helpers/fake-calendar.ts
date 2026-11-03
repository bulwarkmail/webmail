/**
 * FakeJmap with calendars, modelled on what was measured on both Stalwarts
 * (local-data/desktop-offline-facts-parts/stalwart-changes-prf.md section 7, and
 * the probe run in desktop-offline-decisions.md):
 *
 * - /changes lists masters only. An edit through a synthetic id gives
 *   `updated: [master]`.
 * - A plain query returns masters. An expanded one needs both bounds, says
 *   canCalculateChanges false on 1.0 and true on 0.16, refuses more than P52W1D
 *   on 1.0, and gives a single event a synthetic id on 0.16 only.
 * - 1.0 refuses recurrenceOverrides next to utcStart in one get, and series keys
 *   inside an override. `recurrenceRules` is an invalid property on both.
 * - A pointer into overrides fails while a series has none.
 * - A second event with one uid is refused, uid filters match exactly.
 * - Overrides read back differently from what was written. 1.0 keeps only
 *   what differs from the series, a participant as a pointer key. 0.16 keeps
 *   the entry, adds `updated` to every entry on any change of the series, and
 *   drops an attendee-only `roles` from participants.
 */

import { normalizeCalendarEventLike } from '@/lib/calendar-event-normalization';
import { applyPatchObject } from '@/lib/jmap/patch-object';
import type { CalendarEvent } from '@/lib/jmap/types';
import { expandRecurringEvents } from '@/lib/recurrence-expansion';
import { SYNTHETIC_ID_PROBE } from '@/lib/recurrence-instances';
import { TransportError, type JmapResponse, type MethodCall, type MethodResponse, type StoreSession } from '../../engine/transport';
import { Collection, FakeJmap, JMAP_ACCOUNT } from './fake-jmap';

export const CAL = 'urn:ietf:params:jmap:calendars';

export const CALENDAR_SESSION: StoreSession = {
  apiUrl: 'https://fake.test/jmap/',
  downloadUrl: 'https://fake.test/d/{accountId}/{blobId}/{name}?type={type}',
  uploadUrl: 'https://fake.test/u/{accountId}',
  primaryAccounts: { [CAL]: JMAP_ACCOUNT },
  accounts: {
    [JMAP_ACCOUNT]: { name: 'a@example.org', isPersonal: true, accountCapabilities: { [CAL]: { maxExpandedQueryDuration: 'P52W1D' } } },
  },
  capabilities: { 'urn:ietf:params:jmap:core': {}, [CAL]: {} },
};

export type FakeEvent = Record<string, unknown> & { id: string };
export type StalwartVersion = '1.0' | '0.16' | '0.16.19';

/** One override as the server hands it back (measured on both, 2026-11-03). */
function readBack(version: StalwartVersion, master: FakeEvent, key: string, entry: Record<string, unknown>, tick: number): Record<string, unknown> {
  if (entry.excluded) return entry;
  if (version === '1.0') {
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(entry)) {
      if (name === 'updated') continue;
      if (name === 'start' && value === key) continue;
      if (name === 'participants') {
        const series = (master.participants ?? {}) as Record<string, Record<string, unknown>>;
        for (const [id, person] of Object.entries(value as Record<string, Record<string, unknown>>)) {
          for (const [field, fieldValue] of Object.entries(person)) {
            if (JSON.stringify(series[id]?.[field]) !== JSON.stringify(fieldValue)) out[`participants/${id}/${field}`] = fieldValue;
          }
        }
        continue;
      }
      if (name !== 'sequence' && JSON.stringify(master[name]) === JSON.stringify(value)) continue;
      out[name] = value;
    }
    return out;
  }
  const out: Record<string, unknown> = { ...entry, updated: `2026-11-03T00:00:${String(tick % 60).padStart(2, '0')}Z` };
  if (out.participants) {
    out.participants = Object.fromEntries(Object.entries(out.participants as Record<string, Record<string, unknown>>).map(([id, person]) => {
      const { roles, ...rest } = person;
      const attendeeOnly = roles && Object.keys(roles).length === 1 && (roles as Record<string, boolean>).attendee;
      return [id, attendeeOnly ? rest : person];
    }));
  }
  return out;
}

function jmapError(type: string, description?: string): Error {
  return Object.assign(new Error(type), { jmapError: type, description });
}

const SERIES_KEYS_IN_OVERRIDE = ['privacy', 'organizerCalendarAddress'];

interface Instance {
  id: string;
  master: FakeEvent;
  recurrenceId: string | null;
}

export class FakeCalendarJmap extends FakeJmap {
  readonly events = new Map<string, FakeEvent>();
  readonly calendars = new Map<string, Record<string, unknown> & { id: string }>();
  readonly identities: Array<Record<string, unknown>> = [{ id: 'pi1', name: 'A', calendarAddress: 'mailto:a@example.org', isDefault: true }];
  readonly eventLog = new Collection();
  private readonly instances = new Map<string, Instance>();
  private nextEvent = 1;
  /** The next create or update reaches the server, but its answer doesn't reach the client. */
  loseNextSetResponse = false;
  /** The next CalendarEvent/set refuses this id like a server would. */
  refuse: Record<string, { type: string; description?: string; properties?: string[] }> = {};

  constructor(readonly version: StalwartVersion = '1.0') {
    super();
    this.calendars.set('cal1', {
      id: 'cal1', name: 'Personal', isDefault: true, myRights: { mayWriteAll: true },
      defaultAlertsWithTime: { d1: { '@type': 'Alert', action: 'display', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' } } },
    });
  }

  addEvent(partial: Partial<FakeEvent> = {}): FakeEvent {
    const id = partial.id ?? `ev${this.nextEvent++}`;
    const event: FakeEvent = {
      '@type': 'Event',
      uid: `${id}@example.org`,
      calendarIds: { cal1: true },
      title: `Event ${id}`,
      start: '2026-11-10T10:00:00',
      duration: 'PT1H',
      timeZone: 'Europe/Berlin',
      baseEventId: null,
      isOrigin: true,
      useDefaultAlerts: false,
      ...partial,
      id,
    };
    this.events.set(id, event);
    this.eventLog.push('created', id);
    return event;
  }

  /** Someone else changes an event. */
  patchEvent(id: string, patch: Record<string, unknown>): void {
    const next = applyPatchObject(this.events.get(id) as FakeEvent, patch);
    if (next.recurrenceOverrides) {
      const tick = this.eventLog.log.length;
      next.recurrenceOverrides = Object.fromEntries(Object.entries(next.recurrenceOverrides as Record<string, Record<string, unknown>>)
        .map(([key, entry]) => [key, readBack(this.version, next, key, entry, tick)]));
    }
    this.events.set(id, next);
    this.eventLog.push('updated', id);
  }

  removeEvent(id: string): void {
    this.events.delete(id);
    this.eventLog.push('destroyed', id);
  }

  private expanded(after: string, before: string): Instance[] {
    const out: Instance[] = [];
    for (const master of this.events.values()) {
      const normal = normalizeCalendarEventLike(master as unknown as CalendarEvent);
      if (!normal.recurrenceRules?.length) {
        const start = String(master.start);
        if (start < after || start >= before) continue;
        out.push({ id: this.version === '1.0' ? master.id : `e${master.id}`, master, recurrenceId: null });
        continue;
      }
      for (const occurrence of expandRecurringEvents([normal], after, before)) {
        out.push({
          id: `h${String(occurrence.recurrenceId).replace(/\D/g, '')}${master.id}`,
          master,
          recurrenceId: occurrence.recurrenceId as string,
        });
      }
    }
    for (const instance of out) this.instances.set(instance.id, instance);
    return out;
  }

  private instanceView(instance: Instance): FakeEvent {
    const { master, recurrenceId } = instance;
    if (!recurrenceId) return { ...master, id: instance.id, baseEventId: this.version === '1.0' ? null : master.id };
    const override = ((master.recurrenceOverrides ?? {}) as Record<string, Record<string, unknown>>)[recurrenceId] ?? {};
    const { recurrenceRule: _r, recurrenceOverrides: _o, ...rest } = master;
    return {
      ...rest,
      start: recurrenceId,
      ...override,
      id: instance.id,
      baseEventId: master.id,
      recurrenceId,
      recurrenceRule: null,
    };
  }

  private query(args: Record<string, unknown>): Record<string, unknown> {
    const filter = (args.filter ?? {}) as { uid?: string; after?: string; before?: string; inCalendar?: string; operator?: string };
    const position = Number(args.position ?? 0);
    const limit = Number(args.limit ?? 5000) || 5000;
    const page = (ids: string[], canCalculateChanges: boolean) => ({
      accountId: args.accountId,
      queryState: this.eventLog.state(),
      canCalculateChanges,
      position,
      ids: ids.slice(position, position + limit),
    });
    if (args.expandRecurrences) {
      if (!filter.after || !filter.before) throw jmapError('invalidArguments', 'Expansion needs after and before');
      const days = (Date.parse(`${filter.before}Z`) - Date.parse(`${filter.after}Z`)) / 86_400_000;
      if (this.version === '1.0' && days > 365) throw jmapError('expandDurationTooLarge');
      const list = this.expanded(filter.after, filter.before);
      return page(list.map((instance) => instance.id), this.version !== '1.0');
    }
    const masters = [...this.events.values()].filter((event) => {
      if (filter.uid !== undefined && event.uid !== filter.uid) return false;
      if (filter.inCalendar && !(event.calendarIds as Record<string, boolean>)[filter.inCalendar]) return false;
      return true;
    });
    return page(masters.map((event) => event.id), true);
  }

  private get(args: Record<string, unknown>): Record<string, unknown> {
    const properties = args.properties as string[] | undefined;
    if (properties?.includes('recurrenceRules')) throw jmapError('invalidArguments', 'recurrenceRules');
    if (this.version === '1.0' && properties?.includes('recurrenceOverrides')
      && (properties.includes('utcStart') || properties.includes('utcEnd'))) {
      throw jmapError('invalidArguments', 'recurrenceOverrides cannot be requested together with utcStart or utcEnd');
    }
    const ids = (args.ids as string[] | null) ?? [...this.events.keys()].slice(0, 500);
    if (ids.length > 500) throw jmapError('requestTooLarge');
    const list: Record<string, unknown>[] = [];
    const notFound: string[] = [];
    for (const id of ids) {
      const instance = this.instances.get(id);
      const event = instance && this.events.has(instance.master.id)
        ? this.instanceView({ ...instance, master: this.events.get(instance.master.id) as FakeEvent })
        : this.events.get(id);
      if (!event) {
        notFound.push(id);
        continue;
      }
      const full = { ...event, utcStart: `${String(event.start)}Z`, utcEnd: `${String(event.start)}Z` };
      if (!properties) {
        list.push({ ...event });
        continue;
      }
      const out: Record<string, unknown> = { id };
      for (const name of properties) if (name in full) out[name] = (full as Record<string, unknown>)[name];
      list.push(out);
    }
    return { accountId: args.accountId, state: this.eventLog.state(), list, notFound };
  }

  private seriesKeyInOverride(patch: Record<string, unknown>): string | null {
    if (this.version !== '1.0') return null;
    for (const [key, value] of Object.entries(patch)) {
      if (key !== 'recurrenceOverrides' && !key.startsWith('recurrenceOverrides/')) continue;
      const entries = key === 'recurrenceOverrides' ? Object.values(value as object) : [value];
      for (const entry of entries) {
        for (const name of SERIES_KEYS_IN_OVERRIDE) {
          if (entry && typeof entry === 'object' && name in entry) return name;
        }
      }
    }
    return null;
  }

  private update(id: string, patch: Record<string, unknown>): { type: string; description?: string; properties?: string[] } | null {
    if (this.refuse[id]) {
      const refusal = this.refuse[id];
      delete this.refuse[id];
      return refusal;
    }
    if (id === SYNTHETIC_ID_PROBE) {
      return this.version === '0.16.19'
        ? { type: 'invalidProperties', description: 'Updating synthetic ids is not yet supported.', properties: ['id'] }
        : { type: 'notFound' };
    }
    const instance = this.instances.get(id);
    if (instance?.recurrenceId) {
      if (this.version === '0.16.19') {
        return { type: 'invalidProperties', description: 'Updating synthetic ids is not yet supported.', properties: ['id'] };
      }
      const master = this.events.get(instance.master.id);
      if (!master) return { type: 'notFound' };
      const overrides = { ...(master.recurrenceOverrides as object | undefined) } as Record<string, Record<string, unknown>>;
      overrides[instance.recurrenceId] = { ...overrides[instance.recurrenceId], ...patch };
      this.patchEvent(master.id, { recurrenceOverrides: overrides });
      return null;
    }
    const event = this.events.get(id);
    if (!event) return { type: 'notFound' };
    const seriesKey = this.seriesKeyInOverride(patch);
    if (seriesKey) {
      return { type: 'invalidProperties', description: `${seriesKey} cannot be set inside recurrenceOverrides.`, properties: ['recurrenceOverrides'] };
    }
    const pointsIntoNothing = Object.keys(patch).some((key) => key.startsWith('recurrenceOverrides/')) && !event.recurrenceOverrides;
    if (pointsIntoNothing) return { type: this.version === '1.0' ? 'invalidPatch' : 'invalidProperties', description: 'Patch operation failed.' };
    this.patchEvent(id, patch);
    return null;
  }

  private set(args: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { accountId: args.accountId, oldState: this.eventLog.state() };
    const created: Record<string, unknown> = {};
    const notCreated: Record<string, unknown> = {};
    for (const [key, event] of Object.entries((args.create ?? {}) as Record<string, Record<string, unknown>>)) {
      const seriesKey = this.seriesKeyInOverride(event);
      if (seriesKey) {
        notCreated[key] = { type: 'invalidProperties', description: `${seriesKey} cannot be set inside recurrenceOverrides.`, properties: ['recurrenceOverrides'] };
      } else if (typeof event.uid === 'string' && [...this.events.values()].some((other) => other.uid === event.uid)) {
        notCreated[key] = { type: 'invalidProperties', description: `An event with UID ${event.uid} already exists.`, properties: ['uid'] };
      } else if (this.refuse[key]) {
        notCreated[key] = this.refuse[key];
        delete this.refuse[key];
      } else {
        created[key] = { id: this.addEvent(event).id };
      }
    }
    const updated: Record<string, unknown> = {};
    const notUpdated: Record<string, unknown> = {};
    for (const [id, patch] of Object.entries((args.update ?? {}) as Record<string, Record<string, unknown>>)) {
      const refusal = this.update(id, patch);
      if (refusal) notUpdated[id] = refusal;
      else updated[id] = null;
    }
    const destroyed: string[] = [];
    const notDestroyed: Record<string, unknown> = {};
    for (const id of (args.destroy ?? []) as string[]) {
      const instance = this.instances.get(id);
      if (instance?.recurrenceId && this.events.has(instance.master.id)) {
        const master = this.events.get(instance.master.id) as FakeEvent;
        this.patchEvent(master.id, {
          recurrenceOverrides: { ...(master.recurrenceOverrides as object | undefined), [instance.recurrenceId]: { excluded: true } },
        });
        destroyed.push(id);
      } else if (this.refuse[id]) {
        notDestroyed[id] = this.refuse[id];
        delete this.refuse[id];
      } else if (this.events.has(id)) {
        this.removeEvent(id);
        destroyed.push(id);
      } else {
        notDestroyed[id] = { type: 'notFound' };
      }
    }
    if (Object.keys(created).length > 0) out.created = created;
    if (Object.keys(notCreated).length > 0) out.notCreated = notCreated;
    if (Object.keys(updated).length > 0) out.updated = updated;
    if (Object.keys(notUpdated).length > 0) out.notUpdated = notUpdated;
    if (destroyed.length > 0) out.destroyed = destroyed;
    if (Object.keys(notDestroyed).length > 0) out.notDestroyed = notDestroyed;
    out.newState = this.eventLog.state();
    return out;
  }

  private answerCalendarCall(name: string, args: Record<string, unknown>): Record<string, unknown> {
    switch (name) {
      case 'Calendar/get':
        return { accountId: args.accountId, state: 'cs1', list: [...this.calendars.values()], notFound: [] };
      case 'ParticipantIdentity/get':
        return { accountId: args.accountId, list: this.identities, notFound: [] };
      case 'CalendarEvent/query':
        return this.query(args);
      case 'CalendarEvent/get':
        return this.get(args);
      case 'CalendarEvent/set':
        return this.set(args);
      case 'CalendarEvent/changes': {
        const since = String(args.sinceState);
        if (!/^s\d+$/.test(since)) throw jmapError('invalidArguments');
        const from = Number(since.slice(1));
        if (from < this.eventLog.truncatedBelow || from > this.eventLog.log.length) throw jmapError('cannotCalculateChanges');
        const maxChanges = Math.min(Number(args.maxChanges ?? 5000) || 5000, 5000);
        return { accountId: args.accountId, oldState: since, ...this.eventLog.changes(since, maxChanges) };
      }
      default:
        throw jmapError('unknownMethod');
    }
  }

  override async request(calls: MethodCall[]): Promise<JmapResponse> {
    if (!calls.every(([name]) => /^(Calendar|CalendarEvent|ParticipantIdentity)\//.test(name))) return super.request(calls);
    this.requests += 1;
    this.beforeRequest?.(this.requests);
    if (this.offline) throw new TransportError('network', 'Failed to fetch');
    if (calls.length > 16) throw new TransportError('http', 'too many calls', 400, 'urn:ietf:params:jmap:error:limit');
    const done: MethodResponse[] = [];
    let lose = false;
    for (const call of calls) {
      this.calls.push(call);
      const [name, raw, id] = call;
      const args: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(raw)) {
        if (key.startsWith('#')) {
          const ref = value as { resultOf: string; path: string };
          const source = done.find(([, , callId]) => callId === ref.resultOf);
          args[key.slice(1)] = source?.[1][ref.path.slice(1)];
        } else {
          args[key] = value;
        }
      }
      try {
        done.push([name, this.answerCalendarCall(name, args), id]);
        if (name === 'CalendarEvent/set' && (raw.create || raw.update) && this.loseNextSetResponse) lose = true;
      } catch (error) {
        const type = (error as { jmapError?: string }).jmapError;
        if (!type) throw error;
        done.push(['error', { type, description: (error as { description?: string }).description }, id]);
      }
    }
    if (lose) {
      this.loseNextSetResponse = false;
      throw new TransportError('network', 'The connection dropped before the answer came');
    }
    return { methodResponses: done };
  }
}
