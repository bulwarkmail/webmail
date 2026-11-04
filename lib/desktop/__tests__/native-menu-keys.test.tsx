import { render, screen } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ContextMenuItem } from '@/components/ui/context-menu';
import { readMenu, toAccelerator } from '../native-menu';

// A native menu built from an HTML one shows a row's key apart from its label,
// as the native menus' own accelerators do. The calendar's view menu came out
// as "DayD", "WeekW": the key was read as part of the label.

function menuOf(children: React.ReactNode) {
  render(<div role="menu" data-testid="root">{children}</div>);
  return readMenu(screen.getByTestId('root')).items;
}

describe('a row\'s key in a native menu', () => {
  it('is not part of the label, and becomes the accelerator', () => {
    const items = menuOf(
      <button type="button" role="menuitemradio" aria-checked="false">
        <span>Day</span>
        <kbd>D</kbd>
      </button>,
    );
    expect(items[0].label).toBe('Day');
    expect(items[0].accelerator).toBe('D');
  });

  it('a menu item\'s shortcut too', () => {
    const items = menuOf(<ContextMenuItem label="Cut" shortcut="Ctrl+X" onClick={() => {}} />);
    expect(items[0]).toMatchObject({ label: 'Cut', accelerator: 'Ctrl+X' });
  });

  it('a count is no key: it goes after the label', () => {
    const items = menuOf(<ContextMenuItem label="Notifications" badge="3" onClick={() => {}} />);
    expect(items[0].label).toBe('Notifications (3)');
    expect(items[0].accelerator).toBeUndefined();
  });

  it('words in separate elements stay separate words', () => {
    const items = menuOf(
      <button type="button" role="menuitem">
        <span>Alice Example</span>
        <span>alice@example.net</span>
      </button>,
    );
    expect(items[0].label).toBe('Alice Example alice@example.net');
  });
});

describe('toAccelerator', () => {
  it.each([
    ['D', 'D'],
    ['r', 'R'],
    ['Shift + I', 'Shift+I'],
    ['Ctrl+X', 'Ctrl+X'],
    ['⌘X', 'Cmd+X'],
    ['⌘⇧K', 'Cmd+Shift+K'],
    ['Mod + Enter', 'CmdOrCtrl+Enter'],
    ['Del', 'Delete'],
    ['F2', 'F2'],
    ['?', '?'],
    ['#', '#'],
    ['Ctrl++', 'Ctrl+Plus'],
  ])('%s is %s', (hint, accelerator) => {
    expect(toAccelerator(hint)).toBe(accelerator);
  });

  it.each(['j / ↓', '', 'Hyper+Q', 'twelve'])('%s is no single key', (hint) => {
    expect(toAccelerator(hint)).toBeUndefined();
  });
});

// Menu rows show their keys through MenuShortcut (or ContextMenuItem's
// shortcut), which the native menu knows. A raw <kbd> in a file with menu
// rows is how "DayD" happened.
describe('menu rows show keys through MenuShortcut', () => {
  const root = path.resolve(__dirname, '../../..');
  it('no raw <kbd> next to role="menuitem…" rows', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.tsx')) files.push(full);
      }
    };
    walk(path.join(root, 'components'));
    walk(path.join(root, 'app'));
    const offenders = files.filter((file) => {
      if (file.endsWith(path.join('ui', 'context-menu.tsx'))) return false;
      const source = readFileSync(file, 'utf8');
      return /role="menuitem/.test(source) && /<kbd[\s>]/.test(source);
    });
    expect(offenders.map((file) => path.relative(root, file))).toEqual([]);
  }, 60_000);
});
