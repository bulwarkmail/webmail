import { useRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { rowA11yProps, rowLabel, useListboxFocus } from '../list-a11y';

function Row({ id, selected, onToggle = () => {}, onOpenMenu, onClick }: {
  id: string; selected?: boolean; onToggle?: () => void; onOpenMenu?: () => void; onClick?: () => void;
}) {
  return (
    <div data-pos="1">
      <div
        {...rowA11yProps({ rowKey: id, label: `row ${id}`, selected: !!selected, selectionMode: false, onToggleCheck: onToggle, onOpenMenu })}
        onClick={onClick}
      >
        <button type="button">star {id}</button>
        <input aria-label={`check ${id}`} type="checkbox" />
      </div>
    </div>
  );
}

function List({ ids, initial: active }: { ids: string[]; initial?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useListboxFocus(ref, active, `${ids.length}:${active}`);
  return (
    <>
      <button type="button">outside</button>
      <div ref={ref} tabIndex={-1} data-testid="scroller">
        <div role="treegrid" aria-label="Messages" data-setsize="3">
          {ids.map((id) => <Row key={id} id={id} selected={id === active} />)}
        </div>
      </div>
    </>
  );
}

const option = (name: string) => screen.getByRole('row', { name });

/** Lays rows out at these tops in a 200px tall view; 60px each. */
function mockRowTops(tops: Record<string, number>) {
  return vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const id = this.getAttribute('data-row-key');
    const top = id ? tops[id] : 0;
    const height = id ? 60 : 200;
    return { top, bottom: top + height, left: 0, right: 100, width: 100, height, x: 0, y: top, toJSON() {} } as DOMRect;
  });
}

describe('message list as one widget', () => {
  it('names a row in one sentence and skips what does not apply', () => {
    expect(rowLabel(['unread', 'Anna Berg', 'Budget', false, null, '', 'Has attachment'])).toBe('unread, Anna Berg, Budget, Has attachment');
  });

  it('keeps one Tab stop: the open message, and takes the row controls out of the Tab order', () => {
    render(<List ids={['a', 'b', 'c']} initial="b" />);
    expect(option('row b')).toHaveAttribute('tabindex', '0');
    expect(option('row a')).toHaveAttribute('tabindex', '-1');
    expect(screen.getByText('star a')).toHaveAttribute('tabindex', '-1');
    expect(document.querySelector('input[aria-label="check c"]')).toHaveAttribute('tabindex', '-1');
    expect(option('row b')).toHaveAttribute('aria-selected', 'true');
    expect(option('row b')).toHaveAttribute('aria-current', 'true');
    expect(option('row a')).not.toHaveAttribute('aria-selected');
  });

  it('settles when a row control is set to -1 again (no observer loop)', async () => {
    render(<List ids={['a']} initial="a" />);
    const star = screen.getByText('star a');
    star.setAttribute('tabindex', '-1');
    star.setAttribute('tabindex', '0');
    // A loop of observer callbacks would never let this timer run.
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(star).toHaveAttribute('tabindex', '-1');
  }, 2000);

  it('hands the focus from the list itself to the row with the Tab stop', () => {
    render(<List ids={['a', 'b']} initial="b" />);
    act(() => screen.getByTestId('scroller').focus());
    expect(document.activeElement).toBe(option('row b'));
  });

  it('falls back to the first row when nothing is open', () => {
    render(<List ids={['a', 'b']} />);
    expect(option('row a')).toHaveAttribute('tabindex', '0');
  });

  it('moves the focus with the selection while the focus is in the list', () => {
    const { rerender } = render(<List ids={['a', 'b', 'c']} initial="a" />);
    act(() => option('row a').focus());
    rerender(<List ids={['a', 'b', 'c']} initial="b" />);
    expect(document.activeElement).toBe(option('row b'));
    expect(option('row b')).toHaveAttribute('tabindex', '0');
    expect(option('row a')).toHaveAttribute('tabindex', '-1');
  });

  it('leaves the focus alone when rows scroll in or out', () => {
    const { rerender } = render(<List ids={['a', 'b', 'c']} initial="a" />);
    act(() => option('row c').focus());
    rerender(<List ids={['b', 'c']} initial="a" />);
    expect(document.activeElement).toBe(option('row c'));
    rerender(<List ids={['a', 'b', 'c']} initial="a" />);
    expect(document.activeElement).toBe(option('row c'));
  });

  it('hands the focus to a row in view when the open message is scrolled out of it', () => {
    const rect = mockRowTops({ a: -300, b: 20, c: 80 });
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    try {
      render(<List ids={['a', 'b', 'c']} initial="a" />);
      act(() => screen.getByTestId('scroller').focus());
      expect(document.activeElement).toBe(option('row b'));
      expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    } finally {
      rect.mockRestore();
      focus.mockRestore();
    }
  });

  it('puts the Tab stop on the first row in view when nothing is open', () => {
    const rect = mockRowTops({ a: -300, b: 20 });
    try {
      render(<List ids={['a', 'b']} />);
      expect(option('row b')).toHaveAttribute('tabindex', '0');
      expect(option('row a')).toHaveAttribute('tabindex', '-1');
    } finally {
      rect.mockRestore();
    }
  });

  it('never pulls the focus out of another part of the page', () => {
    const { rerender } = render(<List ids={['a', 'b']} initial="a" />);
    act(() => screen.getByText('outside').focus());
    rerender(<List ids={['a', 'b']} initial="b" />);
    expect(document.activeElement).toBe(screen.getByText('outside'));
    expect(option('row b')).toHaveAttribute('tabindex', '0');
  });

  it('writes each row\'s position and the list size for screen readers', () => {
    render(<List ids={['a']} initial="a" />);
    expect(option('row a')).toHaveAttribute('aria-posinset', '1');
    expect(option('row a')).toHaveAttribute('aria-setsize', '3');
  });

  it('opens with Enter, ticks with Space and opens the actions with Shift+F10', () => {
    const onClick = vi.fn();
    const onToggle = vi.fn();
    const onOpenMenu = vi.fn();
    render(<div role="treegrid"><Row id="a" onClick={onClick} onToggle={onToggle} onOpenMenu={onOpenMenu} /></div>);
    fireEvent.keyDown(option('row a'), { key: 'Enter' });
    fireEvent.keyDown(option('row a'), { key: ' ' });
    fireEvent.keyDown(option('row a'), { key: 'F10', shiftKey: true });
    fireEvent.keyDown(option('row a'), { key: 'ContextMenu' });
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onOpenMenu).toHaveBeenCalledTimes(2);
  });

  it('leaves keys from a control inside the row to that control', () => {
    const onToggle = vi.fn();
    render(<div role="treegrid"><Row id="a" onToggle={onToggle} /></div>);
    fireEvent.keyDown(screen.getByText('star a'), { key: ' ' });
    expect(onToggle).not.toHaveBeenCalled();
  });
});

// The list keeps a row on screen for the next folder's message at its place.
function SlotList({ ids }: { ids: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useListboxFocus(ref, undefined, ids.join());
  return (
    <div ref={ref} tabIndex={-1} data-testid="scroller">
      <div role="treegrid" aria-label="Messages" data-setsize="3">
        {ids.map((id, slot) => <Row key={`row-${slot}`} id={id} />)}
      </div>
    </div>
  );
}

describe('a focused row that shows another message', () => {
  it("hands the focus on to the list's Tab stop, as a new row did", () => {
    const spy = mockRowTops({ a: 0, b: 60, c: 120, d: 0, e: 60, f: 120 });
    const { rerender } = render(<SlotList ids={['a', 'b', 'c']} />);
    option('row b').focus();
    expect(document.activeElement).toBe(option('row b'));
    const focused: string[] = [];
    const scroller = screen.getByTestId('scroller');
    scroller.addEventListener('focusin', (e) => { focused.push((e.target as HTMLElement).getAttribute('aria-label') ?? (e.target as HTMLElement).dataset.testid ?? ''); });
    act(() => { rerender(<SlotList ids={['d', 'e', 'f']} />); });
    // Through the list to the Tab stop: a focus move a screen reader announces.
    expect(focused).toContain('scroller');
    expect(document.activeElement).toBe(option('row d'));
    spy.mockRestore();
  });
});
