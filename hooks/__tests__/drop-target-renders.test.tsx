import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Mailbox } from '@/lib/jmap/types';
import { useEmailStore } from '@/stores/email-store';

// Every folder and tag row in the sidebar is a drop target. Switching folder
// makes a new selection and a new open folder; neither may draw the rows
// again, since a drop reads both when it happens.

vi.mock('@/contexts/drag-drop-context', () => ({
  useDragDropContext: () => ({ isDragging: false, sourceMailboxId: null, draggedEmails: [], endDrag: () => {}, markDropped: () => {} }),
}));

const { useMailboxDrop } = await import('../use-mailbox-drop');
const { useTagDrop } = await import('../use-tag-drop');

const archive = { id: 'f', name: 'Archive', role: 'archive', myRights: { mayAddItems: true } } as unknown as Mailbox;

describe('sidebar drop targets during a folder switch', () => {
  it('a folder row does not draw again for a new selection', () => {
    let renders = 0;
    renderHook(() => { renders++; return useMailboxDrop({ mailbox: archive }); });
    const before = renders;
    act(() => { useEmailStore.setState({ selectedEmailKeys: new Set(), selectedMailbox: 'sent' }); });
    expect(renders).toBe(before);
  });

  it('a tag row does not draw again for another open folder', () => {
    let renders = 0;
    renderHook(() => { renders++; return useTagDrop({ tagId: 'work' }); });
    const before = renders;
    act(() => { useEmailStore.setState({ selectedMailbox: 'drafts' }); });
    expect(renders).toBe(before);
  });
});
