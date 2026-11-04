import { describe, expect, it } from 'vitest';
import { MAIL_SECTIONS } from '@/lib/keyboard-shortcuts/mail';
import { shortcutKeyFor, type ShortcutEntry } from '@/lib/keyboard-shortcuts';

const row = (description: string): ShortcutEntry => {
  for (const section of MAIL_SECTIONS) {
    const found = section.entries.find((entry) => entry.description === description);
    if (found) return found;
  }
  throw new Error(`no row ${description}`);
};

describe('the shortcut help in the desktop app', () => {
  it('lists the Outlook keys its menus run beside the single keys', () => {
    expect(shortcutKeyFor(row('shortcuts.actions.reply'), 'windows')).toBe('Mod + R / r');
    expect(shortcutKeyFor(row('shortcuts.actions.reply_all'), 'linux')).toBe('Mod + Shift + R / R / a');
    expect(shortcutKeyFor(row('shortcuts.actions.forward'), 'mac')).toBe('Mod + Shift + F / f');
    expect(shortcutKeyFor(row('shortcuts.global.search'), 'windows')).toBe('Ctrl + E / /');
    expect(shortcutKeyFor(row('shortcuts.global.refresh'), 'windows')).toBe('F9 / F5 / Shift + G');
  });

  it('gives Ctrl+Q to Mark as read on Windows only, where Exit has no key', () => {
    expect(shortcutKeyFor(row('shortcuts.actions.mark_read'), 'windows')).toBe('Ctrl + Q / Shift + I');
    expect(shortcutKeyFor(row('shortcuts.actions.mark_read'), 'linux')).toBe('Shift + I');
    expect(shortcutKeyFor(row('shortcuts.actions.mark_read'), 'mac')).toBe('Shift + I');
  });

  it('lists nothing extra in a browser, and leaves out a row only the desktop app has', () => {
    expect(shortcutKeyFor(row('shortcuts.actions.reply'), 'browser')).toBe('r');
    expect(shortcutKeyFor(row('shortcuts.global.compose'), 'browser')).toBe('c');
    expect(shortcutKeyFor(row('desktopMenus.shortcut_apps'), 'browser')).toBeNull();
    expect(shortcutKeyFor(row('desktopMenus.shortcut_apps'), 'mac')).toBeNull();
    expect(shortcutKeyFor(row('desktopMenus.shortcut_apps'), 'windows')).toBe('Ctrl + 1 / Ctrl + 2 / Ctrl + 3 / Ctrl + 4');
  });
});
