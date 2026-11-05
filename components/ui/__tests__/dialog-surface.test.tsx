import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { Dialog } from '../dialog';
import type { BulwarkDesktopBridge } from '@/lib/desktop/types';

// In the desktop app a Dialog is drawn into a window of its own: the page opens an
// about:blank window named bulwark-dialog-…, copies its styles over and renders the same
// tree into it. Here the window is a second document.

interface FakeWindow {
  name: string;
  document: Document;
  devicePixelRatio: number;
  closed: boolean;
  close: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
  addEventListener: (type: string, listener: () => void) => void;
  fire: (type: string) => void;
}

/** A document with a window of its own, as the dialog window's is: an iframe's. */
function frameDocument(): Document {
  const frame = document.createElement('iframe');
  frame.setAttribute('data-fake-window', '');
  document.body.appendChild(frame);
  return frame.contentDocument!;
}

function fakeWindow(name: string): FakeWindow {
  const listeners: Record<string, (() => void)[]> = {};
  const win: FakeWindow = {
    name,
    document: frameDocument(),
    devicePixelRatio: 1,
    closed: false,
    close: vi.fn(() => {
      win.closed = true;
    }),
    open: vi.fn(),
    addEventListener: (type, listener) => {
      (listeners[type] ??= []).push(listener);
    },
    fire: (type) => listeners[type]?.forEach((listener) => listener()),
  };
  win.open.mockImplementation((_url: string, child: string) => {
    const nested = fakeWindow(child);
    opened.push(nested);
    return nested;
  });
  return win;
}

let opened: FakeWindow[] = [];

function desktop(showWindow: (name: string) => Promise<boolean> = async () => true) {
  opened = [];
  const show = vi.fn(showWindow);
  window.bulwarkDesktop = { version: 1, platform: 'win32', dialogs: { confirm: vi.fn(), showWindow: show } } as unknown as BulwarkDesktopBridge;
  vi.spyOn(window, 'open').mockImplementation(((_url: string, name: string) => {
    const win = fakeWindow(name);
    opened.push(win);
    return win as unknown as Window;
  }) as typeof window.open);
  return show;
}

afterEach(() => {
  window.bulwarkDesktop = undefined;
  vi.restoreAllMocks();
  document.documentElement.className = '';
  document.head.querySelectorAll('[data-test-style]').forEach((node) => node.remove());
  document.querySelectorAll('[data-fake-window]').forEach((node) => node.remove());
});

/** Choose a PIN, as a form dialog: Save takes what was typed. */
function PinDialog({ onSave, onClose }: { onSave: (pin: string) => void; onClose: () => void }) {
  const [pin, setPin] = useState('');
  const short = pin.length > 0 && pin.length < 4;
  return (
    <Dialog
      isOpen
      onClose={onClose}
      title="Choose a PIN"
      onSubmit={(e) => {
        e.preventDefault();
        if (pin.length >= 4) onSave(pin);
      }}
      footer={<button type="submit" disabled={pin.length < 4}>Save</button>}
    >
      <input aria-label="PIN" value={pin} onChange={(e) => setPin(e.target.value)} />
      {short && <p role="alert">At least 4 digits</p>}
    </Dialog>
  );
}

describe('Dialog in the desktop app', () => {
  it('draws into a window of its own, with the page\'s styles and theme, and shows it', async () => {
    const show = desktop();
    const style = document.createElement('style');
    style.setAttribute('data-test-style', '');
    style.textContent = '.card { color: red }';
    document.head.appendChild(style);
    document.documentElement.classList.add('dark');

    render(<PinDialog onSave={vi.fn()} onClose={vi.fn()} />);
    expect(opened).toHaveLength(1);
    const [win] = opened;
    expect(win.name).toMatch(/^bulwark-dialog-/);
    // Nothing over the page.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(win.document.querySelector('[role="dialog"]')?.textContent).toContain('Choose a PIN');
    expect(win.document.head.textContent).toContain('.card { color: red }');
    expect(win.document.documentElement.classList.contains('dark')).toBe(true);
    expect(win.document.title).toBe('Choose a PIN');
    await waitFor(() => expect(show).toHaveBeenCalledWith(win.name));

    // A style the page adds later comes over too.
    style.textContent = '.card { color: blue }';
    await waitFor(() => expect(win.document.head.textContent).toContain('.card { color: blue }'));
  });

  it('keeps the form working there: typing, the check, Save', async () => {
    desktop();
    const onSave = vi.fn();
    render(<PinDialog onSave={onSave} onClose={vi.fn()} />);
    const doc = opened[0].document;
    const input = doc.querySelector<HTMLInputElement>('input[aria-label="PIN"]')!;
    fireEvent.change(input, { target: { value: '12' } });
    expect(doc.querySelector('[role="alert"]')?.textContent).toBe('At least 4 digits');
    fireEvent.change(input, { target: { value: '1234' } });
    expect(doc.querySelector('[role="alert"]')).toBeNull();
    fireEvent.submit(doc.querySelector('form')!);
    expect(onSave).toHaveBeenCalledWith('1234');
  });

  it('Escape in the window and closing the window itself close it; the page closing it is no user close', async () => {
    desktop();
    const onClose = vi.fn();
    const view = render(<PinDialog onSave={vi.fn()} onClose={onClose} />);
    const [win] = opened;
    fireEvent.keyDown(win.document.querySelector('input')!, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    win.fire('pagehide');
    expect(onClose).toHaveBeenCalledTimes(2);

    view.unmount();

    const again = render(<PinDialog onSave={vi.fn()} onClose={onClose} />);
    const second = opened[1];
    again.unmount();
    expect(second.close).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('gives the focus back to what opened it', async () => {
    desktop();
    function Opener() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Change PIN</button>
          <Dialog isOpen={open} onClose={() => setOpen(false)} title="Change PIN">
            <input aria-label="PIN" />
          </Dialog>
        </>
      );
    }
    render(<Opener />);
    const opener = screen.getByRole('button', { name: 'Change PIN' });
    opener.focus();
    fireEvent.click(opener);
    const [win] = opened;
    expect(win.document.activeElement?.getAttribute('aria-label')).toBe('PIN');
    fireEvent.keyDown(win.document.querySelector('input')!, { key: 'Escape' });
    expect(win.close).toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
  });

  it('a dialog opened from a dialog hangs its window on that one', () => {
    desktop();
    render(
      <Dialog isOpen onClose={vi.fn()} title="Rules">
        <Dialog isOpen onClose={vi.fn()} title="Choose folder">
          <p>Inbox</p>
        </Dialog>
      </Dialog>,
    );
    expect(opened).toHaveLength(2);
    const [outer, inner] = opened;
    expect(outer.open).toHaveBeenCalledWith('', inner.name);
    expect(inner.document.body.textContent).toContain('Inbox');
  });

  it('stays in the page without the shell\'s windows, when asked to, or when the shell refuses', async () => {
    window.bulwarkDesktop = { version: 1, platform: 'win32', dialogs: { confirm: vi.fn() } } as unknown as BulwarkDesktopBridge;
    const open = vi.spyOn(window, 'open');
    const first = render(<PinDialog onSave={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Choose a PIN' })).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
    first.unmount();
    vi.restoreAllMocks();

    desktop();
    const second = render(<Dialog isOpen inPage onClose={vi.fn()} title="Preview" />);
    expect(screen.getByRole('dialog', { name: 'Preview' })).toBeTruthy();
    expect(opened).toHaveLength(0);
    second.unmount();
    vi.restoreAllMocks();

    desktop(async () => false);
    render(<PinDialog onSave={vi.fn()} onClose={vi.fn()} />);
    await act(async () => {});
    expect(await screen.findByRole('dialog', { name: 'Choose a PIN' })).toBeTruthy();
    expect(opened[0].close).toHaveBeenCalled();
  });
});
