import { afterEach, describe, expect, it, vi } from 'vitest';
import { askInWindow, dialogWindowsAvailable, messageRuns, readDialogTheme } from '../dialog-window';
import type { BulwarkDesktopBridge, DesktopDialogWindowRequest } from '../types';

function setBridge(dialogs: Record<string, unknown> | undefined) {
  window.bulwarkDesktop = (dialogs ? { version: 1, platform: 'win32', dialogs } : undefined) as BulwarkDesktopBridge | undefined;
}

afterEach(() => {
  setBridge(undefined);
  document.documentElement.removeAttribute('style');
  document.documentElement.className = '';
  document.documentElement.removeAttribute('dir');
});

describe('askInWindow', () => {
  it('is not there in the browser or on a shell with only the OS message box', () => {
    expect(dialogWindowsAvailable()).toBe(false);
    expect(askInWindow({ title: 'Empty trash?', buttons: [{ label: 'OK' }] })).toBeNull();
    setBridge({ confirm: vi.fn() });
    expect(dialogWindowsAvailable()).toBe(false);
    expect(askInWindow({ title: 'Empty trash?', buttons: [{ label: 'OK' }] })).toBeNull();
  });

  it('sends the question with the page\'s look and hands back the answer', async () => {
    document.documentElement.style.setProperty('--color-primary', '#185aea');
    document.documentElement.style.setProperty('--color-background', 'rgb(10, 10, 10)');
    document.documentElement.classList.add('dark');
    document.documentElement.dir = 'rtl';
    const show = vi.fn(async (_request: DesktopDialogWindowRequest) => ({ button: 1 }));
    setBridge({ confirm: vi.fn(), show, cancel: vi.fn() });

    const asked = askInWindow({ title: 'Empty trash?', message: 'Gone for good.', buttons: [{ label: 'Cancel', variant: 'secondary' }, { label: 'Empty', variant: 'destructive' }], defaultIndex: 0 })!;
    await expect(asked.answer).resolves.toEqual({ button: 1 });
    const request = show.mock.calls[0][0];
    expect(request).toMatchObject({ title: 'Empty trash?', message: [{ text: 'Gone for good.' }], defaultIndex: 0, dir: 'rtl' });
    expect(request.id).toMatch(/^dialog-/);
    expect(request.theme?.dark).toBe(true);
    expect(request.theme?.colours?.primary).toBe('rgb(24, 90, 234)');
    expect(request.theme?.colours?.background).toBe('rgb(10, 10, 10)');
  });

  it('takes a question back until it is answered, and only then', async () => {
    let answer: (value: unknown) => void = () => {};
    const cancel = vi.fn();
    setBridge({ confirm: vi.fn(), show: vi.fn(() => new Promise((resolve) => (answer = resolve))), cancel });
    const asked = askInWindow({ title: 'Sign out?', buttons: [{ label: 'OK' }] })!;
    asked.cancel();
    expect(cancel).toHaveBeenCalledTimes(1);
    const id = cancel.mock.calls[0][0];
    expect(id).toMatch(/^dialog-/);
    answer(null);
    await expect(asked.answer).resolves.toBeNull();
    asked.cancel();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('says "failed" when the shell refuses, so the page can show its own dialog', async () => {
    setBridge({ confirm: vi.fn(), show: vi.fn(async () => { throw new Error('Not a question'); }), cancel: vi.fn() });
    await expect(askInWindow({ title: 'x', buttons: [{ label: 'OK' }] })!.answer).resolves.toBe('failed');
  });
});

describe('messageRuns', () => {
  it('keeps text as it is, with ** pairs bold only where asked', () => {
    expect(messageRuns('Visit **github.com**? <b>x</b>')).toEqual([{ text: 'Visit **github.com**? <b>x</b>' }]);
    expect(messageRuns('Visit **github.com**? <b>x</b>', true)).toEqual([{ text: 'Visit ' }, { text: 'github.com', bold: true }, { text: '? <b>x</b>' }]);
    expect(messageRuns('')).toEqual([]);
  });
});

describe('readDialogTheme', () => {
  it('leaves out what it can\'t read as a colour', () => {
    document.documentElement.style.setProperty('--color-foreground', 'not-a-colour');
    const theme = readDialogTheme();
    expect(theme.colours?.foreground).toBeUndefined();
    expect(theme.dark).toBe(false);
  });
});
