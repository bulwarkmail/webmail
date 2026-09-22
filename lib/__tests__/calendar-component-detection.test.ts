import { describe, it, expect } from 'vitest';
import { isTaskLikeObject, findTasksOnlyCalendarIds, isTasksOnlyCalendarName, type ScannedCalendarObject } from '@/lib/calendar-component-detection';

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

describe('isTasksOnlyCalendarName', () => {
  it('detects common task calendar names in English and German', () => {
    expect(isTasksOnlyCalendarName('Aufgaben')).toBe(true);
    expect(isTasksOnlyCalendarName('aufgaben')).toBe(true);
    expect(isTasksOnlyCalendarName('Tasks')).toBe(true);
    expect(isTasksOnlyCalendarName('Task')).toBe(true);
    expect(isTasksOnlyCalendarName('To-Do')).toBe(true);
    expect(isTasksOnlyCalendarName('Todos')).toBe(true);
    expect(isTasksOnlyCalendarName('To Do')).toBe(true);
    expect(isTasksOnlyCalendarName('Erinnerungen')).toBe(true);
    expect(isTasksOnlyCalendarName('Reminders')).toBe(true);
  });

  it('rejects regular event calendar names', () => {
    expect(isTasksOnlyCalendarName('Kalender')).toBe(false);
    expect(isTasksOnlyCalendarName('Sport')).toBe(false);
    expect(isTasksOnlyCalendarName('Dataport')).toBe(false);
    expect(isTasksOnlyCalendarName('Feiertage')).toBe(false);
    expect(isTasksOnlyCalendarName('')).toBe(false);
    expect(isTasksOnlyCalendarName(null)).toBe(false);
    expect(isTasksOnlyCalendarName(undefined)).toBe(false);
  });
});

describe('findTasksOnlyCalendarIds', () => {
  it('flags a calendar whose objects are all tasks', () => {
    const objects: ScannedCalendarObject[] = [
      { '@type': 'Task', calendarIds: { 'cal-tasks': true } },
      { due: '2026-01-01T00:00:00', calendarIds: { 'cal-tasks': true } },
    ];
    expect([...findTasksOnlyCalendarIds(objects, [{ id: 'cal-tasks', name: 'Work Tasks' }])]).toEqual(['cal-tasks']);
  });

  it('flags a calendar named Aufgaben even if server returns objects without task fields or empty', () => {
    const objects: ScannedCalendarObject[] = [
      { id: '1', title: 'Task 1', calendarIds: { 'cal-aufgaben': true } },
      { id: '2', title: 'Task 2', calendarIds: { 'cal-aufgaben': true } },
    ];
    expect([...findTasksOnlyCalendarIds(objects, [{ id: 'cal-aufgaben', name: 'Aufgaben' }])]).toEqual(['cal-aufgaben']);
    expect([...findTasksOnlyCalendarIds([], [{ id: 'cal-aufgaben', name: 'Aufgaben' }])]).toEqual(['cal-aufgaben']);
  });

  it('does not flag a calendar that has at least one event', () => {
    const objects: ScannedCalendarObject[] = [
      { '@type': 'Task', calendarIds: { 'cal-mixed': true } },
      { '@type': 'Event', calendarIds: { 'cal-mixed': true } },
    ];
    expect(findTasksOnlyCalendarIds(objects, [{ id: 'cal-mixed', name: 'Mixed' }]).size).toBe(0);
  });

  it('does not flag an empty regular event calendar', () => {
    expect(findTasksOnlyCalendarIds([], [{ id: 'cal-empty', name: 'Work' }]).size).toBe(0);
    const objects: ScannedCalendarObject[] = [{ '@type': 'Event', calendarIds: { 'cal-other': true } }];
    expect(findTasksOnlyCalendarIds(objects, [{ id: 'cal-empty', name: 'Work' }]).size).toBe(0);
  });

  it('classifies each calendar independently in a mixed account', () => {
    const objects: ScannedCalendarObject[] = [
      { '@type': 'Event', calendarIds: { work: true } },
      { '@type': 'Task', calendarIds: { todos: true } },
      { percentComplete: 50, calendarIds: { todos: true } },
    ];
    const result = findTasksOnlyCalendarIds(objects, [
      { id: 'work', name: 'Work' },
      { id: 'todos', name: 'To-Do' },
      { id: 'empty', name: 'Personal' },
    ]);
    expect([...result]).toEqual(['todos']);
  });

  it('handles an object that belongs to several calendars', () => {
    const objects: ScannedCalendarObject[] = [
      { '@type': 'Event', calendarIds: { a: true, b: true } },
      { '@type': 'Task', calendarIds: { b: true } },
    ];
    expect(findTasksOnlyCalendarIds(objects, [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]).size).toBe(0);
  });
});
