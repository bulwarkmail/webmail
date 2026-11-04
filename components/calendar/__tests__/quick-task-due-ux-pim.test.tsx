import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskListView } from '../task-list-view';
import { useCalendarStore } from '@/stores/calendar-store';

// pim-24: "Call the plumber tomorrow" in "Add a task…" made a task with that
// title and no due date. The date at the end is now the due date, shown as
// a chip before the task is made.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 4, 9, 0));
  useCalendarStore.setState({ hiddenTaskListIds: [] } as never);
});
afterEach(() => vi.useRealTimers());

function setup() {
  const onQuickCreate = vi.fn();
  render(<TaskListView tasks={[]} calendars={[]} filter="all" onSelectTask={() => {}} onToggleComplete={() => {}} onQuickCreate={onQuickCreate} />);
  const input = screen.getByLabelText('tasks.quick_add_placeholder');
  return { input, onQuickCreate };
}

describe('quick task due date (pim-24)', () => {
  it('shows the date as a chip and makes the task due then, without the word', () => {
    const { input, onQuickCreate } = setup();
    fireEvent.change(input, { target: { value: 'Call the plumber tomorrow' } });
    expect(screen.getByTestId('quick-task-due')).toHaveTextContent('quick_task_due');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onQuickCreate).toHaveBeenCalledWith('Call the plumber', '2026-11-05');
  });

  it('keeps the words in the title when the chip is dismissed', () => {
    const { input, onQuickCreate } = setup();
    fireEvent.change(input, { target: { value: 'Call the plumber tomorrow' } });
    fireEvent.click(screen.getByRole('button', { name: 'quick_task_due_remove' }));
    expect(screen.queryByTestId('quick-task-due')).toBeNull();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onQuickCreate).toHaveBeenCalledWith('Call the plumber tomorrow', null);
  });

  it('makes a task without a date as before', () => {
    const { input, onQuickCreate } = setup();
    fireEvent.change(input, { target: { value: 'Water the plants' } });
    expect(screen.queryByTestId('quick-task-due')).toBeNull();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onQuickCreate).toHaveBeenCalledWith('Water the plants', null);
  });
});
