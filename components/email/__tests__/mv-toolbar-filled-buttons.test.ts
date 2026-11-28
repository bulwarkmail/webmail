import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// #1903: Mountain View's reader toolbar greys its icon buttons. The filled
// ones (Edit on a draft, Send now on a scheduled message) kept the primary
// background and took the grey text, which was hard to read.

const css = readFileSync(path.resolve(__dirname, '../../../app/globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const viewer = readFileSync(path.resolve(__dirname, '../email-viewer.tsx'), 'utf8');

/** The selectors of every rule that sets a text colour on the toolbar's buttons. */
function toolbarColourSelectors(): string[] {
  const selectors: string[] = [];
  for (const match of css.matchAll(/([^{}]*\[data-mv-viewer-toolbar\][^{}]*)\{([^}]*)\}/g)) {
    if (/(^|[;\s])color\s*:/.test(match[2])) {
      selectors.push(...match[1].split(',').map((s) => s.trim()).filter((s) => s.includes('button')));
    }
  }
  return selectors;
}

function toolbarButton(filled: boolean): HTMLButtonElement {
  document.body.innerHTML = `
    <div data-interface-layout="mountain-view">
      <div data-mv-viewer-toolbar="">
        <button ${filled ? 'data-filled=""' : ''} class="bg-primary">Edit</button>
      </div>
    </div>`;
  return document.querySelector('button')!;
}

describe('Mountain View reader toolbar', () => {
  it('greys the plain buttons', () => {
    const selectors = toolbarColourSelectors();
    expect(selectors.length).toBeGreaterThan(0);
    const button = toolbarButton(false);
    expect(selectors.some((s) => button.matches(s.replace(/:hover$/, '')))).toBe(true);
  });

  it('leaves the text colour of a filled button alone', () => {
    const button = toolbarButton(true);
    for (const selector of toolbarColourSelectors()) {
      expect(button.matches(selector.replace(/:hover$/, '')), selector).toBe(false);
    }
  });

  it('marks Edit and Send now as filled', () => {
    for (const testHook of [/data-testid="edit-draft"/, /title=\{t\('send_now'\)\}/]) {
      const at = viewer.search(testHook);
      expect(at).toBeGreaterThan(-1);
      const start = viewer.lastIndexOf('<Button', at);
      expect(viewer.slice(start, at)).toMatch(/variant="default"\s+data-filled=""/);
    }
  });
});
