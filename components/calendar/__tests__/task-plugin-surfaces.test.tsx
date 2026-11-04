import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { TaskModal } from '../task-modal';
import { TaskToolbar } from '../task-toolbar';
import { filterTasksForList } from '../task-list-view';
import { resetActions, setActionDispatcher, setPluginActions } from '@/lib/plugin-sandbox/actions';
import { clearSlotOffers, framePropsOf, offerSlots } from '@/components/plugins/__tests__/fake-slot-offer';
import type { Calendar, CalendarTask } from '@/lib/jmap/types';

// Plugin surfaces for tasks: a section in a task's details and buttons in
// the task list toolbar acting on the tasks the list shows.

vi.mock('@/components/plugins/plugin-iframe-slot', () => import('@/components/plugins/__tests__/fake-slot-offer'));

const calendars = [{ id: 'cal-1', name: 'Tasks', isShared: false }] as unknown as Calendar[];

function makeTask(id: string, overrides: Partial<CalendarTask> = {}): CalendarTask {
  return {
    id,
    '@type': 'Task',
    uid: `uid-${id}`,
    title: `Task ${id}`,
    description: '',
    due: null,
    showWithoutTime: true,
    priority: 0,
    progress: 'needs-action',
    calendarIds: { 'cal-1': true },
    alerts: null,
    ...overrides,
  } as unknown as CalendarTask;
}

const dispatch = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  dispatch.mockClear();
  setActionDispatcher(dispatch);
});

afterEach(() => {
  cleanup();
  clearSlotOffers();
  resetActions();
  setActionDispatcher(null);
});

describe('task-detail-section', () => {
  it('shows an open task to the plugin', () => {
    offerSlots('p1', ['task-detail-section']);
    render(<TaskModal task={makeTask('t1', { priority: 5 })} calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} />);

    const frame = screen.getByTestId('plugin-frame-task-detail-section');
    expect(framePropsOf(frame).task).toMatchObject({ id: 't1', uid: 'uid-t1', title: 'Task t1', priority: 5, calendarId: 'cal-1', isComplete: false });
  });

  it('is not shown for a new task or without a plugin', () => {
    offerSlots('p1', ['task-detail-section']);
    const { unmount } = render(<TaskModal calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByTestId('plugin-frame-task-detail-section')).toBeNull();
    unmount();

    clearSlotOffers();
    render(<TaskModal task={makeTask('t1')} calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(document.querySelector('[data-plugin-slot]')).toBeNull();
  });
});

describe('task-list-actions', () => {
  const toolbar = {
    filter: 'all' as const,
    onFilterChange: vi.fn(),
    onCreateTask: vi.fn(),
  };

  it('puts plugin buttons after the create button and sends the listed task ids', async () => {
    act(() => setPluginActions('pm', 'Planner', 'task-list-actions', [{ id: 'plan', label: 'Plan my day' }]));
    render(<TaskToolbar {...toolbar} taskIds={['t2', 't1']} />);

    const button = screen.getByRole('button', { name: 'Plan my day' });
    expect(screen.getByText('tasks.create').compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await act(async () => { fireEvent.click(button); });
    expect(dispatch).toHaveBeenCalledWith('pm', 'task-list-actions', 'plan', { taskIds: ['t2', 't1'] });
  });

  it('draws icon-only buttons when compact', () => {
    act(() => setPluginActions('pm', 'Planner', 'task-list-actions', [{ id: 'plan', label: 'Plan my day' }]));
    render(<TaskToolbar {...toolbar} taskIds={[]} compact />);
    expect(screen.getByRole('button', { name: 'Plan my day' })).not.toHaveTextContent('Plan my day');
  });

  it('renders nothing without a plugin', () => {
    render(<TaskToolbar {...toolbar} taskIds={['t1']} />);
    expect(document.querySelector('[data-plugin-actions]')).toBeNull();
  });

  it('lists the ids the task list shows, in its order', () => {
    const tasks = [
      makeTask('done', { progress: 'completed' }),
      makeTask('later', { due: '2030-01-02' }),
      makeTask('other-cal', { calendarIds: { 'cal-2': true } }),
      makeTask('soon', { due: '2030-01-01' }),
    ];
    // All is all of them: completed ones too, at the end.
    // The second argument names the task lists the user unticked (pim-1).
    expect(filterTasksForList(tasks, ['cal-2'], 'all').map((t) => t.id)).toEqual(['soon', 'later', 'done']);
    expect(filterTasksForList(tasks, ['cal-2'], 'pending').map((t) => t.id)).toEqual(['soon', 'later']);
  });
});
