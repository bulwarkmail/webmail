import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * iOS Safari zooms the viewport when a focused field computes below 16px and
 * leaves the page zoomed and panned afterwards (#838). Every field in the app
 * is `text-sm` (0.875rem), so none of the three --font-size-base settings
 * clears the threshold on its own: 12.25px / 14px / 15.75px.
 *
 * jsdom does not evaluate media queries or the cascade well enough to assert
 * this against a rendered element, so lock the stylesheet rule itself. The
 * behavioural check lives with the browser suite.
 */
const css = readFileSync(path.join(process.cwd(), 'app', 'globals.css'), 'utf8');

/** The `@media (pointer: coarse)` block that carries the font-size floor. */
function coarseBlockWithFontSize(): string {
  const start = css.search(/@media\s*\(\s*pointer:\s*coarse\s*\)\s*\{/);
  expect(start, 'no @media (pointer: coarse) block in globals.css').toBeGreaterThan(-1);

  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error('unterminated @media (pointer: coarse) block');
}

describe('iOS input zoom floor (#838)', () => {
  const block = coarseBlockWithFontSize();

  it('floors touch-device fields at 16px', () => {
    expect(block).toMatch(/font-size:\s*max\(\s*16px\s*,/);
  });

  it('keeps scaling past the floor for the Large font-size setting', () => {
    // A bare `16px` would pin Large (18px root) back down to the threshold.
    expect(block).toMatch(/font-size:\s*max\(\s*16px\s*,\s*1rem\s*\)/);
  });

  it.each(['input', 'textarea', 'select', '[contenteditable="true"]'])(
    'covers %s',
    (selector) => {
      expect(block).toContain(selector);
    },
  );

  it('leaves checkbox and radio alone, whose box is font-relative in Safari', () => {
    expect(block).toContain(':not([type="checkbox"])');
    expect(block).toContain(':not([type="radio"])');
  });

  it('is scoped to touch pointers so desktop typography is untouched', () => {
    // The rule must not leak out of the media query into the base stylesheet.
    const outside = css.replace(block, '');
    expect(outside).not.toMatch(/font-size:\s*max\(\s*16px/);
  });
});

describe('viewport keeps pinch zoom available (#838)', () => {
  const layout = readFileSync(path.join(process.cwd(), 'app', '(main)', 'layout.tsx'), 'utf8');

  it('does not pin maximum-scale or disable user scaling', () => {
    // Blocking zoom would also stop the auto-zoom, but at the cost of the
    // accessibility affordance the CSS floor exists to preserve.
    expect(layout).not.toMatch(/maximumScale/);
    expect(layout).not.toMatch(/userScalable/);
  });
});
