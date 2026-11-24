import { describe, it, expect } from 'vitest';
import type { CalendarTask } from '@/lib/jmap/types';
import { findParentTask, nestTasks, subtaskRelatedTo, taskParentUid } from '../task-subtasks';

// #1048: tasks.org, Nextcloud and jtx Board link a subtask to its parent with
// RELATED-TO. Stalwart returns it as relatedTo: { <parent uid>: { relation: { parent: true } } },
// and a bare RELATED-TO (no RELTYPE, as tasks.org writes it) as { <uid>: {} }.

function task(id: string, extra: Partial<CalendarTask> = {}): CalendarTask {
  return { id, uid: `uid-${id}`, title: id, calendarIds: { home: true }, relatedTo: null, ...extra } as CalendarTask;
}
const under = (parent: string) => ({ [`uid-${parent}`]: { '@type': 'Relation' as const, relation: { parent: true } } });

describe('taskParentUid', () => {
  it('reads a parent relation', () => {
    expect(taskParentUid(task('b', { relatedTo: under('a') }))).toBe('uid-a');
  });

  it('reads a bare RELATED-TO, which Stalwart returns with no relation, as the parent', () => {
    const bare = { 'uid-a': {} } as unknown as CalendarTask['relatedTo'];
    expect(taskParentUid(task('b', { relatedTo: bare }))).toBe('uid-a');
  });

  it('skips links that name another kind of relation, and the task itself', () => {
    const relatedTo = {
      'uid-c': { '@type': 'Relation', relation: { child: true } },
      'uid-b': { '@type': 'Relation', relation: { parent: true } },
      'uid-d': { '@type': 'Relation', relation: { sibling: true } },
    } as CalendarTask['relatedTo'];
    expect(taskParentUid(task('b', { relatedTo }))).toBeNull();
  });
});

describe('subtaskRelatedTo', () => {
  it('links to the parent by uid with a parent relation', () => {
    expect(subtaskRelatedTo(task('a'))).toEqual(under('a'));
  });
});

describe('nestTasks', () => {
  it('puts each subtask right under its parent, in the order it had among its siblings', () => {
    // The list's sort put the subtasks before their parent.
    const rows = nestTasks([
      task('b2', { relatedTo: under('a') }),
      task('c', { relatedTo: under('b2') }),
      task('x'),
      task('b1', { relatedTo: under('a') }),
      task('a'),
    ]);
    expect(rows.map((r) => [r.task.id, r.depth, r.parent?.id ?? null])).toEqual([
      ['x', 0, null],
      ['a', 0, null],
      ['b2', 1, 'a'],
      ['c', 2, 'b2'],
      ['b1', 1, 'a'],
    ]);
  });

  it('shows a subtask whose parent is not in the list at the top level', () => {
    const rows = nestTasks([task('b', { relatedTo: under('gone') })]);
    expect(rows.map((r) => [r.task.id, r.depth])).toEqual([['b', 0]]);
  });

  it('does not match a parent of the same uid in another login', () => {
    const rows = nestTasks([
      task('a', { localAccountId: 'one' }),
      task('b', { localAccountId: 'two', relatedTo: under('a') }),
    ]);
    expect(rows.map((r) => r.depth)).toEqual([0, 0]);
  });

  it('shows every task once when parents form a loop', () => {
    const rows = nestTasks([task('a', { relatedTo: under('b') }), task('b', { relatedTo: under('a') })]);
    expect(rows.map((r) => r.task.id).sort()).toEqual(['a', 'b']);
    expect(rows[0].depth).toBe(0);
  });
});

describe('findParentTask', () => {
  it('finds the parent among the tasks', () => {
    const a = task('a');
    expect(findParentTask(task('b', { relatedTo: under('a') }), [a])).toBe(a);
    expect(findParentTask(task('b'), [a])).toBeNull();
  });
});
