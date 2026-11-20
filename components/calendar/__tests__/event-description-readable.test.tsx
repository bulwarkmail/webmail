import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { EventDetailPopover } from '../event-detail-popover';
import { EventModal } from '../event-modal';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';

// #1777: a long description can be read in full in the popover, and the
// editor's description field is taller and can be made taller still.

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
  useFormatter: () => ({ dateTime: (d: Date | string) => String(d), relativeTime: (d: Date | string) => String(d), number: (n: number) => String(n) }),
}));
vi.mock('../participant-availability', () => ({ ParticipantAvailability: () => null }));

const rights = {
  mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayWriteOwn: true,
  mayUpdatePrivate: true, mayRSVP: true, mayShare: true, mayDelete: true,
};
const calendar = { id: 'cal-1', name: 'Work', color: '#123456', isDefault: true, myRights: rights } as unknown as Calendar;

function eventWith(description: string) {
  return {
    id: 'evt-1', uid: 'u1', '@type': 'Event', calendarIds: { 'cal-1': true }, title: 'Planning', description,
    start: '2026-11-20T10:00:00', duration: 'PT1H', timeZone: 'Europe/Berlin', showWithoutTime: false,
    participants: null, alerts: null, useDefaultAlerts: false, recurrenceRules: null,
  } as unknown as CalendarEvent;
}

function renderPopover(description: string) {
  render(
    <EventDetailPopover event={eventWith(description)} calendar={calendar} anchorRect={new DOMRect(100, 100, 50, 20)}
      onEdit={vi.fn()} onDelete={vi.fn()} onDuplicate={vi.fn()} onClose={vi.fn()} onSaveNote={vi.fn()} />,
  );
  return screen.getByText((_, el) => el?.tagName === 'P' && !!el.textContent?.startsWith('Agenda'));
}

/** jsdom lays nothing out: make every element report content taller than its box. */
function pretendOverflow(scrollHeight: number, clientHeight: number) {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(scrollHeight);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(clientHeight);
}

afterEach(() => vi.restoreAllMocks());

describe('event popover description', () => {
  it('shows a long description in full after Show more, and cuts it again with Show less', () => {
    pretendOverflow(400, 160);
    const text = renderPopover('Agenda\n1. Budget\n2. Hiring\n3. Office move\n4. Q&A\n5. Wrap-up\n6. Lunch\n7. Drinks\n8. Taxi\n9. Hotel');
    expect(text.className).toContain('line-clamp-8');

    fireEvent.click(screen.getByRole('button', { name: 'events.show_more' }));
    expect(text.className).not.toMatch(/line-clamp/);
    expect(screen.getByRole('button', { name: 'events.show_less' })).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'events.show_less' }));
    expect(text.className).toContain('line-clamp-8');
  });

  it('has no toggle when the description fits', () => {
    pretendOverflow(40, 40);
    renderPopover('Agenda\nBudget');
    expect(screen.queryByRole('button', { name: 'events.show_more' })).toBeNull();
  });

  it('shows a run of blank lines as one', () => {
    const text = renderPopover('Agenda\n\n\n\n  \nJoin the meeting');
    expect(text.textContent).toBe('Agenda\n\nJoin the meeting');
  });

  it('keeps links in the description', () => {
    renderPopover('Agenda\nhttps://meet.example.com/abc');
    expect(screen.getByRole('link', { name: 'https://meet.example.com/abc' })).toHaveAttribute('href', 'https://meet.example.com/abc');
  });
});

describe('event editor description', () => {
  const field = () => document.querySelector('textarea[id$="description"]') as HTMLTextAreaElement;

  it('is six rows tall and can be resized up and down', () => {
    render(<EventModal event={eventWith('Agenda')} startInEditMode calendars={[calendar]} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(field().rows).toBe(6);
    expect(field().className).toContain('resize-y');
    expect(field().className).not.toContain('resize-none');
  });

  it('is taller in the large dialog', () => {
    render(<EventModal event={eventWith('Agenda')} startInEditMode expanded onToggleExpand={vi.fn()} calendars={[calendar]} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(field().rows).toBe(12);
  });
});
