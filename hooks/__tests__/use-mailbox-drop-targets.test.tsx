import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { DragEvent } from 'react';
import { DragDropProvider, useDragDropContext } from '@/contexts/drag-drop-context';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useMailboxDrop } from '../use-mailbox-drop';

// A folder in the sidebar takes dragged mail where a Move list would offer
// it, and nowhere else: not the open folder, not one without write rights,
// not Drafts.

const box = (id: string, extra: Partial<Mailbox> = {}) =>
  ({ id, name: id, myRights: { mayAddItems: true }, ...extra }) as Mailbox;

function dragOver(mailbox: Mailbox) {
  const { result } = renderHook(
    () => ({ drag: useDragDropContext(), drop: useMailboxDrop({ mailbox }) }),
    { wrapper: DragDropProvider },
  );
  act(() => result.current.drag.startDrag([{ id: 'e1' } as Email], 'inbox'));
  const event = { preventDefault() {}, stopPropagation() {}, dataTransfer: { dropEffect: 'move' } } as unknown as DragEvent<HTMLDivElement>;
  act(() => result.current.drop.dropHandlers.onDragEnter(event));
  act(() => result.current.drop.dropHandlers.onDragOver(event));
  return { effect: event.dataTransfer.dropEffect, valid: result.current.drop.isValidDropTarget };
}

describe('dropping mail on a folder', () => {
  it('is allowed on another writable folder', () => {
    expect(dragOver(box('work'))).toEqual({ effect: 'move', valid: true });
  });

  it('is refused on the open folder, a read-only one and Drafts', () => {
    expect(dragOver(box('inbox'))).toEqual({ effect: 'none', valid: false });
    expect(dragOver(box('ro', { myRights: { mayAddItems: false } as Mailbox['myRights'] }))).toEqual({ effect: 'none', valid: false });
    expect(dragOver(box('drafts', { role: 'drafts' }))).toEqual({ effect: 'none', valid: false });
  });
});
