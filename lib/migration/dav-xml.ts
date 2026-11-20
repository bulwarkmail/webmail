/**
 * Just enough XML for WebDAV multistatus answers (CardDAV, CalDAV). There is
 * no DOMParser on the server and the answers come from servers users name,
 * so this parser is small and strict: no DTDs, no custom entities, capped
 * size and depth. Namespaces are resolved, so `D:href` and a default-namespace
 * `href` in DAV: are the same element.
 */

export const DAV_NS = 'DAV:';
export const CARDDAV_NS = 'urn:ietf:params:xml:ns:carddav';
export const CALDAV_NS = 'urn:ietf:params:xml:ns:caldav';
export const APPLE_ICAL_NS = 'http://apple.com/ns/ical/';
export const CALSERVER_NS = 'http://calendarserver.org/ns/';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

export const MAX_XML_LENGTH = 20 * 1024 * 1024;
const MAX_DEPTH = 64;

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlError';
  }
}

export interface XmlElement {
  /** Namespace URI, '' when none. */
  ns: string;
  local: string;
  /** Attributes by the name as written (`name`, `xmlns:d`…), values decoded. */
  attrs: Record<string, string>;
  children: XmlElement[];
  /** The element's own text and CDATA, decoded, in document order. */
  text: string;
}

const NAMED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&([^;&\s<]*);?/g, (match, ref: string) => {
    if (!match.endsWith(';')) throw new XmlError('Unescaped & in XML');
    if (ref.startsWith('#')) {
      const code = /^#x[0-9a-f]+$/i.test(ref) ? parseInt(ref.slice(2), 16) : /^#\d+$/.test(ref) ? parseInt(ref.slice(1), 10) : NaN;
      if (!(code > 0 && code <= 0x10ffff) || (code >= 0xd800 && code <= 0xdfff)) throw new XmlError(`Bad character reference &${ref};`);
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[ref];
    // Custom entities would need a DTD, which is refused.
    if (named === undefined) throw new XmlError(`Unknown entity &${ref};`);
    return named;
  });
}

interface OpenElement {
  el: XmlElement;
  qname: string;
  scope: Map<string, string>;
}

const NAME = /[^\s/>=<"']+/y;
const SPACE = /\s*/y;

function resolveName(qname: string, scope: Map<string, string>, isAttr = false): { ns: string; local: string } {
  const colon = qname.indexOf(':');
  if (colon < 0) return { ns: isAttr ? '' : scope.get('') ?? '', local: qname };
  const prefix = qname.slice(0, colon);
  const ns = scope.get(prefix);
  if (ns === undefined) throw new XmlError(`Undeclared namespace prefix ${prefix}`);
  return { ns, local: qname.slice(colon + 1) };
}

/** Parse a whole document into its root element. Throws {@link XmlError}. */
export function parseXml(xml: string): XmlElement {
  if (xml.length > MAX_XML_LENGTH) throw new XmlError('XML document too large');
  const len = xml.length;
  const stack: OpenElement[] = [];
  let root: XmlElement | null = null;
  let i = xml.charCodeAt(0) === 0xfeff ? 1 : 0;

  const until = (marker: string, from: number): number => {
    const at = xml.indexOf(marker, from);
    if (at < 0) throw new XmlError(`Unterminated XML: missing ${marker}`);
    return at;
  };

  while (i < len) {
    const lt = xml.indexOf('<', i);
    const end = lt < 0 ? len : lt;
    if (end > i) {
      const raw = xml.slice(i, end);
      if (stack.length) stack[stack.length - 1].el.text += decodeEntities(raw);
      else if (raw.trim()) throw new XmlError('Text outside the root element');
      i = end;
      continue;
    }

    if (xml.startsWith('<!--', i)) {
      i = until('-->', i + 4) + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', i)) {
      const close = until(']]>', i + 9);
      if (!stack.length) throw new XmlError('CDATA outside the root element');
      stack[stack.length - 1].el.text += xml.slice(i + 9, close);
      i = close + 3;
      continue;
    }
    if (xml.startsWith('<?', i)) {
      i = until('?>', i + 2) + 2;
      continue;
    }
    // DOCTYPE and other declarations: entity expansion is how XML bombs and XXE work.
    if (xml.startsWith('<!', i)) throw new XmlError('XML declarations (DOCTYPE) are not accepted');

    if (xml.startsWith('</', i)) {
      const close = until('>', i + 2);
      const qname = xml.slice(i + 2, close).trim();
      const open = stack.pop();
      if (!open || open.qname !== qname) throw new XmlError(`Mismatched closing tag </${qname}>`);
      i = close + 1;
      continue;
    }

    if (root && !stack.length) throw new XmlError('More than one root element');
    NAME.lastIndex = i + 1;
    const nameMatch = NAME.exec(xml);
    if (!nameMatch) throw new XmlError('Malformed start tag');
    const qname = nameMatch[0];
    i = NAME.lastIndex;

    const rawAttrs: Array<[string, string]> = [];
    let selfClosing = false;
    for (;;) {
      SPACE.lastIndex = i;
      SPACE.exec(xml);
      i = SPACE.lastIndex;
      if (i >= len) throw new XmlError('Unterminated start tag');
      if (xml[i] === '>') {
        i += 1;
        break;
      }
      if (xml.startsWith('/>', i)) {
        selfClosing = true;
        i += 2;
        break;
      }
      NAME.lastIndex = i;
      const attrMatch = NAME.exec(xml);
      if (!attrMatch) throw new XmlError('Malformed attribute');
      i = NAME.lastIndex;
      SPACE.lastIndex = i;
      SPACE.exec(xml);
      i = SPACE.lastIndex;
      if (xml[i] !== '=') throw new XmlError('Attribute without a value');
      SPACE.lastIndex = i + 1;
      SPACE.exec(xml);
      i = SPACE.lastIndex;
      const quote = xml[i];
      if (quote !== '"' && quote !== "'") throw new XmlError('Unquoted attribute value');
      const close = until(quote, i + 1);
      const rawValue = xml.slice(i + 1, close);
      if (rawValue.includes('<')) throw new XmlError('< in attribute value');
      rawAttrs.push([attrMatch[0], decodeEntities(rawValue)]);
      i = close + 1;
    }

    const parentScope = stack.length ? stack[stack.length - 1].scope : new Map([['xml', XML_NS]]);
    let scope = parentScope;
    for (const [name, value] of rawAttrs) {
      if (name === 'xmlns' || name.startsWith('xmlns:')) {
        if (scope === parentScope) scope = new Map(parentScope);
        scope.set(name === 'xmlns' ? '' : name.slice(6), value);
      }
    }
    for (const [name] of rawAttrs) {
      if (name !== 'xmlns' && !name.startsWith('xmlns:')) resolveName(name, scope, true);
    }

    const { ns, local } = resolveName(qname, scope);
    const el: XmlElement = { ns, local, attrs: Object.fromEntries(rawAttrs), children: [], text: '' };
    if (stack.length) stack[stack.length - 1].el.children.push(el);
    else root = el;
    if (!selfClosing) {
      if (stack.length >= MAX_DEPTH) throw new XmlError('XML nested too deeply');
      stack.push({ el, qname, scope });
    }
  }

  if (stack.length) throw new XmlError(`Unclosed element <${stack[stack.length - 1].qname}>`);
  if (!root) throw new XmlError('Empty XML document');
  return root;
}

export function childrenNamed(el: XmlElement | undefined, ns: string, local: string): XmlElement[] {
  return el ? el.children.filter((c) => c.ns === ns && c.local === local) : [];
}

export function childNamed(el: XmlElement | undefined, ns: string, local: string): XmlElement | undefined {
  return el?.children.find((c) => c.ns === ns && c.local === local);
}

// ─── Multistatus ───────────────────────────────────────────────────────────

export interface DavPropstat {
  status: number;
  props: XmlElement[];
}

export interface DavResponse {
  /** As the server sent it, trimmed; resolve against the request URL to use it. */
  href: string;
  /** A response-level status (multiget answers 404 like this), when present. */
  status?: number;
  propstats: DavPropstat[];
}

/** The code in an HTTP status line ("HTTP/1.1 404 Not Found"), 0 when unreadable. */
export function statusCode(line: string | undefined): number {
  const match = line?.trim().match(/^HTTP\/\d+(?:\.\d+)?\s+(\d{3})\b/i);
  return match ? Number(match[1]) : 0;
}

export function parseMultistatus(xml: string): DavResponse[] {
  const root = parseXml(xml);
  if (root.ns !== DAV_NS || root.local !== 'multistatus') throw new XmlError('Not a DAV multistatus answer');
  const out: DavResponse[] = [];
  for (const response of childrenNamed(root, DAV_NS, 'response')) {
    const href = childNamed(response, DAV_NS, 'href')?.text.trim();
    if (!href) continue;
    const status = childNamed(response, DAV_NS, 'status');
    out.push({
      href,
      ...(status ? { status: statusCode(status.text) } : {}),
      propstats: childrenNamed(response, DAV_NS, 'propstat').map((propstat) => ({
        status: statusCode(childNamed(propstat, DAV_NS, 'status')?.text),
        props: childNamed(propstat, DAV_NS, 'prop')?.children ?? [],
      })),
    });
  }
  return out;
}

const isOk = (status: number) => status >= 200 && status < 300;

/** A property the server returned with a 2xx propstat. */
export function getProp(response: DavResponse | undefined, ns: string, local: string): XmlElement | undefined {
  for (const propstat of response?.propstats ?? []) {
    if (!isOk(propstat.status)) continue;
    const prop = propstat.props.find((p) => p.ns === ns && p.local === local);
    if (prop) return prop;
  }
  return undefined;
}

/** Whether the server answered for this resource at all (some 2xx propstat). */
export function hasProps(response: DavResponse): boolean {
  return response.propstats.some((p) => isOk(p.status));
}

/** Whether the server said 404 for the resource or for one of its properties. */
export function isNotFound(response: DavResponse): boolean {
  return response.status === 404 || (!hasProps(response) && response.propstats.some((p) => p.status === 404));
}

function propText(response: DavResponse | undefined, ns: string, local: string): string | undefined {
  return getProp(response, ns, local)?.text;
}

function propTrimmed(response: DavResponse | undefined, ns: string, local: string): string | undefined {
  const text = propText(response, ns, local)?.trim();
  return text ? text : undefined;
}

/** The DAV:href children of a property such as a home set. */
export function propHrefs(response: DavResponse | undefined, ns: string, local: string): string[] {
  return childrenNamed(getProp(response, ns, local), DAV_NS, 'href')
    .map((href) => href.text.trim())
    .filter(Boolean);
}

export function currentUserPrincipal(response: DavResponse | undefined): string | undefined {
  return propHrefs(response, DAV_NS, 'current-user-principal')[0];
}

export function homeSet(response: DavResponse | undefined, kind: 'carddav' | 'caldav'): string[] {
  return kind === 'carddav'
    ? propHrefs(response, CARDDAV_NS, 'addressbook-home-set')
    : propHrefs(response, CALDAV_NS, 'calendar-home-set');
}

export interface ResourceType {
  collection: boolean;
  addressbook: boolean;
  calendar: boolean;
}

export function resourceType(response: DavResponse | undefined): ResourceType {
  const prop = getProp(response, DAV_NS, 'resourcetype');
  return {
    collection: !!childNamed(prop, DAV_NS, 'collection'),
    addressbook: !!childNamed(prop, CARDDAV_NS, 'addressbook'),
    calendar: !!childNamed(prop, CALDAV_NS, 'calendar'),
  };
}

export function displayName(response: DavResponse | undefined): string | undefined {
  return propTrimmed(response, DAV_NS, 'displayname');
}

/** The ETag as sent, quotes (and W/) kept. */
export function getEtag(response: DavResponse | undefined): string | undefined {
  return propTrimmed(response, DAV_NS, 'getetag');
}

export function getCtag(response: DavResponse | undefined): string | undefined {
  return propTrimmed(response, CALSERVER_NS, 'getctag');
}

export function getContentType(response: DavResponse | undefined): string | undefined {
  return propTrimmed(response, DAV_NS, 'getcontenttype');
}

/** Apple's calendar-color as sent: #rrggbb or #rrggbbaa, usually. */
export function calendarColor(response: DavResponse | undefined): string | undefined {
  return propTrimmed(response, APPLE_ICAL_NS, 'calendar-color');
}

/** The comp names of supported-calendar-component-set, upper-cased. */
export function supportedComponents(response: DavResponse | undefined): string[] {
  return childrenNamed(getProp(response, CALDAV_NS, 'supported-calendar-component-set'), CALDAV_NS, 'comp')
    .map((comp) => comp.attrs.name?.trim().toUpperCase())
    .filter((name): name is string => !!name);
}

export function addressData(response: DavResponse | undefined): string | undefined {
  return propText(response, CARDDAV_NS, 'address-data');
}

export function calendarData(response: DavResponse | undefined): string | undefined {
  return propText(response, CALDAV_NS, 'calendar-data');
}
