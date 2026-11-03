import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { EventCard } from '../event-card';
import { useSettingsStore } from '@/stores/settings-store';
import type { Calendar, CalendarEvent, CalendarParticipant } from '@/lib/jmap/types';

// #1110: an invitation the user declined - the whole series or one occurrence
// of an accepted series - stays on the calendar, struck through and drawn as
// an outline like a cancelled event, instead of looking like one they will
// attend.

function makeOccurrence(id: string, myStatus: CalendarParticipant['participationStatus']): CalendarEvent {
  return {
    id,
    '@type': 'Event',
    uid: 'series',
    title: 'Standup ' + id,
    start: '2026-09-28T09:00:00',
    duration: 'PT30M',
    showWithoutTime: false,
    status: 'confirmed',
    calendarIds: { 'cal-1': true },
    participants: {
      org: { '@type': 'Participant', calendarAddress: 'mailto:boss@example.com', participationStatus: 'accepted' },
      me: { '@type': 'Participant', calendarAddress: 'mailto:me@example.com', participationStatus: myStatus },
    },
  } as unknown as CalendarEvent;
}

const me = ['me@example.com'];

describe('EventCard', () => {
  afterEach(() => {
    cleanup();
  });

  // The block of a short event has room for its title line only; the count was cut in half.
  it.each([
    ['PT30M', false],
    ['PT45M', true],
  ])('shows the participant count on a %s block: %s', (duration, shown) => {
    const event = { ...makeOccurrence('a', 'accepted'), duration } as CalendarEvent;
    render(<EventCard event={event} variant="block" currentUserEmails={me} />);
    expect(screen.queryByTitle('participants.count') !== null).toBe(shown);
  });

  it.each(['chip', 'span', 'block'] as const)('strikes through an occurrence the user declined (%s)', (variant) => {
    render(<EventCard event={makeOccurrence('a', 'declined')} variant={variant} currentUserEmails={me} />);
    const card = screen.getByRole('button');
    expect(card.style.boxShadow).toContain('inset 0 0 0 1px');
    expect(card.getAttribute('aria-label')).toMatch(/, participants\.declined$/);
    expect(screen.getByText('Standup a')).toHaveClass('line-through');
  });

  it('leaves accepted and unanswered occurrences alone', () => {
    render(
      <>
        <EventCard event={makeOccurrence('a', 'accepted')} variant="block" currentUserEmails={me} />
        <EventCard event={makeOccurrence('b', 'needs-action')} variant="block" currentUserEmails={me} />
      </>
    );
    for (const card of screen.getAllByRole('button')) {
      expect(card.style.boxShadow).not.toContain('inset');
      expect(card.getAttribute('aria-label')).not.toMatch(/declined/);
    }
    expect(screen.getByText('Standup a')).not.toHaveClass('line-through');
  });

  it('only looks at the user\'s own participant entry', () => {
    const event = makeOccurrence('a', 'accepted');
    event.participants!.org.participationStatus = 'declined';
    render(<EventCard event={event} variant="block" currentUserEmails={me} />);
    expect(screen.getByRole('button').style.boxShadow).not.toContain('inset');
  });

  it('labels a cancelled event as cancelled even when the user declined it', () => {
    const event = { ...makeOccurrence('a', 'declined'), status: 'cancelled' } as CalendarEvent;
    render(<EventCard event={event} variant="block" currentUserEmails={me} />);
    expect(screen.getByRole('button').getAttribute('aria-label')).toMatch(/, detail\.cancelled$/);
  });
});

describe('EventCard fill', () => {
  afterEach(() => {
    cleanup();
  });

  const calendar = { id: 'cal-1', name: 'Work', color: '#22c55e' } as unknown as Calendar;

  it.each(['chip', 'span', 'block'] as const)('fills the %s with the calendar colour and readable text', (variant) => {
    render(<EventCard event={makeOccurrence('a', 'accepted')} calendar={calendar} variant={variant} currentUserEmails={me} />);
    const card = screen.getByRole('button');
    expect(card.style.backgroundColor).toBe('rgb(34, 197, 94)');
    expect(card.style.color).toBe('rgb(17, 24, 39)');
  });

  it('keeps the selection ring next to the declined outline', () => {
    render(<EventCard event={makeOccurrence('a', 'declined')} calendar={calendar} variant="block" isSelected currentUserEmails={me} />);
    const shadow = screen.getByRole('button').style.boxShadow;
    expect(shadow).toContain('0 0 0 2px var(--color-primary)');
    expect(shadow).toContain('inset 0 0 0 1px');
  });

  describe('with light event colours', () => {
    beforeEach(() => useSettingsStore.setState({ calendarTintedEvents: true }));
    afterEach(() => useSettingsStore.setState({ calendarTintedEvents: false }));

    it.each(['chip', 'span', 'block'] as const)('tints the %s and draws the calendar colour as a bar at its start', (variant) => {
      render(<EventCard event={makeOccurrence('a', 'accepted')} calendar={calendar} variant={variant} currentUserEmails={me} />);
      const card = screen.getByRole('button');
      expect(card).toHaveClass('start-bar');
      expect(card.style.getPropertyValue('--start-bar')).toBe('#22c55e');
      expect(card.style.backgroundColor).not.toBe('rgb(34, 197, 94)');
      expect(card.style.color).toBe('var(--color-foreground)');
    });

    it('keeps the outline of a declined event, without a bar', () => {
      render(<EventCard event={makeOccurrence('a', 'declined')} calendar={calendar} variant="block" currentUserEmails={me} />);
      const card = screen.getByRole('button');
      expect(card).not.toHaveClass('start-bar');
      expect(card.style.boxShadow).toContain('inset 0 0 0 1px');
    });
  });
});

describe('EventCard colour settings', () => {
  const calendar = { id: 'cal-1', name: 'Work', color: '#22c55e' } as unknown as Calendar;
  afterEach(() => {
    cleanup();
    useSettingsStore.setState({ showColorNames: false, colorBlindPalette: false });
  });

  it.each(['chip', 'span', 'block'] as const)('shows the calendar name on the %s with "Show names next to colours"', (variant) => {
    useSettingsStore.setState({ showColorNames: true });
    render(<EventCard event={makeOccurrence('a', 'accepted')} calendar={calendar} variant={variant} currentUserEmails={me} />);
    expect(screen.getByText('Work')).toBeInTheDocument();
  });

  it('shows only the colour without it', () => {
    render(<EventCard event={makeOccurrence('a', 'accepted')} calendar={calendar} variant="block" currentUserEmails={me} />);
    expect(screen.queryByText('Work')).not.toBeInTheDocument();
  });

  it("draws the event in the colour-blind-safe colour and keeps the calendar's own", () => {
    useSettingsStore.setState({ colorBlindPalette: true });
    render(<EventCard event={makeOccurrence('a', 'accepted')} calendar={calendar} variant="block" currentUserEmails={me} />);
    // #009E73, the palette's bluish green
    expect(screen.getByRole('button').style.backgroundColor).toBe('rgb(0, 158, 115)');
    expect(calendar.color).toBe('#22c55e');
  });
});

describe('EventCard from the keyboard (MA-05)', () => {
  afterEach(cleanup);

  it.each(['chip', 'span', 'block'] as const)('opens the event menu with Shift+F10 on the %s', (variant) => {
    const onContextMenu = vi.fn();
    const event = makeOccurrence('a', 'accepted');
    render(<EventCard event={event} variant={variant} onContextMenu={onContextMenu} currentUserEmails={me} />);
    const card = screen.getByRole('button');
    fireEvent.keyDown(card, { key: 'F10' });
    expect(onContextMenu).not.toHaveBeenCalled();
    fireEvent.keyDown(card, { key: 'F10', shiftKey: true });
    expect(onContextMenu).toHaveBeenCalledOnce();
    expect(onContextMenu.mock.calls[0][1]).toBe(event);
    expect(onContextMenu.mock.calls[0][0].currentTarget).toBe(card);
  });
});
