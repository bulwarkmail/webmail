import { describe, it, expect } from 'vitest';
import type { Email } from '@/lib/jmap/types';
import { stepListEmail } from '../list-step';

const mail = (id: string) => ({ id, threadId: `t-${id}` }) as Email;
const emails = [mail('a'), mail('b'), mail('c'), mail('d')];
const ids = (e: Email | null) => e?.id ?? null;

describe('stepListEmail', () => {
  it('goes on from the given message', () => {
    expect(ids(stepListEmail(emails, 'c', 1))).toBe('d');
    expect(ids(stepListEmail(emails, 'c', -1))).toBe('b');
  });
  it('stays put at either end', () => {
    expect(ids(stepListEmail(emails, 'd', 1))).toBe('d');
    expect(ids(stepListEmail(emails, 'a', -1))).toBe('a');
  });
  it('starts at the top for j and the bottom for k without a place', () => {
    expect(ids(stepListEmail(emails, null, 1))).toBe('a');
    expect(ids(stepListEmail(emails, null, -1))).toBe('d');
    expect(ids(stepListEmail(emails, 'gone', 1))).toBe('a');
  });
  it('counts a conversation once and opens it at its row', () => {
    // b's row stands for b and a (its older message); then d, then c.
    const rows = [{ key: 'b', members: ['b', 'a'] }, { key: 'd', members: ['d'] }, { key: 'c', members: ['c'] }];
    expect(ids(stepListEmail(emails, 'a', 1, rows))).toBe('d');
    expect(ids(stepListEmail(emails, 'd', 1, rows))).toBe('c');
    expect(ids(stepListEmail(emails, 'd', -1, rows))).toBe('b');
    expect(ids(stepListEmail(emails, null, -1, rows))).toBe('c');
  });
  it('is empty for an empty list', () => {
    expect(stepListEmail([], 'a', 1)).toBeNull();
  });
});
