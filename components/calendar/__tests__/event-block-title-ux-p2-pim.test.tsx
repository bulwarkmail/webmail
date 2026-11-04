import { render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EventCard } from '../event-card';
import { useDisplayHours } from '@/hooks/use-display-hours';
import type { CalendarEvent } from '@/lib/jmap/types';

// pim-p2-19: the part of "Night train to Vienna" after midnight starts at the
// top of the day, scrolled out of view, so the week showed a block with no
// title. The title line now sticks under the grid's header while the block is
// in sight. A block that hid its overflow was a scroller of its own, and a
// sticky line inside one sticks to the block, not to the grid.

const train = {
  id: 'n1', '@type': 'Event', uid: 'n1', title: 'Night train to Vienna', start: '2026-11-07T00:00:00',
  duration: 'PT7H40M', showWithoutTime: false, status: 'confirmed', calendarIds: { cal: true }, participants: null,
} as unknown as CalendarEvent;

describe('the title of a long block stays in sight', () => {
  it('sticks the title line under the header and clips the block without making it a scroller', () => {
    render(<EventCard event={train} variant="block" continuesBefore />);
    const card = screen.getByRole('button', { name: /Night train to Vienna/ });
    expect(card.className).toContain('overflow-clip');
    expect(card.className).not.toContain('overflow-hidden');
    const line = card.querySelector('[data-event-title-line]') as HTMLElement;
    expect(line.className).toContain('sticky');
    expect(line.className).toContain('top-[var(--grid-header-height,0px)]');
    expect(line.textContent).toContain('Night train to Vienna');
  });

  it('tells the grid how tall its header is, for the sticky title', () => {
    const pane = document.createElement('div');
    const header = document.createElement('div');
    Object.defineProperty(header, 'offsetHeight', { value: 96 });
    renderHook(() => useDisplayHours({ scrollRef: { current: pane }, headerRef: { current: header }, minHourHeight: 48 }));
    expect(pane.style.getPropertyValue('--grid-header-height')).toBe('96px');
  });
});
