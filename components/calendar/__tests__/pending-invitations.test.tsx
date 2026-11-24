import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PendingInvitations } from '../pending-invitations';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';
import type { CalendarEvent } from '@/lib/jmap/types';

// #1669: the sidebar lists the invitations the user hasn't answered, each
// with its answers.

const me = 'me@example.com';

function invitation(id: string, status: string): CalendarEvent {
  return {
    id, uid: `uid-${id}`, title: `Meeting ${id}`, start: '2026-12-01T10:00:00', utcStart: '2026-12-01T10:00:00Z',
    duration: 'PT1H', showWithoutTime: false, calendarIds: { c: true },
    organizerCalendarAddress: 'mailto:boss@example.com',
    participants: {
      boss: { '@type': 'Participant', name: 'The Boss', calendarAddress: 'mailto:boss@example.com', roles: { owner: true } },
      mine: { '@type': 'Participant', calendarAddress: `mailto:${me}`, roles: { attendee: true }, participationStatus: status },
    },
  } as unknown as CalendarEvent;
}

const queryCalendarEvents = vi.fn();
const initialAuth = useAuthStore.getState();
const initialCalendar = useCalendarStore.getState();

beforeEach(() => {
  queryCalendarEvents.mockReset();
  useAuthStore.setState({ client: { queryCalendarEvents } as never });
});

afterEach(() => {
  cleanup();
  useAuthStore.setState(initialAuth, true);
  useCalendarStore.setState(initialCalendar, true);
});

describe('PendingInvitations', () => {
  it('lists the unanswered invitations with how many there are', async () => {
    queryCalendarEvents.mockResolvedValue([invitation('a', 'needs-action'), invitation('b', 'accepted'), invitation('c', 'needs-action')]);
    render(<PendingInvitations userEmailsFor={() => [me]} onOpen={vi.fn()} onRespond={vi.fn()} />);

    await waitFor(() => expect(screen.getAllByTestId('pending-invitation')).toHaveLength(2));
    expect(screen.getByTestId('pending-invitations-count').textContent).toBe('2');
    expect(screen.getByText('Meeting a')).toBeTruthy();
    expect(screen.queryByText('Meeting b')).toBeNull();
  });

  it('answers from the list and takes the invitation out', async () => {
    queryCalendarEvents.mockResolvedValue([invitation('a', 'needs-action'), invitation('c', 'needs-action')]);
    const onRespond = vi.fn(async () => true);
    render(<PendingInvitations userEmailsFor={() => [me]} onOpen={vi.fn()} onRespond={onRespond} />);
    await waitFor(() => expect(screen.getAllByTestId('pending-invitation')).toHaveLength(2));

    await act(async () => { fireEvent.click(screen.getAllByTestId('pending-invitation-tentative')[0]); });
    expect(onRespond).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 'mine', 'tentative');
    expect(screen.getAllByTestId('pending-invitation')).toHaveLength(1);
    expect(screen.queryByText('Meeting a')).toBeNull();
  });

  it('keeps an invitation whose answer didn\'t go out', async () => {
    queryCalendarEvents.mockResolvedValue([invitation('a', 'needs-action')]);
    const onRespond = vi.fn(async () => false);
    render(<PendingInvitations userEmailsFor={() => [me]} onOpen={vi.fn()} onRespond={onRespond} />);
    await waitFor(() => expect(screen.getByText('Meeting a')).toBeTruthy());

    await act(async () => { fireEvent.click(screen.getByTestId('pending-invitation-declined')); });
    expect(onRespond).toHaveBeenCalled();
    expect(screen.getByText('Meeting a')).toBeTruthy();
  });

  it('opens the event from the list', async () => {
    queryCalendarEvents.mockResolvedValue([invitation('a', 'needs-action')]);
    const onOpen = vi.fn();
    render(<PendingInvitations userEmailsFor={() => [me]} onOpen={onOpen} onRespond={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Meeting a')).toBeTruthy());
    fireEvent.click(screen.getByText('Meeting a'));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
  });

  it('shows nothing while there is nothing to answer', async () => {
    queryCalendarEvents.mockResolvedValue([invitation('b', 'accepted')]);
    render(<PendingInvitations userEmailsFor={() => [me]} onOpen={vi.fn()} onRespond={vi.fn()} />);
    await waitFor(() => expect(queryCalendarEvents).toHaveBeenCalled());
    expect(screen.queryByTestId('pending-invitations')).toBeNull();
  });
});
