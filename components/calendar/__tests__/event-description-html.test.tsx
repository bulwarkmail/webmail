import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { EventDetailPopover } from '../event-detail-popover';
import { EventModal } from '../event-modal';
import { EventPrintSheet } from '../calendar-print';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';

// Other JMAP clients, and ICS files with STYLED-DESCRIPTION, store an HTML
// description with descriptionContentType text/html. The calendar showed its
// markup as text; it now shows the text.

vi.mock('../participant-availability', () => ({ ParticipantAvailability: () => null }));

const calendar = {
  id: 'cal-1', name: 'Work', isDefault: true,
  myRights: { mayReadItems: true, mayWriteAll: true, mayWriteOwn: true, mayUpdatePrivate: true, mayRSVP: true, mayDelete: true },
} as unknown as Calendar;

const HTML = '<p>Agenda:<br>Budget &amp; plans</p><p>Bring <b>notes</b></p>';

function htmlEvent(): CalendarEvent {
  return {
    id: 'evt-1', uid: 'u1', '@type': 'Event', calendarIds: { 'cal-1': true }, title: 'Review',
    description: HTML, descriptionContentType: 'text/html',
    start: '2026-11-20T10:00:00', duration: 'PT1H', timeZone: 'Europe/Berlin', showWithoutTime: false,
    participants: null, alerts: null, useDefaultAlerts: false, recurrenceRules: null,
  } as unknown as CalendarEvent;
}

const TEXT = 'Agenda:\nBudget & plans\n\nBring notes';

describe('HTML event descriptions', () => {
  it('shows the text in the detail popover', () => {
    render(
      <EventDetailPopover event={htmlEvent()} calendar={calendar} anchorRect={new DOMRect(100, 100, 50, 20)}
        onEdit={vi.fn()} onDelete={vi.fn()} onDuplicate={vi.fn()} onClose={vi.fn()} onSaveNote={vi.fn()} />,
    );
    // The popover renders in a portal.
    const text = document.body.textContent;
    expect(text).not.toContain('<p>');
    expect(text).not.toContain('&amp;');
    expect(text).toContain('Budget & plans');
  });

  it('shows the text in the editor, read and edit', () => {
    const { container } = render(
      <EventModal event={htmlEvent()} calendars={[calendar]} onSave={vi.fn()} onClose={vi.fn()} currentUserEmails={['me@example.com']} />,
    );
    expect(container.textContent).not.toContain('<p>');
    expect(container.textContent).toContain('Budget & plans');
    fireEvent.click(screen.getByText('events.edit'));
    expect((screen.getByPlaceholderText('form.description') as HTMLTextAreaElement).value).toBe(TEXT);
  });

  it('prints the text', () => {
    const { container } = render(
      <EventPrintSheet event={htmlEvent()} calendar={calendar} timeFormat="24h" timeZone="Europe/Berlin" />,
    );
    const text = container.querySelector('.pr-text')?.textContent;
    expect(text).toBe(TEXT);
  });

  it('leaves a plain-text description as it is', () => {
    const event = { ...htmlEvent(), description: 'a <b> c', descriptionContentType: 'text/plain' };
    const { container } = render(
      <EventPrintSheet event={event} calendar={calendar} timeFormat="24h" timeZone="Europe/Berlin" />,
    );
    expect(container.querySelector('.pr-text')?.textContent).toBe('a <b> c');
  });
});
