/**
 * BIMI indicators are SVG Tiny Portable/Secure (draft-svg-tiny-ps-abrotman):
 * no script, no animation, nothing loaded from elsewhere. The browser never
 * gets the sender's SVG: it is checked here and drawn to a PNG in a process
 * of its own (draw.ts), so whatever the checks miss can't run or call out on
 * the webmail origin anyway.
 *
 * The check parses the document as XML once, front to back, resolving
 * character references the way an XML parser does (there is no DTD, so no
 * other entities), and judges the parsed elements and attribute values.
 * What gets drawn is that parsed document written out again (checkedSvg),
 * so the drawing library reads exactly what was checked. The cost grows
 * with the size of the logo and nothing else.
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
const EFFECT_PROPERTY = /(?:^|[\s;{])(?:filter|mask|clip-path|marker(?:-start|-mid|-end)?)\s*:/i;
/** Characters XML doesn't allow anywhere: control characters but tab and line breaks, U+FFFE, U+FFFF. */
const NOT_XML_CHARACTER = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(0x0b, 0x0c)}${String.fromCharCode(0x0e)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0xfffe, 0xffff)}]`);
/** The entities XML has without a DTD. */
const PREDEFINED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export interface SvgCheckOptions {
  /**
   * Hold the logo to the profile itself: baseProfile="tiny-ps", a title and
   * the size ceiling. For self-published logos; a mark certificate's logo was
   * checked by the CA that issued it, and gets the same safety checks.
   */
  strictProfile: boolean;
}

/** One parsed element: its name, its attributes with their values decoded, and its content. */
interface SvgElement {
  name: string;
  attributes: Array<[name: string, value: string]>;
  children: Array<SvgElement | string>;
  /** Whether this element is a <use> or has one inside. */
  hasUse: boolean;
}

interface Tag {
  name: string;
  /** In document order, values decoded. */
  attributes: Array<[name: string, value: string]>;
  /** The same, by lower-case name. */
  byName: Map<string, string>;
  selfClosing: boolean;
  /** Index just after the tag's ">". */
  end: number;
}

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/** XML name characters, ASCII ones checked exactly. */
function isNameChar(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) || (code >= 0x30 && code <= 0x39)
    || code === 0x5f || code === 0x3a || code === 0x2d || code === 0x2e || code >= 0x80;
}

function isXmlChar(code: number): boolean {
  return code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0xd7ff)
    || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
}

/**
 * Text or an attribute value with its character references and predefined
 * entities resolved, as an XML parser hands it on; null when a reference is
 * not one XML knows. Each "&" is looked at once.
 */
function decodeReferences(raw: string): string | null {
  if (!raw.includes('&')) return raw;
  let out = '';
  let pos = 0;
  for (;;) {
    const amp = raw.indexOf('&', pos);
    if (amp === -1) return out + raw.slice(pos);
    out += raw.slice(pos, amp);
    const semi = raw.indexOf(';', amp + 1);
    if (semi === -1 || semi - amp > 10) return null;
    const ref = raw.slice(amp + 1, semi);
    let decoded: string | undefined;
    if (/^#[0-9]{1,7}$/.test(ref) || /^#x[0-9a-fA-F]{1,6}$/.test(ref)) {
      const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!isXmlChar(code)) return null;
      decoded = String.fromCodePoint(code);
    } else {
      decoded = Object.prototype.hasOwnProperty.call(PREDEFINED_ENTITIES, ref) ? PREDEFINED_ENTITIES[ref] : undefined;
    }
    if (decoded === undefined) return null;
    out += decoded;
    pos = semi + 1;
  }
}

/**
 * A style value as a CSS parser reads it: comments dropped and escapes
 * decoded. Dropping a comment joins what was on either side, which can only
 * make the check stricter.
 */
function cssDecoded(value: string): string {
  let text = '';
  let pos = 0;
  for (;;) {
    const open = value.indexOf('/*', pos);
    if (open === -1) {
      text += value.slice(pos);
      break;
    }
    text += value.slice(pos, open);
    const close = value.indexOf('*/', open + 2);
    // An unclosed comment runs to the end.
    if (close === -1) break;
    pos = close + 2;
  }
  return text.replace(/\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\n\r\f])?|\r\n|[\n\r\f]|([\s\S]))/g, (_m, hex: string | undefined, char: string | undefined) => {
    if (hex === undefined) return char ?? '';
    const code = parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : String.fromCharCode(0xfffd);
  });
}

/** The start tag at `lt`, or why it is malformed. Reads each character once. */
function readTag(svg: string, lt: number): Tag | string {
  const n = svg.length;
  let i = lt + 1;
  while (i < n && isNameChar(svg.charCodeAt(i))) i++;
  if (i === lt + 1) return 'malformed';
  const name = svg.slice(lt + 1, i);
  const attributes: Array<[string, string]> = [];
  const byName = new Map<string, string>();
  for (;;) {
    const before = i;
    while (i < n && isSpace(svg.charCodeAt(i))) i++;
    if (i >= n) return 'malformed';
    const c = svg[i];
    if (c === '>') return { name, attributes, byName, selfClosing: false, end: i + 1 };
    if (c === '/') return svg[i + 1] === '>' ? { name, attributes, byName, selfClosing: true, end: i + 2 } : 'malformed';
    // Attributes are separated by white space.
    if (i === before) return 'malformed';
    const nameStart = i;
    while (i < n && isNameChar(svg.charCodeAt(i))) i++;
    if (i === nameStart) return 'malformed';
    const attribute = svg.slice(nameStart, i);
    while (i < n && isSpace(svg.charCodeAt(i))) i++;
    if (svg[i] !== '=') return 'malformed';
    i++;
    while (i < n && isSpace(svg.charCodeAt(i))) i++;
    const quote = svg[i];
    if (quote !== '"' && quote !== "'") return 'malformed';
    const close = svg.indexOf(quote, i + 1);
    if (close === -1) return 'malformed';
    const raw = svg.slice(i + 1, close);
    if (raw.includes('<') || byName.has(attribute.toLowerCase())) return 'malformed';
    // Attribute-value normalisation: line breaks and tabs written as such are spaces.
    const value = decodeReferences(raw.replace(/\r\n|[\t\n\r]/g, ' '));
    if (value === null) return 'malformed';
    attributes.push([attribute, value]);
    byName.set(attribute.toLowerCase(), value);
    i = close + 1;
  }
}

/** Why one start tag can't be shown, or null. Judges the decoded values. */
function checkTag(tag: Tag): string | null {
  if (!ALLOWED_ELEMENTS.has(tag.name)) return `forbidden element <${tag.name.toLowerCase()}>`;
  for (const [name, value] of tag.byName) {
    if (name.startsWith('on')) return 'event handler';
    if ((name === 'href' || name.endsWith(':href')) && !value.trim().startsWith('#')) return 'external reference';
    if (EFFECT_ATTRIBUTES.has(name)) return `forbidden property ${name}`;
    const css = cssDecoded(value);
    if (name === 'style' && EFFECT_PROPERTY.test(css)) return 'forbidden property style';
    // url(...) may only point inside the document, however it is spelled.
    for (const m of css.matchAll(/url\(\s*['"]?\s*([^)'"\s]*)/gi)) {
      if (!m[1].startsWith('#')) return 'external reference';
    }
    if (/@import/i.test(css)) return 'external reference';
  }
  return null;
}

/** The names an id or a reference may be matched under: as written, trimmed, and percent-decoded. */
function idForms(value: string): string[] {
  const trimmed = value.trim();
  const forms = [trimmed];
  try {
    const unescaped = decodeURIComponent(trimmed);
    if (unescaped !== trimmed) forms.push(unescaped);
  } catch {
    // Not percent-encoded.
  }
  return forms;
}

interface Parsed {
  root: SvgElement;
  rootAttributes: Map<string, string>;
  hasTitle: boolean;
}

/**
 * One pass over the document into a tree: every element against the
 * allowlist, every decoded attribute value against the rules above, and
 * each <use> against what it points at. A <use> may not point at an element
 * that is or holds a <use>, so no logo draws one shape more often than it
 * has <use> elements. Comments and processing instructions are dropped.
 */
function parse(svg: string): Parsed | string {
  const stack: SvgElement[] = [];
  const byId = new Map<string, SvgElement[]>();
  const useTargets: string[] = [];
  let root: SvgElement | null = null;
  let rootAttributes: Map<string, string> | null = null;
  let rootClosed = false;
  let elements = 0;
  let hasTitle = false;
  let pos = 0;

  const addText = (text: string): string | null => {
    if (stack.length === 0) return /\S/.test(text) ? 'malformed' : null;
    if (text) stack[stack.length - 1].children.push(text);
    return null;
  };

  for (;;) {
    const lt = svg.indexOf('<', pos);
    const rawText = svg.slice(pos, lt === -1 ? svg.length : lt);
    if (rawText) {
      const text = decodeReferences(rawText.replace(/\r\n?/g, '\n'));
      if (text === null) return 'malformed';
      const problem = addText(text);
      if (problem) return problem;
    }
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
      const problem = addText(svg.slice(lt + 9, end).replace(/\r\n?/g, '\n'));
      if (problem) return problem;
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
    if (rootClosed || (!root && tag.name !== 'svg')) return root ? 'malformed' : 'not svg';
    const problem = checkTag(tag);
    if (problem) return problem;
    if (++elements > MAX_ELEMENTS) return 'too many elements';

    const element: SvgElement = { name: tag.name, attributes: tag.attributes, children: [], hasUse: false };
    if (!root) {
      root = element;
      rootAttributes = tag.byName;
    } else {
      stack[stack.length - 1].children.push(element);
    }
    for (const key of ['id', 'xml:id']) {
      const id = tag.byName.get(key);
      if (id === undefined) continue;
      for (const form of idForms(id)) {
        const same = byId.get(form);
        if (same) same.push(element);
        else byId.set(form, [element]);
      }
    }
    if (tag.name === 'use') {
      if (useTargets.length >= MAX_USES) return 'too many uses';
      element.hasUse = true;
      // The elements around it hold a <use> now. Going outwards, the first
      // one already marked has its own ancestors marked too.
      for (let i = stack.length - 1; i >= 0 && !stack[i].hasUse; i--) stack[i].hasUse = true;
      for (const [name, value] of tag.byName) {
        if (name === 'href' || name.endsWith(':href')) useTargets.push(...idForms(value.trim().slice(1)));
      }
    }
    if (tag.name === 'title' && !tag.selfClosing) {
      const next = svg.indexOf('<', tag.end);
      const text = next === -1 ? null : decodeReferences(svg.slice(tag.end, next));
      if (text && svg.startsWith('</title', next) && /\S/.test(text)) hasTitle = true;
    }
    if (tag.selfClosing) {
      if (stack.length === 0) rootClosed = true;
    } else {
      stack.push(element);
    }
    pos = tag.end;
  }

  if (!root || !rootAttributes) return 'not svg';
  if (stack.length > 0) return 'malformed';
  for (const target of useTargets) {
    if (byId.get(target)?.some((element) => element.hasUse)) return 'nested use';
  }
  return { root, rootAttributes, hasTitle };
}

function escapeAttribute(value: string): string {
  return value.replace(/[&<"\t\n\r]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '"': '&quot;', '\t': '&#9;', '\n': '&#10;', '\r': '&#13;' })[c]!);
}

function escapeText(value: string): string {
  return value.replace(/[&<>\r]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\r': '&#13;' })[c]!);
}

/** The parsed tree written out as plain XML: no comments, no references but the escapes it needs. */
function serialize(element: SvgElement): string {
  let out = `<${element.name}`;
  for (const [name, value] of element.attributes) out += ` ${name}="${escapeAttribute(value)}"`;
  if (element.children.length === 0) return `${out}/>`;
  out += '>';
  for (const child of element.children) out += typeof child === 'string' ? escapeText(child) : serialize(child);
  return `${out}</${element.name}>`;
}

export type CheckedSvg = { ok: true; svg: string } | { ok: false; reason: string };

/**
 * The logo as the drawing gets it, or why it can't be shown. The SVG
 * returned is the checked tree written out again: draw that, not the text
 * that came in.
 */
export function checkedSvg(input: string, { strictProfile }: SvgCheckOptions): CheckedSvg {
  const refuse = (reason: string): CheckedSvg => ({ ok: false, reason });
  const bytes = Buffer.byteLength(input, 'utf8');
  // A byte order mark is not part of the document.
  const svg = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (bytes > (strictProfile ? MAX_SELF_ASSERTED_BYTES : MAX_CERTIFIED_BYTES)) return refuse('too large');
  // Entities can expand without bound or pull in files.
  if (/<!DOCTYPE|<!ENTITY/i.test(svg)) return refuse('doctype');
  // url(...) and @import as written; the parsed values are checked again in checkTag.
  for (const m of svg.matchAll(/url\(\s*['"]?\s*([^)'"\s]*)/gi)) {
    if (!m[1].startsWith('#')) return refuse('external reference');
  }
  if (/@import/i.test(svg)) return refuse('external reference');
  if (NOT_XML_CHARACTER.test(svg)) return refuse('malformed');

  const result = parse(svg);
  if (typeof result === 'string') return refuse(result);
  const { root, rootAttributes, hasTitle } = result;

  const viewBox = rootAttributes.get('viewbox')?.trim().split(/[\s,]+/).map(Number);
  if (viewBox && viewBox.length === 4) {
    const [, , width, height] = viewBox;
    if (!(width > 0 && height > 0)) return refuse('empty viewBox');
    if (Math.abs(width - height) / Math.max(width, height) > 0.01) return refuse('not square');
  }

  if (strictProfile) {
    if (rootAttributes.get('baseprofile')?.toLowerCase() !== 'tiny-ps') return refuse('not tiny-ps');
    if (!hasTitle) return refuse('no title');
    // The profile forbids positioning the root element.
    if (rootAttributes.has('x') || rootAttributes.has('y')) return refuse('positioned root');
  }
  return { ok: true, svg: serialize(root) };
}

/** Why the SVG can't be shown, or null when it can. */
export function checkSvg(svg: string, options: SvgCheckOptions): string | null {
  const checked = checkedSvg(svg, options);
  return checked.ok ? null : checked.reason;
}
