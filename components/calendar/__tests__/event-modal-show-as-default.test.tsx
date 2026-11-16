import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { EventModal } from '../event-modal';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';

// A new all-day event starts as Free, a timed one as Busy (#1684). The user
// can still pick either under Show as, and an existing event keeps its own.

vi.mock('../participant-availability', () => ({ ParticipantAvailability: () => null }));

const rights = {
  mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayWriteOwn: true,
  mayUpdatePrivate: true, mayRSVP: true, mayShare: true, mayDelete: true,
};
const own = { id: 'own', name: 'Personal', color: '#123456', isDefault: true, myRights: rights } as unknown as Calendar;

const showAs = () => document.querySelector('select[id$="show_as"]') as HTMLSelectElement;
const allDayBox = () => screen.getByLabelText('form.all_day_event') as HTMLInputElement;

async function savedData(onSave: ReturnType<typeof vi.fn>): Promise<Partial<CalendarEvent>> {
  fireEvent.click(screen.getByText('form.save'));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  return onSave.mock.calls[0][0];
}

function renderNew(allDay: boolean) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(
    <EventModal
      calendars={[own]}
      defaultDate={new Date('2026-11-20T10:00:00')}
      defaultEndDate={new Date('2026-11-20T11:00:00')}
      defaultAllDay={allDay}
      defaultCalendarId="own"
      onSave={onSave}
      onClose={vi.fn()}
    />,
  );
  return onSave;
}

describe('EventModal Show as default', () => {
  it('saves a new all-day event as free', async () => {
    const onSave = renderNew(true);
    expect(showAs().value).toBe('free');
    expect((await savedData(onSave)).freeBusyStatus).toBe('free');
  });

  it('saves a new timed event as busy', async () => {
    const onSave = renderNew(false);
    expect(showAs().value).toBe('busy');
    expect((await savedData(onSave)).freeBusyStatus).toBe('busy');
  });

  it('follows the all-day box until the user picks one', () => {
    renderNew(false);
    fireEvent.click(allDayBox());
    expect(showAs().value).toBe('free');
    fireEvent.click(allDayBox());
    expect(showAs().value).toBe('busy');

    fireEvent.change(showAs(), { target: { value: 'busy' } });
    fireEvent.click(allDayBox());
    expect(showAs().value).toBe('busy');
  });

  it('keeps what an existing all-day event has', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const event = {
      id: 'e1', uid: 'u1', '@type': 'Event', title: 'Offsite', description: '', start: '2026-11-20T00:00:00',
      duration: 'P1D', timeZone: null, showWithoutTime: true, calendarIds: { own: true },
      participants: null, alerts: null, recurrenceRules: null, freeBusyStatus: 'busy', privacy: 'public',
    } as unknown as CalendarEvent;
    render(<EventModal event={event} startInEditMode calendars={[own]} onSave={onSave} onClose={vi.fn()} />);
    expect(showAs().value).toBe('busy');
    expect('freeBusyStatus' in (await savedData(onSave))).toBe(false);
  });
});
