import { describe, it, expect } from 'vitest';
import { isTaskLikeObject, findTasksOnlyCalendarIds, type ScannedCalendarObject } from '@/lib/calendar-component-detection';

describe('isTaskLikeObject', () => {
  it('treats an explicit @type Task as a task', () => {
    expect(isTaskLikeObject({ '@type': 'Task' })).toBe(true);
    expect(isTaskLikeObject({ '@type': 'task' })).toBe(true);
  });

  it('treats an @type Event as not a task even with a stray field', () => {
    expect(isTaskLikeObject({ '@type': 'Event' })).toBe(false);
    expect(isTaskLikeObject({ '@type': 'Event', due: '2026-01-01T00:00:00' })).toBe(false);
  });

  it('detects a CalDAV task lacking @type by its task-only fields', () => {
    expect(isTaskLikeObject({ due: '2026-01-01T00:00:00' })).toBe(true);
    expect(isTaskLikeObject({ progress: 'needs-action' })).toBe(true);
    expect(isTaskLikeObject({ percentComplete: 0 })).toBe(true);
  });

  it('treats a plain object with no task markers as an event', () => {
    expect(isTaskLikeObject({})).toBe(false);
    expect(isTaskLikeObject({ '@type': 'Event', title: 'Standup' })).toBe(false);
  });
});

describe('findTasksOnlyCalendarIds', () => {
  it('flags a calendar whose objects are all tasks', () => {
    const objects: ScannedCalendarObject[] = [
      { '@type': 'Task', calendarIds: { 'cal-tasks': true } },
      { due: '2026-01-01T00:00:00', calendarIds: { 'cal-tasks': true } },
    ];
    expect([...findTasksOnlyCalendarIds(objects, ['cal-tasks'])]).toEqual(['cal-tasks']);
  });

  it('does not flag a calendar that has at least one event', () => {
    const objects: ScannedCalendarObject[] = [
      { '@type': 'Task', calendarIds: { 'cal-mixed': true } },
      { '@type': 'Event', calendarIds: { 'cal-mixed': true } },
    ];
    expect(findTasksOnlyCalendarIds(objects, ['cal-mixed']).size).toBe(0);
  });

  it('does not flag an empty calendar (no objects)', () => {
    expect(findTasksOnlyCalendarIds([], ['cal-empty']).size).toBe(0);
    const objects: ScannedCalendarObject[] = [{ '@type': 'Event', calendarIds: { 'cal-other': true } }];
    expect(findTasksOnlyCalendarIds(objects, ['cal-empty']).size).toBe(0);
  });

  it('classifies each calendar independently in a mixed account', () => {
    const objects: ScannedCalendarObject[] = [
      { '@type': 'Event', calendarIds: { work: true } },
      { '@type': 'Task', calendarIds: { todos: true } },
      { percentComplete: 50, calendarIds: { todos: true } },
    ];
    const result = findTasksOnlyCalendarIds(objects, ['work', 'todos', 'empty']);
    expect([...result]).toEqual(['todos']);
  });

  it('handles an object that belongs to several calendars', () => {
    // An event shared into two calendars keeps both off the tasks-only list.
    const objects: ScannedCalendarObject[] = [
      { '@type': 'Event', calendarIds: { a: true, b: true } },
      { '@type': 'Task', calendarIds: { b: true } },
    ];
    expect(findTasksOnlyCalendarIds(objects, ['a', 'b']).size).toBe(0);
  });
});
