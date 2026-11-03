import { describe, expect, it } from 'vitest';
import { acceleratorFromKeyEvent, describeAccelerator, type ShortcutKeyEvent } from '../shortcut-keys';

const press = (key: string, code: string, modifiers: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent => ({
  key,
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...modifiers,
});

describe('describeAccelerator', () => {
  it('names the keys as each OS does', () => {
    expect(describeAccelerator('CommandOrControl+Alt+N', 'win32')).toBe('Ctrl+Alt+N');
    expect(describeAccelerator('CommandOrControl+Alt+N', 'linux')).toBe('Ctrl+Alt+N');
    expect(describeAccelerator('CommandOrControl+Alt+N', 'darwin')).toBe('⌥⌘N');
    expect(describeAccelerator('Super+Shift+F9', 'win32')).toBe('Win+Shift+F9');
    expect(describeAccelerator('Control+Shift+CommandOrControl+B', 'darwin')).toBe('⌃⇧⌘B');
  });

  it('reads what a policy may write', () => {
    expect(describeAccelerator('Ctrl+Alt+M', 'win32')).toBe('Ctrl+Alt+M');
  });
});

describe('acceleratorFromKeyEvent', () => {
  it('turns a press into what the shell takes', () => {
    expect(acceleratorFromKeyEvent(press('n', 'KeyN', { ctrlKey: true, altKey: true }), 'win32')).toBe('CommandOrControl+Alt+N');
    expect(acceleratorFromKeyEvent(press('m', 'KeyM', { metaKey: true, altKey: true }), 'darwin')).toBe('CommandOrControl+Alt+M');
    expect(acceleratorFromKeyEvent(press('7', 'Digit7', { ctrlKey: true, shiftKey: true }), 'linux')).toBe('CommandOrControl+Shift+7');
  });

  it('uses the letter on the key, whatever the layout puts where', () => {
    expect(acceleratorFromKeyEvent(press('z', 'KeyY', { ctrlKey: true, altKey: true }), 'win32')).toBe('CommandOrControl+Alt+Z');
  });

  it('falls back on the key itself when a modifier changed the character', () => {
    expect(acceleratorFromKeyEvent(press('˜', 'KeyN', { metaKey: true, altKey: true }), 'darwin')).toBe('CommandOrControl+Alt+N');
  });

  it('keeps Ctrl on a Mac apart from Cmd, and the Windows key apart from Ctrl', () => {
    expect(acceleratorFromKeyEvent(press('n', 'KeyN', { ctrlKey: true, altKey: true }), 'darwin')).toBe('Control+Alt+N');
    expect(acceleratorFromKeyEvent(press('n', 'KeyN', { metaKey: true, altKey: true }), 'win32')).toBe('Super+Alt+N');
  });

  it('needs two modifiers, so no key is taken away from every other app', () => {
    expect(acceleratorFromKeyEvent(press('c', 'KeyC', { ctrlKey: true }), 'win32')).toBeNull();
    expect(acceleratorFromKeyEvent(press('c', 'KeyC'), 'win32')).toBeNull();
  });

  it('takes one modifier on a function key, and none is still not enough', () => {
    expect(acceleratorFromKeyEvent(press('F9', 'F9', { ctrlKey: true }), 'win32')).toBe('CommandOrControl+F9');
    expect(acceleratorFromKeyEvent(press('F9', 'F9'), 'win32')).toBeNull();
  });

  it('waits while only modifiers are down', () => {
    expect(acceleratorFromKeyEvent(press('Control', 'ControlLeft', { ctrlKey: true }), 'win32')).toBeNull();
    expect(acceleratorFromKeyEvent(press('Alt', 'AltLeft', { ctrlKey: true, altKey: true }), 'win32')).toBeNull();
  });
});
