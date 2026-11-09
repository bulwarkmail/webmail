/**
 * The global focus outline in app/accessibility.css.
 *
 * jsdom does not apply stylesheets or match :focus-visible, so the test takes
 * the selectors of the outline rule, drops the focus pseudo-class and checks
 * which elements the rest of each selector matches.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const css = readFileSync(path.join(process.cwd(), 'app', 'accessibility.css'), 'utf8').replace(/\r\n/g, '\n');

/** Selectors of the first top-level rule whose body contains `declaration`. */
function selectorsOf(declaration: string): string[] {
  const at = css.indexOf(declaration);
  expect(at).toBeGreaterThan(-1);
  const open = css.lastIndexOf('{', at);
  const prevClose = css.lastIndexOf('}', open);
  const prelude = css.slice(prevClose + 1, open).replace(/\/\*[\s\S]*?\*\//g, '');
  // Split on top-level commas only (the :not() lists have commas too).
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of prelude) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}

const outlined = selectorsOf('outline: var(--focus-ring-width) solid var(--focus-ring-color)')
  .find((s) => s.startsWith(':focus-visible'))!
  .replace(/^:focus-visible/, '*');

function el(html: string): Element {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host.firstElementChild!;
}

describe('global focus outline', () => {
  it.each([
    ['a menu item', '<div role="menuitem" tabindex="-1">Reply</div>'],
    ['a listbox option', '<div role="option" tabindex="-1">Inbox</div>'],
    ['a grid cell', '<div role="gridcell" tabindex="-1">12</div>'],
    ['a tab', '<button role="tab" tabindex="-1">All</button>'],
    ['a row', '<div role="row" tabindex="-1"></div>'],
    ['a tree item', '<div role="treeitem" tabindex="-1">Work</div>'],
    ['a button in a toolbar', '<button tabindex="-1">Bold</button>'],
    ['a link', '<a href="#x" tabindex="-1">Open</a>'],
    ['a plain button', '<button>Send</button>'],
  ])('draws on %s, even with tabindex -1', (_name, html) => {
    expect(el(html).matches(outlined)).toBe(true);
  });

  it.each([
    ['a message list container', '<div id="message-list" tabindex="-1"></div>'],
    ['a dialog', '<div role="dialog" tabindex="-1"></div>'],
    ['main', '<main tabindex="-1"></main>'],
    ['a heading focused after navigation', '<h1 tabindex="-1">Inbox</h1>'],
    ['a menu container', '<div role="menu" tabindex="-1"></div>'],
  ])('skips %s that only takes focus from script', (_name, html) => {
    expect(el(html).matches(outlined)).toBe(false);
  });

  it('takes its colour from the ring token, which themes keep at 3:1', () => {
    expect(css).toMatch(/--focus-ring-color:\s*var\(--color-ring\)/);
  });
});

/** The body of the top-level `@media (forced-colors: active)` block. */
function forcedBlock(): string {
  const at = css.indexOf('@media (forced-colors: active) {');
  expect(at).toBeGreaterThan(-1);
  const open = css.indexOf('{', at);
  let depth = 0;
  let end = open;
  for (; end < css.length; end++) {
    if (css[end] === '{') depth++;
    if (css[end] === '}' && --depth === 0) break;
  }
  return css.slice(open + 1, end).replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The selector of the rule in `block` whose body contains `declaration`. */
function ruleSelector(block: string, declaration: string): string {
  const at = block.indexOf(declaration);
  expect(at).toBeGreaterThan(-1);
  const open = block.lastIndexOf('{', at);
  return block.slice(block.lastIndexOf('}', open) + 1, open).trim();
}

describe('forced colours', () => {
  const block = forcedBlock();
  const selected = ruleSelector(block, 'background-color: Highlight !important;\n    color: HighlightText');

  it.each([
    ['a pressed segment (settings radio group, formatting toggle)', '<button aria-pressed="true">Light</button>'],
    ['the selected tab', '<button role="tab" aria-selected="true">All</button>'],
    ['the open message row', '<div aria-current="true"></div>'],
    ['the current folder or page', '<button aria-current="page">Inbox</button>'],
    ['an active toolbar button', '<button data-active="true"></button>'],
    ['a checked view-mode radio', '<button role="radio" aria-checked="true"></button>'],
    ['a selected option', '<div role="option" aria-selected="true"></div>'],
  ])('maps %s to Highlight', (_name, html) => {
    expect(el(html).matches(selected)).toBe(true);
  });

  it.each([
    ['an unpressed segment', '<button aria-pressed="false">Dark</button>'],
    ['an unselected tab', '<button role="tab" aria-selected="false">Unread</button>'],
    ['today without selection', '<button aria-current="date">29</button>'],
    ['a native radio', '<input type="radio" role="radio" aria-checked="true">'],
  ])('leaves %s alone', (_name, html) => {
    expect(el(html).matches(selected)).toBe(false);
  });

  it('gives switches a border and a knob that keeps its fill', () => {
    expect(ruleSelector(block, 'border: 1px solid ButtonText')).toBe('[role="switch"]');
    const knob = block.slice(block.indexOf('[role="switch"] > span'));
    expect(knob).toMatch(/^\[role="switch"\] > span \{\s*forced-color-adjust: none;\s*background-color: ButtonText/);
    expect(block).toMatch(/\[role="switch"\]\[aria-checked="true"\] > span \{\s*background-color: HighlightText/);
  });

  it('lets a colour swatch keep its colour, and only the swatch', () => {
    expect(el('<span style="background-color: rgb(1, 2, 3)"></span>').matches(':is(span, div, i):empty[style*="background"]')).toBe(true);
    expect(block).toContain(':is(span, div, i):empty[style*="background"] {\n    forced-color-adjust: none;');
  });
});

describe('large targets', () => {
  const tall = selectorsOf('min-height: 44px;').join(', ');
  const wide = selectorsOf('min-width: 44px;').join(', ');
  const strip = (sel: string) => sel.replace(/:root\[data-large-targets="on"\]\s*/g, '');

  it.each([
    ['a button', '<button>Reply</button>'],
    ['a menu item', '<div role="menuitem">Archive</div>'],
    ['an option', '<div role="option">Inbox</div>'],
    ['a tab', '<button role="tab">All</button>'],
    ['a custom checkbox', '<button role="checkbox" aria-checked="false"></button>'],
  ])('makes %s 44px tall when On', (_name, html) => {
    expect(el(html).matches(strip(tall))).toBe(true);
  });

  it('keeps the switch at its drawn size and gives it a 44px hit area instead', () => {
    const sw = el('<button role="switch" aria-checked="true"><span></span></button>');
    expect(sw.matches(strip(tall))).toBe(false);
    expect(sw.matches(strip(wide))).toBe(false);
    expect(css).toMatch(/:root\[data-large-targets="on"\] \[role="switch"\]::after \{[^}]*width: max\(100%, 44px\);[^}]*height: max\(100%, 44px\);/);
  });

  it('applies only when the setting is On; System is left to the touch-screen styles', () => {
    for (const s of selectorsOf('min-height: 44px;')) expect(s.startsWith(':root[data-large-targets="on"]')).toBe(true);
  });
});

describe('large text in narrow panes', () => {
  it('lets labels in the folder list and settings navigation wrap once the pane is narrow for the text', () => {
    expect(selectorsOf('container: a11y-nav / inline-size;')).toEqual(['nav:is([data-tour="sidebar"], [data-tour="settings-tabs"])']);
    expect(css).toMatch(/@container a11y-nav \(width < 14rem\) \{\s*\.truncate \{[^}]*white-space: normal;/);
  });

  it('shows a cut label in full while its control has the keyboard focus', () => {
    const wrap = selectorsOf('hyphens: auto;\n}').map((s) => s.replace(':focus-visible', ''));
    const label = el('<button><span class="truncate">Notifications</span></button>').querySelector('.truncate')!;
    document.body.append(label.parentElement!);
    expect(wrap.some((s) => label.matches(s))).toBe(true);
    const rowLabel = el('<div role="option"><span class="truncate">Subject</span></div>').querySelector('.truncate')!;
    document.body.append(rowLabel.parentElement!);
    expect(wrap.some((s) => rowLabel.matches(s))).toBe(false);
    // With the focus outline off, the focus changes nothing on screen.
    document.documentElement.dataset.focusRing = 'off';
    expect(wrap.some((s) => label.matches(s))).toBe(false);
    delete document.documentElement.dataset.focusRing;
  });
});

describe('scroll padding', () => {
  it('keeps a focused element clear of sticky headers inside the scrolling panes too', () => {
    const panes = selectorsOf('scroll-padding-block: 3rem;').join(', ');
    expect(el('<div class="flex-1 overflow-y-auto"></div>').matches(panes)).toBe(true);
    expect(el('<div class="overflow-auto"></div>').matches(panes)).toBe(true);
  });
});

describe('reduced transparency', () => {
  it('gives Aurora Glass solid surfaces, in both colour schemes', () => {
    expect(css).toMatch(/:root\[data-transparency="reduce"\] body\[data-theme-skin="builtin-aurora-glass"\] \{\s*--color-sidebar-accent: #e1e2fb;/);
    expect(css).toMatch(/:root\.dark\[data-transparency="reduce"\] body\[data-theme-skin="builtin-aurora-glass"\] \{[^}]*--color-card: #101119;/);
    expect(css).toMatch(/:root\[data-transparency="reduce"\] body\[data-theme-skin="builtin-aurora-glass"\] :is\(\.bg-card, \.bg-popover, \[role="menu"\], \[role="dialog"\], \[role="listbox"\]\) \{\s*background-color: var\(--color-popover\) !important;/);
  });
});

describe('focus outline off', () => {
  /** Selectors and body of the rule whose prelude starts with `start`. */
  function ruleAt(start: string): { selectors: string[]; body: string } {
    const at = css.indexOf(start);
    expect(at).toBeGreaterThan(-1);
    const open = css.indexOf('{', at);
    return {
      selectors: css.slice(at, open).split(/,\s*\n/).map((s) => s.trim()),
      body: css.slice(open + 1, css.indexOf('}', open)),
    };
  }

  it('takes the outline off every focused element, the browser one included', () => {
    const rule = ruleAt('html:root[data-focus-ring="off"] :focus-visible');
    expect(rule.body.trim()).toBe('outline: none !important;');
    expect(rule.selectors).toHaveLength(2);
    // Padded past the global outline, the inset offset and the writing area.
    for (const s of rule.selectors) expect(s.match(/:focus(-visible)?/g)!.length).toBeGreaterThanOrEqual(6);
    const bare = rule.selectors.map((s) => s.replace(/(:focus-visible|:focus)+/g, '*'));
    document.body.innerHTML = '<input type="text"><button>Send</button><div role="menuitem" tabindex="-1">Reply</div>';
    const elements = [...document.body.children];
    document.documentElement.dataset.focusRing = 'off';
    for (const e of elements) expect(bare.some((s) => e.matches(s))).toBe(true);
    document.documentElement.dataset.focusRing = 'thick';
    for (const e of elements) expect(bare.some((s) => e.matches(s))).toBe(false);
    delete document.documentElement.dataset.focusRing;
    document.body.innerHTML = '';
  });

  it("takes the writing area's bar off, and its forced-colors outline", () => {
    const rule = ruleAt('html:root[data-focus-ring="off"] [data-composer-writing]');
    expect(rule.selectors).toEqual(['html:root[data-focus-ring="off"] [data-composer-writing]:has(:is(.tiptap, textarea):focus-visible)']);
    expect(rule.body).toMatch(/^\s*box-shadow: none;\s*outline: none;\s*$/);
  });
});

// inline-reply: the editor always matches :focus-visible, and the outline
// boxed in the typing part alone, with the signature outside it.
describe("the composer's writing area", () => {
  it('shows the focus on the whole page, not as a box round the editor', () => {
    // The rule that takes the outline off, found by its first selector.
    const start = css.indexOf('html:root [data-composer-writing]');
    expect(start).toBeGreaterThan(-1);
    const rule = css.slice(start, css.indexOf('}', start));
    expect(rule).toMatch(/\{\s*outline: none !important;\s*$/);
    const off = rule.slice(0, rule.indexOf('{')).split(/,\s*\n/).map((s) => s.trim().replace(/(:focus-visible|:focus)+/g, ''));
    document.body.innerHTML = '<div data-composer-writing=""><div class="tiptap ProseMirror" contenteditable="true"></div><p>Signature</p></div><div class="tiptap other" contenteditable="true"></div>';
    const inside = document.querySelector('[data-composer-writing] .tiptap')!;
    const outside = document.querySelector('.tiptap.other')!;
    expect(off.some((s) => inside.matches(s))).toBe(true);
    // Only inside the writing area: other editors keep the outline.
    expect(off.some((s) => outside.matches(s))).toBe(false);
    document.body.innerHTML = '';
    expect(css).toMatch(/\[data-composer-writing\]:has\(:is\(\.tiptap, textarea\):focus-visible\) \{\s*box-shadow: inset var\(--focus-ring-width\) 0 0 0 var\(--focus-ring-color\);/);
    // Forced colours drop box-shadows: an outline round the page there.
    expect(forcedBlock()).toMatch(/\[data-composer-writing\]:has\(:is\(\.tiptap, textarea\):focus-visible\) \{\s*outline: var\(--focus-ring-width\) solid CanvasText;/);
  });
});

describe('more contrast', () => {
  const globals = readFileSync(path.join(process.cwd(), 'app', 'globals.css'), 'utf8');
  const brandVars = [...new Set([...globals.matchAll(/var\((--brand-[\w-]+)/g)].map((m) => m[1]))];

  /** The declarations of the rule whose selector is `selector`. */
  function body(selector: string): string {
    const at = css.indexOf(`${selector} {`);
    expect(at).toBeGreaterThan(-1);
    return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
  }

  it.each([
    ['the system setting', ':root:not([data-contrast="normal"])'],
    ['the More setting', ':root[data-contrast="more"]'],
  ])('drops the host palette for %s, so its stock colour pairs apply', (_name, selector) => {
    expect(brandVars.length).toBeGreaterThanOrEqual(8);
    const rule = body(selector);
    for (const name of brandVars) expect(rule).toContain(`${name}: initial;`);
  });
});
