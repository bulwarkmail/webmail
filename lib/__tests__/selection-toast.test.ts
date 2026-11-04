import { describe, expect, it } from 'vitest';
import type { Email } from '@/lib/jmap/types';
import { batchToastTitle, selectionRowCount } from '../selection-toast';

// mail-18: a batch toast said "5 emails archived" under a bar that said
// "5 conversations". The toasts now count the rows the bar counts.

const t = (key: string, values?: Record<string, unknown>) => `${key} ${JSON.stringify(values ?? {})}`;
const mail = (id: string, threadId: string) => ({ id, threadId }) as Email;

describe('selection toasts', () => {
  it('counts conversations, not the messages a conversation row ticks', () => {
    const selected = [mail('a', 't1'), mail('b', 't1'), mail('c', 't2')];
    expect(selectionRowCount(selected, 3, false)).toBe(2);
    expect(selectionRowCount(selected, 3, true)).toBe(3);
    expect(selectionRowCount([], 4, false)).toBe(4);
  });

  it('names conversations while the list groups them', () => {
    expect(batchToastTitle(t, 'archive', 5, false)).toBe('mail_p2_list.conversations_archived {"count":5}');
    expect(batchToastTitle(t, 'trash', 2, false)).toBe('mail_p2_list.conversations_to_trash {"count":2}');
    expect(batchToastTitle(t, 'delete', 2, false)).toBe('mail_p2_list.conversations_deleted {"count":2}');
    expect(batchToastTitle(t, 'move', 3, false, 'Family')).toBe('mail_p2_list.conversations_moved_to {"count":3,"mailbox":"Family"}');
  });

  it('keeps the email wording with conversations off', () => {
    expect(batchToastTitle(t, 'archive', 5, true)).toBe('notifications.emails_archived {"count":5}');
    expect(batchToastTitle(t, 'move', 3, true, 'Family')).toBe('mail_list_extra.moved_count_to {"count":3,"mailbox":"Family"}');
  });
});
