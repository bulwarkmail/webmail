import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Every right-click, ⋮ and overflow menu is the shared ContextMenu
// (components/ui/context-menu.tsx): one look, one keyboard model, one placement, and
// the same in the browser and the desktop app. A component that draws a role="menu"
// of its own is one more menu style. The few that aren't a list of actions are named
// here with the reason.
const ALLOWED: Record<string, string> = {
  'components/ui/context-menu.tsx': 'the shared menu itself',
  'components/layout/window-menu-bar.tsx': "the desktop app's menu bar: the shell's menus, with a menu bar's keys; it draws its rows in the shared menu's look",
  'components/layout/account-switcher.tsx': 'account cards with avatars and storage, not a list of actions',
  'components/layout/mv-top-bar.tsx': "Mountain View's app launcher: a grid of apps, as Gmail has it",
  'components/email/email-viewer.tsx': "the phone's More sheet, which slides in and has sub-views",
  'components/email/rich-text-editor.tsx': "the editor toolbar's pickers (font, size, colour)",
  'components/email/move-to-dialog.tsx': 'a folder list inside the Move dialog',
  'components/files/import-eml-dialog.tsx': 'a folder list inside the import dialog',
};

const ROOT = path.resolve(__dirname, '../../..');

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const all = () => [...sources(path.join(ROOT, 'components')), ...sources(path.join(ROOT, 'app'))];
const relative = (full: string) => path.relative(ROOT, full).split(path.sep).join('/');

// role="menu" as an attribute, or role: "menu" in props; not a selector like '[role="menu"]'.
const MENU_ROOT = /(?<!\[)role=(?:"menu"|\{"menu"\}|'menu')|\brole:\s*["']menu["']/;

// A menu row and its props, up to the first ">" that isn't an arrow's.
const MENU_ROW = /<(ContextMenuItem|ContextMenuSubMenu)\b((?:=>|[^>])*)>/g;

describe('one menu component', () => {
  it('no component draws a menu of its own', () => {
    const offenders = all()
      .map(relative)
      .filter((file) => !(file in ALLOWED))
      .filter((file) => MENU_ROOT.test(readFileSync(path.join(ROOT, file), 'utf8')));
    expect(offenders).toEqual([]);
  }, 60_000);

  it('the list of exceptions holds only files that still need it', () => {
    const stale = Object.keys(ALLOWED).filter((file) => {
      try {
        return !MENU_ROOT.test(readFileSync(path.join(ROOT, file), 'utf8'));
      } catch {
        return true;
      }
    });
    expect(stale).toEqual([]);
  });

  it('every row of it has an icon', () => {
    const missing: string[] = [];
    for (const full of all()) {
      const source = readFileSync(full, 'utf8');
      for (const match of source.matchAll(MENU_ROW)) {
        const attrs = match[2];
        if (attrs.includes('icon=') || attrs.includes('{...')) continue;
        const line = source.slice(0, match.index).split(/\r?\n/).length;
        missing.push(`${relative(full)}:${line}`);
      }
    }
    expect(missing).toEqual([]);
  }, 60_000);

  // useContextMenu closes the menu on a click outside its menuRef. Without the
  // ref it can't tell a click outside from a click on an item, so it doesn't
  // close at all (#1646).
  it('every menu hands its element to the hook that closes it', () => {
    const missing: string[] = [];
    for (const full of all()) {
      if (relative(full) === 'components/ui/context-menu.tsx') continue;
      const source = readFileSync(full, 'utf8');
      for (const match of source.matchAll(/<ContextMenu\b((?:=>|[^>])*)>/g)) {
        if (/\bref=\{/.test(match[1])) continue;
        missing.push(`${relative(full)}:${source.slice(0, match.index).split(/\r?\n/).length}`);
      }
    }
    expect(missing).toEqual([]);
  }, 60_000);

  it('a row that deletes or clears is drawn as destructive', () => {
    const plain: string[] = [];
    for (const full of all()) {
      const source = readFileSync(full, 'utf8');
      for (const match of source.matchAll(MENU_ROW)) {
        const attrs = match[2];
        if (!/icon=\{(Trash2|Eraser)\}/.test(attrs) || attrs.includes('destructive')) continue;
        plain.push(`${relative(full)}:${source.slice(0, match.index).split(/\r?\n/).length}`);
      }
    }
    expect(plain).toEqual([]);
  }, 60_000);
});
