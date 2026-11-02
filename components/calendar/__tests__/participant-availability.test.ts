import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { availabilityFor, ParticipantAvailability } from '../participant-availability';
import { JMAPClient } from '@/lib/jmap/client';
import { useAuthStore } from '@/stores/auth-store';
import type { BusyPeriod } from '@/lib/jmap/types';

const period = (utcStart: string, utcEnd: string, busyStatus: BusyPeriod['busyStatus'] = 'confirmed'): BusyPeriod => ({
  utcStart,
  utcEnd,
  busyStatus,
});

const start = new Date('2026-09-01T10:00:00Z');
const end = new Date('2026-09-01T11:00:00Z');

describe('availabilityFor', () => {
  it('is free without an overlapping busy period', () => {
    expect(availabilityFor([], start, end)).toBe('free');
    // Adjacent periods do not overlap.
    expect(availabilityFor([period('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z'), period('2026-09-01T11:00:00Z', '2026-09-01T12:00:00Z')], start, end)).toBe('free');
  });

  it('is busy on any confirmed or unclassified overlap', () => {
    expect(availabilityFor([period('2026-09-01T10:30:00Z', '2026-09-01T10:45:00Z')], start, end)).toBe('busy');
    expect(availabilityFor([period('2026-09-01T09:00:00Z', '2026-09-01T12:00:00Z', null)], start, end)).toBe('busy');
    expect(availabilityFor([period('2026-09-01T09:00:00Z', '2026-09-01T12:00:00Z', 'unavailable')], start, end)).toBe('busy');
  });

  it('reports tentative unless a firm conflict exists too', () => {
    expect(availabilityFor([period('2026-09-01T10:30:00Z', '2026-09-01T10:45:00Z', 'tentative')], start, end)).toBe('tentative');
    expect(
      availabilityFor(
        [period('2026-09-01T10:30:00Z', '2026-09-01T10:45:00Z', 'tentative'), period('2026-09-01T10:50:00Z', '2026-09-01T11:30:00Z')],
        start,
        end,
      ),
    ).toBe('busy');
  });
});

type Call = [string, Record<string, unknown>, string];
type MethodResponse = [string, Record<string, unknown>, string];

const DIRECTORY = [
  { id: 'me', type: 'individual', name: 'me@example.com', description: 'Me', email: 'me@example.com' },
  { id: 'anna', type: 'individual', name: 'anna@example.com', description: 'Anna', email: 'anna@example.com' },
  { id: 'bob', type: 'individual', name: 'bob@example.com', description: 'Bob', email: 'bob@example.com' },
];

// The user's own principal as each server version returns it for
// properties ["id", "capabilities"].
const OWN_PRINCIPAL_1_0_DIRECTORY_OFF: MethodResponse = ['Principal/get', { accountId: 'me', state: 'n', list: [{
  id: 'me',
  capabilities: {
    'urn:ietf:params:jmap:mail': {},
    'urn:ietf:params:jmap:contacts': {},
    'urn:ietf:params:jmap:filenode': {},
    'urn:ietf:params:jmap:principals': {},
    'urn:ietf:params:jmap:calendars': { accountId: 'me', mayGetAvailability: false, mayShareWith: false, calendarAddress: 'mailto:me@example.com' },
  },
}], notFound: [] }, '0'];

const OWN_PRINCIPAL_0_16: MethodResponse = ['Principal/get', { accountId: 'me', state: 'n', list: [{
  id: 'me',
  capabilities: {
    'urn:ietf:params:jmap:mail': {},
    'urn:ietf:params:jmap:contacts': {},
    'urn:ietf:params:jmap:calendars': {},
    'urn:ietf:params:jmap:filenode': {},
    'urn:ietf:params:jmap:principals': {},
  },
}], notFound: [] }, '0'];

// 1.0 with directory queries on, for a role that may look up free/busy.
const OWN_PRINCIPAL_1_0: MethodResponse = ['Principal/get', { accountId: 'me', state: 'n', list: [{
  id: 'me',
  capabilities: {
    'urn:ietf:params:jmap:principals': {},
    'urn:ietf:params:jmap:calendars': { accountId: 'me', mayGetAvailability: true, mayShareWith: true, calendarAddress: 'mailto:me@example.com' },
  },
}], notFound: [] }, '0'];

const NOT_AUTHORIZED: MethodResponse = ['error', { type: 'forbidden', description: 'You are not authorized to perform this action' }, '0'];
const DIRECTORY_QUERIES_OFF: MethodResponse = ['error', { type: 'forbidden', description: 'The administrator has disabled directory queries.' }, '0'];
const RATE_LIMITED: MethodResponse = ['error', { type: 'rateLimit', description: 'Too many availability requests, please try again later' }, '0'];
const UNRESOLVED_REFERENCE: MethodResponse = ['error', { type: 'invalidResultReference', description: 'Result reference to 0#Principal/query not found.' }, '1'];

interface ServerScript {
  /** Answer to Principal/get of the user's own principal; throws for an HTTP failure. */
  ownPrincipal: MethodResponse | (() => MethodResponse);
  /** Answer to the paged Principal/query + Principal/get; throws for an HTTP failure. */
  directory?: () => MethodResponse[];
  /** Answer to Principal/get without ids (the principals the user knows); the own principal's otherwise. */
  known?: MethodResponse;
  /** Answer to one Principal/getAvailability call; throws for an HTTP failure. */
  availability?: (principalId: string, callId: string) => MethodResponse;
}

function http500(): never {
  throw new Error('Request failed: 500 - Internal Server Error');
}

function makeClient(script: ServerScript) {
  const client = new JMAPClient('https://jmap.example.com', 'me@example.com', 'pass');
  Object.assign(client, {
    accountId: 'me',
    capabilities: {
      'urn:ietf:params:jmap:core': { maxObjectsInGet: 500, maxCallsInRequest: 16 },
      'urn:ietf:params:jmap:principals': {},
      'urn:ietf:params:jmap:principals:availability': { maxAvailabilityDuration: 'P365D' },
    },
    session: {
      accounts: {
        me: { name: 'me@example.com', isPersonal: true, accountCapabilities: { 'urn:ietf:params:jmap:principals': { currentUserPrincipalId: 'me' } } },
      },
    },
  });
  const requests: Call[][] = [];
  vi.spyOn(client as unknown as { request: (c: Call[]) => Promise<unknown> }, 'request')
    .mockImplementation(async (calls: Call[]) => {
      requests.push(calls);
      const [method, args] = calls[0];
      if (method === 'Principal/get') {
        if (args.ids === null && script.known) return { methodResponses: [script.known] };
        return { methodResponses: [typeof script.ownPrincipal === 'function' ? script.ownPrincipal() : script.ownPrincipal] };
      }
      if (method === 'Principal/query') {
        return { methodResponses: script.directory ? script.directory() : [
          ['Principal/query', { ids: DIRECTORY.map((p) => p.id) }, '0'],
          ['Principal/get', { list: DIRECTORY, notFound: [] }, '1'],
        ] };
      }
      if (method === 'Principal/getAvailability') {
        return { methodResponses: calls.map(([, a, callId]) => script.availability!(a.id as string, callId)) };
      }
      throw new Error(`unexpected ${method} ${JSON.stringify(args)}`);
    });
  return { client, requests };
}

const methodsOf = (requests: Call[][]) => requests.map((calls) => calls.map((c) => c[0]).join('+'));

const attendees = [
  { name: 'Anna', email: 'anna@example.com' },
  { name: '', email: 'outsider@elsewhere.org' },
];

function renderFor(client: JMAPClient) {
  useAuthStore.setState({ client } as never);
  return render(createElement(ParticipantAvailability, { attendees, start, end }));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

describe('ParticipantAvailability', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    useAuthStore.setState({ client: null } as never);
    vi.restoreAllMocks();
  });

  it('says free/busy is not available on Stalwart 1.0 with directory queries off, without looking anyone up', async () => {
    const { client, requests } = makeClient({ ownPrincipal: OWN_PRINCIPAL_1_0_DIRECTORY_OFF });
    renderFor(client);
    // Nothing shows while the server is asked.
    expect(screen.queryByTestId('participant-availability')).toBeNull();
    expect(screen.queryByTestId('participant-availability-unavailable')).toBeNull();

    // The i18n test mock renders the translation key.
    await waitFor(() => expect(screen.getByText('unavailable_on_server')).toBeInTheDocument());
    await settle();

    expect(screen.queryByTestId('participant-availability')).toBeNull();
    expect(screen.getAllByTestId('participant-availability-unavailable')).toHaveLength(1);
    expect(methodsOf(requests)).toEqual(['Principal/get']);
    expect(requests[0][0]).toEqual(['Principal/get', { accountId: 'me', ids: ['me'], properties: ['id', 'capabilities'] }, '0']);
  });

  it('renders nothing when the server offers no free/busy at all', async () => {
    const { client, requests } = makeClient({ ownPrincipal: OWN_PRINCIPAL_0_16 });
    // No urn:ietf:params:jmap:principals:availability in the session.
    const capabilities = (client as unknown as { capabilities: Record<string, unknown> }).capabilities;
    delete capabilities['urn:ietf:params:jmap:principals:availability'];
    const { container } = renderFor(client);

    await settle();

    expect(container).toBeEmptyDOMElement();
    expect(requests).toHaveLength(0);
  });

  it('checks attendees on Stalwart 0.16, whose principal capabilities are empty', async () => {
    const { client } = makeClient({
      ownPrincipal: OWN_PRINCIPAL_0_16,
      availability: (id, callId) => ['Principal/getAvailability', {
        list: id === 'anna' ? [{ utcStart: '2026-09-01T10:30:00Z', utcEnd: '2026-09-01T11:30:00Z', busyStatus: 'confirmed' }] : [],
      }, callId],
    });
    renderFor(client);

    // The i18n test mock renders the translation key.
    await waitFor(() => expect(screen.getByText('busy')).toBeInTheDocument(), { timeout: 2000 });
    // Found nowhere in a complete directory listing.
    expect(screen.getByText('unknown')).toBeInTheDocument();
  });

  it('says free/busy is not available once getAvailability is refused with forbidden, and asks no more', async () => {
    const { client, requests } = makeClient({
      ownPrincipal: OWN_PRINCIPAL_0_16,
      availability: () => DIRECTORY_QUERIES_OFF,
    });
    const first = renderFor(client);
    await waitFor(() => expect(methodsOf(requests)).toContain('Principal/getAvailability'), { timeout: 2000 });
    await waitFor(() => expect(screen.getByText('unavailable_on_server')).toBeInTheDocument());
    expect(screen.queryByTestId('participant-availability')).toBeNull();
    first.unmount();

    const calls = requests.length;
    renderFor(client);
    await settle();
    expect(screen.getByText('unavailable_on_server')).toBeInTheDocument();
    expect(screen.queryByTestId('participant-availability')).toBeNull();
    expect(requests).toHaveLength(calls);
  });

  it('says free/busy is not available when the role may not read principals (0.16 and 1.0)', async () => {
    const { client, requests } = makeClient({ ownPrincipal: NOT_AUTHORIZED });
    renderFor(client);

    await waitFor(() => expect(screen.getByText('unavailable_on_server')).toBeInTheDocument());
    await settle();

    expect(screen.queryByTestId('participant-availability')).toBeNull();
    expect(methodsOf(requests)).toEqual(['Principal/get']);
  });

  it('says it could not check, not that the attendee is unknown, on rateLimit (1.0)', async () => {
    const { client } = makeClient({ ownPrincipal: OWN_PRINCIPAL_0_16, availability: () => RATE_LIMITED });
    renderFor(client);

    await waitFor(() => expect(screen.getByText('error')).toBeInTheDocument(), { timeout: 2000 });
    expect(screen.getByText('unknown')).toBeInTheDocument();
    expect(screen.getByTestId('participant-availability')).toBeInTheDocument();
  });

  it('says it could not check on an HTTP 500', async () => {
    const { client } = makeClient({ ownPrincipal: OWN_PRINCIPAL_0_16, availability: http500 });
    renderFor(client);

    await waitFor(() => expect(screen.getByText('error')).toBeInTheDocument(), { timeout: 2000 });
  });

  it('shows "no busy times shared", not "available", for an empty answer', async () => {
    // Both versions answer list:[] as well for someone whose free/busy the
    // user may not see.
    const { client } = makeClient({
      ownPrincipal: OWN_PRINCIPAL_0_16,
      availability: (_id, callId) => ['Principal/getAvailability', { list: [] }, callId],
    });
    renderFor(client);

    await waitFor(() => expect(screen.getByText('no_busy_times')).toBeInTheDocument(), { timeout: 2000 });
    expect(screen.queryByText('free')).toBeNull();
  });

  it('asks for all attendees in one request and answers a new time on the same day from the cache', async () => {
    // Local times: the cache holds whole local days.
    const tenOclock = new Date(2026, 8, 1, 10);
    const { client, requests } = makeClient({
      ownPrincipal: OWN_PRINCIPAL_0_16,
      availability: (id, callId) => ['Principal/getAvailability', {
        list: [{ utcStart: new Date(2026, 8, 1, 10, 30).toISOString(), utcEnd: new Date(2026, 8, 1, 11, 30).toISOString(), busyStatus: id === 'anna' ? 'confirmed' : 'tentative' }],
      }, callId],
    });
    useAuthStore.setState({ client } as never);
    const people = [{ name: 'Anna', email: 'anna@example.com' }, { name: 'Bob', email: 'bob@example.com' }];
    const view = render(createElement(ParticipantAvailability, { attendees: people, start: tenOclock, end: new Date(2026, 8, 1, 11) }));

    await waitFor(() => expect(screen.getByText('busy')).toBeInTheDocument(), { timeout: 2000 });
    expect(screen.getByText('tentative')).toBeInTheDocument();
    const lookups = requests.filter((calls) => calls[0][0] === 'Principal/getAvailability');
    expect(lookups).toHaveLength(1);
    expect(lookups[0].map(([, args]) => args.id)).toEqual(['anna', 'bob']);

    view.rerender(createElement(ParticipantAvailability, { attendees: people, start: new Date(2026, 8, 1, 14), end: new Date(2026, 8, 1, 15) }));

    await waitFor(() => expect(screen.getAllByText('free')).toHaveLength(2), { timeout: 2000 });
    expect(requests.filter((calls) => calls[0][0] === 'Principal/getAvailability')).toHaveLength(1);
  });

  it('stops asking after rateLimit on Stalwart 1.0 and keeps saying it could not check', async () => {
    const { client, requests } = makeClient({ ownPrincipal: OWN_PRINCIPAL_0_16, availability: () => RATE_LIMITED });
    useAuthStore.setState({ client } as never);
    const people = [{ name: 'Anna', email: 'anna@example.com' }];
    const view = render(createElement(ParticipantAvailability, { attendees: people, start: new Date(2026, 8, 1, 10), end: new Date(2026, 8, 1, 11) }));
    await waitFor(() => expect(screen.getByText('error')).toBeInTheDocument(), { timeout: 2000 });

    view.rerender(createElement(ParticipantAvailability, { attendees: people, start: new Date(2026, 8, 1, 14), end: new Date(2026, 8, 1, 15) }));
    expect(screen.queryByText('error')).toBeNull();

    await waitFor(() => expect(screen.getByText('error')).toBeInTheDocument(), { timeout: 2000 });
    expect(requests.filter((calls) => calls[0][0] === 'Principal/getAvailability')).toHaveLength(1);
  });

  it('calls no one "not a user" when the directory listing failed', async () => {
    const { client } = makeClient({
      ownPrincipal: OWN_PRINCIPAL_0_16,
      directory: http500,
      availability: (_id, callId) => ['Principal/getAvailability', { list: [] }, callId],
    });
    renderFor(client);

    await waitFor(() => expect(screen.getAllByText('error')).toHaveLength(2), { timeout: 2000 });
    expect(screen.queryByText('unknown')).toBeNull();
  });

  // Listing the directory (Principal/query) and looking up free/busy
  // (Principal/getAvailability) are permissions of their own on 0.16 and 1.0,
  // and both refuse a missing one with "You are not authorized to perform this
  // action" before the method runs. Principal/get without ids still returns
  // everyone there (0.16; 1.0 with directory queries on).
  it.each([
    ['0.16', OWN_PRINCIPAL_0_16],
    ['1.0', OWN_PRINCIPAL_1_0],
  ])('keeps checking attendees on Stalwart %s when the role may not list the directory', async (_version, ownPrincipal) => {
    const { client } = makeClient({
      ownPrincipal,
      directory: () => [NOT_AUTHORIZED, UNRESOLVED_REFERENCE],
      known: ['Principal/get', { accountId: 'me', state: 'n', list: DIRECTORY, notFound: [] }, '0'],
      availability: (id, callId) => ['Principal/getAvailability', {
        list: id === 'anna' ? [{ utcStart: '2026-09-01T10:30:00Z', utcEnd: '2026-09-01T11:30:00Z', busyStatus: 'confirmed' }] : [],
      }, callId],
    });
    renderFor(client);

    await waitFor(() => expect(screen.getByText('busy')).toBeInTheDocument(), { timeout: 2000 });
    // Not a complete listing, so the outsider can't be called "not a user".
    expect(screen.getByText('error')).toBeInTheDocument();
    expect(screen.queryByText('unavailable_on_server')).toBeNull();
  });

  // Stalwart 1.0.1 refuses Principal/query with directory queries off but
  // still answers getAvailability for the principals the user shares an
  // account with (local-data/enterprise-pack-facts.md part 6 §1), so the
  // list stays and says who could not be looked up.
  it('keeps checking the known principals and says the rest cannot be looked up when Stalwart 1.0.1 has directory queries off', async () => {
    const { client } = makeClient({
      ownPrincipal: OWN_PRINCIPAL_1_0,
      directory: () => [DIRECTORY_QUERIES_OFF, UNRESOLVED_REFERENCE],
      known: ['Principal/get', { accountId: 'me', state: 'n', list: [DIRECTORY[0], DIRECTORY[1]], notFound: [] }, '0'],
      availability: (id, callId) => ['Principal/getAvailability', {
        list: id === 'anna' ? [{ utcStart: '2026-09-01T10:30:00Z', utcEnd: '2026-09-01T11:30:00Z', busyStatus: 'confirmed' }] : [],
      }, callId],
    });
    renderFor(client);

    await waitFor(() => expect(screen.getByText('busy')).toBeInTheDocument(), { timeout: 2000 });
    expect(screen.getByText('not_looked_up')).toBeInTheDocument();
    expect(screen.getByTestId('participant-availability-directory-off')).toHaveTextContent('directory_off');
    expect(screen.queryByText('unavailable_on_server')).toBeNull();
  });

  it('says free/busy is not available when a 1.0 build refuses the lookups as well with directory queries off', async () => {
    // The 1.0 test build (4fb4420b5) refuses every lookup with the same text.
    const { client } = makeClient({
      ownPrincipal: OWN_PRINCIPAL_1_0,
      directory: () => [DIRECTORY_QUERIES_OFF, UNRESOLVED_REFERENCE],
      known: ['Principal/get', { accountId: 'me', state: 'n', list: [DIRECTORY[0], DIRECTORY[1]], notFound: [] }, '0'],
      availability: () => DIRECTORY_QUERIES_OFF,
    });
    renderFor(client);

    await waitFor(() => expect(screen.getByText('unavailable_on_server')).toBeInTheDocument(), { timeout: 2000 });
    expect(screen.queryByTestId('participant-availability')).toBeNull();
  });
});
