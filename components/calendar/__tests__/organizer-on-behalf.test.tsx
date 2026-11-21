import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventModal } from '../event-modal';
import { participantFieldsToSave } from '@/lib/calendar-participants';
import type { Calendar, CalendarEvent, CalendarParticipant } from '@/lib/jmap/types';

// #1761: a delegate with edit access to another person's calendar organizes
// a meeting there for its owner: organizerCalendarAddress is the owner, the
// owner's participant has sentBy the delegate. Stalwart 1.0.3 sends the
// invitations from the owner with ORGANIZER;SENT-BY (reporter's live test).

vi.mock('../participant-availability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../participant-availability')>()),
  ParticipantAvailability: () => null,
}));

afterEach(cleanup);

const rights = {
  mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayWriteOwn: true,
  mayUpdatePrivate: true, mayRSVP: true, mayShare: true, mayDelete: true,
};
const own = { id: 'cal', name: 'Personal', color: '#123456', isDefault: true, myRights: rights } as unknown as Calendar;
const bossCalendar = (myRights = rights, accountName = 'boss@example.org') => ({
  id: 'boss-cal', name: 'Calendar', color: '#654321', isShared: true,
  accountId: 'boss-account', accountName, myRights,
}) as unknown as Calendar;

const organizerOf = (participants: Record<string, CalendarParticipant>) =>
  Object.values(participants).find((p) => p.roles?.owner);

describe('participantFieldsToSave for someone else', () => {
  const boss = { name: 'Boss', email: 'boss@example.org', sentBy: 'mailto:me@example.com' };
  const attendees = [{ name: 'Guest', email: 'guest@example.net' }];

  it('makes the owner the organizer of a new event, sent by the delegate', () => {
    const fields = participantFieldsToSave(null, attendees, { userEmail: 'me@example.com', organizer: boss });

    expect(fields.organizerCalendarAddress).toBe('mailto:boss@example.org');
    const organizer = organizerOf(fields.participants as Record<string, CalendarParticipant>);
    expect(organizer).toMatchObject({ email: 'boss@example.org', roles: { owner: true }, sentBy: 'mailto:me@example.com' });
  });

  it('writes the delegate as sentBy when the owner already organizes the event', () => {
    const event = {
      id: 'e', uid: 'u', organizerCalendarAddress: 'mailto:Boss@example.org',
      participants: {
        o: { '@type': 'Participant', email: 'Boss@example.org', calendarAddress: 'mailto:Boss@example.org', roles: { owner: true }, participationStatus: 'accepted' },
        g: { '@type': 'Participant', email: 'guest@example.net', calendarAddress: 'mailto:guest@example.net', roles: { attendee: true }, participationStatus: 'accepted' },
      },
    } as unknown as CalendarEvent;
    const fields = participantFieldsToSave(event, attendees, { userEmail: 'me@example.com', organizer: boss });

    expect(fields).not.toHaveProperty('organizerCalendarAddress');
    expect(organizerOf(fields.participants as Record<string, CalendarParticipant>)?.sentBy).toBe('mailto:me@example.com');
  });

  it('leaves another organizer without sentBy', () => {
    const event = {
      id: 'e', uid: 'u', organizerCalendarAddress: 'mailto:other@example.org',
      participants: {
        o: { '@type': 'Participant', email: 'other@example.org', calendarAddress: 'mailto:other@example.org', roles: { owner: true }, participationStatus: 'accepted' },
      },
    } as unknown as CalendarEvent;
    const fields = participantFieldsToSave(event, attendees, { userEmail: 'me@example.com', organizer: boss });

    expect(organizerOf(fields.participants as Record<string, CalendarParticipant>)).not.toHaveProperty('sentBy');
  });
});

describe('the Organizer choice in the event editor', () => {
  async function createWithGuest(calendars: Calendar[], defaultCalendarId: string, pick?: string) {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <EventModal
        calendars={calendars}
        defaultCalendarId={defaultCalendarId}
        defaultTitle="Board meeting"
        onSave={onSave}
        onClose={vi.fn()}
        currentUserEmails={['me@example.com']}
      />,
    );
    const field = screen.getByPlaceholderText('email_placeholder');
    fireEvent.change(field, { target: { value: 'guest@example.net' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    const choice = screen.queryByLabelText('participants.organizer') as HTMLSelectElement | null;
    if (pick) fireEvent.change(choice!, { target: { value: pick } });
    fireEvent.click(screen.getByText('form.save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    return { choice, data: onSave.mock.calls[0][0] as Partial<CalendarEvent>, editor: onSave.mock.calls[0][2] };
  }

  it('organizes for the calendar owner by default in their calendar', async () => {
    const { choice, data, editor } = await createWithGuest([own, bossCalendar()], 'boss-cal');

    expect(choice?.value).toBe('owner');
    expect(data.organizerCalendarAddress).toBe('mailto:boss@example.org');
    expect(organizerOf(data.participants as Record<string, CalendarParticipant>))
      .toMatchObject({ email: 'boss@example.org', sentBy: 'mailto:me@example.com' });
    // A series saved from one occurrence keeps it too.
    expect(editor.organizer).toMatchObject({ email: 'boss@example.org', sentBy: 'mailto:me@example.com' });
  });

  it('organizes as the user when they pick themselves', async () => {
    const { data } = await createWithGuest([own, bossCalendar()], 'boss-cal', 'me');

    expect(data.organizerCalendarAddress).toBe('mailto:me@example.com');
    expect(organizerOf(data.participants as Record<string, CalendarParticipant>)).not.toHaveProperty('sentBy');
  });

  it('offers no choice in the user\'s own calendar, or without edit access', async () => {
    const ownResult = await createWithGuest([own, bossCalendar()], 'cal');
    expect(ownResult.choice).toBeNull();
    expect(ownResult.data.organizerCalendarAddress).toBe('mailto:me@example.com');
    cleanup();

    const readOnly = await createWithGuest([own, bossCalendar({ ...rights, mayWriteAll: false })], 'boss-cal');
    expect(readOnly.choice).toBeNull();
  });
});
