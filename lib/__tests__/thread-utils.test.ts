import { describe, it, expect } from 'vitest';
import {
  groupEmailsByThread,
  sortThreadGroups,
  getThreadParticipants,
  mergeThreadEmails,
  getEmailColorTag,
  getThreadColorTag,
} from '../thread-utils';
import type { Email, ThreadGroup } from '../jmap/types';

const makeEmail = (overrides: Partial<Email> = {}): Email => ({
  id: 'email-1',
  threadId: 'thread-1',
  mailboxIds: { inbox: true },
  keywords: { $seen: true },
  size: 1000,
  receivedAt: '2024-01-15T10:00:00Z',
  from: [{ name: 'Alice', email: 'alice@example.com' }],
  subject: 'Test Subject',
  hasAttachment: false,
  ...overrides,
});

describe('groupEmailsByThread', () => {
  it('groups emails by threadId', () => {
    const emails = [
      makeEmail({ id: 'e1', threadId: 'thread-1' }),
      makeEmail({ id: 'e2', threadId: 'thread-1' }),
      makeEmail({ id: 'e3', threadId: 'thread-2' }),
    ];
    const groups = groupEmailsByThread(emails);
    expect(groups).toHaveLength(2);
    expect(groups.find(g => g.threadId === 'thread-1')!.emailCount).toBe(2);
    expect(groups.find(g => g.threadId === 'thread-2')!.emailCount).toBe(1);
  });

  it('sorts emails within group by receivedAt descending', () => {
    const emails = [
      makeEmail({ id: 'e1', threadId: 'thread-1', receivedAt: '2024-01-10T10:00:00Z' }),
      makeEmail({ id: 'e2', threadId: 'thread-1', receivedAt: '2024-01-15T10:00:00Z' }),
      makeEmail({ id: 'e3', threadId: 'thread-1', receivedAt: '2024-01-12T10:00:00Z' }),
    ];
    const group = groupEmailsByThread(emails)[0];
    expect(group.emails[0].id).toBe('e2');
    expect(group.emails[1].id).toBe('e3');
    expect(group.emails[2].id).toBe('e1');
  });

  it('sets latestEmail to the newest email', () => {
    const emails = [
      makeEmail({ id: 'old', threadId: 'thread-1', receivedAt: '2024-01-01T00:00:00Z' }),
      makeEmail({ id: 'new', threadId: 'thread-1', receivedAt: '2024-06-01T00:00:00Z' }),
    ];
    expect(groupEmailsByThread(emails)[0].latestEmail.id).toBe('new');
  });

  it('calculates participantNames from unique senders', () => {
    const emails = [
      makeEmail({ id: 'e1', from: [{ name: 'Alice', email: 'alice@example.com' }] }),
      makeEmail({ id: 'e2', from: [{ name: 'Bob', email: 'bob@example.com' }] }),
      makeEmail({ id: 'e3', from: [{ name: 'Alice', email: 'alice@example.com' }] }),
    ];
    const group = groupEmailsByThread(emails)[0];
    expect(group.participantNames).toEqual(['Alice', 'Bob']);
  });

  it('detects hasUnread when an email lacks $seen', () => {
    const emails = [
      makeEmail({ id: 'e1', keywords: { $seen: true } }),
      makeEmail({ id: 'e2', keywords: {} }),
    ];
    expect(groupEmailsByThread(emails)[0].hasUnread).toBe(true);
  });

  it('detects hasStarred when an email has $flagged', () => {
    const emails = [
      makeEmail({ id: 'e1', keywords: { $seen: true } }),
      makeEmail({ id: 'e2', keywords: { $seen: true, $flagged: true } }),
    ];
    expect(groupEmailsByThread(emails)[0].hasStarred).toBe(true);
  });

  it('detects hasAttachment', () => {
    const emails = [
      makeEmail({ id: 'e1', hasAttachment: false }),
      makeEmail({ id: 'e2', hasAttachment: true }),
    ];
    expect(groupEmailsByThread(emails)[0].hasAttachment).toBe(true);
  });

  it('detects hasAnswered when an email has $answered', () => {
    const emails = [
      makeEmail({ id: 'e1', keywords: { $seen: true } }),
      makeEmail({ id: 'e2', keywords: { $seen: true, $answered: true } }),
    ];
    expect(groupEmailsByThread(emails)[0].hasAnswered).toBe(true);
  });

  it('detects hasForwarded when an email has $forwarded', () => {
    const emails = [
      makeEmail({ id: 'e1', keywords: { $seen: true } }),
      makeEmail({ id: 'e2', keywords: { $seen: true, $forwarded: true } }),
    ];
    expect(groupEmailsByThread(emails)[0].hasForwarded).toBe(true);
  });

  it('returns empty array for empty input', () => {
    expect(groupEmailsByThread([])).toEqual([]);
  });

  it('returns empty array for null/undefined input', () => {
    expect(groupEmailsByThread(null as unknown as Email[])).toEqual([]);
    expect(groupEmailsByThread(undefined as unknown as Email[])).toEqual([]);
  });
});

describe('sortThreadGroups', () => {
  const makeGroup = (threadId: string, receivedAt: string, hasPinned = false): ThreadGroup => ({
    threadId,
    emails: [makeEmail({ receivedAt })],
    latestEmail: makeEmail({ receivedAt }),
    participantNames: ['A'],
    hasUnread: false,
    hasStarred: false,
    hasPinned,
    hasAttachment: false,
    hasAnswered: false,
    hasForwarded: false,
    emailCount: 1,
  });

  it('sorts groups by latestEmail.receivedAt descending', () => {
    const groups = [
      makeGroup('old', '2024-01-01T00:00:00Z'),
      makeGroup('new', '2024-06-01T00:00:00Z'),
    ];
    const sorted = sortThreadGroups(groups);
    expect(sorted[0].threadId).toBe('new');
    expect(sorted[1].threadId).toBe('old');
  });

  it('keeps pinned threads on top regardless of date', () => {
    const groups = [
      makeGroup('newest', '2024-06-01T00:00:00Z'),
      makeGroup('old-pinned', '2024-01-01T00:00:00Z', true),
      makeGroup('mid', '2024-03-01T00:00:00Z'),
    ];
    const sorted = sortThreadGroups(groups);
    expect(sorted.map(g => g.threadId)).toEqual(['old-pinned', 'newest', 'mid']);
  });

  it('detects hasPinned from the $pinned keyword', () => {
    const emails = [
      makeEmail({ id: 'e1', keywords: { $seen: true } }),
      makeEmail({ id: 'e2', keywords: { $seen: true, '$pinned': true } }),
    ];
    expect(groupEmailsByThread(emails)[0].hasPinned).toBe(true);
  });
});

describe('getThreadParticipants', () => {
  it('extracts unique sender names', () => {
    const emails = [
      makeEmail({ from: [{ name: 'Alice', email: 'alice@example.com' }] }),
      makeEmail({ from: [{ name: 'Bob', email: 'bob@example.com' }] }),
      makeEmail({ from: [{ name: 'Alice', email: 'alice@example.com' }] }),
    ];
    expect(getThreadParticipants(emails)).toEqual(['Alice', 'Bob']);
  });

  it('respects maxNames limit', () => {
    const emails = [
      makeEmail({ from: [{ name: 'A', email: 'a@x.com' }] }),
      makeEmail({ from: [{ name: 'B', email: 'b@x.com' }] }),
      makeEmail({ from: [{ name: 'C', email: 'c@x.com' }] }),
    ];
    expect(getThreadParticipants(emails, 2)).toEqual(['A', 'B']);
  });

  it('uses email prefix when name is empty', () => {
    const emails = [
      makeEmail({ from: [{ name: '', email: 'charlie@example.com' }] }),
    ];
    expect(getThreadParticipants(emails)).toEqual(['charlie']);
  });
});

describe('mergeThreadEmails', () => {
  it('merges new emails without duplicating existing ones', () => {
    const existing: ThreadGroup = {
      threadId: 'thread-1',
      emails: [
        makeEmail({ id: 'e1', receivedAt: '2024-01-10T00:00:00Z' }),
        makeEmail({ id: 'e2', receivedAt: '2024-01-09T00:00:00Z' }),
      ],
      latestEmail: makeEmail({ id: 'e1', receivedAt: '2024-01-10T00:00:00Z' }),
      participantNames: ['Alice'],
      hasUnread: false,
      hasStarred: false,
      hasPinned: false,
      hasAttachment: false,
      hasAnswered: false,
      hasForwarded: false,
      emailCount: 2,
    };
    const fetched = [
      makeEmail({ id: 'e2', receivedAt: '2024-01-09T00:00:00Z' }),
      makeEmail({ id: 'e3', receivedAt: '2024-01-11T00:00:00Z', from: [{ name: 'Bob', email: 'bob@example.com' }] }),
    ];
    const merged = mergeThreadEmails(existing, fetched);
    expect(merged.emailCount).toBe(3);
    expect(merged.emails.map(e => e.id)).toEqual(['e3', 'e1', 'e2']);
  });

  it('updates thread metadata after merge', () => {
    const existing: ThreadGroup = {
      threadId: 'thread-1',
      emails: [makeEmail({ id: 'e1', keywords: { $seen: true }, hasAttachment: false })],
      latestEmail: makeEmail({ id: 'e1' }),
      participantNames: ['Alice'],
      hasUnread: false,
      hasStarred: false,
      hasPinned: false,
      hasAttachment: false,
      hasAnswered: false,
      hasForwarded: false,
      emailCount: 1,
    };
    const fetched = [
      makeEmail({
        id: 'e2',
        receivedAt: '2024-06-01T00:00:00Z',
        keywords: { $flagged: true },
        hasAttachment: true,
        from: [{ name: 'Bob', email: 'bob@example.com' }],
      }),
    ];
    const merged = mergeThreadEmails(existing, fetched);
    expect(merged.latestEmail.id).toBe('e2');
    expect(merged.hasUnread).toBe(true);
    expect(merged.hasStarred).toBe(true);
    expect(merged.hasAttachment).toBe(true);
    expect(merged.participantNames).toContain('Bob');
  });
});

describe('getEmailColorTag', () => {
  it('returns label from $label: keyword', () => {
    expect(getEmailColorTag({ '$label:red': true, $seen: true })).toBe('red');
  });

  it('returns label from legacy $color: keyword', () => {
    expect(getEmailColorTag({ '$color:red': true, $seen: true })).toBe('red');
  });

  it('returns null when no color keyword', () => {
    expect(getEmailColorTag({ $seen: true, $flagged: true })).toBeNull();
  });

  it('returns null for undefined keywords', () => {
    expect(getEmailColorTag(undefined)).toBeNull();
  });

  it('ignores keywords set to false', () => {
    expect(getEmailColorTag({ '$label:red': false } as unknown as Record<string, boolean>)).toBeNull();
  });

  it('prefers $label: over $color: when both exist', () => {
    expect(getEmailColorTag({ '$label:blue': true, '$color:red': true })).toBe('blue');
  });

  it('handles custom keyword ids', () => {
    expect(getEmailColorTag({ '$label:my-custom-tag': true })).toBe('my-custom-tag');
  });

  it('returns null for empty keywords object', () => {
    expect(getEmailColorTag({})).toBeNull();
  });
});

describe('getThreadColorTag', () => {
  it('returns first color found across thread emails', () => {
    const emails = [
      makeEmail({ id: 'e1', keywords: { $seen: true } }),
      makeEmail({ id: 'e2', keywords: { '$label:blue': true } }),
    ];
    expect(getThreadColorTag(emails)).toBe('blue');
  });

  it('returns null when no emails have color tags', () => {
    const emails = [
      makeEmail({ id: 'e1', keywords: { $seen: true } }),
      makeEmail({ id: 'e2', keywords: { $flagged: true } }),
    ];
    expect(getThreadColorTag(emails)).toBeNull();
  });

  it('returns first tag from earliest tagged email', () => {
    const emails = [
      makeEmail({ id: 'e1', keywords: { '$label:red': true } }),
      makeEmail({ id: 'e2', keywords: { '$label:blue': true } }),
    ];
    expect(getThreadColorTag(emails)).toBe('red');
  });

  it('returns legacy tag from thread emails', () => {
    const emails = [
      makeEmail({ id: 'e1', keywords: { $seen: true } }),
      makeEmail({ id: 'e2', keywords: { '$color:green': true } }),
    ];
    expect(getThreadColorTag(emails)).toBe('green');
  });

  it('returns null for empty email array', () => {
    expect(getThreadColorTag([])).toBeNull();
  });
});
