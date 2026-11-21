/**
 * Rules stay in the place a sheet is held to.
 *
 * theme.css (and what a plugin returns from onThemeBeforeApply) may only hold
 * rules for `:root` and `.dark`; a plugin's print style only rules inside
 * `[data-print-theme]`. A browser ends a string at a line break and pairs
 * every bracket; a filter that reads a string as running on to the next
 * quote, or takes comment markers inside a string for a comment, sees other
 * rules than the browser builds. So the filters take the rules from the
 * sheet's tokens, and a sheet with an unterminated string, comment or block
 * is refused whole.
 *
 * The check in the first describes is a reader of its own that ends a string
 * at a line break, as a browser does.
 */
import { describe, it, expect } from 'vitest';
import * as loader from '../theme-loader';
import { sanitizePrintThemeCss } from '../print/print-theme';

const BS = '\\';

/** Top-level rules of a sheet, read with a line break ending a string, as a browser does. */
function topLevelPreludes(css: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let prelude = '';
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === BS) { prelude += c + (css[i + 1] ?? ''); i++; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== c && css[j] !== '\n') { if (css[j] === BS) j++; j++; }
      // An unterminated string ends before the line break.
      const end = css[j] === c ? j : j - 1;
      if (depth === 0) prelude += css.slice(i, end + 1);
      i = end;
      continue;
    }
    if (c === '{') { if (depth === 0) out.push(prelude.trim()); depth++; prelude = ''; continue; }
    if (c === '}') { depth = Math.max(0, depth - 1); prelude = ''; continue; }
    if (c === ';' && depth === 0) { prelude = ''; continue; }
    if (depth === 0) prelude += c;
  }
  return out;
}

/** The selectors of a list: divided at commas that are not escaped, not in a string and not inside brackets. */
function selectorsOf(prelude: string): string[] {
  const out = [''];
  let depth = 0;
  for (let i = 0; i < prelude.length; i++) {
    const c = prelude[i];
    if (c === BS) { out[out.length - 1] += c + (prelude[i + 1] ?? ''); i++; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < prelude.length && prelude[j] !== c) { if (prelude[j] === BS) j++; j++; }
      out[out.length - 1] += prelude.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (c === ',' && depth === 0) out.push('');
    else out[out.length - 1] += c;
  }
  return out.map((s) => s.trim());
}

const THEME_CASES: Record<string, string> = {
  'comment markers inside two strings of an @font-face rule':
    `@font-face{font-family:"/*";a:'*/'\n}\ninput[value^="a"]{display:none}\n:root{--color-x:"}"}`,
  'the same inside @keyframes':
    `@keyframes k{from{content:"/*";a:'*/'\n}}\n[role="alert"]{display:none}\n:root{--color-x:"}}"}`,
  'the same with the markers written as escapes':
    `@font-face{font-family:"${BS}2f*";a:'*${BS}2f'\n}\nhtml::after{content:"x";position:fixed;inset:0}\n:root{--color-x:"}"}`,
  'a removed url( that takes a closing quote along':
    `@font-face{font-family:"url(" "'";a:'z;'\n}\ninput[value^="a"]{display:none}\n:root{--color-x:"}"}`,
  'comment markers inside strings of two :root rules':
    `:root{--color-a:"/*"}\ninput[value^="a"]{display:none}\n:root{--color-b:"*/"}`,
  'a string left open at a line break':
    `:root{--color-a:"\n}\ninput[value^="a"]{display:none}\n:root{--color-b:"}"}`,
  'a block left open':
    `:root{--color-a:1}\n@media screen{:root{--color-b:2}\ninput[value^="a"]{display:none}`,
  'a parenthesis left open across rules':
    `:root{--color-a:(}\ninput[value^="a"]{display:none}\n:root{--color-b:)}`,
  'a closing brace nothing opened':
    `}\ninput[value^="a"]{display:none}\n:root{--color-a:1}`,
  'a rule nested in :root':
    `:root{--color-a:1;& input{display:none}}`,
  'an escaped brace in a selector':
    `:root${BS}{--color-a:1}\ninput{display:none}\n:root{--color-b:2}`,
  'a statement in front of a rule for something else':
    `@charset "x"; input[value^="a"]{display:none}`,
  'rules for something else inside @media and @supports':
    `@media screen{html{display:none}@supports (display:grid){[role="alert"]{display:none}}}`,
};

const PRINT_CASES: Record<string, string> = {
  'comment markers written as escapes, inside @media':
    `@media print { a "${BS}2f*" '*${BS}2f'\n} html { color: red } .y { content: '${BS}2f*' "*${BS}2f" } }`,
  'the same reaching the app around the printout':
    `@media screen { a "${BS}2f*" '*${BS}2f'\n} [role="alert"], .external-label { display: none } .y { content: '${BS}2f*' "*${BS}2f" } }`,
  'comment markers inside strings of two rules':
    `h1::after { content: "/*" } html { color: red } h2::after { content: "*/" }`,
  'a selector list after an escaped bracket':
    `.a${BS}[ , html { color: red }`,
  'a selector list after an escaped parenthesis':
    `.a${BS}( , [role="alert"] { display: none }`,
  'an escaped comma, then a real one':
    `.a${BS}, b, html { color: red }`,
  'a block left open':
    `h1 { color: red } @media print { html { color: red }`,
  'a string left open at a line break':
    `h1 { content: "\n} html { color: red } h2 { content: "}" }`,
  'a "<" taken out of an escape in front of a brace':
    `.a${BS}<{ color: blue } html { color: red }`,
  'a sibling of the printout':
    `html ~ * { display: none } body + div { display: none } ~ div { display: none }`,
};

describe('theme.css: only :root and .dark', () => {
  it.each(Object.entries(THEME_CASES))('%s', (_name, css) => {
    const out = loader.sanitizeThemeCSS(css).css;
    const rules = topLevelPreludes(out).filter((p) => !p.startsWith('@'));
    expect(rules.filter((p) => !p.split(',').every((s) => [':root', '.dark'].includes(s.trim())))).toEqual([]);
    // Nothing for another selector anywhere in it, a nested block included.
    expect(out).not.toMatch(/input|html|role=|display:none/);
  });

  it('control: an honest theme keeps its rules', () => {
    const css = ':root{--color-primary:#123456;--font:"Inter", sans-serif}\n.dark{--color-primary:#abcdef}\n@font-face{font-family:"X";src:local("Arial")}';
    const out = loader.sanitizeThemeCSS(css).css;
    expect(topLevelPreludes(out)).toEqual([':root', '.dark', '@font-face']);
  });
});

describe('a plugin print style: only inside [data-print-theme]', () => {
  it.each(Object.entries(PRINT_CASES))('%s', (_name, css) => {
    const out = sanitizePrintThemeCss(css).css;
    const rules = [
      ...topLevelPreludes(out).filter((p) => !p.startsWith('@')),
      // The rules inside an @media block count as well.
      ...[...out.matchAll(/@media[^{]*\{([\s\S]*)\}\s*$/g)].flatMap((m) => topLevelPreludes(m[1])),
    ];
    expect(rules.filter((p) => !p.startsWith('[data-print-theme]'))).toEqual([]);
    // Every selector of a list is inside the scope, not only the first.
    for (const prelude of rules) {
      expect(selectorsOf(prelude).filter((s) => !s.startsWith('[data-print-theme]'))).toEqual([]);
    }
    expect(out).not.toMatch(/\[data-print-theme\]\s*[~+]/);
  });

  it('control: an honest print style is scoped and kept', () => {
    const out = sanitizePrintThemeCss('h1 { font-family: "Georgia", serif }\n@media print { .meta { color: #333 } }').css;
    expect(out).toContain('[data-print-theme] h1 {');
    expect(out).toContain('[data-print-theme] .meta {');
  });
});

describe('what a sanitiser returns still reads cleanly', () => {
  it.each([
    ...Object.entries(THEME_CASES).map(([name, css]) => [`theme: ${name}`, () => loader.sanitizeThemeCSS(css).css] as const),
    ...Object.entries(PRINT_CASES).map(([name, css]) => [`print: ${name}`, () => sanitizePrintThemeCss(css).css] as const),
    ...Object.entries({ ...THEME_CASES, ...PRINT_CASES }).map(([name, css]) => [`skin: ${name}`, () => loader.sanitizeSkinCSS(css).css] as const),
  ])('%s', (_name, run) => {
    const out = run();
    expect(out === '' || loader.readStylesheet(out) !== null).toBe(true);
  });
});

describe('a sheet with an unterminated string, comment or block is refused whole', () => {
  const UNTERMINATED: Record<string, string> = {
    'a string that ends at a line break': `:root{--color-a:"x\n}`,
    'a string that never ends': `:root{--color-a:1}\n.dark{--color-b:"x`,
    'a comment that never ends': `:root{--color-a:1} /* todo`,
    'a block that never ends': `:root{--color-a:1}\n.dark{--color-b:2`,
    'a parenthesis that never closes': `:root{--color-a:calc(1px + 2px}`,
    'a bracket closed by another kind': `:root{--color-a:(1]}`,
    'a closing brace nothing opened': `:root{--color-a:1}}`,
  };

  it.each(Object.entries(UNTERMINATED))('%s', (_name, css) => {
    for (const sanitised of [loader.sanitizeThemeCSS(css), loader.sanitizeSkinCSS(css), sanitizePrintThemeCss(css)]) {
      expect(sanitised.css).toBe('');
      expect(sanitised.warnings.join(' ')).toMatch(/could not be read cleanly/);
    }
    expect(loader.validateThemeCSSSafety(css).valid).toBe(false);
    expect(loader.readStylesheet(css)).toBeNull();
  });

  it('control: brackets, braces and quotes inside a string or a comment are no brackets', () => {
    const css = ':root{--color-a:"}{)(][";--color-b:\'/* "\'} /* } " */ .dark{--color-c:calc((1px + 2px) * 2)}';
    expect(loader.sanitizeThemeCSS(css).css).toBe(':root {--color-a:"}{)(][";--color-b:\'/* "\'}\n.dark {--color-c:calc((1px + 2px) * 2)}');
    expect(loader.sanitizeSkinCSS(css).warnings).toEqual([]);
  });
});

describe('what the filters keep, read from tokens', () => {
  it('theme.css: comment markers inside strings stay strings, and the rule between them goes', () => {
    const out = loader.sanitizeThemeCSS(':root{--color-a:"/*"}\ninput{display:none}\n.dark{--color-b:"*/"}');
    expect(out.css).toBe(':root {--color-a:"/*"}\n.dark {--color-b:"*/"}');
    expect(out.warnings).toEqual(['Removed rule for "input" - themes only set :root and .dark variables']);
  });

  it('theme.css: a selector is compared as the browser reads it', () => {
    // `.d\61rk` is `.dark`; `\3a root` is an element called ":root", which is no `:root`.
    const out = loader.sanitizeThemeCSS(`.d${BS}61rk{--color-a:1}\n${BS}3a root{--color-b:2}\n:ro${BS}6ft{--color-c:3}\n:root/* x */{--color-d:4}`);
    expect(out.css).toBe('.dark {--color-a:1}\n:root {--color-c:3}\n:root {--color-d:4}');
  });

  it('theme.css: a statement in front of a rule costs only itself', () => {
    const out = loader.sanitizeThemeCSS('@import "x.css"; :root{--color-a:1}');
    expect(out.css).toBe(':root {--color-a:1}');
  });

  it('theme.css: @media and @supports keep their :root and .dark rules only', () => {
    const out = loader.sanitizeThemeCSS('@media (prefers-contrast: more){:root{--color-a:1}input{display:none}@supports (color: red){.dark{--color-b:2}html{display:none}}}');
    expect(out.css).toBe('@media (prefers-contrast: more) {:root {--color-a:1}\n@supports (color: red) {.dark {--color-b:2}}}');
  });

  it('theme.css: what it returns comes back the same from a second pass', () => {
    const css = ':root{--color-a:"/*";--font:"Inter", sans-serif}\n@font-face{font-family:"X";src:local("Arial")}\n@media screen{.dark{--color-b:"*/"}}';
    const once = loader.sanitizeThemeCSS(css).css;
    expect(loader.sanitizeThemeCSS(once).css).toBe(once);
    expect(loader.validateThemeCSSSafety(css).errors).toEqual([]);
  });

  it('a print style: every selector of a list is moved inside the scope', () => {
    expect(sanitizePrintThemeCss(`.a${BS}[ , html { color: red }`).css).toBe(`[data-print-theme] .a${BS}[, [data-print-theme] { color: red }`);
    expect(sanitizePrintThemeCss('a[title="x, html"], :is(b, i) u { color: red }').css)
      .toBe('[data-print-theme] a[title="x, html"], [data-print-theme] :is(b, i) u { color: red }');
  });

  it('a print style: comment markers inside strings stay strings, and each rule is scoped', () => {
    expect(sanitizePrintThemeCss('h1::after { content: "/*" } html { color: red } h2::after { content: "*/" }').css)
      .toBe('[data-print-theme] h1::after { content: "/*" }\n[data-print-theme] { color: red }\n[data-print-theme] h2::after { content: "*/" }');
  });

  it('a print style: a sibling combinator counts outside parentheses only', () => {
    const out = sanitizePrintThemeCss('html ~ * { color: red } .a:has(~ .b) { color: blue } li:nth-child(2n+1) { color: green }');
    expect(out.css).toBe('[data-print-theme] .a:has(~ .b) { color: blue }\n[data-print-theme] li:nth-child(2n+1) { color: green }');
  });

  it('a print style: the page margin and a comment are read as before', () => {
    const out = sanitizePrintThemeCss('/* letterhead */ h1 { color: red } @page { margin: 20mm 15mm }');
    expect(out).toMatchObject({ css: '[data-print-theme] h1 { color: red }', pageMargin: '20mm 15mm', warnings: [] });
  });
});
