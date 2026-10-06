import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '../jmap/client';
import { CalendarMoveError } from '../calendar-move';

const CORE = 'urn:ietf:params:jmap:core';
const CALENDARS = 'urn:ietf:params:jmap:calendars';
const source = {
  id: 'event-1', uid: 'planning@example.test', title: 'Planning', isDraft: true,
  start: '2026-04-15T10:00:00', duration: 'PT1H', timeZone: 'Etc/UTC',
  calendarIds: { 'calendar-1': true },
};
const destination = { ...source, id: 'copied-event' };
type Call = [string, Record<string, unknown>, string];
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

let client: JMAPClient;
let calls: Call[];
let copyResult: Record<string, unknown>;
let removalResult: Record<string, unknown>;
let destinationResult: Record<string, unknown>;
let sourceResult: Record<string, unknown>;
let loseCopyResponse: boolean;

beforeEach(async () => {
  calls = [];
  loseCopyResponse = false;
  sourceResult = source;
  copyResult = { created: { 'event-1': { id: 'copied-event' } } };
  removalResult = { accountId: 'alice', destroyed: ['event-1'] };
  destinationResult = destination;
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  fetchSpy.mockResolvedValueOnce(json({
    capabilities: { [CORE]: {}, [CALENDARS]: {} },
    accounts: { alice: { name: 'Alice', isPersonal: true, accountCapabilities: { [CALENDARS]: {} } } },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'alice', [CALENDARS]: 'alice' },
    apiUrl: 'https://mail.example.test/jmap', downloadUrl: '', uploadUrl: '', eventSourceUrl: '',
  }));
  client = new JMAPClient('https://mail.example.test', 'alice@example.test', 'test-password');
  await client.connect();
  fetchSpy.mockImplementation(async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    const [name, args, id] = request.methodCalls[0] as Call;
    expect(request.using).toContain(CALENDARS);
    calls.push([name, args, id]);
    if (name === 'CalendarEvent/get') {
      const event = args.accountId === 'alice' ? sourceResult : destinationResult;
      return json({ methodResponses: [[name, { accountId: args.accountId, state: 'source-state', list: event ? [event] : [] }, id]] });
    }
    if (name === 'CalendarEvent/copy') {
      if (loseCopyResponse) throw new Error('Connection lost');
      return json({ methodResponses: [[name, copyResult, id]] });
    }
    if (name === 'CalendarEvent/set') return json({ methodResponses: [[name, removalResult, id]] });
    throw new Error(`Unexpected method ${name}`);
  });
});
afterEach(() => vi.restoreAllMocks());

const move = () => client.moveCalendarEvent('event-1', { calendarIds: { 'calendar-1': true } }, 'alice', 'team');

describe('CalendarEvent cross-account move', () => {
  it('copies into the destination, reads it back, then removes the source without scheduling', async () => {
    expect(await move()).toMatchObject(destination);
    expect(calls.map(call => call[0])).toEqual(['CalendarEvent/get', 'CalendarEvent/copy', 'CalendarEvent/get', 'CalendarEvent/set']);
    expect(calls[1][1]).toEqual({
      fromAccountId: 'alice', accountId: 'team',
      create: { 'event-1': { calendarIds: { 'calendar-1': true }, isDraft: true } },
      onSuccessDestroyOriginal: false,
    });
    expect(calls[2][1].accountId).toBe('team');
    expect(calls[3][1]).toEqual({ accountId: 'alice', ifInState: 'source-state', destroy: ['event-1'], sendSchedulingMessages: false });
  });

  it('sends edits with the copy but not client metadata or immutable fields', async () => {
    await client.moveCalendarEvent('event-1', {
      id: 'client-id', uid: 'must-not-replace@example.test', title: 'Updated', calendarIds: { 'calendar-1': true },
      accountId: 'alice', accountName: 'Alice', localAccountId: 'login-1', originalId: 'event-1',
      baseEventId: 'event-1', isShared: false, originalCalendarIds: { 'old': true }, isOrigin: true,
    }, 'alice', 'team');
    expect(calls[1][1].create).toEqual({ 'event-1': { title: 'Updated', calendarIds: { 'calendar-1': true }, isDraft: true } });
  });

  it('does not delete the source after a refused copy', async () => {
    copyResult = { notCreated: { 'event-1': { type: 'forbidden', description: 'Read-only calendar' } } };
    await expect(move()).rejects.toThrow('Read-only calendar');
    expect(calls.some(call => call[0] === 'CalendarEvent/set')).toBe(false);
  });

  it.each([
    { uid: 'different@example.test' },
    { calendarIds: { 'wrong-calendar': true } },
    { calendarIds: { 'calendar-1': true, 'extra-calendar': true } },
  ])('retains the source if the destination cannot be verified: %j', async (change) => {
    destinationResult = { ...destination, ...change };
    await expect(move()).rejects.toMatchObject({ reason: 'incomplete' });
    expect(calls.some(call => call[0] === 'CalendarEvent/set')).toBe(false);
  });

  it.each([
    { notDestroyed: { 'event-1': { type: 'forbidden' } } },
    { type: 'stateMismatch' },
    { destroyed: [] },
  ])('does not report success when source removal is unconfirmed: %j', async (result) => {
    removalResult = result;
    await expect(move()).rejects.toBeInstanceOf(CalendarMoveError);
    expect(calls.filter(call => call[0] === 'CalendarEvent/copy')).toHaveLength(1);
  });

  it('does not automatically repeat a copy after losing its response', async () => {
    loseCopyResponse = true;
    await expect(move()).rejects.toMatchObject({ reason: 'incomplete' });
    expect(calls.filter(call => call[0] === 'CalendarEvent/copy')).toHaveLength(1);
    expect(calls.some(call => call[0] === 'CalendarEvent/set')).toBe(false);
  });

  it('rejects a recurring source even when the UI submitted only a calendar change', async () => {
    sourceResult = { ...source, recurrenceRule: { frequency: 'daily' } };
    await expect(move()).rejects.toMatchObject({ reason: 'unsupported' });
    expect(calls).toHaveLength(1);
  });
});
