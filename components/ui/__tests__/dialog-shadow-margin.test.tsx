import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { Dialog } from '../dialog';
import { shadowReach } from '@/lib/desktop/dialog-surface';
import type { BulwarkDesktopBridge } from '@/lib/desktop/types';

// A dialog in a window of its own leaves room around the card for its whole shadow (the
// shadow was cut off at the window's edge), and a click in that room does what a click on
// the dimmed backdrop does over the page.

let opened: { document: Document }[] = [];

function desktop() {
  opened = [];
  window.bulwarkDesktop = { version: 1, platform: 'win32', dialogs: { confirm: vi.fn(), showWindow: vi.fn(async () => true) } } as unknown as BulwarkDesktopBridge;
  vi.spyOn(window, 'open').mockImplementation((() => {
    const frame = document.createElement('iframe');
    frame.setAttribute('data-fake-window', '');
    document.body.appendChild(frame);
    const win = { document: frame.contentDocument!, devicePixelRatio: 1, close: vi.fn(), open: vi.fn(), addEventListener: vi.fn() };
    opened.push(win);
    return win as unknown as Window;
  }) as typeof window.open);
}

afterEach(() => {
  window.bulwarkDesktop = undefined;
  vi.restoreAllMocks();
  document.querySelectorAll('[data-fake-window]').forEach((node) => node.remove());
});

describe('room for the shadow', () => {
  it('reads how far a shadow reaches, the furthest side, at least 32 px', () => {
    // shadow-xl as Chromium computes it, with Tailwind's empty layers before it.
    expect(shadowReach('rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.1) 0px 20px 25px -5px, rgba(0, 0, 0, 0.1) 0px 8px 10px -6px')).toBe(40);
    expect(shadowReach('rgba(0, 0, 0, 0.5) 0px 40px 60px 0px')).toBe(100);
    expect(shadowReach('rgba(0, 0, 0, 0.1) 0px 1px 2px 0px')).toBe(32);
    expect(shadowReach('inset rgba(0, 0, 0, 0.5) 0px 40px 60px 0px')).toBe(40);
    expect(shadowReach('none')).toBe(40);
  });

  it('a dialog window keeps its card off the edges by the shadow\'s reach', () => {
    desktop();
    render(<Dialog isOpen onClose={vi.fn()} title="Delete this message forever?" />);
    const doc = opened[0].document;
    const margin = parseFloat(doc.body.style.getPropertyValue('--bulwark-dialog-margin'));
    expect(margin).toBeGreaterThanOrEqual(40);
    const room = doc.querySelector('[data-dialog-margin]')!;
    expect(room.className).toContain('p-[var(--bulwark-dialog-margin');
    expect(room.contains(doc.querySelector('[role="dialog"]'))).toBe(true);
  });

  it('a click beside the card closes it as over the page, unless it holds unsaved input', () => {
    desktop();
    const onClose = vi.fn();
    const view = render(<Dialog isOpen onClose={onClose} title="Rename" />);
    let room = opened[0].document.querySelector('[data-dialog-margin]')!;
    fireEvent.mouseDown(room);
    fireEvent.click(room);
    expect(onClose).toHaveBeenCalledTimes(1);
    // A press in the card that ends beside it is no click beside it.
    fireEvent.mouseDown(opened[0].document.querySelector('[role="dialog"]')!);
    fireEvent.click(room);
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();

    const dirty = vi.fn();
    render(<Dialog isOpen dirty onClose={dirty} title="Rename" />);
    room = opened[1].document.querySelector('[data-dialog-margin]')!;
    fireEvent.mouseDown(room);
    fireEvent.click(room);
    expect(dirty).not.toHaveBeenCalled();
  });
});
