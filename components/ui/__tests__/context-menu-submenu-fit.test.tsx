import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextMenu, ContextMenuItem, ContextMenuSubMenu } from '../context-menu';
import { placeSubmenu } from '@/lib/menu-placement';

// A submenu stays inside the window: beside its entry, moved up as far as it
// needs, capped and scrolling when it is taller than the window, on the other
// side when there's no room. The folder menu's Rules submenu ran off the
// bottom of a 570px desktop window: its rules load after it opened.

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

let viewport = { width: 1000, height: 570 };
// The Rules entry, and the submenu's natural size.
let entry = { left: 300, top: 480, width: 220, height: 32 };
let sub = { width: 260, height: 60 };
const ROW = 80;
let menuBar: HTMLElement | null = null;

const observers = new Set<() => void>();
class ManualResizeObserver {
  private readonly cb: () => void;
  constructor(cb: () => void) { this.cb = cb; }
  observe() { observers.add(this.cb); }
  unobserve() {}
  disconnect() { observers.delete(this.cb); }
}
const resizeAll = () => act(() => { for (const cb of [...observers]) cb(); });

beforeEach(() => {
  viewport = { width: 1000, height: 570 };
  entry = { left: 300, top: 480, width: 220, height: 32 };
  sub = { width: 260, height: 60 };
  vi.stubGlobal('ResizeObserver', ManualResizeObserver);
  Object.defineProperty(window, 'innerWidth', { get: () => viewport.width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { get: () => viewport.height, configurable: true });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.windowMenuBar !== undefined) return rect(0, 0, viewport.width, 32);
    const panel = this.closest<HTMLElement>('[data-submenu-panel]');
    if (panel) {
      // The panel sits where its style puts it (left/top 0 before it's placed).
      const left = parseFloat(panel.style.left) || 0;
      const top = parseFloat(panel.style.top) || 0;
      if (this === panel) return rect(left, top, sub.width, sub.height);
      if (this.dataset.menuScroll !== undefined) return rect(left, top + 1, sub.width, this.clientHeight);
      const list = panel.firstElementChild as HTMLElement;
      const index = Array.from(panel.querySelectorAll('[role="menuitem"]')).indexOf(this);
      return rect(left, top + 5 + index * ROW - list.scrollTop, sub.width, ROW);
    }
    if ((this.firstElementChild as HTMLElement | null)?.dataset.testid === 'rules') {
      return rect(entry.left, entry.top, entry.width, entry.height);
    }
    if (this.getAttribute('role') === 'menu') return rect(entry.left, 100, entry.width, 420);
    return rect(0, 0, 0, 0);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  observers.clear();
  menuBar?.remove();
  menuBar = null;
});

function openRules(count = 12) {
  render(
    <ContextMenu isOpen position={{ x: entry.left, y: 100 }} onClose={() => {}}>
      <ContextMenuItem label="Refresh" onClick={() => {}} />
      <ContextMenuSubMenu label="Rules" testId="rules">
        {Array.from({ length: count }, (_, i) => (
          <ContextMenuItem key={i} label={`Move from wordpress${i}@example.org to wordpress`} onClick={() => {}} />
        ))}
      </ContextMenuSubMenu>
    </ContextMenu>,
  );
  fireEvent.mouseEnter(screen.getByTestId('rules').parentElement!);
  const panel = screen.getByRole('menu', { name: 'Rules' });
  return { panel, list: panel.firstElementChild as HTMLElement };
}

const px = (value: string) => parseFloat(value);

/** jsdom has no getComputedStyle direction from dir: answer rtl for every element. */
function forceRtl() {
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
    const style = real(el, pseudo);
    return new Proxy(style, {
      get: (target, prop) => {
        if (prop === 'direction') return 'rtl';
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
}

describe('a submenu near the bottom of a short window', () => {
  it('opens level with its entry when it fits', () => {
    const { panel } = openRules();
    expect(panel.style.top).toBe('480px');
    expect(panel.style.left).toBe('520px');
  });

  it('moves up to stay inside when its rules load after it opened', () => {
    const { panel } = openRules();
    sub.height = 400;
    resizeAll();
    expect(px(panel.style.top) + sub.height).toBeLessThanOrEqual(570 - 10);
    expect(panel.style.top).toBe(`${570 - 10 - 400}px`);
  });

  it('moves up when the window gets shorter while it is open', () => {
    sub.height = 300;
    const { panel } = openRules();
    expect(panel.style.top).toBe(`${570 - 10 - 300}px`);
    viewport.height = 400;
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(panel.style.top).toBe(`${400 - 10 - 300}px`);
  });
});

describe('a submenu taller than the window', () => {
  it('starts at the top margin, gets a max height and scrolls inside', () => {
    sub.height = 12 * ROW + 10;
    const { panel, list } = openRules();
    expect(panel.style.top).toBe('10px');
    expect(list.className).toContain('overflow-y-auto');
    expect(list.style.maxHeight).toBe(`${570 - 20 - 2}px`);
  });

  it('stays below the desktop app\'s menu bar', () => {
    menuBar = document.createElement('div');
    menuBar.dataset.windowMenuBar = '';
    document.body.appendChild(menuBar);
    sub.height = 12 * ROW + 10;
    const { panel, list } = openRules();
    expect(panel.style.top).toBe('36px');
    expect(list.style.maxHeight).toBe(`${570 - 10 - 36 - 2}px`);
  });

  it('scrolls the row the arrow keys move to into view', () => {
    sub.height = 12 * ROW + 10;
    const { panel, list } = openRules();
    Object.defineProperty(list, 'clientHeight', { value: 548, configurable: true });
    Object.defineProperty(list, 'scrollHeight', { value: 12 * ROW + 8, configurable: true });
    Object.defineProperty(list, 'scrollTop', { value: 0, writable: true, configurable: true });
    const rows = Array.from(panel.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    rows[0].focus();
    for (let i = 0; i < 8; i++) fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[8]);
    expect(list.scrollTop).toBeGreaterThan(0);
    const row = rows[8].getBoundingClientRect();
    const box = list.getBoundingClientRect();
    expect(row.top).toBeGreaterThanOrEqual(box.top);
    expect(row.bottom).toBeLessThanOrEqual(box.bottom);
    // The last row and the first: scrolled to the end and back, padding and all.
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(list.scrollTop).toBe(12 * ROW + 8 - 548);
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(list.scrollTop).toBe(0);
  });

  it('keeps the focused row in view when the rows load and it starts to scroll', () => {
    const { panel, list } = openRules();
    const rows = Array.from(panel.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    rows[rows.length - 1].focus();
    Object.defineProperty(list, 'clientHeight', { value: 548, configurable: true });
    Object.defineProperty(list, 'scrollHeight', { value: 12 * ROW + 8, configurable: true });
    Object.defineProperty(list, 'scrollTop', { value: 0, writable: true, configurable: true });
    sub.height = 12 * ROW + 10;
    resizeAll();
    expect(list.scrollTop).toBe(12 * ROW + 8 - 548);
  });
});

describe('a submenu with no room on its side', () => {
  it('opens on the left when the window gets too narrow on the right', () => {
    const { panel } = openRules();
    expect(panel.style.left).toBe('520px');
    viewport.width = 700;
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(panel.style.left).toBe(`${300 - 260}px`);
  });

  it('RTL: opens on the left, and on the right once the entry has no room on its left', () => {
    forceRtl();
    entry.left = 400;
    const { panel } = openRules();
    expect(panel.style.left).toBe(`${400 - 260}px`);
    entry.left = 200;
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(panel.style.left).toBe(`${200 + 220}px`);
  });
});

describe('placeSubmenu', () => {
  const viewportSize = { width: 1000, height: 570 };
  const item = { left: 300, top: 480, right: 520, bottom: 512 };

  it('beside the entry, moved up so its bottom stays inside', () => {
    expect(placeSubmenu({ item, size: { width: 260, height: 300 }, viewport: viewportSize })).toEqual({ x: 520, y: 260 });
  });

  it('taller than the window: from the top, capped', () => {
    expect(placeSubmenu({ item, size: { width: 260, height: 900 }, viewport: viewportSize })).toEqual({ x: 520, y: 10, maxHeight: 550 });
  });

  it('no room on the right: on the left', () => {
    const right = { left: 700, top: 100, right: 920, bottom: 132 };
    expect(placeSubmenu({ item: right, size: { width: 260, height: 100 }, viewport: viewportSize }).x).toBe(440);
  });

  it('RTL mirrored: on the left first, on the right when there is no room on the left', () => {
    expect(placeSubmenu({ item, size: { width: 260, height: 100 }, viewport: viewportSize, rtl: true }).x).toBe(40);
    const left = { left: 60, top: 100, right: 280, bottom: 132 };
    expect(placeSubmenu({ item: left, size: { width: 260, height: 100 }, viewport: viewportSize, rtl: true }).x).toBe(280);
  });

  it('no room on either side: the side with more room, inside the window', () => {
    const wide = { left: 100, top: 100, right: 800, bottom: 132 };
    expect(placeSubmenu({ item: wide, size: { width: 400, height: 100 }, viewport: viewportSize }).x).toBe(590);
  });

  it('below the desktop app\'s title row', () => {
    expect(placeSubmenu({ item, size: { width: 260, height: 900 }, viewport: viewportSize, topEdge: 40 })).toEqual({ x: 520, y: 44, maxHeight: 570 - 10 - 44 });
  });
});
