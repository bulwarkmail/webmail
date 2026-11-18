import { describe, it, expect, vi } from 'vitest';
import { useRef, useState } from 'react';
import { render, fireEvent, act } from '@testing-library/react';
import { ResizeHandle } from '../resize-handle';

/** A pane whose width the handle changes, as the apps wire it up. */
function Pane({ onSave }: { onSave: (width: number) => void }) {
  const [width, setWidth] = useState(200);
  const start = useRef(width);
  return (
    <ResizeHandle
      pane="sidebar"
      value={width}
      min={180}
      max={400}
      onResizeStart={() => { start.current = width; }}
      onResize={(delta) => setWidth(Math.max(180, Math.min(400, start.current + delta)))}
      onResizeEnd={() => onSave(width)}
    />
  );
}


describe('ResizeHandle', () => {
  it('should render with separator role', () => {
    const { getByRole } = render(
      <ResizeHandle onResize={vi.fn()} />
    );
    const handle = getByRole('separator');
    expect(handle).toBeInTheDocument();
    expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    expect(handle).toHaveAttribute('tabindex', '0');
  });

  describe('keyboard interaction', () => {
    it('should call onResize with negative delta on ArrowLeft', async () => {
      const onResize = vi.fn();
      const onResizeEnd = vi.fn();
      const { getByRole } = render(
        <ResizeHandle onResize={onResize} onResizeEnd={onResizeEnd} />
      );
      const handle = getByRole('separator');
      fireEvent.keyDown(handle, { key: 'ArrowLeft' });
      expect(onResize).toHaveBeenCalledWith(-10);
      await act(async () => {});
      expect(onResizeEnd).toHaveBeenCalled();
    });

    it('should call onResize with positive delta on ArrowRight', async () => {
      const onResize = vi.fn();
      const onResizeEnd = vi.fn();
      const { getByRole } = render(
        <ResizeHandle onResize={onResize} onResizeEnd={onResizeEnd} />
      );
      const handle = getByRole('separator');
      fireEvent.keyDown(handle, { key: 'ArrowRight' });
      expect(onResize).toHaveBeenCalledWith(10);
      await act(async () => {});
      expect(onResizeEnd).toHaveBeenCalled();
    });

    it('should not respond to other keys', () => {
      const onResize = vi.fn();
      const { getByRole } = render(
        <ResizeHandle onResize={onResize} />
      );
      const handle = getByRole('separator');
      fireEvent.keyDown(handle, { key: 'ArrowUp' });
      fireEvent.keyDown(handle, { key: 'Enter' });
      fireEvent.keyDown(handle, { key: 'a' });
      expect(onResize).not.toHaveBeenCalled();
    });

    it('should keep the arrows away from the mail shortcuts on the window', () => {
      const shortcuts = vi.fn();
      window.addEventListener('keydown', shortcuts);
      try {
        const { getAllByRole } = render(
          <>
            <ResizeHandle orientation="horizontal" onResize={vi.fn()} />
            <ResizeHandle onResize={vi.fn()} />
          </>
        );
        const [horizontal, vertical] = getAllByRole('separator');
        fireEvent.keyDown(horizontal, { key: 'ArrowDown' });
        fireEvent.keyDown(horizontal, { key: 'ArrowUp' });
        fireEvent.keyDown(vertical, { key: 'ArrowLeft' });
        expect(shortcuts).not.toHaveBeenCalled();
        // Keys the handle doesn't use still reach them.
        fireEvent.keyDown(vertical, { key: 'j' });
        expect(shortcuts).toHaveBeenCalledOnce();
      } finally {
        window.removeEventListener('keydown', shortcuts);
      }
    });

    it('should step from the current width on every press and save the new one', async () => {
      const onSave = vi.fn();
      const { getByRole } = render(<Pane onSave={onSave} />);
      const handle = getByRole('separator');
      fireEvent.keyDown(handle, { key: 'ArrowRight' });
      await act(async () => {});
      fireEvent.keyDown(handle, { key: 'ArrowRight' });
      await act(async () => {});
      expect(handle).toHaveAttribute('aria-valuenow', '220');
      expect(onSave).toHaveBeenLastCalledWith(220);
    });
  });

  describe('name and value', () => {
    it('should say which pane it resizes and how wide it is', () => {
      const { getByRole } = render(<Pane onSave={vi.fn()} />);
      const handle = getByRole('separator', { name: 'resize_sidebar' });
      expect(handle).toHaveAttribute('aria-valuenow', '200');
      expect(handle).toHaveAttribute('aria-valuemin', '180');
      expect(handle).toHaveAttribute('aria-valuemax', '400');
    });

    it('should fall back to a plain name and no value', () => {
      const { getByRole } = render(<ResizeHandle onResize={vi.fn()} />);
      const handle = getByRole('separator');
      expect(handle).toHaveAccessibleName('resize');
      expect(handle).not.toHaveAttribute('aria-valuenow');
    });
  });

  describe('double-click', () => {
    it('should call onDoubleClick when provided', () => {
      const onDoubleClick = vi.fn();
      const { getByRole } = render(
        <ResizeHandle onResize={vi.fn()} onDoubleClick={onDoubleClick} />
      );
      const handle = getByRole('separator');
      fireEvent.doubleClick(handle);
      expect(onDoubleClick).toHaveBeenCalledOnce();
    });

    it('should not error when onDoubleClick is not provided', () => {
      const { getByRole } = render(
        <ResizeHandle onResize={vi.fn()} />
      );
      const handle = getByRole('separator');
      expect(() => fireEvent.doubleClick(handle)).not.toThrow();
    });
  });

  describe('pointer drag', () => {
    const down = (el: Element, pos: number) =>
      fireEvent.pointerDown(el, { pointerId: 1, button: 0, buttons: 1, pointerType: 'mouse', clientX: pos, clientY: pos });
    const move = (pos: number, buttons = 1) =>
      fireEvent.pointerMove(document, { pointerId: 1, buttons, pointerType: 'mouse', clientX: pos, clientY: pos });
    const up = () =>
      fireEvent.pointerUp(document, { pointerId: 1, button: 0, buttons: 0, pointerType: 'mouse' });

    it('should call onResize during pointermove after pointerdown', () => {
      const onResize = vi.fn();
      const { getByRole } = render(<ResizeHandle onResize={onResize} />);
      down(getByRole('separator'), 100);
      move(115);
      expect(onResize).toHaveBeenCalledWith(15);
    });

    it('should measure vertically for a horizontal handle', () => {
      const onResize = vi.fn();
      const { getByRole } = render(<ResizeHandle orientation="horizontal" onResize={onResize} />);
      const handle = getByRole('separator');
      fireEvent.pointerDown(handle, { pointerId: 1, button: 0, buttons: 1, pointerType: 'mouse', clientX: 0, clientY: 50 });
      fireEvent.pointerMove(document, { pointerId: 1, buttons: 1, pointerType: 'mouse', clientX: 300, clientY: 30 });
      expect(onResize).toHaveBeenCalledWith(-20);
    });

    it('should call onResizeEnd once on pointerup and stop following the pointer', () => {
      const onResize = vi.fn();
      const onResizeEnd = vi.fn();
      const { getByRole } = render(<ResizeHandle onResize={onResize} onResizeEnd={onResizeEnd} />);
      down(getByRole('separator'), 100);
      up();
      expect(onResizeEnd).toHaveBeenCalledOnce();
      move(140);
      expect(onResize).not.toHaveBeenCalled();
      expect(document.body.style.cursor).toBe('');
    });

    it('should stop when a move arrives with no button held (release missed over an iframe)', () => {
      const onResize = vi.fn();
      const onResizeEnd = vi.fn();
      const { getByRole } = render(<ResizeHandle onResize={onResize} onResizeEnd={onResizeEnd} />);
      down(getByRole('separator'), 100);
      move(110);
      expect(onResize).toHaveBeenCalledTimes(1);
      // The mouse came back from the message iframe already released: the
      // document never saw a pointerup.
      move(150, 0);
      expect(onResizeEnd).toHaveBeenCalledOnce();
      move(200);
      expect(onResize).toHaveBeenCalledTimes(1);
    });

    it('should stop when the window loses focus mid-drag', () => {
      const onResize = vi.fn();
      const onResizeEnd = vi.fn();
      const { getByRole } = render(<ResizeHandle onResize={onResize} onResizeEnd={onResizeEnd} />);
      down(getByRole('separator'), 100);
      fireEvent.blur(window);
      expect(onResizeEnd).toHaveBeenCalledOnce();
      move(200);
      expect(onResize).not.toHaveBeenCalled();
    });

    it('should ignore a second pointer while one is dragging', () => {
      const onResize = vi.fn();
      const onResizeEnd = vi.fn();
      const { getByRole } = render(<ResizeHandle onResize={onResize} onResizeEnd={onResizeEnd} />);
      const handle = getByRole('separator');
      down(handle, 100);
      fireEvent.pointerDown(handle, { pointerId: 2, button: 0, buttons: 1, pointerType: 'touch', clientX: 500, clientY: 500 });
      fireEvent.pointerMove(document, { pointerId: 2, buttons: 1, pointerType: 'touch', clientX: 520, clientY: 520 });
      fireEvent.pointerUp(document, { pointerId: 2, button: 0, buttons: 0, pointerType: 'touch' });
      expect(onResize).not.toHaveBeenCalled();
      expect(onResizeEnd).not.toHaveBeenCalled();
      move(130);
      expect(onResize).toHaveBeenCalledWith(30);
    });

    it('should ignore a right-button press', () => {
      const onResizeStart = vi.fn();
      const { getByRole } = render(<ResizeHandle onResize={vi.fn()} onResizeStart={onResizeStart} />);
      fireEvent.pointerDown(getByRole('separator'), { pointerId: 1, button: 2, buttons: 2, pointerType: 'mouse', clientX: 100, clientY: 0 });
      expect(onResizeStart).not.toHaveBeenCalled();
    });

    it('should keep using the latest onResize without re-arming the drag', () => {
      const first = vi.fn();
      const second = vi.fn();
      const { getByRole, rerender } = render(<ResizeHandle onResize={first} />);
      down(getByRole('separator'), 100);
      rerender(<ResizeHandle onResize={second} />);
      move(120);
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledWith(20);
    });

    it('should not call onResize on pointermove without pointerdown', () => {
      const onResize = vi.fn();
      render(<ResizeHandle onResize={onResize} />);
      move(200);
      expect(onResize).not.toHaveBeenCalled();
    });
  });

  it('shows what it is given in place of its line, and still drags', () => {
    const onResize = vi.fn();
    const { getByRole } = render(
      <ResizeHandle orientation="horizontal" onResize={onResize}>
        <span>grip</span>
      </ResizeHandle>,
    );
    const handle = getByRole('separator');
    expect(handle).toHaveTextContent('grip');
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientY: 100 });
    fireEvent.pointerMove(document, { pointerId: 1, clientY: 101, buttons: 1 });
    fireEvent.pointerUp(document, { pointerId: 1 });
    expect(onResize).toHaveBeenCalledWith(1);
  });
});
