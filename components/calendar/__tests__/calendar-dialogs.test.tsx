import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { Calendar } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// The event editor opened with the focus on its close button, so typing
// went nowhere; the import, subscription and new-calendar dialogs were
// hand-rolled: Escape only worked from some places and no focus handling.

vi.mock('../participant-availability', () => ({ ParticipantAvailability: () => null }));

import { EventModal } from '../event-modal';
import { ICalImportModal } from '../ical-import-modal';
import { ICalSubscriptionModal } from '../ical-subscription-modal';
import { CreateCalendarModal } from '../create-calendar-modal';

const calendars = [{
  id: 'cal', name: 'Personal', color: '#123456', isDefault: true,
  myRights: { mayReadItems: true, mayWriteAll: true, mayWriteOwn: true, mayDelete: true },
}] as unknown as Calendar[];
const client = { getAccountId: () => 'acct' } as unknown as IJMAPClient;

describe('calendar dialogs', () => {
  it('opens a new event with the cursor in Title', () => {
    render(<EventModal calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByPlaceholderText('form.title'));
  });

  it('closes the import dialog with Escape, wherever the focus is', () => {
    const onClose = vi.fn();
    render(<ICalImportModal calendars={calendars} client={client} onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: 'title' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('opens the subscription dialog in the address field, with a named close button', () => {
    const onClose = vi.fn();
    render(<ICalSubscriptionModal client={client} onClose={onClose} />);
    expect(document.activeElement).toBe(screen.getByLabelText('url_label'));
    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('opens the new-calendar dialog in the name field and keeps typed input on an outside click', () => {
    const onClose = vi.fn();
    render(<CreateCalendarModal client={client} onClose={onClose} />);
    const name = screen.getByLabelText('name');
    expect(document.activeElement).toBe(name);
    fireEvent.change(name, { target: { value: 'Gym' } });
    const backdrop = screen.getByRole('dialog').parentElement!;
    fireEvent.mouseDown(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('import dialog from the keyboard', () => {
  it('lets the keyboard reach the file drop zone', () => {
    render(<ICalImportModal calendars={calendars} client={client} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: /select_file/ })).toBeInTheDocument();
  });

  // It focused the hidden file input, which can't take the focus, so the
  // focus stayed on the page behind and Tab walked the calendar.
  it('opens with the focus on the drop zone, or on the address field for a link', () => {
    const { unmount } = render(<ICalImportModal calendars={calendars} client={client} onClose={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /select_file/ }));
    unmount();
    render(<ICalImportModal calendars={calendars} client={client} onClose={vi.fn()} initialUrl="https://example.com/a.ics" />);
    expect(document.activeElement).toBe(screen.getByLabelText('tab_url'));
  });
});

describe('import preview', () => {
  it('names a repeating event\'s rule in the app language', async () => {
    const weekly = { title: 'Gym', start: '2026-10-12T18:00:00', duration: 'PT1H', recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly', interval: 1 }] };
    const parsing = {
      getAccountId: () => 'acct',
      getCalendarsAccountId: () => 'acct',
      getServerUrl: () => 'https://mail.example.com',
      uploadBlob: vi.fn().mockResolvedValue({ blobId: 'b1' }),
      parseCalendarEvents: vi.fn().mockResolvedValue([weekly]),
    } as unknown as IJMAPClient;
    render(<ICalImportModal calendars={calendars} client={parsing} onClose={vi.fn()} />);
    const file = new File(['BEGIN:VCALENDAR'], 'gym.ics', { type: 'text/calendar' });
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });
    expect(await screen.findByText('Gym')).toBeInTheDocument();
    expect(screen.queryByText('weekly')).toBeNull();
    expect(screen.getByText('recurrence.weekly')).toBeInTheDocument();
  });
});

describe('invitation view', () => {
  it('shows an invitation with the same details as any event: maps link, meeting link, menu and answers', () => {
    const shared = [{
      id: 'team', name: 'Team', color: '#123456',
      myRights: { mayReadItems: true, mayWriteAll: false, mayWriteOwn: false, mayRSVP: true, mayDelete: false },
    }] as unknown as Calendar[];
    const invite = {
      id: 'i1', uid: 'u1', '@type': 'Event', title: 'Planning', start: '2026-10-12T10:00:00', duration: 'PT1H',
      showWithoutTime: false, calendarIds: { team: true },
      description: 'Join: https://teams.microsoft.com/l/meetup-join/abc',
      locations: { l: { '@type': 'Location', name: 'Main St 1, Berlin' } },
      organizerCalendarAddress: 'mailto:boss@example.org',
      participants: {
        boss: { '@type': 'Participant', calendarAddress: 'mailto:boss@example.org', roles: { owner: true }, participationStatus: 'accepted' },
        me: { '@type': 'Participant', calendarAddress: 'mailto:me@example.com', roles: { attendee: true }, participationStatus: 'needs-action' },
      },
    } as unknown as import('@/lib/jmap/types').CalendarEvent;
    render(
      <EventModal event={invite} calendars={shared} onSave={vi.fn()} onClose={vi.fn()} onRsvp={vi.fn()} onMore={vi.fn()}
        currentUserEmails={['me@example.com']} />,
    );
    expect(screen.getByText('participants.invited_by')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Main St 1, Berlin' }).getAttribute('href')).toMatch(/maps/);
    expect(screen.getByRole('link', { name: 'teams.microsoft.com' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'toolbar.more' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'participants.accept' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /events\.edit/ })).toBeNull();
  });
});
