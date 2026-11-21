import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TaskModal } from '../task-modal';
import type { CalendarTask, Calendar } from '@/lib/jmap/types';

// #504: the edit dialog shows only the first alert, and saving used to write
// `alerts` back unconditionally - deleting every alarm it did not display.

const calendars = [{ id: 'cal-1', name: 'Tasks', isShared: false }] as unknown as Calendar[];

function makeTask(): CalendarTask {
  return {
    id: 'task-1',
    '@type': 'Task',
    uid: 'uid-1',
    title: 'Pay rent',
    description: '',
    due: '2026-09-10',
    showWithoutTime: true,
    priority: 0,
    progress: 'needs-action',
    progressUpdated: null,
    calendarIds: { 'cal-1': true },
    alerts: {
      'a-15': {
        '@type': 'Alert',
        trigger: { '@type': 'OffsetTrigger', offset: '-PT15M', relativeTo: 'start' },
        action: 'display',
        acknowledged: null,
        relatedTo: null,
      },
      'a-abs': {
        '@type': 'Alert',
        trigger: { '@type': 'AbsoluteTrigger', when: '2026-09-09T08:00:00Z' },
        action: 'email',
        acknowledged: null,
        relatedTo: null,
      },
    },
  } as unknown as CalendarTask;
}

describe('TaskModal alert preservation (#504)', () => {
  it('leaves alerts out of the patch when the alert control was not touched', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TaskModal task={makeTask()} calendars={calendars} onSave={onSave} onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('tasks.save'));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const patch = onSave.mock.calls[0][0] as Partial<CalendarTask>;
    expect(patch).not.toHaveProperty('alerts');
    expect(patch.title).toBe('Pay rent');
  });

  it('merges a changed alert into the existing map instead of replacing it', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TaskModal task={makeTask()} calendars={calendars} onSave={onSave} onClose={vi.fn()} />);

    fireEvent.change(screen.getByDisplayValue('tasks.alert_15min'), { target: { value: '60' } });
    fireEvent.click(screen.getByText('tasks.save'));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const patch = onSave.mock.calls[0][0] as Partial<CalendarTask>;
    expect(patch.alerts).toBeDefined();
    expect(Object.keys(patch.alerts!)).toEqual(['a-15', 'a-abs']);
    expect(patch.alerts!['a-15'].trigger).toMatchObject({ '@type': 'OffsetTrigger', offset: '-PT60M' });
    expect(patch.alerts!['a-abs'].trigger).toMatchObject({ '@type': 'AbsoluteTrigger' });
  });

  it('counts a changed alert from the due date, the end of a task', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TaskModal task={makeTask()} calendars={calendars} onSave={onSave} onClose={vi.fn()} />);

    fireEvent.change(screen.getByDisplayValue('tasks.alert_15min'), { target: { value: '30' } });
    fireEvent.click(screen.getByText('tasks.save'));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const patch = onSave.mock.calls[0][0] as Partial<CalendarTask>;
    expect(patch.alerts!['a-15'].trigger).toEqual({ '@type': 'OffsetTrigger', offset: '-PT30M', relativeTo: 'end' });
  });

  it('removes only the displayed alert when set to none', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TaskModal task={makeTask()} calendars={calendars} onSave={onSave} onClose={vi.fn()} />);

    fireEvent.change(screen.getByDisplayValue('tasks.alert_15min'), { target: { value: 'none' } });
    fireEvent.click(screen.getByText('tasks.save'));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const patch = onSave.mock.calls[0][0] as Partial<CalendarTask>;
    expect(Object.keys(patch.alerts!)).toEqual(['a-abs']);
  });
});

// Stalwart 1.0 shows a task's calendar defaults in `alerts`, under the
// default alerts' ids, while `useDefaultAlerts` is on, and drops alerts with
// those ids on save.
describe('TaskModal alerts of a task that uses the calendar defaults', () => {
  const defaultsTask = () => ({
    ...makeTask(),
    useDefaultAlerts: true,
    alerts: {
      'default-15': {
        '@type': 'Alert',
        trigger: { '@type': 'OffsetTrigger', offset: '-PT15M', relativeTo: 'start' },
        action: 'display',
        acknowledged: null,
        relatedTo: null,
      },
    },
  } as unknown as CalendarTask);

  it('turns the defaults off and moves the alerts to ids of their own when the alert changes on Stalwart 1.0', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TaskModal task={defaultsTask()} calendars={calendars} onSave={onSave} onClose={vi.fn()} />);

    fireEvent.change(screen.getByDisplayValue('tasks.alert_15min'), { target: { value: '60' } });
    fireEvent.click(screen.getByText('tasks.save'));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const patch = onSave.mock.calls[0][0] as Partial<CalendarTask>;
    expect(patch.useDefaultAlerts).toBe(false);
    expect(Object.keys(patch.alerts!)).toEqual(['alert1']);
    expect(patch.alerts!.alert1.trigger).toMatchObject({ offset: '-PT60M' });
  });

  it('leaves the defaults alone when the alert was not touched', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TaskModal task={defaultsTask()} calendars={calendars} onSave={onSave} onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('tasks.save'));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const patch = onSave.mock.calls[0][0] as Partial<CalendarTask>;
    expect(patch).not.toHaveProperty('alerts');
    expect(patch).not.toHaveProperty('useDefaultAlerts');
  });
});
