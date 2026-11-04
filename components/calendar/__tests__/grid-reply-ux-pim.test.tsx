import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createRef } from 'react';
import { EventCard } from '../event-card';
import { EventContextMenu } from '../event-context-menu';
import { CalendarAgendaView } from '../calendar-agenda-view';
import { gridReplyState } from '@/lib/calendar-reply-state';
import { useAccountStore } from '@/stores/account-store';
import type { Calendar, CalendarEvent, CalendarParticipant } from '@/lib/jmap/types';

// pim-9: an invitation the user hasn't answered looked like an accepted
// event, a solid block. It is now outlined and hatched with a "?" / "Reply"
// marker that offers the answers; "maybe" gets a dashed outline; the agenda a
// hollow dot. With several logins, "the user" is the login the event is in.

const me = ['me@example.com'];
const calendar = { id: 'cal-1', name: 'Work', color: '#2563eb' } as unknown as Calendar;

function invitation(myStatus: CalendarParticipant['participationStatus'] | undefined, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  const mine: Record<string, unknown> = { '@type': 'Participant', calendarAddress: 'mailto:me@example.com', roles: { attendee: true } };
  if (myStatus) mine.participationStatus = myStatus;
  return {
    id: 'ev-1',
    '@type': 'Event',
    uid: 'inv-1',
    title: 'UXFIX-grid weekly sync',
    start: '2026-11-05T10:00:00',
    duration: 'PT1H',
    showWithoutTime: false,
    status: 'confirmed',
    calendarIds: { 'cal-1': true },
    organizerCalendarAddress: 'mailto:boss@example.com',
    participants: {
      boss: { '@type': 'Participant', calendarAddress: 'mailto:boss@example.com', roles: { owner: true, attendee: true }, participationStatus: 'accepted' },
      me: mine,
    },
    ...extra,
  } as unknown as CalendarEvent;
}

afterEach(() => {
  cleanup();
  useAccountStore.setState({ accounts: [], activeAccountId: null });
});

describe('gridReplyState', () => {
  it('tells an open invitation, a maybe, and nothing to answer apart', () => {
    expect(gridReplyState(invitation('needs-action'), me)).toBe('needs-action');
    // JSCalendar: no status is "not answered yet".
    expect(gridReplyState(invitation(undefined), me)).toBe('needs-action');
    expect(gridReplyState(invitation('tentative'), me)).toBe('tentative');
    expect(gridReplyState(invitation('accepted'), me)).toBeNull();
    expect(gridReplyState(invitation('needs-action', { status: 'cancelled' }), me)).toBeNull();
    // The organiser has nothing to answer.
    expect(gridReplyState(invitation('needs-action'), ['boss@example.com'])).toBeNull();
    expect(gridReplyState(invitation('needs-action'), [])).toBeNull();
  });
});

describe('EventCard of an invitation', () => {
  it.each(['chip', 'span', 'block'] as const)('outlines and hatches an unanswered one, with a marker (%s)', (variant) => {
    const onReply = vi.fn();
    const event = invitation('needs-action');
    render(<EventCard event={event} calendar={calendar} variant={variant} currentUserEmails={me} onReply={onReply} />);
    const card = screen.getByRole('button', { name: /UXFIX-grid weekly sync/ });
    expect(card.dataset.replyState).toBe('needs-action');
    expect(card.style.boxShadow).toContain('inset 0 0 0 1.5px');
    expect(card.style.backgroundImage).toContain('repeating-linear-gradient');
    // Said in words too, not only by the look.
    expect(card.getAttribute('aria-label')).toContain('status_needs_action');
    const marker = screen.getByRole('button', { name: 'reply_to_invitation' });
    fireEvent.click(marker);
    expect(onReply).toHaveBeenCalledWith(marker, event);
  });

  it('draws a maybe with a dashed outline and no marker', () => {
    render(<EventCard event={invitation('tentative')} calendar={calendar} variant="span" currentUserEmails={me} onReply={vi.fn()} />);
    const card = screen.getByRole('button');
    expect(card.dataset.replyState).toBe('tentative');
    expect(card.style.border).toContain('dashed');
    expect(screen.queryByRole('button', { name: 'reply_to_invitation' })).toBeNull();
  });

  it('leaves an accepted invitation solid', () => {
    render(<EventCard event={invitation('accepted')} calendar={calendar} variant="span" currentUserEmails={me} onReply={vi.fn()} />);
    const card = screen.getByRole('button');
    expect(card.dataset.replyState).toBeUndefined();
    expect(card.style.backgroundImage).toBe('');
  });

  describe('with two logins', () => {
    beforeEach(() => {
      useAccountStore.setState({
        accounts: [
          { id: 'acc-a', email: 'me@example.com' },
          { id: 'acc-b', email: 'b@example.com' },
        ] as never,
        activeAccountId: 'acc-a',
      });
    });

    const ofB = (status: CalendarParticipant['participationStatus']) => {
      const event = invitation('accepted', { localAccountId: 'acc-b' } as Partial<CalendarEvent>);
      event.participants!.b = { '@type': 'Participant', calendarAddress: 'mailto:b@example.com', roles: { attendee: true }, participationStatus: status } as unknown as CalendarParticipant;
      return event;
    };

    it('reads the other login\'s event with its own address', () => {
      // A (me@) accepted, B has not answered: the event is B's, so it is open.
      render(<EventCard event={ofB('needs-action')} calendar={calendar} variant="span" currentUserEmails={me} />);
      expect(screen.getByRole('button').dataset.replyState).toBe('needs-action');
    });

    it('strikes through what the other login declined', () => {
      render(<EventCard event={ofB('declined')} calendar={calendar} variant="span" currentUserEmails={me} />);
      expect(screen.getByRole('button').getAttribute('aria-label')).toContain('participants.declined');
    });
  });
});

describe('EventContextMenu answers', () => {
  const base = {
    event: invitation('needs-action'),
    position: { x: 10, y: 10 },
    isOpen: true,
    onClose: vi.fn(),
    onEdit: vi.fn(),
    onDuplicate: vi.fn(),
    onExportICS: vi.fn(),
    onCopyTitle: vi.fn(),
    onDelete: vi.fn(),
  };

  it('offers Accept, Maybe and Decline above the rest', () => {
    const onRespond = vi.fn();
    render(<EventContextMenu {...base} menuRef={createRef()} onRespond={onRespond} responseStatus="needs-action" />);
    const items = screen.getAllByRole('menuitem').map((item) => item.textContent);
    expect(items.slice(0, 3)).toEqual(['participants.accept', 'participants.maybe', 'participants.decline']);
    expect(items).toContain('events.duplicate');
    fireEvent.click(screen.getByText('participants.maybe'));
    expect(onRespond).toHaveBeenCalledWith('tentative');
  });

  it('leaves out the answer already given', () => {
    render(<EventContextMenu {...base} menuRef={createRef()} onRespond={vi.fn()} responseStatus="tentative" />);
    expect(screen.queryByText('participants.maybe')).toBeNull();
    expect(screen.getByText('participants.accept')).toBeTruthy();
  });

  it('shows only the answers from the marker', () => {
    render(<EventContextMenu {...base} menuRef={createRef()} onRespond={vi.fn()} answersOnly />);
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent))
      .toEqual(['participants.accept', 'participants.maybe', 'participants.decline']);
  });
});

describe('CalendarAgendaView invitations', () => {
  it('draws a hollow dot and a Reply button', () => {
    const onReplyEvent = vi.fn();
    const event = invitation('needs-action');
    render(
      <CalendarAgendaView
        focus={{ date: new Date(2026, 10, 5), nonce: 0 }}
        windowKey="agenda:2026-11-05"
        rangeStart={new Date(2026, 10, 1)}
        rangeEnd={new Date(2026, 10, 30)}
        events={[event, invitation('tentative', { id: 'ev-2', uid: 'inv-2' })]}
        calendars={[calendar]}
        onSelectEvent={vi.fn()}
        currentUserEmails={me}
        onReplyEvent={onReplyEvent}
      />,
    );
    const dots = Array.from(document.querySelectorAll<HTMLElement>('[data-agenda-dot]')).map((dot) => dot.dataset.agendaDot);
    expect(dots).toEqual(['needs-action', 'tentative']);
    const reply = screen.getByRole('button', { name: 'reply' });
    fireEvent.click(reply);
    expect(onReplyEvent).toHaveBeenCalledWith(reply, event);
  });
});
