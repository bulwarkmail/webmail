import { render, screen } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContextMenuItem } from '@/components/ui/context-menu';

// A menu row's key sits apart from its label, as a keycap, in the app's language as
// Windows writes it. The desktop app shows these same rows (it used to read them into a
// native menu, which wrote "Umschalttaste" from Chromium's German strings).

afterEach(() => {
  document.documentElement.lang = '';
});

function row(shortcut: string, lang = 'en') {
  document.documentElement.lang = lang;
  render(<div role="menu"><ContextMenuItem label="Reply all" shortcut={shortcut} onClick={() => {}} /></div>);
  const item = screen.getByRole('menuitem');
  return {
    label: item.querySelector('[data-menu-label]')?.textContent,
    key: item.querySelector('[data-menu-shortcut]')?.textContent,
  };
}

describe('a menu row\'s key', () => {
  it('is not part of the label', () => {
    expect(row('Shift + R')).toEqual({ label: 'Reply all', key: 'Shift + R' });
  });

  it('says Umschalt and Entf in German, as Windows does, never Umschalttaste', () => {
    expect(row('Shift + R', 'de').key).toBe('Umschalt + R');
    document.body.innerHTML = '';
    expect(row('Del', 'de').key).toBe('Entf');
  });

  it('says Maj in French', () => {
    expect(row('Shift + I', 'fr').key).toBe('Maj + I');
  });

  it('keeps a key that is already in the app\'s words', () => {
    expect(row('Strg + Umschalt + Eingabe', 'de').key).toBe('Strg + Umschalt + Eingabe');
  });
});

// Menu rows show their keys through MenuShortcut (or ContextMenuItem's shortcut),
// which puts them apart from the label in the app's words. A raw <kbd> in a file
// with menu rows is how "DayD" happened.
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

// "Umschalttaste" is Chromium's word, not Windows': it must not appear in what the
// app writes itself.
describe('no Umschalttaste', () => {
  const root = path.resolve(__dirname, '../../..');
  it('in any locale file or source file', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(tsx?|json)$/.test(entry.name)) files.push(full);
      }
    };
    for (const dir of ['components', 'app', 'lib', 'hooks', 'locales']) walk(path.join(root, dir));
    const offenders = files.filter((file) => /Umschalttaste/i.test(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => path.relative(root, file))).toEqual([]);
  }, 60_000);
});
