/**
 * Pull schema.org data out of a mail's raw HTML: JSON-LD blocks and
 * microdata. The HTML is parsed into a detached document (DOMParser runs no
 * scripts and loads nothing) that is never attached to the page; the sanitizer
 * that renders the mail is a separate path and isn't touched.
 */
import { parseLenientJson } from './json-repair';

export type RawItem = Record<string, unknown>;
export interface ExtractedItem {
  item: unknown;
  source: 'json-ld' | 'microdata';
}

const MAX_JSONLD_BLOCKS = 50;
const MAX_MICRODATA_ITEMS = 500;
const MAX_MICRODATA_DEPTH = 12;
const MAX_HTML_LENGTH = 8_000_000;

/** Cheap test that a body may hold markup this feature reads. */
const TYPE_HINT = /Reservation|ParcelDelivery|Order/;
const SCHEMA_ITEMTYPE = /^https?:\/\/(?:www\.)?schema\.org\/([A-Za-z]+)\/?$/i;

/**
 * Mail clients mark what they quote or forward with these containers;
 * markup inside them belongs to someone else's mail.
 */
const QUOTED_CONTAINERS = 'blockquote, .gmail_quote, .moz-forward-container, #appendonsend, #divRplyFwdMsg';

export function defaultParseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

export function mayContainStructuredData(html: string): boolean {
  return TYPE_HINT.test(html);
}

/**
 * Elements that sit inside a quoted or forwarded part: inside one of the
 * containers, or after Outlook's `#divRplyFwdMsg` separator (Outlook puts
 * the forwarded message after it, not inside it).
 */
function isQuoted(element: Element, doc: Document): boolean {
  if (element.closest(QUOTED_CONTAINERS)) return true;
  const separator = doc.getElementById('divRplyFwdMsg');
  return !!separator && !!(separator.compareDocumentPosition(element) & 4 /* FOLLOWING */);
}

function itemTypes(element: Element): string[] {
  return (element.getAttribute('itemtype') ?? '')
    .split(/\s+/)
    .map((value) => SCHEMA_ITEMTYPE.exec(value)?.[1])
    .filter((value): value is string => !!value);
}

function propertyValue(element: Element, depth: number): unknown {
  if (element.hasAttribute('itemscope')) return microdataItem(element, depth + 1);
  const content = element.getAttribute('content');
  if (content !== null) return content.trim();
  const tag = element.tagName.toLowerCase();
  const attr = (name: string) => (element.getAttribute(name) ?? '').trim();
  switch (tag) {
    case 'a': case 'link': case 'area': return attr('href');
    case 'img': case 'audio': case 'video': case 'source': case 'embed': case 'iframe': case 'track': return attr('src');
    case 'object': return attr('data');
    case 'time': return element.hasAttribute('datetime') ? attr('datetime') : (element.textContent ?? '').trim();
    case 'data': case 'meter': return attr('value');
    default: return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
  }
}

/**
 * One microdata item: properties are descendants with `itemprop` whose
 * nearest `itemscope` ancestor is this item. A space-separated itemprop gives
 * the value to each name; a repeated name becomes an array.
 */
function microdataItem(scope: Element, depth: number): RawItem | undefined {
  if (depth > MAX_MICRODATA_DEPTH) return undefined;
  const item: RawItem = {};
  const types = itemTypes(scope);
  if (types.length > 0) item['@type'] = types.length === 1 ? types[0] : types;
  const add = (name: string, value: unknown) => {
    if (value === undefined || value === '') return;
    const existing = item[name];
    if (existing === undefined) item[name] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else item[name] = [existing, value];
  };
  for (const element of Array.from(scope.querySelectorAll('[itemprop]'))) {
    const owner = element.parentElement?.closest('[itemscope]');
    if (owner !== scope) continue;
    const value = propertyValue(element, depth);
    for (const name of (element.getAttribute('itemprop') ?? '').split(/\s+/).filter(Boolean)) add(name, value);
  }
  return item;
}

export function extractStructuredData(
  html: string,
  parseHtml: (html: string) => Document = defaultParseHtml,
): ExtractedItem[] {
  if (!html || html.length > MAX_HTML_LENGTH || !mayContainStructuredData(html)) return [];
  const doc = parseHtml(html);
  const found: ExtractedItem[] = [];

  const scripts = Array.from(doc.querySelectorAll('script')).filter(
    (script) => (script.getAttribute('type') ?? '').trim().toLowerCase() === 'application/ld+json',
  );
  for (const script of scripts.slice(0, MAX_JSONLD_BLOCKS)) {
    if (isQuoted(script, doc)) continue;
    const value = parseLenientJson(script.textContent ?? '');
    if (value !== undefined && value !== null) found.push({ item: value, source: 'json-ld' });
  }

  const tops = Array.from(doc.querySelectorAll('[itemscope]')).filter((element) => !element.hasAttribute('itemprop'));
  for (const scope of tops.slice(0, MAX_MICRODATA_ITEMS)) {
    // Only items typed on schema.org count; an untyped or foreign item is noise.
    if (itemTypes(scope).length === 0 || isQuoted(scope, doc)) continue;
    const item = microdataItem(scope, 0);
    if (item) found.push({ item: { '@context': 'https://schema.org', ...item }, source: 'microdata' });
  }
  return found;
}
