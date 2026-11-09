import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JMAPClient, submissionEnvelopeParameters } from '../jmap/client';
import { isJmapSetError, jmapErrorType } from '../jmap/jmap-error';
import { stalwartExactState, stalwartIntermediateState } from './helpers/stalwart-state';

describe('submissionEnvelopeParameters', () => {
  it('is empty without options', () => {
    expect(submissionEnvelopeParameters(undefined)).toEqual({ mailFrom: {}, rcptTo: {} });
    expect(submissionEnvelopeParameters({ requestReadReceipt: true })).toEqual({ mailFrom: {}, rcptTo: {} });
  });

  it('maps DSN, REQUIRETLS and FUTURERELEASE to envelope parameters', () => {
    expect(submissionEnvelopeParameters({ requestDsn: true, requireTls: true }, 60)).toEqual({
      mailFrom: { HOLDFOR: '60', REQUIRETLS: null, RET: 'HDRS' },
      rcptTo: { NOTIFY: 'SUCCESS,FAILURE,DELAY' },
    });
  });
});

/**
 * Request shapes of the JMAP features layered on the core client: delta sync
 * (Email/changes, Mailbox/changes), search snippets (SearchSnippet/get) and
 * folder sharing (mail:share). Each asserts what goes over the wire and how
 * the response is mapped back.
 */

function makeSession(accountCapabilities: Record<string, unknown> = {}, core: Record<string, unknown> = {}) {
  return {
    capabilities: { 'urn:ietf:params:jmap:core': core },
    accounts: {
      'acct-1': {
        name: 'test',
        isPersonal: true,
        accountCapabilities: { 'urn:ietf:params:jmap:mail': {}, ...accountCapabilities },
      },
    },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acct-1' },
    apiUrl: 'https://mail.example.com/jmap/api',
    downloadUrl: 'https://mail.example.com/jmap/download/{accountId}/{blobId}/{name}',
    uploadUrl: 'https://mail.example.com/jmap/upload/{accountId}/',
    eventSourceUrl: '',
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

type RequestBody = { using: string[]; methodCalls: [string, Record<string, unknown>, string][] };

describe('JMAP client extensions', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let client: JMAPClient;
  let requests: RequestBody[];

  async function setup(accountCapabilities: Record<string, unknown> = {}, core: Record<string, unknown> = {}) {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(jsonResponse(makeSession(accountCapabilities, core)));
    client = new JMAPClient('https://mail.example.com', 'user@test.com', 'pass123');
    await client.connect();
    fetchSpy.mockReset();
    requests = [];
  }

  function answer(handler: (body: RequestBody) => unknown) {
    fetchSpy.mockImplementation(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as RequestBody;
      requests.push(body);
      return jsonResponse(handler(body));
    });
  }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    client?.disconnect();
    vi.restoreAllMocks();
  });

  describe('delta sync', () => {
    it('maps Email/changes and passes sinceState / maxChanges', async () => {
      await setup();
      answer(() => ({
        methodResponses: [[
          'Email/changes',
          { accountId: 'acct-1', oldState: 's1', newState: 's2', hasMoreChanges: false, created: ['a'], updated: ['b'], destroyed: ['c'] },
          '0',
        ]],
      }));

      const delta = await client.getEmailChanges('s1', undefined, 200);

      expect(requests[0].methodCalls[0]).toEqual(['Email/changes', { accountId: 'acct-1', sinceState: 's1', maxChanges: 200 }, '0']);
      expect(delta).toEqual({
        oldState: 's1', newState: 's2', hasMoreChanges: false,
        created: ['a'], updated: ['b'], destroyed: ['c'], updatedProperties: null,
      });
    });

    it('returns null when the server cannot calculate the delta', async () => {
      await setup();
      answer(() => ({ methodResponses: [['error', { type: 'cannotCalculateChanges' }, '0']] }));
      expect(await client.getMailboxChanges('old')).toBeNull();
    });

    it('surfaces updatedProperties from Mailbox/changes', async () => {
      await setup();
      answer(() => ({
        methodResponses: [[
          'Mailbox/changes',
          { oldState: 'm1', newState: 'm2', hasMoreChanges: false, created: [], updated: ['inbox'], destroyed: [], updatedProperties: ['totalEmails', 'unreadEmails'] },
          '0',
        ]],
      }));
      const delta = await client.getMailboxChanges('m1');
      expect(delta?.updatedProperties).toEqual(['totalEmails', 'unreadEmails']);
    });

    it('reports the Mailbox state per account from getAllMailboxesWithState', async () => {
      await setup();
      answer(() => ({
        methodResponses: [['Mailbox/get', { accountId: 'acct-1', state: 'm7', list: [{ id: 'inbox', name: 'Inbox', role: 'inbox' }] }, '0']],
      }));
      const { mailboxes, states } = await client.getAllMailboxesWithState();
      expect(mailboxes.map((m) => m.id)).toEqual(['inbox']);
      expect(states).toEqual({ 'acct-1': 'm7' });
    });

    it('reports the Email state a page was read at', async () => {
      await setup();
      answer(() => ({
        methodResponses: [
          ['Email/query', { ids: ['e1'], total: 1 }, '0'],
          ['Email/get', { state: 'e9', list: [{ id: 'e1', threadId: 't1', receivedAt: '2026-08-29T00:00:00Z', mailboxIds: { inbox: true }, keywords: {} }] }, '1'],
        ],
      }));
      const page = await client.getEmails('inbox');
      expect(page.state).toBe('e9');
      expect(page.emails).toHaveLength(1);
    });

    // Stalwart lists urn:stalwart:jmap on every account (0.16.6 through 1.0).
    const STALWART = { 'urn:stalwart:jmap': {} };
    const changes = (type: string, oldState: string, newState: string) => ({
      methodResponses: [[
        `${type}/changes`,
        { accountId: 'acct-1', oldState, newState, hasMoreChanges: false, created: [], updated: [], destroyed: [] },
        '0',
      ]],
    });

    it.each(['Email', 'Mailbox'])(
      'falls back to a full fetch when Stalwart answers %s/changes with a lower state (upgrade with restarted counters)',
      async (type) => {
        await setup(STALWART);
        // The old change log survived with its ids, the counter restarted
        // lower: Stalwart accepts the old state and reports nothing since.
        const since = stalwartExactState(12_345_678);
        answer(() => changes(type, since, stalwartExactState(16_384)));

        const delta = type === 'Email' ? await client.getEmailChanges(since) : await client.getMailboxChanges(since);

        expect(delta).toBeNull();
      },
    );

    it('trips on the states Stalwart 0.16.23 and 1.0 actually return', async () => {
      await setup(STALWART);
      // `sba` (8) from 0.16.23 answered with `sau` (5) from 1.0.
      answer(() => changes('Email', 'sba', 'sau'));
      expect(await client.getEmailChanges('sba')).toBeNull();

      answer(() => changes('Email', 'sau', 'sba'));
      expect(await client.getEmailChanges('sau')).toMatchObject({ oldState: 'sau', newState: 'sba' });
    });

    it('never trips while Stalwart states go up or stay put', async () => {
      await setup(STALWART);
      const big = (n: number | string) => BigInt(n);
      // Every LEB128 byte boundary, and ids past 2^53.
      const ids = [
        big(0), big(1), big(126), big(127), big(128), big(129), big(16_383), big(16_384),
        big(2_097_151), big(2_097_152), big(2) ** big(32) - big(1), big(2) ** big(32),
        big(2) ** big(53), big(2) ** big(53) + big(1), big(2) ** big(64) - big(2), big(2) ** big(64) - big(1),
      ];
      for (let i = 0; i < ids.length; i++) {
        for (const next of [ids[i], ids[i + 1]]) {
          if (next === undefined) continue;
          const since = stalwartExactState(ids[i]);
          const newState = stalwartExactState(next);
          answer(() => changes('Email', since, newState));
          expect(await client.getEmailChanges(since)).toMatchObject({ oldState: since, newState });
        }
      }
    });

    it('leaves states in any other format alone', async () => {
      await setup(STALWART);
      // An intermediate state (a delta cut short by maxChanges) on either side.
      const intermediate = stalwartIntermediateState(1024, 2048, 100);
      answer(() => changes('Email', stalwartExactState(5000), intermediate));
      expect(await client.getEmailChanges(stalwartExactState(5000))).toMatchObject({ newState: intermediate });

      answer(() => changes('Email', intermediate, stalwartExactState(1)));
      expect(await client.getEmailChanges(intermediate)).toMatchObject({ newState: stalwartExactState(1) });
    });

    it('does not read states of servers other than Stalwart', async () => {
      await setup();
      // Same strings, but the session doesn't list urn:stalwart:jmap.
      answer(() => changes('Email', 'sba', 'sau'));
      expect(await client.getEmailChanges('sba')).toMatchObject({ newState: 'sau' });
    });
  });

  describe('search snippets', () => {
    it('chains SearchSnippet/get onto a text search and attaches the hits', async () => {
      await setup();
      answer(() => ({
        methodResponses: [
          ['Email/query', { ids: ['e1', 'e2'], total: 2 }, '0'],
          ['Email/get', { list: [
            { id: 'e1', threadId: 't1', receivedAt: '2026-08-29T00:00:00Z', subject: 'Invoice', mailboxIds: {}, keywords: {} },
            { id: 'e2', threadId: 't2', receivedAt: '2026-08-28T00:00:00Z', subject: 'Other', mailboxIds: {}, keywords: {} },
          ] }, '1'],
          ['SearchSnippet/get', { list: [
            { emailId: 'e1', subject: '<mark>Invoice</mark>', preview: 'your <mark>invoice</mark> is attached' },
            { emailId: 'e2', subject: null, preview: null },
          ] }, 'snippets'],
        ],
      }));

      const result = await client.searchEmails('invoice', 'inbox');

      const snippetCall = requests[0].methodCalls[2];
      expect(snippetCall[0]).toBe('SearchSnippet/get');
      expect(snippetCall[1]).toEqual({
        accountId: 'acct-1',
        // A plain query goes to the snippets as it went to Email/query.
        filter: { operator: 'AND', conditions: [{ inMailbox: 'inbox' }, { text: 'invoice' }] },
        '#emailIds': { resultOf: '0', name: 'Email/query', path: '/ids' },
      });
      expect(result.emails[0].searchSnippet).toEqual({ subject: '<mark>Invoice</mark>', preview: 'your <mark>invoice</mark> is attached' });
      expect(result.emails[1].searchSnippet).toBeUndefined();
    });

    it('sends quoted phrases as conditions of their own and unquotes them for the snippets', async () => {
      await setup();
      answer(() => ({
        methodResponses: [
          ['Email/query', { ids: [], total: 0 }, '0'],
          ['Email/get', { list: [] }, '1'],
          ['SearchSnippet/get', { list: [] }, 'snippets'],
        ],
      }));

      await client.searchEmails('"annual report" 2024 "draft"', 'inbox');
      const [query, , snippets] = requests[0].methodCalls;
      // One joined value would be one phrase on Stalwart 1.0.
      expect(query[1].filter).toEqual({
        operator: 'AND',
        conditions: [{ inMailbox: 'inbox' }, { text: '"annual report"' }, { text: '2024' }, { text: '"draft"' }],
      });
      // A quoted term switches the whole snippet request to exact mode.
      expect(snippets[1].filter).toEqual({
        operator: 'AND',
        conditions: [{ inMailbox: 'inbox' }, { text: 'annual report' }, { text: '2024' }, { text: 'draft' }],
      });

      await client.searchEmails('project budg*');
      expect(requests[1].methodCalls[0][1].filter).toEqual({
        operator: 'AND',
        conditions: [{ text: 'project' }, { text: 'budg*' }],
      });
    });

    it('sends a no-op instead of SearchSnippet/get for a structural filter', async () => {
      await setup();
      answer(() => ({
        methodResponses: [
          ['Email/query', { ids: [], total: 0 }, '0'],
          ['Email/get', { list: [] }, '1'],
          ['Core/echo', {}, 'snippets'],
        ],
      }));
      await client.advancedSearchEmails({ operator: 'AND', conditions: [{ inMailbox: 'inbox' }, { hasKeyword: '$flagged' }] });
      expect(requests[0].methodCalls[2][0]).toBe('Core/echo');
    });

    it('keeps the results when only the snippet call fails', async () => {
      await setup();
      answer(() => ({
        methodResponses: [
          ['Email/query', { ids: ['e1'], total: 1 }, '0'],
          ['Email/get', { list: [{ id: 'e1', threadId: 't1', receivedAt: '2026-08-29T00:00:00Z', mailboxIds: {}, keywords: {} }] }, '1'],
          ['error', { type: 'requestTooLarge' }, 'snippets'],
        ],
      }));
      const result = await client.searchEmails('hello');
      expect(result.emails).toHaveLength(1);
      expect(result.emails[0].searchSnippet).toBeUndefined();
    });

    describe('deferred', () => {
      const hits = [
        { id: 'e1', threadId: 't1', receivedAt: '2026-08-29T00:00:00Z', subject: 'Invoice', mailboxIds: {}, keywords: {} },
        { id: 'e2', threadId: 't2', receivedAt: '2026-08-28T00:00:00Z', subject: 'Other', mailboxIds: {}, keywords: {} },
      ];
      const searchOrSnippets = (snippets: unknown) => (body: RequestBody) => body.methodCalls[0][0] === 'SearchSnippet/get'
        ? { methodResponses: [snippets] }
        : { methodResponses: [['Email/query', { ids: ['e1', 'e2'], total: 2 }, '0'], ['Email/get', { list: hits.map((hit) => ({ ...hit })) }, '1']] };

      it('lists the results without waiting for the snippets', async () => {
        await setup();
        answer(searchOrSnippets(['SearchSnippet/get', { list: [{ emailId: 'e1', subject: '<mark>Invoice</mark>', preview: null }] }, 'snippets']));

        const result = await client.searchEmails('invoice', 'inbox', undefined, 50, 0, { deferSnippets: true });

        // The search itself no longer carries the snippet call ...
        expect(requests[0].methodCalls.map((call) => call[0])).toEqual(['Email/query', 'Email/get']);
        expect(result.emails.map((email) => email.id)).toEqual(['e1', 'e2']);
        expect(result.emails[0].searchSnippet).toBeUndefined();
        // ... it follows on its own, for exactly the listed messages.
        expect(await result.snippets).toEqual([{ emailId: 'e1', subject: '<mark>Invoice</mark>', preview: null }]);
        expect(requests[1].methodCalls).toEqual([['SearchSnippet/get', {
          accountId: 'acct-1',
          filter: { operator: 'AND', conditions: [{ inMailbox: 'inbox' }, { text: 'invoice' }] },
          emailIds: ['e1', 'e2'],
        }, 'snippets']]);
      });

      it('asks for no snippets when nothing could be highlighted', async () => {
        await setup();
        answer(searchOrSnippets(['SearchSnippet/get', { list: [] }, 'snippets']));

        const structural = await client.advancedSearchEmails({ hasKeyword: '$flagged' }, undefined, 50, 0, { deferSnippets: true });
        expect(structural.snippets).toBeUndefined();

        answer(() => ({ methodResponses: [['Email/query', { ids: [], total: 0 }, '0'], ['Email/get', { list: [] }, '1']] }));
        const empty = await client.searchEmails('nothing', undefined, undefined, 50, 0, { deferSnippets: true });
        expect(empty.snippets).toBeUndefined();
        expect(requests.every((body) => body.methodCalls[0][0] !== 'SearchSnippet/get')).toBe(true);
      });

      it('resolves to nothing instead of rejecting when the snippet request fails', async () => {
        await setup();
        answer(searchOrSnippets(['error', { type: 'requestTooLarge' }, 'snippets']));

        const result = await client.searchEmails('invoice', undefined, undefined, 50, 0, { deferSnippets: true });
        expect(result.emails).toHaveLength(2);
        await expect(result.snippets).resolves.toBeUndefined();
      });
    });
  });

  describe('deleteMailbox', () => {
    it('only sends onDestroyRemoveEmails when asked to remove the messages', async () => {
      await setup();
      answer(() => ({ methodResponses: [['Mailbox/set', { destroyed: ['f1'] }, '0']] }));

      await client.deleteMailbox('f1');
      expect(requests[0].methodCalls[0]).toEqual(['Mailbox/set', { accountId: 'acct-1', destroy: ['f1'] }, '0']);

      await client.deleteMailbox('f1', undefined, { removeEmails: true });
      expect(requests[1].methodCalls[0]).toEqual(['Mailbox/set', { accountId: 'acct-1', destroy: ['f1'], onDestroyRemoveEmails: true }, '0']);
    });

    it('exposes the server error type for a non-empty folder', async () => {
      await setup();
      answer(() => ({ methodResponses: [['Mailbox/set', { notDestroyed: { f1: { type: 'mailboxHasEmail', description: 'not empty' } } }, '0']] }));
      await expect(client.deleteMailbox('f1')).rejects.toMatchObject({ message: 'not empty', jmapType: 'mailboxHasEmail' });
    });
  });

  describe('calendar event notifications', () => {
    it('lists notifications with the event title and destroys acknowledged ones', async () => {
      await setup({ 'urn:ietf:params:jmap:calendars': {} });
      answer((body) => {
        const [method] = body.methodCalls[0];
        if (method === 'CalendarEventNotification/query') {
          return { methodResponses: [
            ['CalendarEventNotification/query', { ids: ['n1'] }, '0'],
            ['CalendarEventNotification/get', { list: [
              { id: 'n1', created: '2026-08-29T10:00:00Z', type: 'created', changedBy: { name: 'Alice', email: 'alice@example.com' }, calendarEventId: 'e1', isDraft: false, event: { title: 'Sync' } },
            ] }, '1'],
          ] };
        }
        return { methodResponses: [['CalendarEventNotification/set', { destroyed: ['n1'] }, '0']] };
      });

      const list = await client.getCalendarEventNotifications();
      expect(requests[0].methodCalls[1][1]).toMatchObject({ properties: expect.arrayContaining(['event', 'type', 'changedBy']) });
      expect(list).toHaveLength(1);
      expect(list[0].event?.title).toBe('Sync');

      await client.destroyCalendarEventNotifications(['n1']);
      expect(requests[1].methodCalls[0]).toEqual(['CalendarEventNotification/set', { accountId: 'acct-1', destroy: ['n1'] }, '0']);
    });

    it('pages through more notifications than the server gets at once', async () => {
      await setup({ 'urn:ietf:params:jmap:calendars': {} }, { maxObjectsInGet: 2 });
      const all = ['n1', 'n2', 'n3'];
      answer((body) => {
        const { position = 0, limit } = body.methodCalls[0][1] as { position?: number; limit: number };
        const ids = all.slice(position, position + limit);
        return { methodResponses: [
          ['CalendarEventNotification/query', { ids, position, total: all.length }, '0'],
          ['CalendarEventNotification/get', { list: ids.map((id) => ({ id, created: '2026-08-29T10:00:00Z', type: 'created', calendarEventId: 'e1', isDraft: false })) }, '1'],
        ] };
      });

      const list = await client.getCalendarEventNotifications();
      expect(list.map((n) => n.id)).toEqual(all);
      expect(requests.map((r) => r.methodCalls[0][1])).toEqual([
        expect.objectContaining({ position: 0, limit: 2 }),
        expect.objectContaining({ position: 2, limit: 2 }),
      ]);
    });

    it('stops paging when a server ignores position and keeps answering full pages', async () => {
      await setup({ 'urn:ietf:params:jmap:calendars': {} }, { maxObjectsInGet: 5000 });
      answer(() => ({ methodResponses: [
        ['CalendarEventNotification/query', { ids: Array.from({ length: 5000 }, (_, i) => `n${i}`), position: 0 }, '0'],
        ['CalendarEventNotification/get', { list: [] }, '1'],
      ] }));

      await client.getCalendarEventNotifications();
      expect(requests).toHaveLength(4);
    });
  });

  describe('participant identities', () => {
    it('maps ParticipantIdentity/get and sets the default via onSuccessSetIsDefault', async () => {
      await setup({ 'urn:ietf:params:jmap:calendars': {} });
      answer((body) => {
        const [method] = body.methodCalls[0];
        if (method === 'ParticipantIdentity/get') {
          return { methodResponses: [['ParticipantIdentity/get', { list: [
            { id: 'i1', name: 'Me', calendarAddress: 'mailto:me@example.com', isDefault: true },
            { id: 'i2', name: '', calendarAddress: 'mailto:alias@example.com', isDefault: false },
          ] }, '0']] };
        }
        return { methodResponses: [['ParticipantIdentity/set', { updated: null }, '0']] };
      });

      const identities = await client.getParticipantIdentities();
      expect(requests[0].using).toContain('urn:ietf:params:jmap:calendars');
      expect(identities).toEqual([
        { id: 'i1', name: 'Me', calendarAddress: 'mailto:me@example.com', isDefault: true },
        { id: 'i2', name: '', calendarAddress: 'mailto:alias@example.com', isDefault: false },
      ]);

      await client.setDefaultParticipantIdentity('i2');
      expect(requests[1].methodCalls[0]).toEqual(['ParticipantIdentity/set', { accountId: 'acct-1', onSuccessSetIsDefault: 'i2' }, '0']);
    });
  });

  describe('free/busy', () => {
    it('needs both the principals and the availability capability', async () => {
      await setup();
      expect(client.supportsAvailability()).toBe(false);
      expect(await client.getPrincipalAvailability('p1', new Date(), new Date())).toEqual([]);
    });

    it('queries Principal/getAvailability without event details', async () => {
      client?.disconnect();
      vi.restoreAllMocks();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      fetchSpy = vi.spyOn(globalThis, 'fetch');
      const session = makeSession();
      (session.capabilities as Record<string, unknown>)['urn:ietf:params:jmap:principals'] = {};
      (session.capabilities as Record<string, unknown>)['urn:ietf:params:jmap:principals:availability'] = {};
      fetchSpy.mockResolvedValueOnce(jsonResponse(session));
      client = new JMAPClient('https://mail.example.com', 'user@test.com', 'pass123');
      await client.connect();
      fetchSpy.mockReset();
      requests = [];
      answer(() => ({
        methodResponses: [['Principal/getAvailability', { list: [
          { utcStart: '2026-09-01T10:00:00Z', utcEnd: '2026-09-01T11:00:00Z', busyStatus: 'tentative' },
          { utcStart: '2026-09-01T12:00:00Z', utcEnd: '2026-09-01T13:00:00Z' },
        ] }, '0']],
      }));

      const periods = await client.getPrincipalAvailability('p1', new Date('2026-09-01T09:00:00.000Z'), new Date('2026-09-01T17:00:00.000Z'));

      expect(requests[0].using).toEqual(expect.arrayContaining(['urn:ietf:params:jmap:principals', 'urn:ietf:params:jmap:principals:availability']));
      expect(requests[0].methodCalls[0]).toEqual(['Principal/getAvailability', {
        accountId: 'acct-1', id: 'p1', utcStart: '2026-09-01T09:00:00Z', utcEnd: '2026-09-01T17:00:00Z', showDetails: false,
      }, '0']);
      expect(periods).toEqual([
        { utcStart: '2026-09-01T10:00:00Z', utcEnd: '2026-09-01T11:00:00Z', busyStatus: 'tentative' },
        { utcStart: '2026-09-01T12:00:00Z', utcEnd: '2026-09-01T13:00:00Z', busyStatus: null },
      ]);
    });

    async function setupAvailability() {
      client?.disconnect();
      vi.restoreAllMocks();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      fetchSpy = vi.spyOn(globalThis, 'fetch');
      const session = makeSession({ 'urn:ietf:params:jmap:principals': { currentUserPrincipalId: 'p-me' } });
      (session.capabilities as Record<string, unknown>)['urn:ietf:params:jmap:principals'] = {};
      (session.capabilities as Record<string, unknown>)['urn:ietf:params:jmap:principals:availability'] = { maxAvailabilityDuration: 'P365D' };
      fetchSpy.mockResolvedValueOnce(jsonResponse(session));
      client = new JMAPClient('https://mail.example.com', 'user@test.com', 'pass123');
      await client.connect();
      fetchSpy.mockReset();
      requests = [];
    }

    it('reads mayGetAvailability from the own principal and is false on Stalwart 1.0 with directory queries off', async () => {
      await setupAvailability();
      answer(() => ({
        methodResponses: [['Principal/get', { accountId: 'acct-1', state: 'n', list: [{
          id: 'p-me',
          capabilities: {
            'urn:ietf:params:jmap:mail': {},
            'urn:ietf:params:jmap:contacts': {},
            'urn:ietf:params:jmap:filenode': {},
            'urn:ietf:params:jmap:principals': {},
            'urn:ietf:params:jmap:calendars': { accountId: 'p-me', mayGetAvailability: false, mayShareWith: false, calendarAddress: 'mailto:user@test.com' },
          },
        }], notFound: [] }, '0']],
      }));

      expect(await client.mayGetAvailability()).toBe(false);
      // currentUserPrincipalId, not the account id, names the own principal.
      expect(requests[0].methodCalls[0]).toEqual(['Principal/get', { accountId: 'acct-1', ids: ['p-me'], properties: ['id', 'capabilities'] }, '0']);
    });

    it('goes ahead on Stalwart 0.16, whose principal capabilities are empty objects', async () => {
      await setupAvailability();
      answer(() => ({
        methodResponses: [['Principal/get', { accountId: 'acct-1', state: 'n', list: [{
          id: 'p-me',
          capabilities: {
            'urn:ietf:params:jmap:mail': {},
            'urn:ietf:params:jmap:contacts': {},
            'urn:ietf:params:jmap:calendars': {},
            'urn:ietf:params:jmap:filenode': {},
            'urn:ietf:params:jmap:principals': {},
          },
        }], notFound: [] }, '0']],
      }));

      expect(await client.mayGetAvailability()).toBe(true);
    });

    it('says no when the role may not read principals and throws on other failures', async () => {
      await setupAvailability();
      answer(() => ({
        methodResponses: [['error', { type: 'forbidden', description: 'You are not authorized to perform this action' }, '0']],
      }));
      expect(await client.mayGetAvailability()).toBe(false);

      answer(() => ({
        methodResponses: [['error', { type: 'serverUnavailable', description: 'This server is temporarily unavailable.' }, '0']],
      }));
      await expect(client.mayGetAvailability()).rejects.toMatchObject({ jmapType: 'serverUnavailable' });
    });

    it('throws getAvailability refusals with their JMAP type', async () => {
      await setupAvailability();
      const window = [new Date('2026-09-01T09:00:00Z'), new Date('2026-09-01T17:00:00Z')] as const;

      answer(() => ({
        methodResponses: [['error', { type: 'forbidden', description: 'The administrator has disabled directory queries.' }, '0']],
      }));
      await expect(client.getPrincipalAvailability('p1', ...window)).rejects.toMatchObject({
        jmapType: 'forbidden',
        message: 'The administrator has disabled directory queries.',
      });

      answer(() => ({
        methodResponses: [['error', { type: 'rateLimit', description: 'Too many availability requests, please try again later' }, '0']],
      }));
      await expect(client.getPrincipalAvailability('p1', ...window)).rejects.toMatchObject({ jmapType: 'rateLimit' });
    });

    it('batches several principals per request up to maxCallsInRequest and keeps each answer apart', async () => {
      await setupAvailability();
      (client as unknown as { capabilities: Record<string, unknown> }).capabilities['urn:ietf:params:jmap:core'] = { maxCallsInRequest: 2 };
      answer((body) => ({
        methodResponses: body.methodCalls.map(([, args, callId]) => (args.id === 'p2'
          // Stalwart 1.0 past 100 calls a minute; the calls before it still answer.
          ? ['error', { type: 'rateLimit', description: 'Too many availability requests, please try again later' }, callId]
          : ['Principal/getAvailability', { list: args.id === 'p1'
            ? [{ utcStart: '2026-09-01T10:00:00Z', utcEnd: '2026-09-01T11:00:00Z', busyStatus: 'confirmed' }]
            : [] }, callId])),
      }));

      const answers = await client.getPrincipalsAvailability(['p1', 'p2', 'p3'], new Date('2026-09-01T00:00:00Z'), new Date('2026-09-02T00:00:00Z'));

      expect(requests.map((r) => r.methodCalls.map(([method, args, callId]) => [method, args.id, callId]))).toEqual([
        [['Principal/getAvailability', 'p1', '0'], ['Principal/getAvailability', 'p2', '1']],
        [['Principal/getAvailability', 'p3', '0']],
      ]);
      expect(requests[0].methodCalls[0][1]).toEqual({
        accountId: 'acct-1', id: 'p1', utcStart: '2026-09-01T00:00:00Z', utcEnd: '2026-09-02T00:00:00Z', showDetails: false,
      });
      expect(answers).toEqual({
        p1: { periods: [{ utcStart: '2026-09-01T10:00:00Z', utcEnd: '2026-09-01T11:00:00Z', busyStatus: 'confirmed' }] },
        p2: { error: 'rateLimit' },
        p3: { periods: [] },
      });
    });
  });

  describe('mailbox sharing', () => {
    it('is advertised only with the mail:share capability', async () => {
      await setup();
      expect(client.supportsMailboxSharing()).toBe(false);
      client.disconnect();
      vi.restoreAllMocks();
      await setup({ 'urn:ietf:params:jmap:mail:share': {} });
      expect(client.supportsMailboxSharing()).toBe(true);
    });

    it('reads shareWith with the extension in `using`', async () => {
      await setup({ 'urn:ietf:params:jmap:mail:share': {} });
      answer(() => ({
        methodResponses: [['Mailbox/get', { list: [{ id: 'f1', shareWith: { p1: { mayReadItems: true } } }] }, '0']],
      }));

      const shareWith = await client.getMailboxShareWith('f1');

      expect(requests[0].using).toContain('urn:ietf:params:jmap:mail:share');
      expect(requests[0].methodCalls[0]).toEqual(['Mailbox/get', { accountId: 'acct-1', ids: ['f1'], properties: ['id', 'shareWith'] }, '0']);
      expect(shareWith).toEqual({ p1: { mayReadItems: true } });
    });

    it('patches shareWith/{principal} on the owner account and checks the outcome', async () => {
      await setup({ 'urn:ietf:params:jmap:mail:share': {} });
      answer(() => ({ methodResponses: [['Mailbox/set', { updated: { f1: null } }, '0']] }));

      await client.setMailboxShare('f1', 'p1', null, 'owner');
      expect(requests[0].methodCalls[0]).toEqual(['Mailbox/set', { accountId: 'owner', update: { f1: { 'shareWith/p1': null } } }, '0']);

      answer(() => ({ methodResponses: [['Mailbox/set', { notUpdated: { f1: { type: 'forbidden', description: 'no' } } }, '0']] }));
      await expect(client.setMailboxShare('f1', 'p1', null)).rejects.toThrow('no');
    });
  });
});

/**
 * PushSubscription/set refusals reach web-push as typed errors: a SetError
 * (jmapSetError, the server refused this subscription) apart from a refused
 * method call (plain jmapError). Bodies are Stalwart's (jmap/src/push/set.rs,
 * identical on 0.16.16 to 0.16.23 and 1.0).
 */
describe('JMAP client push subscriptions', () => {
  const EMAIL_PUSH = 'urn:ietf:params:jmap:emailpush';
  const FORBIDDEN_MAP = { type: 'forbidden', description: 'No access to one of the accounts in the emailPush map.' };
  const OVER_QUOTA = {
    type: 'overQuota',
    description: 'There are too many subscriptions, please delete some before adding a new one.',
  };
  const EMAIL_PUSH_MAP = {
    'acct-1': { filter: { operator: 'AND', conditions: [{ notKeyword: '$junk' }] }, properties: ['id', 'threadId'] },
    b: { filter: { operator: 'AND', conditions: [{ notKeyword: '$junk' }] }, properties: ['id', 'threadId'] },
  };
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let client: JMAPClient;
  let requests: RequestBody[];

  // 0.16.16 to 0.16.23 and 1.0 advertise emailpush in the session; 0.16.6
  // to 0.16.15 don't. `b` is a mailbox shared by ACL as 1.0 lists it:
  // read-only, without emailpush and the other owner-only capabilities.
  async function setup(withEmailPush: boolean) {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    const session = makeSession(withEmailPush ? { [EMAIL_PUSH]: {} } : {});
    if (withEmailPush) (session.capabilities as Record<string, unknown>)[EMAIL_PUSH] = {};
    (session.accounts as Record<string, unknown>).b = {
      name: 'userb',
      isPersonal: false,
      isReadOnly: true,
      accountCapabilities: {
        'urn:ietf:params:jmap:mail': {},
        'urn:ietf:params:jmap:calendars': { mayCreateCalendar: false },
      },
    };
    fetchSpy.mockResolvedValueOnce(jsonResponse(session));
    client = new JMAPClient('https://mail.example.com', 'user@test.com', 'pass123');
    await client.connect();
    fetchSpy.mockReset();
    requests = [];
  }

  function answer(handler: (body: RequestBody) => unknown) {
    fetchSpy.mockImplementation(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as RequestBody;
      requests.push(body);
      return jsonResponse(handler(body));
    });
  }

  const newSubscription = {
    deviceClientId: 'dcid',
    url: 'https://relay.example/api/push/jmap/dcid',
    types: ['EmailDelivery'],
    emailPush: EMAIL_PUSH_MAP,
  };

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    client?.disconnect();
    vi.restoreAllMocks();
  });

  it('throws a forbidden SetError when Stalwart refuses the emailPush map on create (0.16.16+ and 1.0)', async () => {
    await setup(true);
    answer(() => ({ methodResponses: [['PushSubscription/set', { notCreated: { new: FORBIDDEN_MAP } }, '0']] }));

    const err = await client.createPushSubscription(newSubscription).catch((e) => e);

    expect(requests[0].using).toEqual(['urn:ietf:params:jmap:core', EMAIL_PUSH]);
    expect(requests[0].methodCalls[0][1]).toEqual({ create: { new: { ...newSubscription } } });
    expect(jmapErrorType(err)).toBe('forbidden');
    expect(isJmapSetError(err)).toBe(true);
    expect(err.message).toContain('No access to one of the accounts in the emailPush map.');
    expect(err.message).not.toContain('{');
  });

  it('throws an overQuota SetError past the subscription limit', async () => {
    await setup(true);
    answer(() => ({ methodResponses: [['PushSubscription/set', { notCreated: { new: OVER_QUOTA } }, '0']] }));

    const err = await client.createPushSubscription(newSubscription).catch((e) => e);

    expect(jmapErrorType(err)).toBe('overQuota');
    expect(isJmapSetError(err)).toBe(true);
  });

  it('returns the id Stalwart assigns', async () => {
    await setup(true);
    answer(() => ({
      methodResponses: [['PushSubscription/set', {
        created: { new: { id: 'k', keys: null, expires: '2026-10-02T15:00:00Z' } },
      }, '0']],
    }));

    expect(await client.createPushSubscription(newSubscription)).toBe('k');
  });

  it('never puts emailpush in `using` or sends the map on 0.16.6 to 0.16.15', async () => {
    await setup(false);
    answer(() => ({ methodResponses: [['PushSubscription/set', { created: { new: { id: 'k' } } }, '0']] }));

    await client.createPushSubscription(newSubscription);

    expect(requests[0].using).toEqual(['urn:ietf:params:jmap:core']);
    expect(requests[0].methodCalls[0][1]).toEqual({
      create: { new: { deviceClientId: 'dcid', url: newSubscription.url, types: ['EmailDelivery'] } },
    });
  });

  it('throws a forbidden SetError when Stalwart refuses the emailPush map on update', async () => {
    await setup(true);
    answer(() => ({ methodResponses: [['PushSubscription/set', { notUpdated: { k: FORBIDDEN_MAP } }, '0']] }));

    const err = await client
      .updatePushSubscription('k', { expires: '2026-12-01T00:00:00Z', emailPush: EMAIL_PUSH_MAP })
      .catch((e) => e);

    expect(requests[0].methodCalls[0][1]).toEqual({
      update: { k: { expires: '2026-12-01T00:00:00Z', emailPush: EMAIL_PUSH_MAP } },
    });
    expect(jmapErrorType(err)).toBe('forbidden');
    expect(isJmapSetError(err)).toBe(true);
  });

  it('throws a notFound SetError for a subscription the server no longer has', async () => {
    await setup(true);
    answer(() => ({ methodResponses: [['PushSubscription/set', { notUpdated: { k: { type: 'notFound' } } }, '0']] }));

    const err = await client.updatePushSubscription('k', { expires: '2026-12-01T00:00:00Z' }).catch((e) => e);

    expect(jmapErrorType(err)).toBe('notFound');
    expect(isJmapSetError(err)).toBe(true);
  });

  it('resolves when the update is applied', async () => {
    await setup(true);
    answer(() => ({ methodResponses: [['PushSubscription/set', { updated: { k: null } }, '0']] }));

    await expect(client.updatePushSubscription('k', { expires: '2026-12-01T00:00:00Z' })).resolves.toBeUndefined();
  });

  it('throws a plain error, not a SetError, when the whole method call is refused', async () => {
    await setup(true);
    answer(() => ({ methodResponses: [['error', { type: 'forbidden', description: 'Not allowed' }, '0']] }));

    const createErr = await client.createPushSubscription(newSubscription).catch((e) => e);
    const updateErr = await client.updatePushSubscription('k', { expires: '2026-12-01T00:00:00Z' }).catch((e) => e);
    const verifyErr = await client.verifyPushSubscription('k', 'code').catch((e) => e);

    for (const err of [createErr, updateErr, verifyErr]) {
      expect(jmapErrorType(err)).toBe('forbidden');
      expect(isJmapSetError(err)).toBe(false);
    }
  });

  it('throws instead of listing nothing when PushSubscription/get fails', async () => {
    await setup(true);
    answer(() => ({ methodResponses: [['error', { type: 'serverFail' }, '0']] }));

    const err = await client.listPushSubscriptions().catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(jmapErrorType(err)).toBe('serverFail');
  });

  it('describes each session account without flattening its capabilities', async () => {
    await setup(true);

    expect(client.getAccountInfo('b')).toEqual({
      name: 'userb',
      isPersonal: false,
      isReadOnly: true,
      accountCapabilities: {
        'urn:ietf:params:jmap:mail': {},
        'urn:ietf:params:jmap:calendars': { mayCreateCalendar: false },
      },
    });
    expect(client.getAccountInfo('acct-1')?.isPersonal).toBe(true);
    expect(client.getAccountInfo('nope')).toBeNull();
  });
});
