import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  blockTimes, decideBlock, ownFilterScriptStops, resolveBlockSetting, effectiveBlockSetting, eventSpan, isoDuration, oooUid, resetVacationCalendarSync,
  syncVacationBlock, vacationReplyLoaded, vacationReplySaved, type DecisionInput,
} from '../vacation-calendar';
import { useSettingsStore } from '@/stores/settings-store';
import { usePolicyStore } from '@/stores/policy-store';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';
import { generateScript } from '@/lib/sieve/generator';

const NOW = new Date('2026-11-10T12:00:00Z');
const reply = (extra: Partial<DecisionInput['reply']> = {}) => ({
  isEnabled: true, fromDate: '2026-12-01T08:00:00Z', toDate: '2026-12-05T17:00:00Z', subject: 'Away', ...extra,
});
const span = (start: string, end: string) => ({ start: new Date(start), end: new Date(end) });
const last = { start: '2026-12-01T08:00:00.000Z', end: '2026-12-05T17:00:00.000Z' };
const input = (extra: Partial<DecisionInput>): DecisionInput => ({
  block: true, reply: reply(), event: null, last: null, now: NOW, trigger: 'save', ...extra,
});

describe('decideBlock', () => {
  it('creates the event for a reply with dates', () => {
    expect(decideBlock(input({}))).toEqual({ action: 'create', start: new Date('2026-12-01T08:00:00Z'), end: new Date('2026-12-05T17:00:00Z') });
  });

  it('moves its own event with the dates', () => {
    const decision = decideBlock(input({ reply: reply({ toDate: '2026-12-08T17:00:00Z' }), event: span(last.start, last.end), last }));
    expect(decision).toEqual({ action: 'update', start: new Date('2026-12-01T08:00:00Z'), end: new Date('2026-12-08T17:00:00Z') });
  });

  it('leaves an event someone edited alone', () => {
    const edited = span('2026-12-01T08:00:00Z', '2026-12-03T12:00:00Z');
    expect(decideBlock(input({ reply: reply({ toDate: '2026-12-08T17:00:00Z' }), event: edited, last }))).toEqual({ action: 'none' });
    expect(decideBlock(input({ reply: reply({ isEnabled: false }), event: edited, last }))).toEqual({ action: 'none' });
  });

  it('removes an event that hasn\'t started when the reply or the block is switched off', () => {
    expect(decideBlock(input({ reply: reply({ isEnabled: false }), event: span(last.start, last.end), last }))).toEqual({ action: 'destroy' });
    expect(decideBlock(input({ block: false, event: span(last.start, last.end), last }))).toEqual({ action: 'destroy' });
  });

  it('ends a running event now when the reply is switched off early', () => {
    const now = new Date('2026-12-03T10:00:00Z');
    expect(decideBlock(input({ reply: reply({ isEnabled: false }), event: span(last.start, last.end), last, now }))).toEqual({ action: 'end-now', end: now });
  });

  it('leaves the past event of a reply that simply ran out', () => {
    const now = new Date('2026-12-06T10:00:00Z');
    expect(decideBlock(input({ event: span(last.start, last.end), last, now }))).toEqual({ action: 'none' });
    expect(decideBlock(input({ now }))).toEqual({ action: 'none' });
  });

  it('keeps a deleted event deleted on load, and brings it back when the dates change', () => {
    expect(decideBlock(input({ last, trigger: 'load' }))).toEqual({ action: 'none' });
    expect(decideBlock(input({ last, trigger: 'load', reply: reply({ toDate: '2026-12-09T17:00:00Z' }) })).action).toBe('create');
  });

  it('follows a reply set in another client on load', () => {
    expect(decideBlock(input({ trigger: 'load' })).action).toBe('create');
  });

  it('does nothing without both dates or with the end before the start', () => {
    expect(decideBlock(input({ reply: reply({ toDate: null }) }))).toEqual({ action: 'none' });
    expect(decideBlock(input({ reply: reply({ toDate: '2026-11-30T00:00:00Z' }) }))).toEqual({ action: 'none' });
  });
});

describe('blockTimes and eventSpan', () => {
  it('writes a timed event in the zone and reads it back', () => {
    const start = new Date('2026-12-01T08:00:00Z');
    const end = new Date('2026-12-05T17:30:00Z');
    const times = blockTimes(start, end, 'Europe/Berlin');
    expect(times).toEqual({ start: '2026-12-01T09:00:00', duration: 'P4DT9H30M', timeZone: 'Europe/Berlin', showWithoutTime: false });
    expect(eventSpan(times, 'Europe/Berlin')).toEqual({ start, end });
  });

  it('writes whole days when both ends are midnight in the zone', () => {
    const start = new Date('2026-11-30T23:00:00Z'); // 1 Dec 00:00 Berlin
    const end = new Date('2026-12-04T23:00:00Z'); // 5 Dec 00:00 Berlin
    const times = blockTimes(start, end, 'Europe/Berlin');
    expect(times).toEqual({ start: '2026-12-01T00:00:00', duration: 'P4D', timeZone: null, showWithoutTime: true });
    expect(eventSpan(times, 'Europe/Berlin')).toEqual({ start, end });
  });

  it('formats durations', () => {
    expect(isoDuration(90 * 60000)).toBe('PT1H30M');
    expect(isoDuration(2 * 86400000)).toBe('P2D');
    expect(isoDuration(0)).toBe('PT0S');
  });
});

describe('effectiveBlockSetting', () => {
  afterEach(() => {
    usePolicyStore.setState({ policy: { ...usePolicyStore.getState().policy, restrictions: {} } });
    useSettingsStore.setState({ vacationBlockCalendar: true });
  });

  it('is on by default, the user\'s choice otherwise, and the organisation\'s when locked', () => {
    expect(effectiveBlockSetting()).toBe(true);
    useSettingsStore.setState({ vacationBlockCalendar: false });
    expect(effectiveBlockSetting()).toBe(false);
    usePolicyStore.setState({ policy: { ...usePolicyStore.getState().policy, restrictions: { vacationBlockCalendar: { locked: true, value: true } } } });
    expect(effectiveBlockSetting()).toBe(true);
  });
});

function fakeClient(found: Partial<CalendarEvent> | null, calendars: Partial<Calendar>[] = [{ id: 'b', isDefault: true, myRights: { mayWriteAll: true } as Calendar['myRights'] }]) {
  return {
    getAccountId: () => 'alice',
    supportsCalendars: () => true,
    getAllCalendars: vi.fn(async () => calendars as Calendar[]),
    queryCalendarEvents: vi.fn(async () => (found ? [found as CalendarEvent] : [])),
    createCalendarEvent: vi.fn(async (e: Partial<CalendarEvent>) => ({ ...e, id: 'new' }) as CalendarEvent),
    updateCalendarEvent: vi.fn(async () => {}),
    deleteCalendarEvent: vi.fn(async () => {}),
  };
}

describe('syncVacationBlock', () => {
  beforeEach(() => {
    useSettingsStore.setState({ vacationBlockCalendar: true, vacationCalendarBlocks: {}, timeZone: 'Europe/Berlin' });
  });
  afterEach(() => useSettingsStore.setState({ timeZone: 'auto' }));

  it('creates a busy event without participants or invitations in the default calendar, and remembers it', async () => {
    const client = fakeClient(null, [
      { id: 'x', isDefault: false },
      { id: 'b', isDefault: true, myRights: { mayWriteAll: true } as Calendar['myRights'] },
      { id: 'bob:c', isDefault: true, isShared: true, accountId: 'bob' },
    ]);
    expect(await syncVacationBlock(client, undefined, reply(), 'save', NOW)).toBe('create');
    expect(client.queryCalendarEvents).toHaveBeenCalledWith({ uid: 'bulwark-ooo-alice' }, undefined, 1, undefined);
    const [event, send, account] = client.createCalendarEvent.mock.calls[0] as unknown as [Partial<CalendarEvent>, boolean, string | undefined];
    expect(event).toMatchObject({
      uid: oooUid('alice'), title: 'Away', calendarIds: { b: true }, freeBusyStatus: 'busy', privacy: 'public',
      start: '2026-12-01T09:00:00', timeZone: 'Europe/Berlin', showWithoutTime: false,
    });
    expect(event.participants).toBeUndefined();
    expect(send).toBe(false);
    expect(account).toBeUndefined();
    expect(useSettingsStore.getState().vacationCalendarBlocks.alice).toEqual(last);
  });

  it('puts a managed account\'s event in that account\'s calendar, and only with write access', async () => {
    const shared = { id: 'boss:b', originalId: 'b', isDefault: true, isShared: true, accountId: 'boss', myRights: { mayWriteAll: false, mayWriteOwn: true } as Calendar['myRights'] };
    const client = fakeClient(null, [{ id: 'own', isDefault: true }, shared]);
    expect(await syncVacationBlock(client, 'boss', reply(), 'save', NOW)).toBe('create');
    expect(client.createCalendarEvent.mock.calls[0][0]).toMatchObject({ uid: 'bulwark-ooo-boss', calendarIds: { b: true } });
    expect((client.createCalendarEvent.mock.calls[0] as unknown[])[2]).toBe('boss');
    const readOnly = fakeClient(null, [{ ...shared, myRights: { mayWriteAll: false, mayWriteOwn: false } as Calendar['myRights'] }]);
    expect(await syncVacationBlock(readOnly, 'boss', reply(), 'save', NOW)).toBe('no-calendar');
    expect(readOnly.createCalendarEvent).not.toHaveBeenCalled();
  });

  it('moves and removes its own event', async () => {
    useSettingsStore.setState({ vacationCalendarBlocks: { alice: last } });
    const ours = { id: 'e1', ...blockTimes(new Date(last.start), new Date(last.end), 'Europe/Berlin') };
    const moving = fakeClient(ours);
    expect(await syncVacationBlock(moving, undefined, reply({ toDate: '2026-12-08T17:00:00Z' }), 'save', NOW)).toBe('update');
    expect(moving.updateCalendarEvent).toHaveBeenCalledWith('e1', expect.objectContaining({ duration: 'P7DT9H' }), false, undefined);
    useSettingsStore.setState({ vacationCalendarBlocks: { alice: last } });
    const off = fakeClient(ours);
    expect(await syncVacationBlock(off, undefined, reply({ isEnabled: false }), 'save', NOW)).toBe('destroy');
    expect(off.deleteCalendarEvent).toHaveBeenCalledWith('e1', false, undefined);
    expect(useSettingsStore.getState().vacationCalendarBlocks.alice).toBeUndefined();
  });

  it('never creates an event while the organisation locks the block off', async () => {
    usePolicyStore.setState({ policy: { ...usePolicyStore.getState().policy, restrictions: { vacationBlockCalendar: { locked: true, value: false } } } });
    try {
      const client = fakeClient(null);
      expect(await syncVacationBlock(client, undefined, reply(), 'save', NOW)).toBe('none');
      expect(client.createCalendarEvent).not.toHaveBeenCalled();
    } finally {
      usePolicyStore.setState({ policy: { ...usePolicyStore.getState().policy, restrictions: {} } });
    }
  });
});

describe('the sync scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetVacationCalendarSync();
    useSettingsStore.setState({ vacationBlockCalendar: true, vacationCalendarBlocks: {} });
  });
  afterEach(() => {
    vi.useRealTimers();
    resetVacationCalendarSync();
  });

  it('syncs only when the switch, the dates or the subject changed, once after a pause', async () => {
    const client = fakeClient(null);
    vacationReplySaved(client, undefined, reply(), reply());
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.queryCalendarEvents).not.toHaveBeenCalled();

    vacationReplySaved(client, undefined, reply(), reply({ subject: 'A' }));
    vacationReplySaved(client, undefined, reply({ subject: 'A' }), reply({ subject: 'Away from' }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.queryCalendarEvents).toHaveBeenCalledTimes(1);
  });

  it('reconciles a loaded reply once per page load and account', async () => {
    const client = fakeClient(null);
    vacationReplyLoaded(client, undefined, reply());
    await vi.advanceTimersByTimeAsync(5000);
    vacationReplyLoaded(client, undefined, reply());
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.queryCalendarEvents).toHaveBeenCalledTimes(1);
  });
});

describe('ownFilterScriptStops', () => {
  const sieve = (scripts: Array<{ name: string; isActive: boolean; content: string }>, extensions = ['include', 'fileinto']) => ({
    getSieveAccountId: () => 'alice',
    getSieveCapabilities: () => ({ sieveExtensions: extensions }) as never,
    getSieveScripts: async () => scripts.map((s, i) => ({ id: String(i), name: s.name, isActive: s.isActive, blobId: s.name })) as never,
    getSieveScriptContent: async (blobId: string) => scripts.find((s) => s.name === blobId)!.content,
  });

  it('warns for an active script Bulwark can\'t keep running, and not for its own', async () => {
    const own = generateScript([]);
    // Edited by hand so that Bulwark can't read it back: it can't be kept next to the reply.
    const handEdited = own.replace('"version"', '"version" oops');
    expect(handEdited).not.toBe(own);
    expect(await ownFilterScriptStops(sieve([{ name: 'mine', isActive: true, content: handEdited }]))).toBe(true);
    // Scripts of other clients that Bulwark reads keep running next to the reply.
    expect(await ownFilterScriptStops(sieve([{ name: 'roundcube', isActive: true, content: 'require ["fileinto"];\r\nif address :is "from" "x@example.org" { fileinto "X"; }\r\n' }]))).toBe(false);
    expect(await ownFilterScriptStops(sieve([{ name: 'filters', isActive: true, content: own }]))).toBe(false);
    expect(await ownFilterScriptStops(sieve([{ name: 'filters', isActive: true, content: own }], ['fileinto']))).toBe(true);
    expect(await ownFilterScriptStops(sieve([{ name: 'vacation', isActive: true, content: '' }]))).toBe(false);
  });
});

describe('whose event it is without this device\'s record', () => {
  it('follows the reply\'s previous dates: switched off or moved on another device or by a delegate', () => {
    const event = span(last.start, last.end);
    const previous = { fromDate: '2026-12-01T08:00:00Z', toDate: '2026-12-05T17:00:00Z' };
    expect(decideBlock(input({ reply: reply({ isEnabled: false }), event, previous }))).toEqual({ action: 'destroy' });
    expect(decideBlock(input({ reply: reply({ toDate: '2026-12-08T17:00:00Z' }), event, previous })).action).toBe('update');
    // Someone moved the event before: neither the record nor the old dates match.
    expect(decideBlock(input({ reply: reply({ isEnabled: false }), event: span('2026-12-02T08:00:00Z', '2026-12-03T08:00:00Z'), previous })))
      .toEqual({ action: 'none' });
  });

  it('takes a marked event as its own when the reply is loaded on a device with no record', () => {
    const event = span(last.start, last.end);
    expect(decideBlock(input({ reply: reply({ toDate: '2026-12-08T17:00:00Z' }), event, marked: true, trigger: 'load' })).action).toBe('update');
    expect(decideBlock(input({ reply: reply({ toDate: '2026-12-08T17:00:00Z' }), event, marked: false, trigger: 'load' }))).toEqual({ action: 'none' });
    expect(decideBlock(input({ reply: reply({ toDate: '2026-12-08T17:00:00Z' }), event, marked: true, trigger: 'save' }))).toEqual({ action: 'none' });
  });

  it('marks the event it creates and keeps the mark when it moves it', async () => {
    useSettingsStore.setState({ vacationBlockCalendar: true, vacationCalendarBlocks: {}, timeZone: 'Europe/Berlin' });
    const client = fakeClient(null);
    await syncVacationBlock(client, undefined, reply(), 'save', NOW);
    expect(client.createCalendarEvent.mock.calls[0][0]).toMatchObject({ keywords: { 'bulwark-out-of-office': true } });
    // Another device, no record: the reply\'s old dates make the event ours.
    useSettingsStore.setState({ vacationCalendarBlocks: {} });
    const ours = { id: 'e1', ...blockTimes(new Date(last.start), new Date(last.end), 'Europe/Berlin') };
    const other = fakeClient(ours);
    expect(await syncVacationBlock(other, undefined, reply({ isEnabled: false }), 'save', NOW, { fromDate: last.start, toDate: last.end })).toBe('destroy');
    useSettingsStore.setState({ timeZone: 'auto' });
  });
});

describe('resolveBlockSetting', () => {
  it('pins the organisation\'s value when locked and hides the choice when hidden', () => {
    expect(resolveBlockSetting({ locked: true, value: false }, undefined, true)).toEqual({ value: false, locked: true, hidden: false });
    // A lock without a value takes the policy default, not the user's choice.
    expect(resolveBlockSetting({ locked: true }, false, true)).toEqual({ value: false, locked: true, hidden: false });
    expect(resolveBlockSetting({ locked: true }, undefined, false)).toEqual({ value: true, locked: true, hidden: false });
    expect(resolveBlockSetting({ hidden: true }, undefined, false)).toEqual({ value: true, locked: false, hidden: true });
    expect(resolveBlockSetting(undefined, undefined, false)).toEqual({ value: false, locked: false, hidden: false });
  });
});

describe('the sync scheduler with several accounts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetVacationCalendarSync();
    useSettingsStore.setState({ vacationBlockCalendar: true, vacationCalendarBlocks: {} });
  });
  afterEach(() => {
    vi.useRealTimers();
    resetVacationCalendarSync();
  });

  it('keeps one job per account, and the dates from before the first of several saves', async () => {
    const client = fakeClient(null);
    vacationReplySaved(client, undefined, reply(), reply({ subject: 'A' }));
    vacationReplySaved(client, 'boss', reply(), reply({ subject: 'B' }));
    await vi.advanceTimersByTimeAsync(5000);
    const accounts = client.queryCalendarEvents.mock.calls.map((c) => (c as unknown[])[3]);
    expect(accounts.sort()).toEqual(['boss', undefined].sort());
  });

  it('syncs several quick saves once, against the dates from before the first', async () => {
    useSettingsStore.setState({ timeZone: 'Europe/Berlin' });
    const ours = { id: 'e1', ...blockTimes(new Date(last.start), new Date(last.end), 'Europe/Berlin') };
    const client = fakeClient(ours);
    const moved = reply({ toDate: '2026-12-09T17:00:00Z' });
    vacationReplySaved(client, undefined, reply(), moved);
    vacationReplySaved(client, undefined, moved, { ...moved, isEnabled: false });
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.queryCalendarEvents).toHaveBeenCalledTimes(1);
    expect(client.deleteCalendarEvent).toHaveBeenCalledWith('e1', false, undefined);
    useSettingsStore.setState({ timeZone: 'auto' });
  });
});
