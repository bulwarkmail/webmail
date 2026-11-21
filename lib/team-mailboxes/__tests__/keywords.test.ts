import { describe, expect, it } from 'vitest';
import {
  assignChanges,
  assignedKeyword,
  assignedTo,
  assigneesOf,
  doneChanges,
  isAssigneeId,
  isDone,
  keywordList,
  recentAssignees,
  reopenChanges,
  reversePatch,
  unassignChanges,
  removeAssigneeChanges,
  setAssigneesChanges,
} from '../keywords';

describe('assignment keywords', () => {
  it('names the assignee by principal id, lower case, and never by address', () => {
    expect(assignedKeyword('cj')).toBe('$assigned:cj');
    expect(assignedKeyword('C2')).toBe('$assigned:c2');
    expect(() => assignedKeyword('bob@example.org')).toThrow();
    expect(() => assignedKeyword('')).toThrow();
    expect(isAssigneeId('a b')).toBe(false);
    expect(isAssigneeId('x.y-z_1')).toBe(true);
  });

  it('reads assignees and done from a keyword map or list, in any case', () => {
    expect(assigneesOf(['$seen', '$Assigned:CJ'])).toEqual(['cj']);
    expect(assigneesOf({ '$assigned:ck': true, '$assigned:cj': false })).toEqual(['ck']);
    expect(assigneesOf(['$assigned:ci', '$assigned:', '$seen'])).toEqual(['ci']);
    expect(assigneesOf(['$seen'])).toEqual([]);
    expect(isDone(['$DONE'])).toBe(true);
    expect(isDone({ $done: false })).toBe(false);
    expect(keywordList(null)).toEqual([]);
  });

  it('says whether a message is assigned to someone, also after a race', () => {
    expect(assignedTo({ '$assigned:cj': true }, 'CJ')).toBe(true);
    expect(assignedTo({ '$assigned:ci': true, '$assigned:cj': true }, 'cj')).toBe(true);
    expect(assignedTo({ '$assigned:ci': true }, 'cj')).toBe(false);
    expect(assignedTo({ '$assigned:cj': true }, null)).toBe(false);
  });

  it('adds a person to the assignees, leaving the others on it', () => {
    expect(assignChanges({ $seen: true }, 'cj')).toEqual({ '$assigned:cj': true });
    expect(assignChanges({ '$assigned:ci': true }, 'cj')).toEqual({ '$assigned:cj': true });
    expect(assignChanges(['$assigned:ci', '$assigned:ck', '$assigned:cj'], 'cj')).toEqual({});
    expect(assignChanges({ '$assigned:cj': true }, 'CJ')).toEqual({});
  });

  it('takes one person off, leaving the others on it', () => {
    expect(removeAssigneeChanges({ '$assigned:ci': true, '$assigned:cj': true }, 'CJ')).toEqual({ '$assigned:cj': null });
    expect(removeAssigneeChanges({ '$assigned:ci': true }, 'cj')).toEqual({});
  });

  it('sets exactly the people given: adds the new ones, removes the rest', () => {
    expect(setAssigneesChanges({ '$assigned:ci': true, '$assigned:cj': true, $seen: true }, ['cj', 'CK']))
      .toEqual({ '$assigned:ci': null, '$assigned:ck': true });
    expect(setAssigneesChanges({ '$assigned:ci': true }, [])).toEqual({ '$assigned:ci': null });
    expect(setAssigneesChanges({ '$assigned:ci': true }, ['ci'])).toEqual({});
  });

  it('unassigns everyone', () => {
    expect(unassignChanges({ '$assigned:ci': true, '$assigned:cj': true, $seen: true })).toEqual({ '$assigned:ci': null, '$assigned:cj': null });
    expect(unassignChanges({ $seen: true })).toEqual({});
  });

  it('marks done and reopens, without touching $seen', () => {
    expect(doneChanges({ $seen: true })).toEqual({ $done: true });
    expect(doneChanges({ $done: true })).toEqual({});
    expect(reopenChanges({ $done: true, $seen: true })).toEqual({ $done: null });
    expect(reopenChanges({})).toEqual({});
  });

  it('takes a change back exactly', () => {
    const patch = setAssigneesChanges({ '$assigned:ci': true }, ['cj']);
    expect(reversePatch(patch)).toEqual({ '$assigned:ci': true, '$assigned:cj': null });
    expect(reversePatch({})).toEqual({});
  });

  it('lists recent assignees, most often first, without the user', () => {
    const seen = new Map([['ck', 1], ['cj', 3], ['ci', 5]]);
    expect(recentAssignees(seen, { exclude: ['CI'] })).toEqual(['cj', 'ck']);
    expect(recentAssignees(seen, { limit: 1 })).toEqual(['ci']);
  });
});
