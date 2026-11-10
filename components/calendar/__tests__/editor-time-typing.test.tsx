import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EventModal } from '../event-modal';
import { TaskModal } from '../task-modal';
import { useSettingsStore } from '@/stores/settings-store';
import { getBrowserTimeZone } from '@/lib/timezone';
import type { Calendar, CalendarEvent, CalendarTask } from '@/lib/jmap/types';

// #1616 follow-ups: typing a time into the editors' time fields, and saving
// what was typed.

// New York, where 2026-11-01 has an hour twice. Set before the imports run:
// the app reads the browser zone once and keeps it.
const ORIGINAL_TZ = vi.hoisted(() => {
  const original = process.env.TZ;
  process.env.TZ = 'America/New_York';
  return original;
});
beforeAll(() => {
  expect(getBrowserTimeZone()).toBe('America/New_York');
});
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

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

function eventEditor(start: string, duration: string) {
  const event = {
    id: 'e1', uid: 'u1', '@type': 'Event', title: 'Planning', description: '',
    start, duration, timeZone: null,
    showWithoutTime: false, calendarIds: { cal: true }, participants: null, alerts: null, recurrenceRules: null,
  } as unknown as CalendarEvent;
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<EventModal event={event} startInEditMode calendars={calendars} onSave={onSave} onClose={vi.fn()} />);
  return onSave;
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

function typeInto(input: HTMLInputElement, text: string) {
  for (let i = 1; i <= text.length; i++) fireEvent.change(input, { target: { value: text.slice(0, i) } });
}

afterEach(() => useSettingsStore.setState({ timeFormat: '24h' }));

describe('typing a start time (#1616)', () => {
  it('moves the end once, by the whole time, on the day the clocks go back', () => {
    // "1", "15", "153" and "15:3" each moved the end on the way to "15:30",
    // and one of those steps crossed the repeated hour and lost it.
    eventEditor('2026-11-01T10:00:00', 'PT1H30M');
    typeInto(field('form.start_time'), '15:30');
    expect(field('form.end_time').value).toBe('17:00');
  });

  it('saves a half-typed time when Save is clicked, since the field loses focus first', async () => {
    const onSave = eventEditor('2026-11-05T10:00:00', 'PT1H');
    const start = field('form.start_time');
    start.focus();
    typeInto(start, '930');
    expect(field('form.end_time').value).toBe('11:00');
    const save = screen.getByText('form.save').closest('button')!;
    // A click moves the focus on mousedown, before the click itself.
    // (@testing-library/user-event isn't installed to do this for us.)
    fireEvent.mouseDown(save);
    act(() => save.focus());
    expect(start.value).toBe('09:30');
    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toMatchObject({ start: '2026-11-05T09:30:00', duration: 'PT1H' });
  });

  it('saves the typed time with Ctrl+Enter from the field', async () => {
    const onSave = eventEditor('2026-11-05T10:00:00', 'PT1H');
    const start = field('form.start_time');
    start.focus();
    typeInto(start, '930');
    fireEvent.keyDown(start, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toMatchObject({ start: '2026-11-05T09:30:00', duration: 'PT1H' });
  });
});

describe('the task due time (#1616)', () => {
  const task = (due: string, showWithoutTime: boolean) => ({
    id: 't1', uid: 't1', '@type': 'Task', title: 'Report', description: '',
    due, showWithoutTime, calendarIds: { cal: true },
  } as unknown as CalendarTask);

  it('starts at 9:00 when "Include time" is ticked, and saves that time', async () => {
    useSettingsStore.setState({ timeFormat: '12h' });
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TaskModal task={task('2026-11-05', true)} calendars={calendars} onSave={onSave} onClose={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('tasks.include_time'));
    expect(screen.getByDisplayValue('9:00 AM')).toBeInTheDocument();
    fireEvent.click(screen.getByText('tasks.save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toMatchObject({ due: '2026-11-05T09:00:00', showWithoutTime: false });
  });

  it('saves the typed time with Ctrl+Enter from the field', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TaskModal task={task('2026-11-05T16:00:00', false)} calendars={calendars} onSave={onSave} onClose={vi.fn()} />);
    const due = screen.getByDisplayValue('16:00') as HTMLInputElement;
    due.focus();
    typeInto(due, '930');
    fireEvent.keyDown(due, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toMatchObject({ due: '2026-11-05T09:30:00', showWithoutTime: false });
  });
});
