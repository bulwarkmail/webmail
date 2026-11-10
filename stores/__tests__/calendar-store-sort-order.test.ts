import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useCalendarStore } from '../calendar-store';
import { useManagedAccountStore } from '../managed-account-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Calendar } from '@/lib/jmap/types';

function cal(overrides: Partial<Calendar>): Calendar {
  return {
    id: 'c', name: 'Cal', color: null, sortOrder: 0, isSubscribed: true, isVisible: true,
    isDefault: false, includeInAvailability: 'all', timeZone: null, shareWith: null,
    myRights: null,
    ...overrides,
  } as unknown as Calendar;
}

const names = () => useCalendarStore.getState().calendars.map((c) => c.name);

beforeEach(() => {
  useCalendarStore.setState({ calendars: [], selectedCalendarIds: [], error: null, accountClients: null, accountClientsActiveId: null });
  useManagedAccountStore.getState().clear();
});

describe('calendar order', () => {
  it('fetchCalendars lists the calendars by sortOrder, not in server order', async () => {
    const client = {
      getAllCalendarsWithFailures: vi.fn().mockResolvedValue({
        calendars: [
          cal({ id: 'b', name: 'Default', sortOrder: 20 }),
          cal({ id: 'n', name: 'Holidays', sortOrder: 30 }),
          cal({ id: 'e', name: 'Work', sortOrder: 1 }),
        ],
        failedAccountIds: [],
      }),
    } as unknown as IJMAPClient;

    await useCalendarStore.getState().fetchCalendars(client);

    expect(names()).toEqual(['Work', 'Default', 'Holidays']);
  });

  it('updateCalendar re-sorts when a calendar is renamed', async () => {
    useCalendarStore.setState({
      calendars: [cal({ id: 'a', name: 'Alpha' }), cal({ id: 'b', name: 'Beta' })],
    });
    const client = { updateCalendar: vi.fn().mockResolvedValue(undefined) } as unknown as IJMAPClient;

    await useCalendarStore.getState().updateCalendar(client, 'a', { name: 'Zulu' });

    expect(names()).toEqual(['Beta', 'Zulu']);
  });

  it('reorderCalendars writes only the sortOrders that change and re-sorts at once', async () => {
    useCalendarStore.setState({
      calendars: [
        cal({ id: 'a', name: 'A', sortOrder: 1 }),
        cal({ id: 'b', name: 'B', sortOrder: 2 }),
        cal({ id: 'c', name: 'C', sortOrder: 3 }),
      ],
    });
    const updateCalendar = vi.fn().mockResolvedValue(undefined);
    const client = { updateCalendar } as unknown as IJMAPClient;

    const done = useCalendarStore.getState().reorderCalendars(client, ['c', 'a', 'b']);
    // Optimistic: the new order shows before the server answers.
    expect(names()).toEqual(['C', 'A', 'B']);
    await done;

    expect(updateCalendar.mock.calls).toEqual([
      ['c', { sortOrder: 1 }, undefined],
      ['a', { sortOrder: 2 }, undefined],
      ['b', { sortOrder: 3 }, undefined],
    ]);
    expect(useCalendarStore.getState().calendars.map((c) => c.sortOrder)).toEqual([1, 2, 3]);
  });

  it('reorderCalendars sends shared-account calendars their raw id and account', async () => {
    useCalendarStore.setState({
      calendars: [
        cal({ id: 'x:a', originalId: 'a', name: 'A', sortOrder: 1, isShared: true, accountId: 'x' }),
        cal({ id: 'x:b', originalId: 'b', name: 'B', sortOrder: 2, isShared: true, accountId: 'x' }),
      ],
    });
    const updateCalendar = vi.fn().mockResolvedValue(undefined);

    await useCalendarStore.getState().reorderCalendars({ updateCalendar } as unknown as IJMAPClient, ['x:b', 'x:a']);

    expect(updateCalendar.mock.calls).toEqual([
      ['b', { sortOrder: 1 }, 'x'],
      ['a', { sortOrder: 2 }, 'x'],
    ]);
  });

  it('after a failed write, shows the order the server holds and rethrows', async () => {
    useCalendarStore.setState({
      calendars: [
        cal({ id: 'a', name: 'A', sortOrder: 1 }),
        cal({ id: 'b', name: 'B', sortOrder: 2 }),
        cal({ id: 'c', name: 'C', sortOrder: 3 }),
      ],
    });
    const updateCalendar = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('forbidden'));
    const client = { updateCalendar } as unknown as IJMAPClient;

    await expect(useCalendarStore.getState().reorderCalendars(client, ['c', 'a', 'b'])).rejects.toThrow('forbidden');

    // c got sortOrder 1 (saved), a kept 1, b kept 2: c and a tie, sorted by name.
    expect(useCalendarStore.getState().calendars.map((c) => [c.id, c.sortOrder])).toEqual([
      ['a', 1], ['c', 1], ['b', 2],
    ]);
    expect(useCalendarStore.getState().error).toBe('Failed to reorder calendars');
  });

  it('reorderCalendars does nothing when the order is unchanged', async () => {
    useCalendarStore.setState({ calendars: [cal({ id: 'a', sortOrder: 1 }), cal({ id: 'b', sortOrder: 2 })] });
    const updateCalendar = vi.fn();

    await useCalendarStore.getState().reorderCalendars({ updateCalendar } as unknown as IJMAPClient, ['a', 'b']);

    expect(updateCalendar).not.toHaveBeenCalled();
  });
});

describe('new calendars after a reorder', () => {
  it('createCalendar puts a new calendar after the reordered own calendars', async () => {
    useCalendarStore.setState({
      calendars: [
        cal({ id: 'a', name: 'A', sortOrder: 1 }),
        cal({ id: 'b', name: 'B', sortOrder: 2 }),
        cal({ id: 's', name: 'Shared', sortOrder: 9, isShared: true, accountId: 'other' }),
      ],
    });
    const createCalendar = vi.fn(async (c: Partial<Calendar>) => cal({ ...c, id: 'n' }));
    const client = { createCalendar, getAccountId: () => 'primary' } as unknown as IJMAPClient;

    await useCalendarStore.getState().createCalendar(client, { name: 'Aardvark' });

    expect(createCalendar.mock.calls[0][0]).toMatchObject({ name: 'Aardvark', sortOrder: 3 });
    expect(names()).toEqual(['A', 'B', 'Aardvark', 'Shared']);
  });

  it('createCalendar leaves sortOrder unset while nothing was reordered', async () => {
    useCalendarStore.setState({ calendars: [cal({ id: 'a', name: 'A' })] });
    const createCalendar = vi.fn(async (c: Partial<Calendar>) => cal({ ...c, id: 'n' }));
    const client = { createCalendar, getAccountId: () => 'primary' } as unknown as IJMAPClient;

    await useCalendarStore.getState().createCalendar(client, { name: 'B' });

    expect(createCalendar.mock.calls[0][0]).not.toHaveProperty('sortOrder');
  });
});

describe('createCalendar with managed account', () => {
  it('uses managedAccountId as targetAccountId when set', async () => {
    useManagedAccountStore.getState().setManagedAccount({
      id: 'group-1',
      name: 'Sales',
      isPrimary: false,
      capabilities: { mail: true, sieve: true, calendars: true, contacts: true, filenode: false },
    } as any);

    const createCalendar = vi.fn(async (c: Partial<Calendar>, targetAccountId?: string) => {
      expect(targetAccountId).toBe('group-1');
      return cal({ ...c, id: 'n', isShared: true });
    });
    const client = { createCalendar, getAccountId: () => 'primary' } as unknown as IJMAPClient;

    await useCalendarStore.getState().createCalendar(client, { name: 'Managed Cal' }, undefined, 'group-1');

    expect(createCalendar).toHaveBeenCalledTimes(1);
  });

  it('returns calendar with correct accountId, localAccountId, isShared', async () => {
    useManagedAccountStore.getState().setManagedAccount({
      id: 'group-1',
      name: 'Sales',
      isPrimary: false,
      capabilities: { mail: true, sieve: true, calendars: true, contacts: true, filenode: false },
    } as any);

    // Debug: verify managed account is set
    console.log('Managed account ID:', useManagedAccountStore.getState().managedAccountId);

    const createCalendar = vi.fn(async (c: Partial<Calendar>, targetAccountId?: string) => {
      expect(targetAccountId).toBe('group-1');
      return cal({ ...c, id: 'n', isShared: true });
    });
    const client = { createCalendar, getAccountId: () => 'primary' } as unknown as IJMAPClient;

    // Pass the managed account ID as targetAccountId
    const created = await useCalendarStore.getState().createCalendar(client, { name: 'Managed Cal' }, undefined, 'group-1');

    console.log('Created calendar:', created);

    expect(created).not.toBeNull();
    expect(created!.accountId).toBe('group-1');
    expect(created!.localAccountId).toBeUndefined();
    expect(created!.isShared).toBe(true);
    expect(created!.originalId).toBe('n');
  });

  it('falls back to single-account mode when no managed account', async () => {
    useManagedAccountStore.getState().clear();

    const createCalendar = vi.fn(async (c: Partial<Calendar>, targetAccountId?: string) => {
      expect(targetAccountId).toBe('primary');
      return cal({ ...c, id: 'n', isShared: false });
    });
    const client = { createCalendar, getAccountId: () => 'primary' } as unknown as IJMAPClient;

    const created = await useCalendarStore.getState().createCalendar(client, { name: 'Own Cal' });

    console.log('Single-account created:', created);

    expect(created).not.toBeNull();
    expect(created!.accountId).toBe('primary');
    expect(created!.localAccountId).toBeUndefined();
    expect(created!.isShared).toBe(false);
  });
});
