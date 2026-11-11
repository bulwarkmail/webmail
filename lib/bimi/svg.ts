/**
 * BIMI indicators are SVG Tiny Portable/Secure (draft-svg-tiny-ps-abrotman):
 * no script, no animation, nothing loaded from elsewhere. The browser never
 * gets the sender's SVG: it is checked here and drawn to a PNG in a process
 * of its own (draw.ts), so whatever the checks miss can't run or call out on
 * the webmail origin anyway.
 *
 * The check runs on the server's own thread before anything is cached, so
 * it reads the document once, front to back, and its cost grows with the
 * size of the logo and nothing else.
 */

export { INDICATOR_SIZE, LogoDrawingError, MAX_DRAWINGS, rasterize, type RasterizeOptions } from './draw';

/** The size the BIMI Group recommends as the ceiling for a self-published logo. */
export const MAX_SELF_ASSERTED_BYTES = 32 * 1024;
/** Mark certificates carry larger logos now and then; the CA checked those. */
export const MAX_CERTIFIED_BYTES = 64 * 1024;

/**
 * The elements SVG Tiny PS has. Anything else is refused, whatever its case
 * or namespace prefix: filters, masks, patterns, clip paths, symbols, markers
 * and style sheets are what make a small logo expensive to draw.
 */
const ALLOWED_ELEMENTS = new Set([
  'svg', 'title', 'desc', 'defs', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'linearGradient', 'radialGradient', 'stop', 'solidColor', 'text', 'tspan', 'use',
]);
/** Logos are a few dozen elements; this is far above any real one. */
const MAX_ELEMENTS = 1000;
const MAX_USES = 100;
/** Attributes and style properties that point at effects the profile doesn't have. */
const EFFECT_ATTRIBUTES = new Set(['filter', 'mask', 'clip-path', 'marker', 'marker-start', 'marker-mid', 'marker-end']);
const EFFECT_PROPERTY = /(?:^|[\s;])(?:filter|mask|clip-path|marker(?:-start|-mid|-end)?)\s*:/i;

export interface SvgCheckOptions {
  /**
   * Hold the logo to the profile itself: baseProfile="tiny-ps", a title and
   * the size ceiling. For self-published logos; a mark certificate's logo was
   * checked by the CA that issued it, and gets the same safety checks.
   */
  strictProfile: boolean;
}

interface Tag {
  name: string;
  /** Attribute names in lower case. */
  attributes: Map<string, string>;
  selfClosing: boolean;
  /** Index just after the tag's ">". */
  end: number;
}

interface Element {
  name: string;
  /** Whether this element is a <use> or has one inside. */
  hasUse: boolean;
}

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/** XML name characters, ASCII ones checked exactly. */
function isNameChar(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) || (code >= 0x30 && code <= 0x39)
    || code === 0x5f || code === 0x3a || code === 0x2d || code === 0x2e || code >= 0x80;
}

/** The start tag at `lt`, or why it is malformed. Reads each character once. */
function readTag(svg: string, lt: number): Tag | string {
  const n = svg.length;
  let i = lt + 1;
  while (i < n && isNameChar(svg.charCodeAt(i))) i++;
  if (i === lt + 1) return 'malformed';
  const name = svg.slice(lt + 1, i);
  const attributes = new Map<string, string>();
  for (;;) {
    const before = i;
    while (i < n && isSpace(svg.charCodeAt(i))) i++;
    if (i >= n) return 'malformed';
    const c = svg[i];
    if (c === '>') return { name, attributes, selfClosing: false, end: i + 1 };
    if (c === '/') return svg[i + 1] === '>' ? { name, attributes, selfClosing: true, end: i + 2 } : 'malformed';
    // Attributes are separated by white space.
    if (i === before) return 'malformed';
    const nameStart = i;
    while (i < n && isNameChar(svg.charCodeAt(i))) i++;
    if (i === nameStart) return 'malformed';
    const attribute = svg.slice(nameStart, i).toLowerCase();
    while (i < n && isSpace(svg.charCodeAt(i))) i++;
    if (svg[i] !== '=') return 'malformed';
    i++;
    while (i < n && isSpace(svg.charCodeAt(i))) i++;
    const quote = svg[i];
    if (quote !== '"' && quote !== "'") return 'malformed';
    const close = svg.indexOf(quote, i + 1);
    if (close === -1) return 'malformed';
    const value = svg.slice(i + 1, close);
    if (value.includes('<') || attributes.has(attribute)) return 'malformed';
    attributes.set(attribute, value);
    i = close + 1;
  }
}

/** Why one start tag can't be shown, or null. */
function checkTag(tag: Tag): string | null {
  if (!ALLOWED_ELEMENTS.has(tag.name)) return `forbidden element <${tag.name.toLowerCase()}>`;
  for (const [name, value] of tag.attributes) {
    if (name.startsWith('on')) return 'event handler';
    if ((name === 'href' || name.endsWith(':href')) && !value.trim().startsWith('#')) return 'external reference';
    if (EFFECT_ATTRIBUTES.has(name) || (name === 'style' && EFFECT_PROPERTY.test(value))) return `forbidden property ${name}`;
  }
  return null;
}

interface Outline {
  root: Map<string, string>;
  hasTitle: boolean;
}

/**
 * One pass over the document: every element against the allowlist, every
 * attribute against the rules above, and each <use> against what it points
 * at. A <use> may not point at an element that is or holds a <use>, so no
 * logo draws one shape more often than it has <use> elements.
 */
function outline(svg: string): Outline | string {
  const stack: Element[] = [];
  const byId = new Map<string, Element[]>();
  const useTargets: string[] = [];
  let root: Map<string, string> | null = null;
  let rootClosed = false;
  let elements = 0;
  let hasTitle = false;
  let pos = 0;

  for (;;) {
    const lt = svg.indexOf('<', pos);
    if (lt === -1) break;
    if (svg.startsWith('<!--', lt)) {
      const end = svg.indexOf('-->', lt + 4);
      if (end === -1) return 'malformed';
      pos = end + 3;
      continue;
    }
    if (svg.startsWith('<![CDATA[', lt)) {
      const end = svg.indexOf(']]>', lt + 9);
      if (end === -1) return 'malformed';
      pos = end + 3;
      continue;
    }
    if (svg.startsWith('<?', lt)) {
      const end = svg.indexOf('?>', lt + 2);
      if (end === -1) return 'malformed';
      pos = end + 2;
      continue;
    }
    if (svg[lt + 1] === '!') return 'doctype';
    if (svg[lt + 1] === '/') {
      const gt = svg.indexOf('>', lt + 2);
      if (gt === -1) return 'malformed';
      const open = stack.pop();
      if (!open || open.name !== svg.slice(lt + 2, gt).trim()) return 'malformed';
      if (stack.length === 0) rootClosed = true;
      pos = gt + 1;
      continue;
    }

    const tag = readTag(svg, lt);
    if (typeof tag === 'string') return tag;
    if (!root) {
      if (tag.name !== 'svg') return 'not svg';
      root = tag.attributes;
    } else if (rootClosed) {
      return 'malformed';
    }
    const problem = checkTag(tag);
    if (problem) return problem;
    if (++elements > MAX_ELEMENTS) return 'too many elements';

    const element: Element = { name: tag.name, hasUse: false };
    const id = tag.attributes.get('id') ?? tag.attributes.get('xml:id');
    if (id !== undefined) {
      const same = byId.get(id);
      if (same) same.push(element);
      else byId.set(id, [element]);
    }
    if (tag.name === 'use') {
      if (useTargets.length >= MAX_USES) return 'too many uses';
      element.hasUse = true;
      // The elements around it hold a <use> now. Going outwards, the first
      // one already marked has its own ancestors marked too.
      for (let i = stack.length - 1; i >= 0 && !stack[i].hasUse; i--) stack[i].hasUse = true;
      for (const [name, value] of tag.attributes) {
        if (name === 'href' || name.endsWith(':href')) useTargets.push(value.trim().slice(1));
      }
    }
    if (tag.name === 'title' && !tag.selfClosing) {
      const next = svg.indexOf('<', tag.end);
      if (next !== -1 && svg.startsWith('</title', next) && /\S/.test(svg.slice(tag.end, next))) hasTitle = true;
    }
    if (tag.selfClosing) {
      if (stack.length === 0) rootClosed = true;
    } else {
      stack.push(element);
    }
    pos = tag.end;
  }

  if (!root) return 'not svg';
  if (stack.length > 0) return 'malformed';
  for (const target of useTargets) {
    if (byId.get(target)?.some((element) => element.hasUse)) return 'nested use';
  }
  return { root, hasTitle };
}

/** Why the SVG can't be shown, or null when it can. */
export function checkSvg(svg: string, { strictProfile }: SvgCheckOptions): string | null {
  const bytes = Buffer.byteLength(svg, 'utf8');
  if (bytes > (strictProfile ? MAX_SELF_ASSERTED_BYTES : MAX_CERTIFIED_BYTES)) return 'too large';
  // Entities can expand without bound or pull in files.
  if (/<!DOCTYPE|<!ENTITY/i.test(svg)) return 'doctype';
  // url(...) in attributes and style sheets may only point inside the document.
  for (const m of svg.matchAll(/url\(\s*['"]?\s*([^)'"\s]*)/gi)) {
    if (!m[1].startsWith('#')) return 'external reference';
  }
  if (/@import/i.test(svg)) return 'external reference';

  const result = outline(svg);
  if (typeof result === 'string') return result;
  const { root, hasTitle } = result;

  const viewBox = root.get('viewbox')?.trim().split(/[\s,]+/).map(Number);
  if (viewBox && viewBox.length === 4) {
    const [, , width, height] = viewBox;
    if (!(width > 0 && height > 0)) return 'empty viewBox';
    if (Math.abs(width - height) / Math.max(width, height) > 0.01) return 'not square';
  }

  if (strictProfile) {
    if (root.get('baseprofile')?.toLowerCase() !== 'tiny-ps') return 'not tiny-ps';
    if (!hasTitle) return 'no title';
    // The profile forbids positioning the root element.
    if (root.has('x') || root.has('y')) return 'positioned root';
  }
  return null;
}
