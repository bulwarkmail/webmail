import { describe, expect, it } from 'vitest';
import type { Email, ThreadGroup } from '@/lib/jmap/types';
import { areThreadRowPropsEqual } from '../thread-list-item';

type RowProps = Parameters<typeof areThreadRowPropsEqual>[0];

const email = (id: string, keywords: Record<string, boolean> = {}): Email =>
  ({ id, threadId: 't1', subject: `Subject ${id}`, keywords, receivedAt: '2026-09-21T10:00:00Z' }) as unknown as Email;

const group = (emails: Email[], over: Partial<ThreadGroup> = {}): ThreadGroup => ({
  threadId: 't1',
  threadKey: 'acct:t1',
  emails,
  latestEmail: emails[0],
  participantNames: ['Ada'],
  hasUnread: false,
  hasStarred: false,
  hasPinned: false,
  hasAttachment: false,
  hasAnswered: false,
  hasForwarded: false,
  emailCount: emails.length,
  ...over,
});

const onToggleExpand = () => {};
const onEmailSelect = () => {};
const props = (over: Partial<RowProps>): RowProps => ({
  thread: group([email('e1')]),
  isExpanded: false,
  onToggleExpand,
  onEmailSelect,
  ...over,
});

describe('areThreadRowPropsEqual', () => {
  it('treats a regrouped thread holding the very same messages as unchanged', () => {
    const e1 = email('e1');
    // groupEmailsByThread builds new ThreadGroup objects on every pass.
    expect(areThreadRowPropsEqual(props({ thread: group([e1]) }), props({ thread: group([e1]) }))).toBe(true);
  });

  it('re-renders when a message in the thread was replaced (read, starred, tagged ...)', () => {
    const before = email('e1');
    const after = email('e1', { $seen: true });
    expect(areThreadRowPropsEqual(props({ thread: group([before]) }), props({ thread: group([after]) }))).toBe(false);
  });

  it('re-renders when the late thread count arrives', () => {
    const e1 = email('e1');
    expect(areThreadRowPropsEqual(
      props({ thread: group([e1], { emailCount: 1 }) }),
      props({ thread: group([e1], { emailCount: 3 }) }),
    )).toBe(false);
  });

  it('re-renders when a thread flag or the participants change', () => {
    const e1 = email('e1');
    const base = props({ thread: group([e1]) });
    expect(areThreadRowPropsEqual(base, props({ thread: group([e1], { hasUnread: true }) }))).toBe(false);
    expect(areThreadRowPropsEqual(base, props({ thread: group([e1], { participantNames: ['Ada', 'Grace'] }) }))).toBe(false);
  });

  it('ignores the open message moving between two OTHER rows', () => {
    const thread = group([email('e1')]);
    expect(areThreadRowPropsEqual(
      props({ thread, selectedEmailKey: 'other-1' }),
      props({ thread, selectedEmailKey: 'other-2' }),
    )).toBe(true);
    expect(areThreadRowPropsEqual(props({ thread }), props({ thread, selectedEmailKey: 'other-1' }))).toBe(true);
  });

  it('re-renders the row that gains or loses the open message', () => {
    const thread = group([email('e1'), email('e2')]);
    expect(areThreadRowPropsEqual(props({ thread, selectedEmailKey: 'other' }), props({ thread, selectedEmailKey: 'e2' }))).toBe(false);
    expect(areThreadRowPropsEqual(props({ thread, selectedEmailKey: 'e2' }), props({ thread, selectedEmailKey: 'other' }))).toBe(false);
    expect(areThreadRowPropsEqual(props({ thread, selectedEmailKey: 'e1' }), props({ thread, selectedEmailKey: 'e2' }))).toBe(false);
  });

  // Ids repeat across accounts: another account's message with the open
  // message's id is not drawn as open.
  it('tells the open message from a namesake of another account', () => {
    const thread = group([{ ...email('e1'), sourceClientAccountId: 'login-b', sourceAccountId: 'cf' }]);
    expect(areThreadRowPropsEqual(props({ thread, selectedEmailKey: 'other' }), props({ thread, selectedEmailKey: 'e1' }))).toBe(true);
    expect(areThreadRowPropsEqual(props({ thread, selectedEmailKey: 'other' }), props({ thread, selectedEmailKey: 'login-b/cf:e1' }))).toBe(false);
  });

  it('counts messages shown by the expanded thread as drawn by the row', () => {
    const thread = group([email('e1')]);
    const expandedEmails = [email('e1'), email('e9')];
    expect(areThreadRowPropsEqual(
      props({ thread, expandedEmails, isExpanded: true, selectedEmailKey: 'other' }),
      props({ thread, expandedEmails, isExpanded: true, selectedEmailKey: 'e9' }),
    )).toBe(false);
  });

  it('re-renders on any other prop change, including a handler appearing', () => {
    const thread = group([email('e1')]);
    expect(areThreadRowPropsEqual(props({ thread }), props({ thread, isExpanded: true }))).toBe(false);
    expect(areThreadRowPropsEqual(props({ thread }), props({ thread, isLoading: true }))).toBe(false);
    expect(areThreadRowPropsEqual(props({ thread }), props({ thread, onDelete: () => {} }))).toBe(false);
    expect(areThreadRowPropsEqual(props({ thread }), props({ thread, onEmailSelect: () => {} }))).toBe(false);
  });
});
