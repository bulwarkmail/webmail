import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ContextMenu, ContextMenuSubMenu, ContextMenuItem } from '../context-menu';

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

afterEach(() => vi.restoreAllMocks());

function openSubmenu(subOrigin: { left: number; top: number }) {
  // Parent menu at (400, 200); the entry spans 400..600 x 240..272. The
  // submenu, before it is placed, sits at the origin `position: fixed`
  // resolves against.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.getAttribute('role') === 'menu' && this.textContent === 'Spam') {
      return rect(subOrigin.left, subOrigin.top, 180, 120);
    }
    if ((this.firstElementChild as HTMLElement | null)?.dataset.testid === 'sub') return rect(400, 240, 200, 32);
    return rect(400, 200, 200, 300);
  });
  render(
    <ContextMenu isOpen position={{ x: 400, y: 200 }} onClose={() => {}}>
      <ContextMenuSubMenu label="Move to" testId="sub">
        <ContextMenuItem label="Spam" onClick={() => {}} />
      </ContextMenuSubMenu>
    </ContextMenu>,
  );
  fireEvent.mouseEnter(screen.getByTestId('sub').parentElement!);
  return screen.getByText('Spam').closest('[role="menu"]') as HTMLElement;
}

describe('ContextMenuSubMenu placement', () => {
  it('opens beside its entry', () => {
    const sub = openSubmenu({ left: 0, top: 0 });
    expect(sub.style.left).toBe('600px');
    expect(sub.style.top).toBe('240px');
  });

  it('stays beside its entry when a theme makes the parent menu the containing block (#1149)', () => {
    // A backdrop-filter on the parent menu moves the fixed origin to (400, 200).
    const sub = openSubmenu({ left: 400, top: 200 });
    expect(sub.style.left).toBe('200px');
    expect(sub.style.top).toBe('40px');
  });
});
