import { createRef, type ReactNode } from 'react';
import { render, screen, fireEvent, cleanup, renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventCard } from '../event-card';
import { EventContextMenu } from '../event-context-menu';
import { CalendarAgendaView } from '../calendar-agenda-view';
import { gridAnswerTargets, useAccountOwners } from '../answer-bars';
import { CALENDAR_PRESETS } from '@/lib/jmap/share-rights';
import { CalendarOwnersContext } from '@/hooks/use-reply-emails';
import { accountOwnerOf, type AccountOwner } from '@/lib/calendar-delegate';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Calendar, CalendarEvent, CalendarParticipant } from '@/lib/jmap/types';

// #1760: in a calendar of another person's account the grid drew the
// viewer's answer instead of the owner's. Bob (me@) has Alice's calendar;
// Carol invited both.

const me = ['me@example.com'];
const shared = { id: 'alice:b', name: 'Alice', color: '#2563eb', accountId: 'alice', accountName: 'alice@example.com', isShared: true } as unknown as Calendar;
const own = { id: 'cal-1', name: 'Work', color: '#2563eb' } as unknown as Calendar;
const alice = accountOwnerOf(null, 'alice@example.com')!;
const owners: ReadonlyMap<string, AccountOwner> = new Map([['alice', alice]]);

function invitation(alice: CalendarParticipant['participationStatus'], mine: CalendarParticipant['participationStatus'], calendarId = 'alice:b'): CalendarEvent {
  return {
    id: 'ev-1',
    '@type': 'Event',
    uid: 'inv-1',
    title: 'Planning',
    start: '2026-11-05T10:00:00',
    duration: 'PT1H',
    showWithoutTime: false,
    status: 'confirmed',
    calendarIds: { [calendarId]: true },
    organizerCalendarAddress: 'mailto:carol@example.com',
    participants: {
      carol: { '@type': 'Participant', calendarAddress: 'mailto:carol@example.com', roles: { owner: true, attendee: true }, participationStatus: 'accepted' },
      alice: { '@type': 'Participant', calendarAddress: 'mailto:alice@example.com', roles: { attendee: true }, participationStatus: alice },
      me: { '@type': 'Participant', calendarAddress: 'mailto:me@example.com', roles: { attendee: true }, participationStatus: mine },
    },
  } as unknown as CalendarEvent;
}

const withOwners = ({ children }: { children: ReactNode }) => (
  <CalendarOwnersContext.Provider value={owners}>{children}</CalendarOwnersContext.Provider>
);

afterEach(cleanup);

describe('EventCard in a shared calendar', () => {
  it('hatches an invitation the owner has not answered, though the viewer accepted it', () => {
    render(<EventCard event={invitation('needs-action', 'accepted')} calendar={shared} variant="span" currentUserEmails={me} />, { wrapper: withOwners });
    expect(screen.getByRole('button').dataset.replyState).toBe('needs-action');
  });

  it('strikes through what the owner declined', () => {
    render(<EventCard event={invitation('declined', 'accepted')} calendar={shared} variant="span" currentUserEmails={me} />, { wrapper: withOwners });
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('participants.declined');
  });

  it('leaves the owner\'s accepted invitation solid, though the viewer has not answered', () => {
    render(<EventCard event={invitation('accepted', 'needs-action')} calendar={shared} variant="span" currentUserEmails={me} />, { wrapper: withOwners });
    expect(screen.getByRole('button').dataset.replyState).toBeUndefined();
  });

  it('keeps the user\'s own answer in their own calendar', () => {
    render(<EventCard event={invitation('needs-action', 'accepted', 'cal-1')} calendar={own} variant="span" currentUserEmails={me} />, { wrapper: withOwners });
    expect(screen.getByRole('button').dataset.replyState).toBeUndefined();
  });
});

describe('CalendarAgendaView in a shared calendar', () => {
  it('draws the owner\'s open answer', () => {
    render(
      <CalendarAgendaView
        focus={{ date: new Date(2026, 10, 5), nonce: 0 }}
        windowKey="agenda:2026-11-05"
        rangeStart={new Date(2026, 10, 1)}
        rangeEnd={new Date(2026, 10, 30)}
        events={[invitation('needs-action', 'accepted')]}
        calendars={[shared]}
        onSelectEvent={vi.fn()}
        currentUserEmails={me}
        onReplyEvent={vi.fn()}
      />,
      { wrapper: withOwners },
    );
    const dots = Array.from(document.querySelectorAll<HTMLElement>('[data-agenda-dot]')).map((dot) => dot.dataset.agendaDot);
    expect(dots).toEqual(['needs-action']);
  });
});

describe('EventContextMenu answers for the owner', () => {
  const base = {
    event: invitation('needs-action', 'accepted'),
    position: { x: 10, y: 10 },
    isOpen: true,
    onClose: vi.fn(),
    onEdit: vi.fn(),
    onDuplicate: vi.fn(),
    onExportICS: vi.fn(),
    onCopyTitle: vi.fn(),
    onDelete: vi.fn(),
  };

  it('offers the owner\'s answers under their name, then the user\'s own', () => {
    const forOwner = vi.fn();
    const forSelf = vi.fn();
    render(
      <EventContextMenu
        {...base}
        menuRef={createRef()}
        ownerAnswer={{ name: 'Alice', status: 'needs-action', onRespond: forOwner }}
        onRespond={forSelf}
        responseStatus="accepted"
        answersOnly
      />,
    );
    expect(screen.getByText('answer_for')).toBeTruthy();
    expect(screen.getByText('participants.rsvp_label')).toBeTruthy();
    expect(screen.getAllByRole('menuitem').map((item) => item.dataset.testid)).toEqual([
      'grid-answer-owner-accepted', 'grid-answer-owner-tentative', 'grid-answer-owner-declined',
      'grid-answer-tentative', 'grid-answer-declined',
    ]);
    fireEvent.click(screen.getByTestId('grid-answer-owner-declined'));
    expect(forOwner).toHaveBeenCalledWith('declined');
    expect(forSelf).not.toHaveBeenCalled();
  });
});

describe('gridAnswerTargets', () => {
  const client = { hasAccountCapability: () => true } as unknown as IJMAPClient;
  const writable = { ...shared, myRights: CALENDAR_PRESETS.readWrite } as Calendar;

  it('answers for the owner with the user as sentBy, and for the user too when invited', () => {
    const event = invitation('needs-action', 'accepted');
    // The user's own answer goes to their own copy of the event.
    const ownCopy = { ...invitation('needs-action', 'accepted', 'cal-1'), id: 'ev-own' };
    const targets = gridAnswerTargets({ event, calendar: writable, userEmails: me, canRsvpSelf: true, owner: alice, events: [event, ownCopy], client });
    expect(targets).toEqual([
      expect.objectContaining({ kind: 'owner', eventId: 'ev-1', participantId: 'alice', status: 'needs-action', sentBy: 'mailto:me@example.com' }),
      expect.objectContaining({ kind: 'self', eventId: 'ev-own', participantId: 'me', status: 'accepted' }),
    ]);
  });

  it('offers nothing for the owner without edit rights', () => {
    const event = invitation('needs-action', 'accepted');
    const readOnly = { ...shared, myRights: CALENDAR_PRESETS.read } as Calendar;
    expect(gridAnswerTargets({ event, calendar: readOnly, userEmails: me, canRsvpSelf: false, owner: alice, events: [event], client })).toEqual([]);
  });

  it('answers only for the user in their own calendar', () => {
    const event = invitation('needs-action', 'accepted', 'cal-1');
    expect(gridAnswerTargets({ event, calendar: own, userEmails: me, canRsvpSelf: true, owner: null, events: [event], client }))
      .toEqual([{ kind: 'self', eventId: 'ev-1', participantId: 'me', status: 'accepted' }]);
  });
});

describe('useAccountOwners', () => {
  it('finds the owner of each shared account once, from Principal/get', async () => {
    const getAccountOwners = vi.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, { id: `p-${id}`, type: 'individual', name: 'Alice Doe', email: 'alice.doe@example.com' }])));
    const client = { getAccountOwners } as unknown as IJMAPClient;
    const second = { ...shared, id: 'alice:c' } as Calendar;
    const { result } = renderHook(() => useAccountOwners(client, [own, shared, second]));
    // The session's account name stands in until Principal/get answers.
    expect(result.current.get('alice')?.emails).toEqual(['alice@example.com']);
    await waitFor(() => expect(result.current.get('alice')?.name).toBe('Alice Doe'));
    expect(result.current.get('alice')?.emails).toEqual(['alice.doe@example.com', 'alice@example.com']);
    expect([...result.current.keys()]).toEqual(['alice']);
    expect(getAccountOwners).toHaveBeenCalledTimes(1);
  });
});
