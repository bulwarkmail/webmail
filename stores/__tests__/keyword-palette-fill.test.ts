import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import type { Root } from 'postcss';
import { KEYWORD_PALETTE } from '../settings-store';

/**
 * A tag lozenge sits on list rows that change colour: unread, selected,
 * hovered. A see-through fill took that colour on, and an amber tag's text
 * fell below 4.5:1 on an unread row (the a11y guard's color-contrast).
 * Build globals.css with Tailwind to see what each fill actually compiles to.
 */
let root: Root;

beforeAll(async () => {
  const postcss = (await import('postcss')).default;
  const tailwind = (await import('@tailwindcss/postcss')).default;
  const file = path.join(process.cwd(), 'app', 'globals.css');
  // Scan a folder holding only the palette's fills.
  const base = mkdtempSync(path.join(os.tmpdir(), 'tag-fill-'));
  try {
    const fills = Object.values(KEYWORD_PALETTE).map((color) => color.fill).join(' ');
    writeFileSync(path.join(base, 'fills.html'), `<span class="${fills}"></span>`);
    root = (await postcss([tailwind({ base })]).process(readFileSync(file, 'utf8'), { from: file })).root;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, 60_000);

/** The values `prop` takes in the class's rule, fallbacks included. */
function values(cls: string, prop: string): string[] {
  const found: string[] = [];
  root.walkRules(`.${cls.replace(/\//g, '\\/')}`, (rule) => {
    rule.walkDecls(prop, (decl) => {
      found.push(decl.value);
    });
  });
  return found;
}

describe('KEYWORD_PALETTE fills', () => {
  it('paint the tint over the page background, so the row behind a tag cannot lower its contrast', () => {
    const seeThrough = Object.entries(KEYWORD_PALETTE)
      .filter(([, color]) => {
        const base = values(color.fill, 'background-color');
        return base.length === 0
          || base.some((v) => v !== 'var(--color-background)')
          || values(color.fill, 'background-image').length === 0;
      })
      .map(([key, color]) => `${key}: ${color.fill} -> ${values(color.fill, 'background-color').join(' | ') || 'no background'}`);
    expect(seeThrough).toEqual([]);
  });
});
