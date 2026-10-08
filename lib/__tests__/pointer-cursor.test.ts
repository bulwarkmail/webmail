import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * Tailwind v4's preflight resets buttons to the default cursor, so buttons,
 * menu items, tabs and switches showed the arrow instead of the pointer.
 * globals.css gives them the pointer back from the base layer, where a cursor
 * utility on a component still overrides it.
 *
 * jsdom does not cascade layered stylesheets, so lock the stylesheet rules.
 * Only rules inside `@layer base` count: unlayered, they would beat the
 * utilities.
 */
const css = readFileSync(path.join(process.cwd(), 'app', 'globals.css'), 'utf8');

/** Return the bodies of every top-level `@layer base { ... }` block. */
function baseLayers(): string[] {
  const bodies: string[] = [];
  let from = 0;
  for (;;) {
    const idx = css.indexOf('\n@layer base {', from);
    if (idx === -1) return bodies;
    const open = css.indexOf('{', idx);
    let depth = 0;
    let end = open;
    for (; end < css.length; end++) {
      if (css[end] === '{') depth++;
      if (css[end] === '}' && --depth === 0) break;
    }
    bodies.push(css.slice(open + 1, end));
    from = end;
  }
}

/** Selectors of each rule in a block, keyed by the cursor the rule sets. */
function cursorRules(block: string): Map<string, string[]> {
  const rules = new Map<string, string[]>();
  for (const m of block.matchAll(/([^{}]+)\{\s*cursor:\s*([a-z-]+);\s*\}/g)) {
    const selectors = m[1].split(',').map((s) => s.trim());
    rules.set(m[2], [...(rules.get(m[2]) ?? []), ...selectors]);
  }
  return rules;
}

describe('pointer cursor on clickable controls', () => {
  const rules = cursorRules(baseLayers().join('\n'));
  const pointer = rules.get('pointer') ?? [];
  const notAllowed = rules.get('not-allowed') ?? [];

  it.each([
    'button:not(:disabled)',
    'select:not(:disabled)',
    '[role="button"]:not([aria-disabled="true"])',
    '[role="tab"]:not([aria-disabled="true"])',
    '[role="switch"]:not([aria-disabled="true"])',
    '[role="option"]:not([aria-disabled="true"])',
    '[role="menuitem"]:not([aria-disabled="true"])',
  ])('gives %s the pointer', (selector) => {
    expect(pointer).toContain(selector);
  });

  it.each([
    'button:disabled',
    'select:disabled',
    '[role="button"][aria-disabled="true"]',
    '[role="menuitem"][aria-disabled="true"]',
  ])('gives %s not-allowed', (selector) => {
    expect(notAllowed).toContain(selector);
  });

  it('never gives a disabled control the pointer', () => {
    for (const selector of pointer) {
      expect(selector).not.toMatch(/:disabled(?!\))|\[aria-disabled="true"\](?!\))/);
    }
  });
});
