import { describe, expect, it } from 'vitest';
import type { Email } from '@/lib/jmap/types';
import { andFilters, isUnreadFirstView, mergeUnreadSection, openSectionRows, withoutReached, type UnreadSection } from '../unread-first';

const mail = (id: string, threadId = `thread-${id}`) => ({ id, threadId, keywords: {} }) as Email;
const section = (...ids: string[]): UnreadSection => ({ mailboxId: 'inbox', ids: new Set(ids), total: ids.length });

describe('mergeUnreadSection', () => {
  it('puts the fresh section first and drops the rows that left it', () => {
    const list = [mail('u1'), mail('u2'), mail('r1'), mail('r2')];
    const merged = mergeUnreadSection(list, section('u1', 'u2'), [mail('u3'), mail('u1')], null);
    expect(merged.emails.map((e) => e.id)).toEqual(['u3', 'u1', 'r1', 'r2']);
    expect([...merged.ids]).toEqual(['u3', 'u1']);
  });

  it('keeps the open conversation\'s message that left the section', () => {
    const list = [mail('u1'), mail('u2', 'open'), mail('r1')];
    const merged = mergeUnreadSection(list, section('u1', 'u2'), [mail('u1')], 'open');
    expect(merged.emails.map((e) => e.id)).toEqual(['u1', 'u2', 'r1']);
    expect(merged.ids.has('u2')).toBe(true);
  });

  it('keeps that message at its place in the section, not after it (#1453)', () => {
    const at = (id: string, minute: number, threadId?: string) =>
      ({ ...mail(id, threadId), receivedAt: new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString() }) as Email;
    const list = [at('u1', 50), at('u2', 40, 'open'), at('u3', 30), at('r1', 45)];
    const merged = mergeUnreadSection(list, section('u1', 'u2', 'u3'), [at('u1', 50), at('u3', 30)], 'open');
    expect(merged.emails.map((e) => e.id)).toEqual(['u1', 'u2', 'u3', 'r1']);
  });

  it('takes a row of the main list the section now has into the section', () => {
    const merged = mergeUnreadSection([mail('r1'), mail('r2')], section(), [mail('r2')], null);
    expect(merged.emails.map((e) => e.id)).toEqual(['r2', 'r1']);
  });
});

describe('withoutReached', () => {
  it('returns the same section when a page reached none of its rows', () => {
    const before = section('u1');
    expect(withoutReached(before, ['r1'])).toBe(before);
    expect([...withoutReached(before, ['u1'])!.ids]).toEqual([]);
  });

  it('leaves the kept rows in the section', () => {
    const before = section('u1', 'u2');
    expect([...withoutReached(before, ['u1', 'u2'], new Set(['u2']))!.ids]).toEqual(['u2']);
  });
});

describe('openSectionRows', () => {
  it('is the section\'s rows of the open conversation', () => {
    const list = [mail('u1', 'open'), mail('u2'), mail('r1', 'open')];
    expect([...openSectionRows(list, section('u1', 'u2'), 'open')]).toEqual(['u1']);
    expect(openSectionRows(list, section('u1', 'u2'), null).size).toBe(0);
  });
});

describe('andFilters', () => {
  it('ANDs two fragments and passes a lone one through', () => {
    expect(andFilters(null, { a: 1 })).toEqual({ a: 1 });
    expect(andFilters({ a: 1 }, undefined)).toEqual({ a: 1 });
    expect(andFilters({ a: 1 }, { b: 2 })).toEqual({ operator: 'AND', conditions: [{ a: 1 }, { b: 2 }] });
  });
});

describe('isUnreadFirstView', () => {
  const view = { interfaceLayout: 'mountain-view', mvInboxType: 'unread-first', mailboxRole: 'inbox', otherView: false } as const;
  it('is Mountain View\'s inbox with the inbox type set, and nothing else', () => {
    expect(isUnreadFirstView(view)).toBe(true);
    expect(isUnreadFirstView({ ...view, interfaceLayout: 'default' })).toBe(false);
    expect(isUnreadFirstView({ ...view, mvInboxType: 'default' })).toBe(false);
    expect(isUnreadFirstView({ ...view, mailboxRole: 'archive' })).toBe(false);
    expect(isUnreadFirstView({ ...view, otherView: true })).toBe(false);
  });
});
