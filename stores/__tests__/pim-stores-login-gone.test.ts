import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetLoginContacts, useContactStore } from '../contact-store';
import { forgetLoginCalendars, useCalendarStore } from '../calendar-store';
import { forgetLoginTasks, useTaskStore } from '../task-store';
import { setClientLookup } from '../client-registry';
import { useAuthStore } from '../auth-store';
import { useAccountStore } from '../account-store';
import type { CalendarEvent, CalendarTask, Calendar, ContactCard, AddressBook } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

/**
 * With several logins the contact, calendar and task stores list every
 * login's rows under `<login>::<id>` and write through the login a row is
 * stamped with. When that login has no client any more (removed, refused by
 * the desktop policy, or being reconnected) a write to its rows is refused:
 * card, event, task, address book and calendar ids repeat across accounts and
 * servers (every Stalwart account has address book `b` and calendar `b`), so
 * through the active login the same id names its own data.
 *
 * Two fake logins with colliding ids; login-b is gone. Nothing may be written
 * through login-a for a row of login-b.
 */

function makeClient() {
  const ok = () => vi.fn().mockResolvedValue(undefined);
  return {
    getAccountId: () => 'br',
    getContactsAccountId: () => 'br',
    getCalendarsAccountId: () => 'br',
    deleteContact: ok(), updateContact: ok(), createContact: vi.fn().mockResolvedValue({ id: 'x', addressBookIds: {} }),
    deleteAddressBook: ok(), updateAddressBook: ok(), setAddressBookShare: ok(), setDefaultAddressBook: ok(),
    deleteCalendarEvent: ok(), updateCalendarEvent: ok(), deleteCalendar: ok(), updateCalendar: ok(), setCalendarShare: ok(),
    getCalendarEvents: vi.fn().mockResolvedValue([]), deleteCalendarEvents: ok(),
    deleteCalendarTask: ok(), updateCalendarTask: ok(),
  };
}

function writes(client: ReturnType<typeof makeClient>): string[] {
  const reads = new Set(['getAccountId', 'getCalendarEvents']);
  return Object.entries(client)
    .filter(([name, fn]) => !reads.has(name) && (fn as ReturnType<typeof vi.fn>).mock?.calls.length > 0)
    .map(([name]) => name);
}

const attempt = async (run: () => Promise<unknown>) => { try { await run(); } catch { /* refusing is fine */ } };

const initial = {
  contacts: useContactStore.getState(),
  calendar: useCalendarStore.getState(),
  tasks: useTaskStore.getState(),
};

describe('rows of a login that has no client any more', () => {
  let active: ReturnType<typeof makeClient>;
  const asClient = () => active as unknown as IJMAPClient;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    active = makeClient();
    // The auth store's lookup: login-a is the active login, login-b is gone.
    setClientLookup((id) => (id === 'login-a' ? asClient() : undefined));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useContactStore.setState(initial.contacts);
    useCalendarStore.setState(initial.calendar);
    useTaskStore.setState(initial.tasks);
    setClientLookup(() => undefined);
  });

  describe('contacts', () => {
    const card = {
      id: 'login-b::c', originalId: 'c', localAccountId: 'login-b', kind: 'individual',
      name: { full: 'B contact' }, addressBookIds: { 'login-b::b': true },
    } as unknown as ContactCard;
    const book = { id: 'login-b::b', originalId: 'b', localAccountId: 'login-b', name: 'B book' } as unknown as AddressBook;

    beforeEach(() => {
      useContactStore.setState({ contacts: [card], addressBooks: [book], supportsSync: true, selectedContactIds: new Set(['login-b::c']) } as never);
    });

    it('deleting its card does not delete the active login\'s card with the same id', async () => {
      await attempt(() => useContactStore.getState().deleteContact(asClient(), 'login-b::c'));
      expect(writes(active)).toEqual([]);
    });

    it('a bulk delete does not reach the active login', async () => {
      await attempt(() => useContactStore.getState().bulkDeleteContacts(asClient(), ['login-b::c']));
      expect(writes(active)).toEqual([]);
    });

    it('editing its card does not change the active login\'s card', async () => {
      await attempt(() => useContactStore.getState().updateContact(asClient(), 'login-b::c', { nickNames: { n: { name: 'x' } } } as never));
      expect(writes(active)).toEqual([]);
    });

    it('removing its address book does not remove the active login\'s', async () => {
      await attempt(() => useContactStore.getState().removeAddressBook(asClient(), book));
      expect(writes(active)).toEqual([]);
    });

    it('renaming or sharing its address book does not touch the active login\'s', async () => {
      await attempt(() => useContactStore.getState().renameAddressBook(asClient(), book, 'Renamed'));
      await attempt(() => useContactStore.getState().shareAddressBook(asClient(), book, 'p1', null));
      expect(writes(active)).toEqual([]);
    });

    it('a bulk delete across two logins deletes the connected login\'s card and keeps the other', async () => {
      const own = { id: 'login-a::c', originalId: 'c', localAccountId: 'login-a', kind: 'individual', name: { full: 'A contact' }, addressBookIds: {} } as unknown as ContactCard;
      useContactStore.setState({ contacts: [card, own] } as never);
      await attempt(() => useContactStore.getState().bulkDeleteContacts(asClient(), ['login-b::c', 'login-a::c']));
      expect(active.deleteContact).toHaveBeenCalledExactlyOnceWith('c', undefined);
      expect(useContactStore.getState().contacts.map((c) => c.id)).toEqual(['login-b::c']);
    });

    it('its cards and books leave the list when the login goes', () => {
      const own = { id: 'login-a::c', originalId: 'c', localAccountId: 'login-a', kind: 'individual', name: { full: 'A contact' }, addressBookIds: {} } as unknown as ContactCard;
      useContactStore.setState({ contacts: [card, own], selectedContactId: 'login-b::c' } as never);
      forgetLoginContacts('login-b');
      const state = useContactStore.getState();
      expect(state.contacts.map((c) => c.id)).toEqual(['login-a::c']);
      expect(state.addressBooks).toEqual([]);
      expect(state.selectedContactId).toBeNull();
      expect([...state.selectedContactIds]).toEqual([]);
    });
  });

  describe('calendar', () => {
    const calendar = { id: 'login-b::b', originalId: 'b', localAccountId: 'login-b', name: 'B calendar', isVisible: true } as unknown as Calendar;
    const event = {
      id: 'login-b::eaaaaab', originalId: 'eaaaaab', localAccountId: 'login-b', title: 'B meeting',
      calendarIds: { 'login-b::b': true }, start: '2026-11-12T10:00:00', duration: 'PT1H', timeZone: 'UTC',
    } as unknown as CalendarEvent;

    beforeEach(() => {
      useCalendarStore.setState({ calendars: [calendar], events: [event], selectedCalendarIds: ['login-b::b'] } as never);
    });

    it('deleting its event does not delete the active login\'s event with the same id', async () => {
      await attempt(() => useCalendarStore.getState().deleteEvent(asClient(), 'login-b::eaaaaab'));
      expect(writes(active)).toEqual([]);
    });

    it('changing its event does not change the active login\'s event', async () => {
      await attempt(() => useCalendarStore.getState().updateEvent(asClient(), 'login-b::eaaaaab', { title: 'moved' }));
      expect(writes(active)).toEqual([]);
    });

    it('deleting its calendar does not delete the active login\'s calendar with the same id', async () => {
      await attempt(() => useCalendarStore.getState().removeCalendar(asClient(), 'login-b::b'));
      expect(writes(active)).toEqual([]);
    });

    it('renaming, sharing or clearing its calendar does not touch the active login\'s', async () => {
      await attempt(() => useCalendarStore.getState().updateCalendar(asClient(), 'login-b::b', { name: 'Renamed' }));
      await attempt(() => useCalendarStore.getState().shareCalendar(asClient(), 'login-b::b', 'p1', null));
      await attempt(() => useCalendarStore.getState().clearCalendarEvents(asClient(), 'login-b::b'));
      expect(writes(active)).toEqual([]);
      expect(active.getCalendarEvents).not.toHaveBeenCalled();
    });

    it('an invitation reply for its event does not answer the active login\'s event', async () => {
      await attempt(() => useCalendarStore.getState().rsvpEvent(asClient(), 'login-b::eaaaaab', 'me', 'accepted'));
      expect(writes(active)).toEqual([]);
    });

    it('its calendars, events and client leave the store when the login goes', () => {
      const own = { id: 'login-a::b', originalId: 'b', localAccountId: 'login-a', name: 'A calendar', isVisible: true } as unknown as Calendar;
      useCalendarStore.setState({
        calendars: [calendar, own], selectedCalendarIds: ['login-b::b', 'login-a::b'], selectedEventId: 'login-b::eaaaaab',
        accountClients: [{ localAccountId: 'login-a', client: asClient() }, { localAccountId: 'login-b', client: asClient() }],
      } as never);
      forgetLoginCalendars('login-b');
      const state = useCalendarStore.getState();
      expect(state.calendars.map((c) => c.id)).toEqual(['login-a::b']);
      expect(state.events).toEqual([]);
      expect(state.selectedCalendarIds).toEqual(['login-a::b']);
      expect(state.selectedEventId).toBeNull();
      expect(state.accountClients?.map((a) => a.localAccountId)).toEqual(['login-a']);
    });
  });

  describe('tasks', () => {
    const task = { id: 'login-b::eaaaaab', localAccountId: 'login-b', title: 'B task', progress: 'needs-action', calendarIds: { 'login-b::b': true } } as unknown as CalendarTask;

    beforeEach(() => {
      useTaskStore.setState({ tasks: [task] } as never);
    });

    it('deleting its task does not delete the active login\'s task with the same id', async () => {
      await attempt(() => useTaskStore.getState().deleteTask(asClient(), 'login-b::eaaaaab'));
      expect(writes(active)).toEqual([]);
    });

    it('completing its task does not complete the active login\'s task', async () => {
      await attempt(() => useTaskStore.getState().toggleTaskComplete(asClient(), task));
      expect(writes(active)).toEqual([]);
    });

    it('its tasks leave the list when the login goes', () => {
      const own = { ...task, id: 'login-a::eaaaaab', localAccountId: 'login-a' } as CalendarTask;
      useTaskStore.setState({ tasks: [task, own], selectedTaskId: 'login-b::eaaaaab' } as never);
      forgetLoginTasks('login-b');
      expect(useTaskStore.getState().tasks.map((t) => t.id)).toEqual(['login-a::eaaaaab']);
      expect(useTaskStore.getState().selectedTaskId).toBeNull();
    });
  });
});

describe('removing a login that is not the active one', () => {
  const entry = (username: string, isDefault: boolean) => ({
    label: username, serverUrl: 'https://mail.example.org', username, authMode: 'basic' as const,
    rememberMe: false, displayName: username, email: username, lastLoginAt: 0,
    isConnected: true, hasError: false, isDefault,
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useContactStore.setState(initial.contacts);
    useCalendarStore.setState(initial.calendar);
    useTaskStore.setState(initial.tasks);
  });

  it('takes its cards, calendars, events and tasks off the lists at once', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
    const a = useAccountStore.getState().addAccount(entry('a@example.org', true));
    const b = useAccountStore.getState().addAccount(entry('b@example.org', false));
    useAccountStore.getState().setActiveAccount(a);
    useAuthStore.setState({ isAuthenticated: true, activeAccountId: a, client: makeClient() as never } as never);
    const row = (login: string, id: string) => ({ id: `${login}::${id}`, localAccountId: login });
    useContactStore.setState({
      contacts: [row(a, 'c'), row(b, 'c')],
      addressBooks: [row(b, 'b')],
    } as never);
    useCalendarStore.setState({
      calendars: [row(b, 'b')],
      events: [row(a, 'e'), row(b, 'e')],
      selectedCalendarIds: [`${b}::b`],
    } as never);
    useTaskStore.setState({ tasks: [row(b, 't')] } as never);

    useAuthStore.getState().removeAccount(b);

    expect(useContactStore.getState().contacts.map((c) => c.id)).toEqual([`${a}::c`]);
    expect(useContactStore.getState().addressBooks).toEqual([]);
    expect(useCalendarStore.getState().calendars).toEqual([]);
    expect(useCalendarStore.getState().events.map((e) => e.id)).toEqual([`${a}::e`]);
    expect(useCalendarStore.getState().selectedCalendarIds).toEqual([]);
    expect(useTaskStore.getState().tasks).toEqual([]);
  });
});
