import { describe, expect, it } from 'vitest';
import { describeAccelerator, readShortcutPress, shortcutProblem, type ShortcutKeyEvent } from '../shortcut-keys';

const press = (key: string, code: string, modifiers: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent => ({
  key,
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...modifiers,
});

const CTRL_ALT = { ctrlKey: true, altKey: true };

describe('describeAccelerator', () => {
  it('names the keys as each OS does', () => {
    expect(describeAccelerator('CommandOrControl+Alt+Enter', 'win32')).toBe('Ctrl+Alt+Enter');
    expect(describeAccelerator('CommandOrControl+Alt+N', 'linux')).toBe('Ctrl+Alt+N');
    expect(describeAccelerator('CommandOrControl+Alt+N', 'darwin')).toBe('⌥⌘N');
    expect(describeAccelerator('Super+Shift+F9', 'win32')).toBe('Win+Shift+F9');
    expect(describeAccelerator('Control+Shift+CommandOrControl+B', 'darwin')).toBe('⌃⇧⌘B');
  });

  it('reads what a policy may write', () => {
    expect(describeAccelerator('Ctrl+Alt+M', 'win32')).toBe('Ctrl+Alt+M');
  });
});

describe('readShortcutPress', () => {
  it('turns a press into what the shell takes', () => {
    expect(readShortcutPress(press('n', 'KeyN', CTRL_ALT), 'win32')).toEqual({ accelerator: 'CommandOrControl+Alt+N' });
    expect(readShortcutPress(press('j', 'KeyJ', { metaKey: true, altKey: true }), 'darwin')).toEqual({ accelerator: 'CommandOrControl+Alt+J' });
    // Cmd+Opt+M minimises every window on a Mac. Elsewhere those keys are free.
    expect(readShortcutPress(press('m', 'KeyM', { metaKey: true, altKey: true }), 'darwin')).toEqual({ refused: 'reserved' });
    expect(readShortcutPress(press('m', 'KeyM', CTRL_ALT), 'win32')).toEqual({ accelerator: 'CommandOrControl+Alt+M' });
    expect(readShortcutPress(press('7', 'Digit7', { ctrlKey: true, shiftKey: true }), 'linux')).toEqual({ accelerator: 'CommandOrControl+Shift+7' });
    expect(readShortcutPress(press('Enter', 'Enter', CTRL_ALT), 'win32')).toEqual({ accelerator: 'CommandOrControl+Alt+Enter' });
  });

  it('uses the letter on the key, whatever the layout puts where', () => {
    expect(readShortcutPress(press('z', 'KeyY', CTRL_ALT), 'win32')).toEqual({ accelerator: 'CommandOrControl+Alt+Z' });
  });

  it('falls back on the key itself when Cmd+Opt changed the character', () => {
    expect(readShortcutPress(press('˜', 'KeyN', { metaKey: true, altKey: true }), 'darwin')).toEqual({ accelerator: 'CommandOrControl+Alt+N' });
  });

  it('keeps Ctrl on a Mac apart from Cmd', () => {
    expect(readShortcutPress(press('n', 'KeyN', { metaKey: true, ctrlKey: true }), 'darwin')).toEqual({ accelerator: 'CommandOrControl+Control+N' });
  });

  for (const [name, event, plainKey] of [
    ['AltGr+N on a Czech keyboard, which types }', press('}', 'KeyN', CTRL_ALT), 'n'],
    ['AltGr+E on a German keyboard, which types €', press('€', 'KeyE', CTRL_ALT), 'e'],
    ['AltGr+N on a Polish keyboard, which types ń', press('ń', 'KeyN', CTRL_ALT), 'n'],
    ['AltGr+Shift+N on a Polish keyboard, which types Ń', press('Ń', 'KeyN', { ...CTRL_ALT, shiftKey: true }), 'n'],
    ['AltGr+2 on a German keyboard, which types ²', press('²', 'Digit2', CTRL_ALT), '2'],
    ['a dead key', press('Dead', 'KeyE', CTRL_ALT), 'e'],
    ['the same with no keyboard map to go by', press('}', 'KeyN', CTRL_ALT), undefined],
    ['Option+Shift on a Mac, which types', press('Ñ', 'KeyN', { altKey: true, shiftKey: true }), 'n'],
  ] as const) {
    it(`refuses ${name}`, () => {
      expect(readShortcutPress(event, name.includes('Mac') ? 'darwin' : 'win32', plainKey)).toEqual({ refused: 'types-character' });
    });
  }

  it('takes Ctrl+Alt on a key that only gives its own letter there, as on a Russian keyboard', () => {
    expect(readShortcutPress(press('т', 'KeyN', CTRL_ALT), 'win32', 'т')).toEqual({ accelerator: 'CommandOrControl+Alt+N' });
  });

  it('a function key and Enter type nothing', () => {
    expect(readShortcutPress(press('F9', 'F9', CTRL_ALT), 'win32')).toEqual({ accelerator: 'CommandOrControl+Alt+F9' });
    expect(readShortcutPress(press('Enter', 'Enter', CTRL_ALT), 'win32')).toEqual({ accelerator: 'CommandOrControl+Alt+Enter' });
  });

  for (const [name, event] of [
    ['Ctrl+C', press('c', 'KeyC', { ctrlKey: true })],
    ['Ctrl+V', press('v', 'KeyV', { ctrlKey: true })],
    ['a letter alone', press('c', 'KeyC')],
    ['Shift+A', press('A', 'KeyA', { shiftKey: true })],
    ['Alt+Shift+A', press('A', 'KeyA', { altKey: true, shiftKey: true })],
    ['Alt+F4', press('F4', 'F4', { altKey: true })],
    ['Ctrl+F9', press('F9', 'F9', { ctrlKey: true })],
    ['a function key alone', press('F9', 'F9')],
    ['Ctrl down on its own', press('Control', 'ControlLeft', { ctrlKey: true })],
    ['Ctrl and Alt down on their own', press('Alt', 'AltLeft', CTRL_ALT)],
  ] as const) {
    it(`waits on ${name}: too few modifiers`, () => {
      expect(readShortcutPress(event, 'win32')).toEqual({ refused: 'incomplete' });
    });
  }

  for (const [name, event, platform] of [
    ['Ctrl+Shift+V, paste in every terminal', press('V', 'KeyV', { ctrlKey: true, shiftKey: true }), 'win32'],
    ['the Windows key with Ctrl+Shift+S', press('S', 'KeyS', { metaKey: true, shiftKey: true, ctrlKey: true }), 'win32'],
    ['Cmd+Shift+4, a Mac screenshot', press('4', 'Digit4', { metaKey: true, shiftKey: true }), 'darwin'],
    ['Cmd+Ctrl+Q, a Mac lock', press('q', 'KeyQ', { metaKey: true, ctrlKey: true }), 'darwin'],
  ] as const) {
    it(`refuses ${name}`, () => {
      expect(readShortcutPress(event, platform)).toEqual({ refused: 'reserved' });
    });
  }
});

describe('shortcutProblem', () => {
  it('counts Ctrl and CommandOrControl as one key off a Mac, and two on one', () => {
    expect(shortcutProblem('CommandOrControl+Control+N', 'win32')).toBe('incomplete');
    expect(shortcutProblem('CommandOrControl+Control+N', 'darwin')).toBeNull();
  });
});
