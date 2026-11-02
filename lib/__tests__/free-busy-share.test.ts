import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyAdminFreeBusyShare, ensureFreeBusyShare, freeBusyShareGroups, groupPrincipalId, resetAppliedFreeBusyShares,
} from '../free-busy-share';
import { CALENDAR_PRESETS } from '@/lib/jmap/share-rights';
import type { Calendar, CalendarRights } from '@/lib/jmap/types';

const READ = CALENDAR_PRESETS.read;
const CAPS = { mail: true, sieve: true, calendars: true, contacts: true, filenode: true };
const NO_FREE_BUSY: CalendarRights = { ...CALENDAR_PRESETS.read, mayReadFreeBusy: false, mayReadItems: false, mayRSVP: true };

function calendar(id: string, extra: Partial<Calendar> = {}): Calendar {
  return { id, name: id, isDefault: false, shareWith: null, ...extra } as Calendar;
}

function fakeClient(calendars: Calendar[], options: { groupAccount?: boolean; directory?: string | null } = {}) {
  const setCalendarShare = vi.fn(async () => {});
  const client = {
    getAccountId: () => 'alice',
    getSharedAccounts: () => [
      { id: 'alice', name: 'alice@example.org', isPrimary: true, capabilities: CAPS },
      ...(options.groupAccount === false ? [] : [{ id: 'team', name: 'Team@example.org', isPrimary: false, capabilities: CAPS }]),
      { id: 'bob', name: 'bob@example.org', isPrimary: false, capabilities: CAPS },
    ],
    getAccountInfo: (id: string) => ({ name: id, isPersonal: id === 'alice' || id === 'bob', isReadOnly: false, accountCapabilities: {} }),
    findPrincipalByEmail: vi.fn(async () => ({
      principal: options.directory ? { id: options.directory, type: 'group' as const, name: 'staff' } : null,
      status: 'ok' as const,
    })),
    getAllCalendars: vi.fn(async () => calendars),
    setCalendarShare,
  };
  return { client, setCalendarShare };
}

describe('ensureFreeBusyShare', () => {
  it('shares only free/busy of the default calendar with the group, leaving other shares alone', async () => {
    const { client, setCalendarShare } = fakeClient([
      calendar('b', { isDefault: false }),
      calendar('a', { isDefault: true, shareWith: { bob: READ } }),
      calendar('team:x', { isDefault: true, isShared: true }),
    ]);
    expect(await ensureFreeBusyShare(client, 'team@example.org')).toBe('shared');
    // One shareWith/<id> patch: the share with bob isn't rewritten.
    expect(setCalendarShare).toHaveBeenCalledTimes(1);
    expect(setCalendarShare).toHaveBeenCalledWith('a', 'team', CALENDAR_PRESETS.freeBusy);
  });

  it('writes nothing when the group can see the free/busy already', async () => {
    const { client, setCalendarShare } = fakeClient([calendar('a', { isDefault: true, shareWith: { team: READ } })]);
    expect(await ensureFreeBusyShare(client, 'team@example.org')).toBe('already');
    expect(setCalendarShare).not.toHaveBeenCalled();
  });

  it('adds free/busy to a share of the group that lacked it, keeping its other rights', async () => {
    const { client, setCalendarShare } = fakeClient([calendar('a', { isDefault: true, shareWith: { team: NO_FREE_BUSY } })]);
    expect(await ensureFreeBusyShare(client, 'team@example.org')).toBe('shared');
    expect(setCalendarShare).toHaveBeenCalledWith('a', 'team', { ...NO_FREE_BUSY, mayReadFreeBusy: true });
  });

  it('looks the group up in the directory when it is no account of the user', async () => {
    const { client, setCalendarShare } = fakeClient([calendar('a', { isDefault: true })], { directory: 'staff' });
    expect(await ensureFreeBusyShare(client, 'staff@example.org')).toBe('shared');
    expect(setCalendarShare).toHaveBeenCalledWith('a', 'staff', CALENDAR_PRESETS.freeBusy);
  });

  it('does nothing for an unknown group or without a calendar of the user', async () => {
    const unknown = fakeClient([calendar('a', { isDefault: true })], { directory: null });
    expect(await ensureFreeBusyShare(unknown.client, 'nobody@example.org')).toBe('no-group');
    const none = fakeClient([calendar('team:x', { isShared: true })]);
    expect(await ensureFreeBusyShare(none.client, 'team@example.org')).toBe('no-calendar');
    expect(unknown.setCalendarShare).not.toHaveBeenCalled();
    expect(none.setCalendarShare).not.toHaveBeenCalled();
  });

  it('never shares with a directory entry that is no group', async () => {
    const { client, setCalendarShare } = fakeClient([calendar('a', { isDefault: true })], { groupAccount: false });
    client.findPrincipalByEmail.mockResolvedValue({ principal: { id: 'p', name: 'x' } as never, status: 'ok' });
    expect(await ensureFreeBusyShare(client, 'person@example.org')).toBe('no-group');
    client.findPrincipalByEmail.mockResolvedValue({ principal: { id: 'p', type: 'individual', name: 'x' } as never, status: 'ok' });
    expect(await ensureFreeBusyShare(client, 'person@example.org')).toBe('no-group');
    expect(setCalendarShare).not.toHaveBeenCalled();
  });

  it('never takes a person\'s shared account for the group', async () => {
    const { client } = fakeClient([], { groupAccount: false, directory: null });
    expect(await groupPrincipalId(client, 'bob@example.org')).toBeNull();
  });
});

describe('applyAdminFreeBusyShare', () => {
  beforeEach(() => resetAppliedFreeBusyShares());

  it('applies once per page load and account, and again after a failure', async () => {
    const { client, setCalendarShare } = fakeClient([calendar('a', { isDefault: true })]);
    setCalendarShare.mockRejectedValueOnce(new Error('down'));
    expect(await applyAdminFreeBusyShare(client, 'team@example.org')).toBeNull();
    expect(await applyAdminFreeBusyShare(client, 'team@example.org')).toBe('shared');
    expect(await applyAdminFreeBusyShare(client, 'team@example.org')).toBeNull();
    expect(setCalendarShare).toHaveBeenCalledTimes(2);
  });

  it('does nothing without a group', async () => {
    const { client, setCalendarShare } = fakeClient([calendar('a', { isDefault: true })]);
    expect(await applyAdminFreeBusyShare(client, '')).toBeNull();
    expect(setCalendarShare).not.toHaveBeenCalled();
  });
});

describe('freeBusyShareGroups', () => {
  it('offers the admin group, else the group accounts of the session', () => {
    const { client } = fakeClient([]);
    expect(freeBusyShareGroups(client, 'Staff@example.org')).toEqual(['staff@example.org']);
    expect(freeBusyShareGroups(client, '')).toEqual(['team@example.org']);
  });
});
