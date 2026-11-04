import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRef } from 'react';
import en from '@/locales/en/common.json';
import de from '@/locales/de/common.json';
import { EventContextMenu } from '../event-context-menu';
import { CalendarAgendaView, agendaDayPart } from '../calendar-agenda-view';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';

// pim-p3-16 and the calendar part of pim-p3-17. The strings name their
// namespace here, so a key from the wrong one shows.
vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string) => (ns ? `${ns}.${key}` : key),
  useLocale: () => 'en',
}));
vi.mock('@/hooks/use-display-date-formatter', () => ({
  useDisplayDateFormatter: () => ({
    dateTime: (d: Date, o?: Intl.DateTimeFormatOptions) => (o?.hour ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : d.toISOString().slice(0, 10)),
  }),
}));
class FakeIntersectionObserver { observe() {} disconnect() {} unobserve() {} }
globalThis.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;

afterEach(cleanup);

function timed(id: string, title: string, start: string, duration: string): CalendarEvent {
  return {
    id, uid: id, '@type': 'Event', title, start, duration, timeZone: null, showWithoutTime: false, calendarIds: { cal: true },
  } as unknown as CalendarEvent;
}

describe('Agenda: an overnight event on its second day (pim-p3-16)', () => {
  const train = timed('t', 'Night train to Vienna', '2026-11-27T22:30:00', 'PT9H');
  const dinner = timed('d', 'Dinner', '2026-11-28T20:00:00', 'PT2H');

  it('reads "until 07:30" there and sorts by its end', () => {
    expect(agendaDayPart(train, new Date(2026, 10, 27)).kind).toBe('range');
    expect(agendaDayPart(train, new Date(2026, 10, 28)).kind).toBe('until');
    render(
      <CalendarAgendaView
        focus={{ date: new Date(2026, 10, 27), nonce: 0 }}
        windowKey="agenda:2026-11-27"
        events={[dinner, train]}
        calendars={[{ id: 'cal', name: 'Home', color: '#123456' } as unknown as Calendar]}
        rangeStart={new Date(2026, 10, 27)}
        rangeEnd={new Date(2026, 11, 5)}
        onSelectEvent={vi.fn()}
      />,
    );
    const rows = screen.getAllByRole('button').filter((b) => /Night train|Dinner/.test(b.textContent ?? ''));
    // Friday: the train; Saturday: the train's morning first, then dinner.
    expect(rows.map((r) => (r.textContent?.includes('Night') ? 'train' : 'dinner'))).toEqual(['train', 'train', 'dinner']);
    expect(rows[1].textContent).toContain('ux_p3_pim_cal.agenda_until');
    expect(rows[0].textContent).not.toContain('agenda_until');
  });
});

describe('calendar wording (pim-p3-17)', () => {
  it('ends the event menu\'s Print with "…", as it opens the print dialog', () => {
    render(
      <EventContextMenu
        event={timed('e', 'Standup', '2026-11-27T10:00:00', 'PT1H')}
        position={{ x: 10, y: 10 }}
        isOpen
        onClose={vi.fn()}
        onEdit={vi.fn()}
        onDuplicate={vi.fn()}
        onExportICS={vi.fn()}
        onCopyTitle={vi.fn()}
        onDelete={vi.fn()}
        onPrint={vi.fn()}
        menuRef={createRef()}
      />,
    );
    expect(screen.getByRole('menuitem', { name: 'ux_p3_pim_cal.print' })).toBeInTheDocument();
    expect((en as unknown as { ux_p3_pim_cal: { print: string } }).ux_p3_pim_cal.print).toBe('Print…');
  });

  it('spells "cancelled" one way in English', () => {
    const found: string[] = [];
    (function walk(o: Record<string, unknown>, path: string) {
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === 'string') { if (/\bcancel(ed|ing)\b/i.test(v)) found.push(`${path}${k}`); } else walk(v as Record<string, unknown>, `${path}${k}.`);
      }
    })(en as unknown as Record<string, unknown>, '');
    expect(found).toEqual([]);
  });

  it('uses "…" in German wherever English does', () => {
    const found: string[] = [];
    (function walk(d: Record<string, unknown>, e: Record<string, unknown> | undefined, path: string) {
      for (const [k, v] of Object.entries(d)) {
        const ev = e?.[k];
        if (typeof v === 'string') { if (v.includes('...') && typeof ev === 'string' && ev.includes('…')) found.push(`${path}${k}`); } else walk(v as Record<string, unknown>, ev as Record<string, unknown> | undefined, `${path}${k}.`);
      }
    })(de as unknown as Record<string, unknown>, en as unknown as Record<string, unknown>, '');
    expect(found).toEqual([]);
  });
});
