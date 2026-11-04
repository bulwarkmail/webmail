import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { ConfirmDialog } from '../confirm-dialog';
import type { BulwarkDesktopBridge, DesktopDialogWindowAnswer, DesktopDialogWindowRequest } from '@/lib/desktop/types';

// In the desktop app the app's confirm (Empty trash, Delete forever, Sign out, …) is a
// window of its own; without the shell's dialogs.show it stays in the page.

type Show = (request: DesktopDialogWindowRequest) => Promise<DesktopDialogWindowAnswer>;

function desktop(show: Show) {
  const cancel = vi.fn();
  window.bulwarkDesktop = { version: 1, platform: 'win32', dialogs: { confirm: vi.fn(), show: vi.fn(show), cancel } } as unknown as BulwarkDesktopBridge;
  return { show: window.bulwarkDesktop!.dialogs!.show as unknown as ReturnType<typeof vi.fn<Show>>, cancel };
}

/** A show that waits until the test answers. */
function pending() {
  let answer: (value: DesktopDialogWindowAnswer) => void = () => {};
  const show: Show = () => new Promise((resolve) => (answer = resolve));
  return { show, answer: (value: DesktopDialogWindowAnswer) => answer(value) };
}

afterEach(() => {
  window.bulwarkDesktop = undefined;
});

const props = { title: 'Empty trash?', message: 'All messages in Trash will be deleted.', confirmText: 'Empty trash', variant: 'destructive' as const };

describe('ConfirmDialog in the desktop app', () => {
  it('asks in a window, draws nothing in the page, and confirms with the window\'s button', async () => {
    const gate = pending();
    const { show } = desktop(gate.show);
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<ConfirmDialog isOpen onClose={onClose} onConfirm={onConfirm} {...props} />);

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0][0]).toMatchObject({
      title: 'Empty trash?',
      message: [{ text: 'All messages in Trash will be deleted.' }],
      icon: 'warning',
      buttons: [{ label: 'cancel', variant: 'secondary' }, { label: 'Empty trash', variant: 'destructive' }],
      // Something that can't be undone: Enter is Cancel's.
      defaultIndex: 0,
    });

    await act(async () => gate.answer({ button: 1 }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Cancel, Escape or a closed window only close it', async () => {
    for (const answer of [{ button: 0 }, null]) {
      const gate = pending();
      desktop(gate.show);
      const onConfirm = vi.fn();
      const onClose = vi.fn();
      const view = render(<ConfirmDialog isOpen onClose={onClose} onConfirm={onConfirm} {...props} variant="default" />);
      await act(async () => gate.answer(answer));
      expect(onConfirm).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledTimes(1);
      view.unmount();
    }
  });

  it('a plain question says yes on Enter', () => {
    const { show } = desktop(pending().show);
    render(<ConfirmDialog isOpen onClose={vi.fn()} onConfirm={vi.fn()} title="Sign out?" message="You can sign in again." />);
    expect(show.mock.calls[0][0]).toMatchObject({ defaultIndex: 1, buttons: [{ variant: 'secondary' }, { label: 'confirm', variant: 'primary' }] });
    expect(show.mock.calls[0][0].icon).toBeUndefined();
  });

  it('takes the window back when the page closes the question', () => {
    const { cancel } = desktop(pending().show);
    const view = render(<ConfirmDialog isOpen onClose={vi.fn()} onConfirm={vi.fn()} {...props} />);
    view.rerender(<ConfirmDialog isOpen={false} onClose={vi.fn()} onConfirm={vi.fn()} {...props} />);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel.mock.calls[0][0]).toMatch(/^dialog-/);
  });

  it('stays in the page with rich details, without the bridge, or when the shell refuses', async () => {
    const { show } = desktop(pending().show);
    const view = render(<ConfirmDialog isOpen onClose={vi.fn()} onConfirm={vi.fn()} {...props} details={<ul><li>a@example.org</li></ul>} />);
    expect(screen.getByRole('alertdialog', { name: 'Empty trash?' })).toBeTruthy();
    expect(show).not.toHaveBeenCalled();
    view.unmount();

    window.bulwarkDesktop = { version: 1, platform: 'win32', dialogs: { confirm: vi.fn() } } as unknown as BulwarkDesktopBridge;
    const older = render(<ConfirmDialog isOpen onClose={vi.fn()} onConfirm={vi.fn()} {...props} />);
    expect(screen.getByRole('alertdialog', { name: 'Empty trash?' })).toBeTruthy();
    older.unmount();

    desktop(async () => {
      throw new Error('Not a question');
    });
    render(<ConfirmDialog isOpen onClose={vi.fn()} onConfirm={vi.fn()} {...props} />);
    expect(await screen.findByRole('alertdialog', { name: 'Empty trash?' })).toBeTruthy();
  });
});
