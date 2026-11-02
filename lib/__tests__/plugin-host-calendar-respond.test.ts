import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';
import type { IJMAPClient } from '../jmap/client-interface';
import type { CalendarEvent } from '../jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useVacationStore } from '@/stores/vacation-store';
import { clearUndoTokens } from '../plugin-sandbox/assistant/c.undo';

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { dispatchApiCall } from '../plugin-sandbox/host-api';

function plugin(id: string, perms: string[]): InstalledPlugin {
  return {
    id, name: id, version: '1.0.0', author: 'test', description: '',
    type: 'hook', permissions: perms, grantedPermissions: perms, entrypoint: 'index.js',
    enabled: true, status: 'running', settings: {},
  };
}
const ASSISTANT = plugin('assistant', ['calendar:respond', 'calendar:write', 'vacation:read']);
const call = (p: InstalledPlugin, method: string, ...args: unknown[]) => dispatchApiCall(p, method, args);

const alice = { email: 'alice@example.org', name: 'Alice', roles: { owner: true } };
const bob = { email: 'bob@example.org', name: 'Bob', roles: { attendee: true }, participationStatus: 'needs-action' };
const invitation = {
  id: 'inv', subject: 'Invitation: Team offsite', from: [{ email: 'alice@example.org', name: 'Alice' }],
  attachments: [{ blobId: 'ics1', name: 'invite.ics', type: 'text/calendar', size: 100 }],
  textBody: [], htmlBody: [],
};
let parsed: Partial<CalendarEvent>;
let client: IJMAPClient;
const store = { rsvpEvent: vi.fn(async () => true), importEvents: vi.fn(async () => 1), deleteEvent: vi.fn(async () => true), createEvent: vi.fn(async () => ({ id: 'again' })) };

beforeEach(() => {
  clearUndoTokens();
  for (const fn of Object.values(store)) fn.mockClear();
  parsed = {
    uid: 'u1', title: 'Team offsite', start: '2026-11-20T09:00:00',
    organizerCalendarAddress: 'mailto:alice@example.org', participants: { p1: alice, p2: bob } as never,
  };
  client = {
    getAccountId: () => 'acc1',
    getEmail: vi.fn(async (id: string) => (id === 'inv' ? invitation : null)),
    parseCalendarEvents: vi.fn(async () => [parsed]),
    fetchBlob: vi.fn(async () => new Blob(['BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR'])),
    queryCalendarEvents: vi.fn(async () => []),
    getCalendarEvent: vi.fn(async () => null),
    supportsVacationResponse: () => true,
  } as unknown as IJMAPClient;
  useAuthStore.setState({ client, primaryIdentity: { email: 'bob@example.org' }, identities: [] } as never);
  useEmailStore.setState({ emails: [], selectedEmail: null } as never);
  useSettingsStore.setState({ calendarInvitationParsingEnabled: true } as never);
  const imported = { id: 'e-new', uid: 'u1', participants: { p1: alice, p2: bob } };
  useCalendarStore.setState({
    supportsCalendar: true, calendars: [{ id: 'cal1', isDefault: true }], events: [],
    ...store,
    importEvents: vi.fn(async () => { useCalendarStore.setState({ events: [imported] } as never); return 1; }),
  } as never);
});
afterEach(() => {
  useAuthStore.setState({ client: null });
});

describe('api.calendar.respond', () => {
  it('answers the invitation the way the banner does, so the server replies to the organiser', async () => {
    const out = await call(ASSISTANT, 'calendar.respond', 'inv', 'accepted');
    expect(out).toEqual({ status: 'accepted', title: 'Team offsite', start: '2026-11-20T09:00:00', organizer: 'alice@example.org' });
    expect(useCalendarStore.getState().importEvents).toHaveBeenCalledWith(client, [parsed], 'cal1', { throwIfNoneImported: true });
    expect(store.rsvpEvent).toHaveBeenCalledWith(client, 'e-new', 'p2', 'accepted', { imip: 'mailto:alice@example.org' });
  });

  it('refuses an event the user organises, a message that asks no answer, and while invitations are off', async () => {
    // The user's own invitation, sent from their own address.
    vi.mocked(client.getEmail).mockResolvedValueOnce({ ...invitation, from: [{ email: 'bob@example.org', name: 'Bob' }] } as never);
    parsed.participants = { p1: { ...alice, email: 'bob@example.org' } } as never;
    await expect(call(ASSISTANT, 'calendar.respond', 'inv', 'accepted')).rejects.toThrow(/organises/);
    // Someone else's event whose sender doesn't match its organiser.
    vi.mocked(client.getEmail).mockResolvedValueOnce({ ...invitation, from: [{ email: 'mallory@evil.example', name: 'Alice' }] } as never);
    parsed.participants = { p1: alice, p2: bob } as never;
    await expect(call(ASSISTANT, 'calendar.respond', 'inv', 'accepted')).rejects.toThrow(/may not come from/);
    parsed.participants = { p1: alice, p2: bob } as never;
    parsed.status = 'cancelled';
    vi.mocked(client.fetchBlob).mockResolvedValue(new Blob(['METHOD:CANCEL']));
    await expect(call(ASSISTANT, 'calendar.respond', 'inv', 'accepted')).rejects.toThrow(/not an invitation that asks for an answer/);
    useSettingsStore.setState({ calendarInvitationParsingEnabled: false } as never);
    await expect(call(ASSISTANT, 'calendar.respond', 'inv', 'accepted')).rejects.toThrow(/switched off/);
    expect(store.rsvpEvent).not.toHaveBeenCalled();
  });

  it('answers a message the list names with the account of the user', async () => {
    // Search results carry their account, the user's own one included.
    useEmailStore.setState({ emails: [{ id: 'inv', sourceClientAccountId: 'login1', sourceAccountId: 'acc1' }] } as never);
    useAuthStore.setState({ getClientForAccount: () => client } as never);
    await expect(call(ASSISTANT, 'calendar.respond', 'inv', 'accepted')).resolves.toMatchObject({ status: 'accepted' });
  });

  it('refuses mail of another account, a bad status and plugins without calendar:respond', async () => {
    useEmailStore.setState({ emails: [{ id: 'inv', sourceClientAccountId: 'login1', sourceAccountId: 'acc2' }] } as never);
    useAuthStore.setState({ getClientForAccount: () => client } as never);
    await expect(call(ASSISTANT, 'calendar.respond', 'inv', 'accepted')).rejects.toThrow(/other accounts/);
    await expect(call(ASSISTANT, 'calendar.respond', 'inv', 'delegated')).rejects.toThrow(/status must be/);
    await expect(call(plugin('cal', ['calendar:write']), 'calendar.respond', 'inv', 'accepted')).rejects.toThrow(/lacks permission "calendar:respond"/);
    expect(store.rsvpEvent).not.toHaveBeenCalled();
  });
});

describe('api.calendar.deleteEvent and undoDelete', () => {
  it('deletes a single event and puts the host\'s copy back with the same uid', async () => {
    vi.mocked(client.getCalendarEvent).mockResolvedValue({ id: 'e1', uid: 'u9', title: 'Dentist', start: '2026-11-03T10:00:00', calendarIds: { cal1: true }, utcStart: 'x' } as never);
    const { undoToken } = await call(ASSISTANT, 'calendar.deleteEvent', 'e1') as { undoToken: string };
    expect(store.deleteEvent).toHaveBeenCalledWith(client, 'e1', false);
    await expect(call(plugin('other', ['calendar:write']), 'calendar.undoDelete', undoToken)).rejects.toThrow(/can't be undone/);
    expect(await call(ASSISTANT, 'calendar.undoDelete', undoToken)).toEqual({ id: 'again' });
    expect(store.createEvent).toHaveBeenCalledWith(client, { uid: 'u9', title: 'Dentist', start: '2026-11-03T10:00:00', calendarIds: { cal1: true } }, false);
  });

  it('gives no token for a repeating event, and takes no copy from the plugin', async () => {
    vi.mocked(client.getCalendarEvent).mockResolvedValue({ id: 'e2', uid: 'u2', recurrenceRules: [{ frequency: 'weekly' }] } as never);
    expect(await call(ASSISTANT, 'calendar.deleteEvent', 'e2')).toEqual({ undoToken: null });
    await expect(call(ASSISTANT, 'calendar.undoDelete', { uid: 'u2', title: 'Fake' })).rejects.toThrow(/undoToken must be a string/);
    expect(store.createEvent).not.toHaveBeenCalled();
  });
});

describe('api.vacation.get', () => {
  it('says whether the out-of-office forwards mail', async () => {
    const fetch = vi.fn(async () => { useVacationStore.setState({ isEnabled: false, forward: { enabled: true, to: 'x@example.com' }, error: null } as never); });
    useVacationStore.setState({ fetchVacationResponse: fetch } as never);
    expect(await call(ASSISTANT, 'vacation.get')).toMatchObject({ isEnabled: false, forwardActive: true });
    useVacationStore.setState({ fetchVacationResponse: vi.fn(async () => { useVacationStore.setState({ forward: null } as never); }) } as never);
    expect(await call(ASSISTANT, 'vacation.get')).toMatchObject({ forwardActive: false });
  });
});
