import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

describe('saving an HTML event description from the editor', () => {
  async function save(event: CalendarEvent, newDescription?: string): Promise<Partial<CalendarEvent>> {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<EventModal event={event} calendars={[calendar]} onSave={onSave} onClose={vi.fn()} currentUserEmails={['me@example.com']} />);
    fireEvent.click(screen.getByText('events.edit'));
    if (newDescription !== undefined) {
      fireEvent.change(screen.getByPlaceholderText('form.description'), { target: { value: newDescription } });
    }
    fireEvent.click(screen.getByText('form.save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    return onSave.mock.calls[0][0] as Partial<CalendarEvent>;
  }

  // Other clients would read the text as HTML and run its lines together.
  it('labels an edited description as plain text', async () => {
    const data = await save(htmlEvent(), `${TEXT}\nMore`);
    expect(data.description).toBe(`${TEXT}\nMore`);
    expect(data.descriptionContentType).toBe('text/plain');
  });

  it('leaves an untouched HTML description as it was', async () => {
    const data = await save(htmlEvent());
    expect(data).not.toHaveProperty('description');
    expect(data).not.toHaveProperty('descriptionContentType');
  });

  // Stalwart writes a set type as STYLED-DESCRIPTION, which many clients skip.
  it('sends no type for an event that had none', async () => {
    const event = { ...htmlEvent(), description: 'old', descriptionContentType: undefined } as unknown as CalendarEvent;
    const data = await save(event, 'new');
    expect(data.description).toBe('new');
    expect(data).not.toHaveProperty('descriptionContentType');
  });
});
