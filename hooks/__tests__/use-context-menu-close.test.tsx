import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useContextMenu } from '../use-context-menu';

// The reader closes its menus on every message it opens. A menu that is
// already closed keeps its state, so that draws nothing again.

describe('closing a context menu', () => {
  it('keeps the state of a menu that is already closed', () => {
    let renders = 0;
    const { result } = renderHook(() => { renders++; return useContextMenu<string>(); });
    const closed = result.current.contextMenu;
    const before = renders;
    act(() => { result.current.closeContextMenu(); });
    expect(result.current.contextMenu).toBe(closed);
    expect(renders).toBe(before);
  });

  it('still closes an open one', () => {
    const { result } = renderHook(() => useContextMenu<string>());
    const button = document.createElement('button');
    document.body.appendChild(button);
    act(() => { result.current.openContextMenuFrom(button, 'row'); });
    expect(result.current.contextMenu.isOpen).toBe(true);
    act(() => { result.current.closeContextMenu(); });
    expect(result.current.contextMenu.isOpen).toBe(false);
    expect(result.current.contextMenu.data).toBe('row');
    button.remove();
  });
});
