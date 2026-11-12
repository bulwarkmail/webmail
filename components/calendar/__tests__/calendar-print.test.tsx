import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Calendar, CalendarEvent, CalendarTask } from '@/lib/jmap/types';
import { useSettingsStore } from '@/stores/settings-store';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) => (params ? `${key}${JSON.stringify(params)}` : key),
  useLocale: () => 'en',
  useFormatter: () => ({
    dateTime: (d: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en', options).format(d),
  }),
}));

import { CalendarPrint, type CalendarPrintProps } from '../calendar-print';

const calendars = [{ id: 'work', name: 'Work', color: '#db2d54' }] as unknown as Calendar[];

function event(id: string, start: string, duration: string, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id, uid: id, title: id, start, duration, showWithoutTime: false, calendarIds: { work: true }, status: 'confirmed', ...extra,
  } as unknown as CalendarEvent;
}

function renderPrint(props: Partial<CalendarPrintProps>) {
  render(
    <CalendarPrint
      content={{ kind: 'view' }}
      viewMode="month"
      periodDate={new Date(2026, 9, 15)}
      weekStart={new Date(2026, 9, 26)}
      rangeStart={new Date(2026, 9, 1)}
      rangeEnd={new Date(2026, 9, 31)}
      events={[]}
      calendars={calendars}
      shownCalendars={calendars}
      tasks={[]}
      taskFilter="all"
      selectedCalendarIds={['work']}
      timeFormat="24h"
      timeZone="Europe/Berlin"
      currentUserEmails={[]}
      {...props}
    />,
  );
  return document.querySelector('[data-print-root]') as HTMLElement;
}

beforeEach(() => {
  document.body.innerHTML = '';
  useSettingsStore.setState({ firstDayOfWeek: 1, calendarLimitHours: true, calendarDayStartHour: 8, calendarDayEndHour: 18 });
});

describe('CalendarPrint', () => {
  it('prints the month on screen as its weeks, on a landscape page with the period, calendars and time zone', () => {
    const root = renderPrint({});
    expect(root.dataset.orientation).toBe('landscape');
    expect(root.querySelector('.pr-title')?.textContent).toBe('October 2026');
    expect(root.querySelector('.pr-meta')?.textContent).toContain('print.calendars{"names":"Work"}');
    expect(root.querySelector('.pr-meta')?.textContent).toContain('Central European Time (Europe/Berlin)');
    // 28 Sep to 1 Nov with Monday first.
    expect(root.querySelectorAll('.pr-month-week')).toHaveLength(5);
  });

  it('adds "+N more" only to a day whose entries do not fit its cell', () => {
    const busy = Array.from({ length: 8 }, (_, i) => event(`busy${i}`, `2026-10-14T${String(8 + i).padStart(2, '0')}:00:00`, 'PT30M'));
    const root = renderPrint({ events: [...busy, event('quiet', '2026-10-15T09:00:00', 'PT1H')] });
    const more = [...root.querySelectorAll('.pr-more')].map((m) => m.textContent);
    // Five weeks leave room for six lines a day: five entries and the link.
    expect(more).toEqual(['events.more{"count":3}']);
    expect(root.textContent).toContain('quiet');
  });

  const weekly = {
    id: 'bins', '@type': 'Task', uid: 'bins', title: 'Put out the bins', due: '2026-10-05T00:00:00', showWithoutTime: true,
    progress: 'needs-action', calendarIds: { work: true }, recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly' }],
  } as unknown as CalendarTask;
  const timesPrinted = (root: HTMLElement) => (root.textContent?.match(/Put out the bins/g) ?? []).length;

  it('prints a repeating task on each day of the month it is due', () => {
    // 5, 12, 19 and 26 October.
    expect(timesPrinted(renderPrint({ gridTasks: [weekly] }))).toBe(4);
  });

  it('prints a repeating task in a week after the one it started in', () => {
    expect(timesPrinted(renderPrint({ viewMode: 'week', gridTasks: [weekly] }))).toBe(1);
  });

  it('prints the week on screen from its first day, the all-day row above the hours', () => {
    const root = renderPrint({
      viewMode: 'week',
      events: [event('offsite', '2026-10-27T00:00:00', 'P2D', { showWithoutTime: true }), event('standup', '2026-10-28T09:15:00', 'PT15M')],
    });
    expect(root.querySelectorAll('.pr-tg-dayhead')).toHaveLength(7);
    const allDay = root.querySelector('.pr-tg-allday') as HTMLElement;
    expect(allDay.textContent).toContain('offsite');
    expect(allDay.compareDocumentPosition(root.querySelector('.pr-tg-body')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(root.querySelector('.pr-tg-body')?.textContent).toContain('standup');
  });

  it('widens the configured hours so an event outside them is still printed', () => {
    const root = renderPrint({ viewMode: 'week', events: [event('flight', '2026-10-29T05:45:00', 'PT30M')] });
    const labels = [...root.querySelectorAll('.pr-tg-hour-label')].map((l) => l.textContent);
    expect(labels[0]).toBe('05:00');
    expect(labels.at(-1)).toBe('17:00');
    expect(root.textContent).toContain('flight');
  });

  it('draws overlapping events side by side', () => {
    const root = renderPrint({
      viewMode: 'day',
      periodDate: new Date(2026, 9, 29),
      events: [event('a', '2026-10-29T10:00:00', 'PT1H'), event('b', '2026-10-29T10:30:00', 'PT1H')],
    });
    const blocks = [...root.querySelectorAll<HTMLElement>('.pr-tg-event')];
    expect(blocks.map((b) => [b.style.insetInlineStart, b.style.width])).toEqual([['0%', '50%'], ['50%', '50%']]);
  });

  it('keeps each agenda day heading together with its first event', () => {
    const root = renderPrint({
      viewMode: 'agenda',
      events: [event('first', '2026-10-14T09:00:00', 'PT1H'), event('second', '2026-10-14T11:00:00', 'PT1H')],
    });
    const keep = root.querySelector('.pr-keep') as HTMLElement;
    expect(keep.querySelector('.pr-day-heading')).not.toBeNull();
    expect(keep.textContent).toContain('first');
    expect(keep.textContent).not.toContain('second');
    expect(root.textContent).toContain('second');
  });

  it('prints one event on a sheet, with its people and their answers, as plain text', () => {
    const root = renderPrint({
      content: {
        kind: 'event',
        event: event('<img src=x onerror=alert(1)>', '2026-10-29T14:00:00', 'PT1H', {
          description: '<script>alert(1)</script>\nSecond line',
          participants: {
            p1: { name: 'Alice', email: 'alice@example.com', roles: { owner: true, attendee: true }, participationStatus: 'accepted' },
            p2: { name: 'Bob', email: 'bob@example.com', roles: { attendee: true }, participationStatus: 'tentative' },
          },
        } as unknown as Partial<CalendarEvent>),
      },
    });
    expect(root.dataset.orientation).toBe('portrait');
    expect(root.querySelector('img, script')).toBeNull();
    expect(root.querySelector('h1')?.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(root.querySelector('.pr-text')?.textContent).toBe('<script>alert(1)</script>\nSecond line');
    const people = [...root.querySelectorAll('.pr-member-row')].map((r) => r.textContent);
    expect(people).toEqual([
      'Alice (participants.organizer_role)alice@example.comparticipants.accepted',
      'Bobbob@example.comparticipants.tentative',
    ]);
    expect(root.textContent).toContain('Alice <alice@example.com>');
  });
});
