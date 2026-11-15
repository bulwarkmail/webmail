import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * Mountain View's j / k cursor filled its row with the accent colour. In the
 * light theme that is the same pale blue as a ticked row, so the cursor could
 * not be told from the selection (#1702). The dark theme keeps the fill (its
 * selection colour is grey there); the light theme marks the cursor with a
 * bar on the row's leading edge and leaves the row its own colour.
 *
 * jsdom does not resolve the cascade of these rules, so lock the stylesheet.
 */
const css = readFileSync(path.join(process.cwd(), 'app', 'globals.css'), 'utf8').replace(/\r\n/g, '\n');

const MV = '[data-interface-layout="mountain-view"]';
const CURSOR = '[data-mv-row][aria-current="true"]';

function ruleBody(selector: string): string | null {
  const index = css.indexOf(`${selector} {`);
  if (index === -1) return null;
  const open = css.indexOf('{', index);
  return css.slice(open + 1, css.indexOf('}', open));
}

describe('Mountain View cursor row (#1702)', () => {
  it('fills the cursor row with the accent in the dark theme only', () => {
    expect(ruleBody(`${MV} ${CURSOR}`)).toBeNull();
    expect(ruleBody(`${MV}.dark ${CURSOR}`)).toMatch(/background-color:\s*var\(--color-accent\)/);
  });

  it('marks it with a bar on the leading edge in the light theme', () => {
    const bar = ruleBody(`${MV}:not(.dark) ${CURSOR}::before`);
    expect(bar).not.toBeNull();
    expect(bar).toMatch(/inset-inline-start:\s*0/);
    expect(bar).toMatch(/width:\s*\d+px/);
    expect(bar).toMatch(/background-color:\s*var\(--color-primary\)/);
  });

  it('still gives a ticked row the selection colour', () => {
    expect(ruleBody(`${MV} [data-mv-row][data-checked]`)).toMatch(/background-color:\s*var\(--mv-nav-selected\)/);
  });
});
