import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { CalendarSkeleton } from '../calendar-skeleton';
import { TasksSkeleton } from '../tasks-skeleton';

// #1698: Tasks have a rail entry only when the user turned the Tasks app on,
// so the skeleton draws it only when the last rail had it (bulwark-boot-hints),
// and on the Tasks page itself.

function html(element: React.ReactElement) {
  const container = document.createElement('div');
  container.innerHTML = renderToString(element);
  return container;
}

const classes = (el: Element | null | undefined) => (el?.getAttribute('class') ?? '').split(/\s+/);
// The standard frame's rail (the Pro frame next to it has one too).
const railItem = (container: HTMLElement, id: string) =>
  container.querySelector(`:not([data-pro-shell]) > [aria-hidden="true"] [data-sk-rail="${id}"]`);

describe('the Tasks rail entry in page skeletons', () => {
  it('waits for the rail hint on other pages', () => {
    const tasks = railItem(html(<CalendarSkeleton label="Loading" />), 'tasks');
    expect(classes(tasks)).toEqual(expect.arrayContaining(['hidden', 'boot-rail-tasks:flex']));
  });

  it('is drawn, and marked, on the Tasks page', () => {
    const tasks = railItem(html(<TasksSkeleton label="Loading" />), 'tasks');
    expect(classes(tasks)).not.toContain('hidden');
    expect(classes(tasks)).toContain('bg-primary/10');
  });
});

describe('TasksSkeleton', () => {
  it('is the tasks page, with its name, filters and quick add', () => {
    const container = html(
      <TasksSkeleton
        label="Loading"
        text={{ title: 'Tasks', filters: ['All', 'Pending', 'Overdue', 'Completed'], quickAdd: 'Add a task…' }}
      />,
    );
    const page = container.querySelector('[data-boot-skeleton="tasks"]');
    expect(page).not.toBeNull();
    const text = page?.textContent ?? '';
    for (const word of ['Tasks', 'All', 'Pending', 'Overdue', 'Completed', 'Add a task…']) expect(text).toContain(word);
    // No calendar in it: no Today button, no month grid.
    expect(page?.querySelector('.sk-cal-mini-days')).toBeNull();
  });
});
