import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventModal } from '../event-modal';
import { TaskModal } from '../task-modal';
import { useSettingsStore } from '@/stores/settings-store';
import type { Calendar, CalendarEvent, CalendarTask } from '@/lib/jmap/types';

// #1616: the editors' time fields were native time inputs, which follow the
// browser's language and showed AM/PM with the 24-hour setting.

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key),
  useLocale: () => 'en',
  useFormatter: () => ({ dateTime: (d: Date | string) => String(d), relativeTime: (d: Date | string) => String(d), number: (n: number) => String(n) }),
}));
vi.mock('../participant-availability', () => ({ ParticipantAvailability: () => null }));

const RIGHTS = {
  mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayWriteOwn: true,
  mayUpdatePrivate: true, mayRSVP: true, mayShare: true, mayDelete: true,
};
const calendars = [{ id: 'cal', name: 'Work', color: '#123456', isDefault: true, myRights: RIGHTS }] as unknown as Calendar[];

const event = {
  id: 'e1', uid: 'u1', '@type': 'Event', title: 'Planning', description: '',
  start: '2026-11-05T10:00:00', duration: 'PT1H', timeZone: null,
  showWithoutTime: false, calendarIds: { cal: true }, participants: null, alerts: null, recurrenceRules: null,
} as unknown as CalendarEvent;

function editor() {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<EventModal event={event} startInEditMode calendars={calendars} onSave={onSave} onClose={vi.fn()} />);
  return onSave;
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

afterEach(() => useSettingsStore.setState({ timeFormat: '24h' }));

describe('the event editor uses the 12/24-hour setting (#1616)', () => {
  it('shows the times on the 24-hour clock with that setting', () => {
    useSettingsStore.setState({ timeFormat: '24h' });
    editor();
    expect(field('form.start_time').value).toBe('10:00');
    expect(field('form.end_time').value).toBe('11:00');
  });

  it('shows the times with AM and PM with the 12-hour setting', () => {
    useSettingsStore.setState({ timeFormat: '12h' });
    editor();
    expect(field('form.start_time').value).toBe('10:00 AM');
    expect(field('form.end_time').value).toBe('11:00 AM');
  });

  it('takes a typed 12-hour time, moves the end with it and saves it on the 24-hour clock', async () => {
    useSettingsStore.setState({ timeFormat: '12h' });
    const onSave = editor();
    fireEvent.change(field('form.start_time'), { target: { value: '2:30 pm' } });
    fireEvent.blur(field('form.start_time'));
    expect(field('form.start_time').value).toBe('2:30 PM');
    expect(field('form.end_time').value).toBe('3:30 PM');
    fireEvent.click(screen.getByText('form.save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toMatchObject({ start: '2026-11-05T14:30:00', duration: 'PT1H' });
  });
});

describe('the task editor uses the 12/24-hour setting (#1616)', () => {
  const task = {
    id: 't1', uid: 't1', '@type': 'Task', title: 'Report', description: '',
    due: '2026-11-05T16:00:00', showWithoutTime: false, calendarIds: { cal: true },
  } as unknown as CalendarTask;

  it('shows the due time on the 24-hour clock with that setting', () => {
    useSettingsStore.setState({ timeFormat: '24h' });
    render(<TaskModal task={task} calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByDisplayValue('16:00')).toBeInTheDocument();
  });

  it('shows the due time with AM and PM with the 12-hour setting', () => {
    useSettingsStore.setState({ timeFormat: '12h' });
    render(<TaskModal task={task} calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByDisplayValue('4:00 PM')).toBeInTheDocument();
  });
});
