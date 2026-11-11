import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useCalendarStore } from '../calendar-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Calendar } from '@/lib/jmap/types';

// Creating a calendar in a shared (group) account managed from Settings (#1617).

function cal(overrides: Partial<Calendar>): Calendar {
  return {
    id: 'c', name: 'Cal', color: null, sortOrder: 0, isSubscribed: true, isVisible: true,
    isDefault: false, includeInAvailability: 'all', timeZone: null, shareWith: null,
    myRights: null,
    ...overrides,
  } as unknown as Calendar;
}

// Stalwart numbers calendars per account, so the group's first new calendar
// can carry the same id as one of the user's own.
function makeClient() {
  const createCalendar = vi.fn(async (...[c]: [Partial<Calendar>, string?, unknown?]) => cal({ ...c, id: 'c' }));
  const client = {
    createCalendar,
    getCalendarsAccountId: () => 'own',
    getAccountId: () => 'own',
    getAccountInfo: (id: string) => (id === 'group' ? { name: 'team@example.org', isPersonal: false, isReadOnly: false, accountCapabilities: {} } : null),
    getServerUrl: () => 'https://mail.example.org',
    getUsername: () => 'usera@example.org',
  } as unknown as IJMAPClient;
  return { client, createCalendar };
}

beforeEach(() => {
  useCalendarStore.setState({
    calendars: [cal({ id: 'c', name: 'Mine', sortOrder: 4, accountId: 'own', originalId: 'c' })],
    selectedCalendarIds: ['c'],
    taskCalendarKinds: {},
    error: null,
    accountClients: null,
    accountClientsActiveId: null,
  });
});

describe('createCalendar in a shared account', () => {
  it('creates it in that account, without the user\'s own order', async () => {
    const { client, createCalendar } = makeClient();

    await useCalendarStore.getState().createCalendar(client, { name: 'Team' }, { components: ['VEVENT'] }, 'group');

    expect(createCalendar).toHaveBeenCalledTimes(1);
    expect(createCalendar.mock.calls[0][1]).toBe('group');
    expect(createCalendar.mock.calls[0][0]).not.toHaveProperty('sortOrder');
  });

  it('lists it under the shared account with an id apart from the user\'s own calendar', async () => {
    const { client } = makeClient();

    const created = await useCalendarStore.getState().createCalendar(client, { name: 'Team' }, undefined, 'group');

    expect(created).toMatchObject({
      id: 'group:c', originalId: 'c', accountId: 'group', accountName: 'team@example.org', isShared: true,
    });
    const { calendars, selectedCalendarIds } = useCalendarStore.getState();
    expect(calendars.map((c) => c.id).sort()).toEqual(['c', 'group:c']);
    expect(calendars.find((c) => c.id === 'c')?.name).toBe('Mine');
    expect(selectedCalendarIds).toEqual(['c', 'group:c']);
  });

  it('marks no task kind, which would land on the user\'s own calendar of that id', async () => {
    const { client } = makeClient();

    const created = await useCalendarStore.getState().createCalendar(client, { name: 'Team' }, { components: ['VTODO'] }, 'group');

    expect(created).toMatchObject({ id: 'group:c' });
    expect(useCalendarStore.getState().taskCalendarKinds).toEqual({});
    expect(created?.isTasksOnly).toBeFalsy();
  });

  it('namespaces it under the login when several are signed in', async () => {
    const { client } = makeClient();
    useCalendarStore.setState({ accountClients: [{ localAccountId: 'usera@mail.example.org', client }], accountClientsActiveId: 'usera@mail.example.org' });

    const created = await useCalendarStore.getState().createCalendar(client, { name: 'Team' }, undefined, 'group');

    expect(created).toMatchObject({
      id: 'usera@mail.example.org::group:c', originalId: 'c', accountId: 'group', localAccountId: 'usera@mail.example.org', isShared: true,
    });
  });

  it('treats the user\'s own account as no target', async () => {
    const { client, createCalendar } = makeClient();
    createCalendar.mockImplementationOnce(async (c) => cal({ ...c, id: 'n' }));

    const created = await useCalendarStore.getState().createCalendar(client, { name: 'Mine too' }, { components: ['VTODO'] }, 'own');

    expect(createCalendar.mock.calls[0][1]).toBeUndefined();
    expect(created).toMatchObject({ id: 'n', isTasksOnly: true });
    expect(created?.isShared).toBeFalsy();
    expect(Object.values(useCalendarStore.getState().taskCalendarKinds)).toEqual(['tasks']);
  });
});
