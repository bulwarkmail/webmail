import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { Calendar, CalendarTask } from '@/lib/jmap/types';

// Due dates were formatted with date-fns' English month names, so a German
// list read "Oct 30" next to "Überfällig". They follow the app's language.
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'de',
  useFormatter: () => ({
    dateTime: (d: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('de-DE', options).format(d),
  }),
}));

import { TaskListView } from '../task-list-view';

const calendars = [{ id: 'cal', name: 'Privat', color: '#123456' }] as unknown as Calendar[];

describe('TaskListView due dates', () => {
  it('writes the due date in the app language', () => {
    const task = { id: 't', title: 'Steuer', calendarIds: { cal: true }, progress: 'needs-action', priority: 0, due: '2031-10-30', showWithoutTime: true } as unknown as CalendarTask;
    render(<TaskListView tasks={[task]} calendars={calendars} filter="all" onSelectTask={() => {}} onToggleComplete={() => {}} />);
    expect(screen.getByText('30. Okt.')).toBeInTheDocument();
    expect(screen.queryByText('Oct 30')).toBeNull();
  });
});
