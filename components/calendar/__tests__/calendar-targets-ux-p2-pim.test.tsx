import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventModal } from '../event-modal';
import { TaskModal } from '../task-modal';
import { QuickCreatePopover } from '../quick-create-popover';
import { ICalImportModal } from '../ical-import-modal';
import { CalendarSidebarPanel } from '../calendar-sidebar-panel';
import { EventContextMenu } from '../event-context-menu';
import { useAccountStore } from '@/stores/account-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useTaskStore } from '@/stores/task-store';
import { buildCopyToCalendarData, copyTargetsFor, distinctAccountDefaultColors } from '@/lib/calendar-targets';
import type { AddressBook, Calendar, CalendarEvent } from '@/lib/jmap/types';
import { ContactForm } from '@/components/contacts/contact-form';
import { AddressBookPickerDialog } from '@/components/contacts/address-book-picker-dialog';

// Usability pass 2, pim-p2-2, p2-3, p2-4, p2-13 and p2-16: with two accounts
// (A and B, both signed in) the calendar choosers were one flat list by
// display name, offered A's task-only "To-do" for events, and preselected
// A's calendar while B was on screen.

vi.mock('../participant-availability', () => ({ ParticipantAvailability: () => null }));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const rights = {
  mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayWriteOwn: true,
  mayUpdatePrivate: true, mayRSVP: true, mayShare: true, mayDelete: true,
};
function cal(id: string, name: string, login: string, extra: Partial<Calendar> = {}): Calendar {
  return {
    id: `${login}::${id}`, originalId: id, name, color: '#3b82f6', isDefault: false, isVisible: true, sortOrder: 0,
    myRights: rights, localAccountId: login, ...extra,
  } as unknown as Calendar;
}
const aDefault = cal('d', 'Stalwart Calendar (pim@example.org)', 'login-a', { isDefault: true });
const aWork = cal('w', 'Work', 'login-a');
const aTodo = cal('t', 'To-do', 'login-a', { isTasksOnly: true });
const bDefault = cal('d', 'Stalwart Calendar (pim-b@example.org)', 'login-b', { isDefault: true });
const calendars = [aDefault, aWork, aTodo, bDefault];

beforeEach(() => {
  useAccountStore.setState({
    accounts: [
      { id: 'login-a', email: 'pim@example.org', username: 'pim@example.org', displayName: 'Pim Audit', label: 'Pim Audit' },
      { id: 'login-b', email: 'pim-b@example.org', username: 'pim-b@example.org', displayName: 'Pim Audit', label: 'Pim Audit' },
    ] as never,
    activeAccountId: 'login-b',
  });
  useCalendarStore.setState({ lastEventCalendarIds: {} });
  useTaskStore.setState({ tasks: [] } as never);
});

afterEach(() => {
  useAccountStore.setState({ accounts: [], activeAccountId: null });
});

function groupsOf(select: HTMLElement): Array<{ label: string; options: string[] }> {
  return Array.from(select.querySelectorAll('optgroup')).map((g) => ({
    label: g.getAttribute('label') ?? '',
    options: Array.from(g.querySelectorAll('option')).map((o) => o.textContent ?? ''),
  }));
}

const editorSelect = () => document.querySelector('select[id$="calendar_select"]') as HTMLSelectElement;

describe('event editor (pim-p2-2, p2-3, p2-4)', () => {
  it("offers no task list, groups by account address, and starts in the active account's default calendar", () => {
    render(<EventModal calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} currentUserEmails={['pim-b@example.org']} />);
    const select = editorSelect();
    expect(groupsOf(select)).toEqual([
      { label: 'pim-b@example.org', options: ['default_calendar'] },
      { label: 'pim@example.org', options: ['default_calendar', 'Work'] },
    ]);
    expect(select.value).toBe(bDefault.id);
  });

  it('starts in the calendar last picked in that account', () => {
    useAccountStore.setState({ activeAccountId: 'login-a' });
    useCalendarStore.setState({ lastEventCalendarIds: { 'login-a': aWork.id } });
    render(<EventModal calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} currentUserEmails={['pim@example.org']} />);
    expect(editorSelect().value).toBe(aWork.id);
  });

  it('keeps the one task list an existing event already sits in, and says so', () => {
    const event = {
      id: 'e1', uid: 'u1', '@type': 'Event', title: 'Lost', description: '', start: '2026-11-05T07:00:00',
      duration: 'PT1H', timeZone: 'Europe/Berlin', showWithoutTime: false, calendarIds: { [aTodo.id]: true },
      participants: null, alerts: null, recurrenceRules: null, localAccountId: 'login-a',
    } as unknown as CalendarEvent;
    render(<EventModal event={event} calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} currentUserEmails={['pim@example.org']} />);
    fireEvent.click(screen.getByText('events.edit'));
    const names = within(editorSelect()).getAllByRole('option').map((o) => o.textContent);
    expect(names).toEqual(['default_calendar', 'Work', 'task_list_not_in_calendar']);
  });
});

describe('quick create (pim-p2-3)', () => {
  it('groups the calendars by account address', () => {
    render(
      <QuickCreatePopover
        draft={{ start: new Date(2026, 10, 5, 9), end: new Date(2026, 10, 5, 10), title: '', allDay: false, calendarId: bDefault.id }}
        calendars={[aDefault, aWork, bDefault]}
        onChange={vi.fn()} onSave={vi.fn()} onMoreOptions={vi.fn()} onClose={vi.fn()}
      />,
    );
    expect(groupsOf(screen.getByLabelText('form.calendar_select')).map((g) => g.label)).toEqual(['pim-b@example.org', 'pim@example.org']);
  });
});

describe('import (pim-p2-2, p2-4)', () => {
  it("leaves the task list out and preselects the active account's calendar", async () => {
    const client = {
      getServerUrl: () => 'https://mail.example.org',
      getCalendarsAccountId: () => 'acc',
      uploadBlob: vi.fn(async () => ({ blobId: 'blob-1' })),
      parseCalendarEvents: vi.fn(async () => [{ title: 'Standup', start: '2026-11-03T09:00:00' }]),
    };
    const file = new File(['BEGIN:VCALENDAR'], 'invite.ics', { type: 'text/calendar' });
    render(<ICalImportModal calendars={calendars} client={client as never} onClose={vi.fn()} initialFile={file} />);
    await screen.findByText('Standup');
    const select = screen.getByLabelText('target_calendar') as HTMLSelectElement;
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).not.toContain('To-do');
    expect(select.value).toBe(bDefault.id);
  });
});

describe('task editor (pim-p2-13)', () => {
  it('is labelled List and offers task lists only, grouped by account', () => {
    const bTodo = cal('t', 'Errands', 'login-b', { isTasksOnly: true });
    render(<TaskModal calendars={[...calendars, bTodo]} onSave={vi.fn()} onClose={vi.fn()} />);
    const select = screen.getByLabelText('task_list_label') as HTMLSelectElement;
    expect(groupsOf(select)).toEqual([
      { label: 'pim-b@example.org', options: ['Errands'] },
      { label: 'pim@example.org', options: ['To-do'] },
    ]);
    // A new task goes to the account on screen.
    expect(select.value).toBe(bTodo.id);
  });
});

describe('sidebar (pim-p2-3)', () => {
  it("heads each account's group with its address, not the shared display name", () => {
    useCalendarStore.setState({ viewMode: 'week' } as never);
    render(<CalendarSidebarPanel calendars={calendars} selectedCalendarIds={[]} onToggleVisibility={() => {}} multiAccountMode />);
    expect(screen.getAllByTestId('calendar-account-group').map((el) => el.textContent)).toEqual(['pim-b@example.org', 'pim@example.org']);
  });

  it("gives the second account's default calendar a colour of its own", () => {
    const shown = distinctAccountDefaultColors(calendars);
    const a = shown.find((c) => c.id === aDefault.id)!;
    const b = shown.find((c) => c.id === bDefault.id)!;
    expect(a.color).toBe('#3b82f6');
    expect(b.color).not.toBe(a.color);
    // Nothing changes with one account.
    expect(distinctAccountDefaultColors([aDefault, aWork])).toEqual([aDefault, aWork]);
  });
});

describe('copy to the other account (pim-p2-16)', () => {
  const event = {
    id: 'login-b::e1', originalId: 'e1', uid: 'u1', '@type': 'Event', title: 'Dentist', description: 'Bring card',
    start: '2026-11-05T07:00:00', duration: 'PT1H', timeZone: 'Europe/Berlin', showWithoutTime: false,
    calendarIds: { [bDefault.id]: true }, localAccountId: 'login-b', status: 'confirmed', freeBusyStatus: 'busy', privacy: 'public',
    participants: { p1: { calendarAddress: 'mailto:pim-b@example.org', roles: { owner: true } } },
    alerts: null, recurrenceRules: null,
  } as unknown as CalendarEvent;

  it('offers the other account by address, into its default calendar', () => {
    const targets = copyTargetsFor(event, [aDefault, aWork, bDefault], useAccountStore.getState().accounts);
    expect(targets.map((x) => [x.account.email, x.calendar.id])).toEqual([['pim@example.org', aDefault.id]]);
  });

  it('copies the same time into the target calendar without its participants', () => {
    const data = buildCopyToCalendarData(event, aDefault.id);
    expect(data).toMatchObject({ title: 'Dentist', start: '2026-11-05T07:00:00', duration: 'PT1H', timeZone: 'Europe/Berlin', calendarIds: { [aDefault.id]: true } });
    expect(data.uid).not.toBe('u1');
    expect(data.participants).toBeUndefined();
  });

  it('shows "Copy to <address>" in the event menu', () => {
    const onCopy = vi.fn();
    const menuRef = { current: null };
    render(
      <EventContextMenu
        event={event} position={{ x: 10, y: 10 }} isOpen onClose={vi.fn()} menuRef={menuRef}
        onEdit={vi.fn()} onDuplicate={vi.fn()} onExportICS={vi.fn()} onCopyTitle={vi.fn()} onDelete={vi.fn()}
        copyTo={[{ address: 'pim@example.org', onCopy }]}
      />,
    );
    act(() => { fireEvent.click(screen.getByText('copy_to_account')); });
    expect(onCopy).toHaveBeenCalledTimes(1);
  });
});

describe('remembering the last calendar (pim-p2-4)', () => {
  it('keeps each account its own pick across an account switch', () => {
    useCalendarStore.getState().rememberEventCalendar(aWork);
    useCalendarStore.getState().clearState();
    expect(useCalendarStore.getState().lastEventCalendarIds).toEqual({ 'login-a': aWork.id });
  });
});

describe('address book choosers (pim-p2-3)', () => {
  const books = [
    { id: 'login-a::ab', name: 'Stalwart Address Book (pim@example.org)', isDefault: true, localAccountId: 'login-a', myRights: { mayWrite: true } },
    { id: 'login-b::ab', name: 'Stalwart Address Book (pim-b@example.org)', isDefault: true, localAccountId: 'login-b', myRights: { mayWrite: true } },
  ] as unknown as AddressBook[];

  it('groups the contact form\'s address books by account address', () => {
    render(<ContactForm addressBooks={books} onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(groupsOf(screen.getByLabelText('section_address_book')).map((g) => g.label)).toEqual(['pim-b@example.org', 'pim@example.org']);
  });

  it('heads the Move to picker with each account address', () => {
    render(<AddressBookPickerDialog isOpen onClose={vi.fn()} addressBooks={books} count={1} onPick={vi.fn()} />);
    expect(screen.getAllByTestId('address-book-account').map((el) => el.textContent)).toEqual(['pim-b@example.org', 'pim@example.org']);
  });
});
