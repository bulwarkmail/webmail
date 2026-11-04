import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextMenu, ContextMenuItem, ContextMenuSubMenu, type ContextMenuPosition } from '../context-menu';
import { useContextMenu } from '@/hooks/use-context-menu';
import { placeMenu } from '@/lib/menu-placement';
import type { BulwarkDesktopBridge } from '@/lib/desktop/types';

// Every menu opens next to what opened it: under a button, lined up with its
// edge, or at the pointer, and towards the other side only where there's no
// room. Never clamped somewhere away from the button.

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

const MENU = { width: 220, height: 300 };

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 720, configurable: true });
  Object.defineProperty(window, 'outerWidth', { value: 1280, configurable: true });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.getAttribute('role') === 'menu' ? rect(0, 0, MENU.width, MENU.height) : rect(0, 0, 0, 0);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  window.bulwarkDesktop = undefined;
  document.documentElement.dir = '';
});

function openAt(position: ContextMenuPosition) {
  render(
    <ContextMenu isOpen position={position} onClose={() => {}}>
      <ContextMenuItem label="Reply" onClick={() => {}} />
    </ContextMenu>,
  );
  const menu = screen.getByRole('menu');
  return { left: parseFloat(menu.style.left), top: parseFloat(menu.style.top) };
}

describe('a menu from a right-click', () => {
  it('opens at the pointer where there is room', () => {
    expect(openAt({ x: 300, y: 200 })).toEqual({ left: 300, top: 200 });
  });

  it('opens to the left of the pointer near the right edge, its corner still at the pointer', () => {
    // Clamped instead, the menu would sit under the pointer, away from where the click was.
    expect(openAt({ x: 1200, y: 200 })).toEqual({ left: 1200 - MENU.width, top: 200 });
  });

  it('opens upwards from the pointer near the bottom', () => {
    expect(openAt({ x: 300, y: 650 })).toEqual({ left: 300, top: 650 - MENU.height });
  });

  it('keeps the pointer where it was: the hook no longer guesses a size and moves it first', () => {
    function Row() {
      const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu<string>();
      return (
        <>
          <div data-testid="row" onContextMenu={(e) => openContextMenu(e, 'row')}>Row</div>
          <ContextMenu isOpen={contextMenu.isOpen} position={contextMenu.position} onClose={closeContextMenu}>
            <ContextMenuItem label="Reply" onClick={() => {}} />
          </ContextMenu>
        </>
      );
    }
    render(<Row />);
    // A short menu right-clicked at 640: it fits below the pointer.
    MENU.height = 60;
    try {
      fireEvent.contextMenu(screen.getByTestId('row'), { clientX: 400, clientY: 640 });
      const menu = screen.getByRole('menu');
      expect(menu.style.top).toBe('640px');
      expect(menu.style.left).toBe('400px');
    } finally {
      MENU.height = 300;
    }
  });
});

describe('a menu from a button', () => {
  it('sits under the button, lined up with its start edge', () => {
    expect(openAt({ x: 0, y: 0, anchor: { left: 100, top: 40, right: 132, bottom: 72 } })).toEqual({ left: 100, top: 76 });
  });

  it('lines up with the button\'s end edge for a button at the end of a toolbar', () => {
    expect(openAt({ x: 0, y: 0, anchor: { left: 900, top: 40, right: 932, bottom: 72, align: 'end' } })).toEqual({ left: 932 - MENU.width, top: 76 });
  });

  it('switches to the button\'s other edge when it doesn\'t fit, instead of sliding away from it', () => {
    const at = openAt({ x: 0, y: 0, anchor: { left: 1200, top: 40, right: 1232, bottom: 72 } });
    expect(at.left + MENU.width).toBe(1232);
  });

  it('goes above the button when there is no room below', () => {
    expect(openAt({ x: 0, y: 0, anchor: { left: 100, top: 600, right: 132, bottom: 632 } }).top).toBe(600 - 4 - MENU.height);
  });

  it('too tall for either side: stays under the button, as tall as the room, and scrolls', () => {
    // The ⋮ menu at 150 % zoom: 480 CSS pixels of window.
    Object.defineProperty(window, 'innerHeight', { value: 480, configurable: true });
    MENU.height = 460;
    try {
      render(
        <ContextMenu isOpen position={{ x: 0, y: 0, anchor: { left: 805, top: 12, right: 837, bottom: 44, align: 'end' } }} onClose={() => {}}>
          <ContextMenuItem label="Reply" onClick={() => {}} />
        </ContextMenu>,
      );
      const menu = screen.getByRole('menu');
      // Clamped instead, it sat at 10 and covered its own button.
      expect(menu.style.top).toBe('48px');
      expect((menu.firstElementChild as HTMLElement).style.maxHeight).toBe(`${480 - 10 - 48 - 2}px`);
    } finally {
      MENU.height = 300;
    }
  });

  it('mirrors in RTL: start is the right edge', () => {
    document.documentElement.dir = 'rtl';
    const at = openAt({ x: 0, y: 0, anchor: { left: 500, top: 40, right: 532, bottom: 72 } });
    // jsdom computes no direction from dir; the pure function covers RTL below.
    expect([500, 532 - MENU.width]).toContain(at.left);
  });
});

describe('placeMenu', () => {
  const viewport = { width: 1280, height: 720 };
  const size = { width: 220, height: 300 };

  it('RTL: under a button, its right edge with the button\'s right edge', () => {
    expect(placeMenu({ point: { x: 0, y: 0 }, anchor: { left: 500, top: 40, right: 532, bottom: 72 }, size, viewport, rtl: true }))
      .toEqual({ x: 532 - 220, y: 76 });
  });

  it('RTL: an end-aligned button gets the left edge', () => {
    expect(placeMenu({ point: { x: 0, y: 0 }, anchor: { left: 40, top: 40, right: 72, bottom: 72, align: 'end' }, size, viewport, rtl: true }))
      .toEqual({ x: 40, y: 76 });
  });

  it('RTL: a right-click opens to the left of the pointer', () => {
    expect(placeMenu({ point: { x: 600, y: 100 }, size, viewport, rtl: true })).toEqual({ x: 380, y: 100 });
  });

  it('taller than the window: inside it, from the top margin, and the menu scrolls', () => {
    expect(placeMenu({ point: { x: 600, y: 100 }, size: { width: 220, height: 900 }, viewport })).toEqual({ x: 600, y: 10 });
  });

  it('wider than the room on both sides of a button: clamped inside the window', () => {
    expect(placeMenu({ point: { x: 0, y: 0 }, anchor: { left: 100, top: 40, right: 132, bottom: 72 }, size: { width: 1270, height: 100 }, viewport }).x).toBe(10);
  });
});

describe('a native menu from a button', () => {
  it('lines its right edge up with an end-aligned button, by the native menu\'s width, not the hidden copy\'s', async () => {
    const popup = vi.fn(async () => null);
    window.bulwarkDesktop = { version: 1, platform: 'win32', menu: { setState: () => {}, popup } } as unknown as BulwarkDesktopBridge;
    // The hidden copy holds every submenu open, so it is far wider than the menu the OS draws.
    MENU.width = 700;
    try {
      render(
        <ContextMenu isOpen position={{ x: 0, y: 0, anchor: { left: 468, top: 40, right: 500, bottom: 72, align: 'end' } }} onClose={() => {}}>
          <ContextMenuItem label="Forward as attachment" onClick={() => {}} />
          <ContextMenuSubMenu label="Rules">
            <ContextMenuItem label="Always move mail from this sender to a folder of its own" onClick={() => {}} />
          </ContextMenuSubMenu>
          <ContextMenuItem label="Print" onClick={() => {}} />
        </ContextMenu>,
      );
      await waitFor(() => expect(popup).toHaveBeenCalled());
      const at = (popup.mock.calls[0] as unknown[])[1] as { x: number; y: number };
      expect(at.y).toBe(76);
      // Under the button: its left edge somewhere left of the button, not at the window's edge.
      expect(at.x).toBeGreaterThan(200);
      expect(at.x).toBeLessThan(468);
    } finally {
      MENU.width = 220;
    }
  });
});
