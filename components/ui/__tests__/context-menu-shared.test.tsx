import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ContextMenu, ContextMenuCheckItem, ContextMenuItem } from '../context-menu';

// One right-click menu everywhere: rows with an icon column, a tick for what's on,
// red only on a destructive row's icon (and the row under the pointer), and letters
// that jump to a row.

const Icon = ({ className }: { className?: string }) => <svg data-testid="icon" className={className} />;

function open(children: React.ReactNode) {
  return render(<ContextMenu isOpen position={{ x: 10, y: 10 }} onClose={vi.fn()}>{children}</ContextMenu>);
}

describe('a destructive row', () => {
  it('has the colour on its icon, not on its words', () => {
    open(<ContextMenuItem icon={Icon} label="Delete" destructive onClick={vi.fn()} testId="del" />);
    const row = screen.getByTestId('del');
    expect(row.querySelector('[data-testid="icon"]')!.getAttribute('class')).toContain('text-destructive');
    // Only under the pointer or the focus.
    expect(row.className.split(/\s+/)).not.toContain('text-destructive');
    expect(row.className).toContain('hover:text-destructive');
  });
});

describe('a check row', () => {
  it('ticks in the icon column and says so to a screen reader', () => {
    open(
      <>
        <ContextMenuCheckItem label="Newest first" kind="radio" checked onClick={vi.fn()} />
        <ContextMenuCheckItem label="Oldest first" kind="radio" checked={false} onClick={vi.fn()} />
      </>,
    );
    const [on, off] = screen.getAllByRole('menuitemradio');
    expect(on).toHaveAttribute('aria-checked', 'true');
    expect(off).toHaveAttribute('aria-checked', 'false');
    expect(on.querySelector('svg')).not.toBeNull();
    expect(off.querySelector('svg')).toBeNull();
  });

  it('with an icon keeps the icon in the column and the tick at the end', () => {
    open(<ContextMenuCheckItem icon={Icon} label="Dark" kind="radio" checked onClick={vi.fn()} />);
    const row = screen.getByRole('menuitemradio');
    const svgs = row.querySelectorAll('svg');
    expect(svgs[0].getAttribute('data-testid')).toBe('icon');
    expect(svgs).toHaveLength(2);
  });
});

describe('type-ahead', () => {
  it('a letter goes to the next row that starts with it, and again to the one after', () => {
    open(
      <>
        <ContextMenuItem icon={Icon} label="Reply" onClick={vi.fn()} />
        <ContextMenuItem icon={Icon} label="Archive" onClick={vi.fn()} />
        <ContextMenuItem icon={Icon} label="Report spam" onClick={vi.fn()} />
      </>,
    );
    const rows = screen.getAllByRole('menuitem');
    rows[1].focus();
    fireEvent.keyDown(rows[1], { key: 'r' });
    expect(document.activeElement).toBe(rows[2]);
    fireEvent.keyDown(rows[2], { key: 'r' });
    expect(document.activeElement).toBe(rows[0]);
  });

  it('several letters typed quickly make a word', () => {
    open(
      <>
        <ContextMenuItem icon={Icon} label="Reply" onClick={vi.fn()} />
        <ContextMenuItem icon={Icon} label="Report spam" onClick={vi.fn()} />
      </>,
    );
    const rows = screen.getAllByRole('menuitem');
    rows[0].focus();
    fireEvent.keyDown(rows[0], { key: 'r' });
    fireEvent.keyDown(document.activeElement!, { key: 'e' });
    fireEvent.keyDown(document.activeElement!, { key: 'p' });
    fireEvent.keyDown(document.activeElement!, { key: 'o' });
    expect(document.activeElement).toBe(rows[1]);
  });
});
