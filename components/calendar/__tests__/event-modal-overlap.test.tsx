import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { EventModal } from '../event-modal';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';

// The event form says which loaded events share its time (#1685). It's a
// notice only: Save still works.

vi.mock('../participant-availability', () => ({ ParticipantAvailability: () => null }));

const rights = {
  mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayWriteOwn: true,
  mayUpdatePrivate: true, mayRSVP: true, mayShare: true, mayDelete: true,
};
const own = { id: 'own', name: 'Personal', color: '#123456', isDefault: true, myRights: rights } as unknown as Calendar;

function other(id: string, start: string, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id, uid: `uid-${id}`, '@type': 'Event', title: `Meeting ${id}`, start, duration: 'PT1H', timeZone: null,
    showWithoutTime: false, status: 'confirmed', freeBusyStatus: 'busy', calendarIds: { own: true },
    ...extra,
  } as unknown as CalendarEvent;
}

const notices = () => screen.queryByTestId('event-conflict-warnings');

function renderNew(overlapEvents: CalendarEvent[], onSave = vi.fn().mockResolvedValue(undefined)) {
  render(
    <EventModal
      calendars={[own]}
      defaultDate={new Date('2026-11-20T10:00:00')}
      defaultEndDate={new Date('2026-11-20T11:00:00')}
      defaultCalendarId="own"
      onSave={onSave}
      onClose={vi.fn()}
      overlapEvents={overlapEvents}
    />,
  );
  return onSave;
}

describe('EventModal overlap notice', () => {
  it('lists an event at the same time, and still saves', async () => {
    const onSave = renderNew([other('a', '2026-11-20T10:30:00'), other('b', '2026-11-20T13:00:00')]);
    expect(notices()?.textContent).toBe('form.overlap');

    fireEvent.click(screen.getByText('form.save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  });

  it('follows the times in the form', () => {
    renderNew([other('a', '2026-11-20T10:30:00')]);
    expect(notices()).not.toBeNull();
    // The end moves with the start, so the event becomes 14:00-15:00.
    const startTime = screen.getByLabelText('form.start_time');
    fireEvent.change(startTime, { target: { value: '14:00' } });
    fireEvent.blur(startTime);
    expect(notices()).toBeNull();
  });

  it('says nothing for free events', () => {
    renderNew([other('a', '2026-11-20T10:30:00', { freeBusyStatus: 'free' })]);
    expect(notices()).toBeNull();
  });

  it('says nothing once the event is shown as free', () => {
    renderNew([other('a', '2026-11-20T10:30:00')]);
    expect(notices()).not.toBeNull();
    fireEvent.change(document.querySelector('select[id$="show_as"]')!, { target: { value: 'free' } });
    expect(notices()).toBeNull();
  });

  it('caps the list and counts the rest', () => {
    renderNew(['a', 'b', 'c', 'd', 'e'].map((id) => other(id, '2026-11-20T10:00:00')));
    expect(notices()?.children.length).toBe(4);
    expect(notices()?.lastElementChild?.textContent).toBe('form.overlap_more');
  });
});
