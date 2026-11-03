/**
 * The `header:<Name>[:<form>][:all]` properties of Email/get (RFC 8621
 * section 4.1.2), worked out from the raw `headers` a kept message stores.
 * Callers read these for mailing list ids, classification labels and rules.
 */

export interface RawHeader {
  name: string;
  value: string;
}

export interface HeaderForm {
  name: string;
  form: 'asRaw' | 'asText' | 'asAddresses' | 'asGroupedAddresses' | 'asMessageIds' | 'asDate' | 'asURLs';
  all: boolean;
}

const FORMS = new Set<HeaderForm['form']>(['asRaw', 'asText', 'asAddresses', 'asGroupedAddresses', 'asMessageIds', 'asDate', 'asURLs']);

export function parseHeaderProperty(property: string): HeaderForm | null {
  if (!property.startsWith('header:')) return null;
  const parts = property.slice('header:'.length).split(':');
  const name = parts.shift();
  if (!name) return null;
  let all = false;
  if (parts[parts.length - 1] === 'all') {
    all = true;
    parts.pop();
  }
  if (parts.length > 1) return null;
  const form = (parts[0] ?? 'asRaw') as HeaderForm['form'];
  return FORMS.has(form) ? { name, form, all } : null;
}

function unfold(value: string): string {
  return value.replace(/\r?\n(?=[ \t])/g, '').trim();
}

function decodeBytes(charset: string, bytes: Uint8Array): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

/** RFC 2047 encoded words. Whitespace between two of them goes. */
function decodeWords(value: string): string {
  return value
    .replace(/(=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[bBqQ]\?)/g, '$1')
    .replace(/=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g, (whole, charset: string, encoding: string, text: string) => {
      try {
        if (encoding.toUpperCase() === 'B') {
          return decodeBytes(charset, Uint8Array.from(atob(text), (c) => c.charCodeAt(0)));
        }
        const raw = text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
        return decodeBytes(charset, Uint8Array.from(raw, (c) => c.charCodeAt(0)));
      } catch {
        return whole;
      }
    });
}

interface Address { name: string | null; email: string }
interface Group { name: string | null; addresses: Address[] }

/** Splits on a separator outside quotes, comments and angle brackets. */
function splitOutside(value: string, separators: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  let depth = 0;
  let angle = false;
  for (let i = 0; i < value.length; i += 1) {
    const c = value[i];
    if (quoted) {
      current += c;
      if (c === '\\') {
        current += value[i + 1] ?? '';
        i += 1;
      } else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === '(') depth += 1;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === '<') angle = true;
    else if (c === '>') angle = false;
    if (depth === 0 && !angle && separators.includes(c)) {
      parts.push(current);
      if (c !== ',') parts.push(c);
      current = '';
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts;
}

function parseAddress(text: string): Address | null {
  const trimmed = text.replace(/\((?:[^()\\]|\\.)*\)/g, ' ').trim();
  if (!trimmed) return null;
  const angle = trimmed.match(/^([\s\S]*)<([^<>]*)>\s*$/);
  const email = (angle ? angle[2] : trimmed).trim();
  if (!angle && !email.includes('@')) return null;
  const rawName = angle ? angle[1].trim() : '';
  const name = rawName.startsWith('"') && rawName.endsWith('"') && rawName.length >= 2
    ? rawName.slice(1, -1).replace(/\\(.)/g, '$1')
    : rawName;
  return { name: name ? decodeWords(name) : null, email };
}

function parseGroups(value: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let loose: Group | null = null;
  const tokens = splitOutside(unfold(value), ',:;');
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (tokens[i + 1] === ':') {
      current = { name: decodeWords(token.trim().replace(/^"|"$/g, '')) || null, addresses: [] };
      groups.push(current);
      loose = null;
      i += 1;
      continue;
    }
    if (token === ';') {
      current = null;
      continue;
    }
    if (token === ':') continue;
    const address = parseAddress(token);
    if (!address) continue;
    if (current) current.addresses.push(address);
    else {
      if (!loose) {
        loose = { name: null, addresses: [] };
        groups.push(loose);
      }
      loose.addresses.push(address);
    }
  }
  return groups;
}

function parseMessageIds(value: string): string[] | null {
  const ids = [...unfold(value).matchAll(/<([^<>\s]+)>/g)].map((match) => match[1]);
  return ids.length > 0 ? ids : null;
}

function parseDate(value: string): string | null {
  const ms = Date.parse(unfold(value).replace(/\((?:[^()\\]|\\.)*\)/g, ' '));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function parseUrls(value: string): string[] | null {
  const urls = [...unfold(value).matchAll(/<([^<>\s]+)>/g)].map((match) => match[1]);
  return urls.length > 0 ? urls : null;
}

function convert(value: string, form: HeaderForm['form']): unknown {
  switch (form) {
    case 'asRaw': return value;
    case 'asText': return decodeWords(unfold(value));
    case 'asAddresses': return parseGroups(value).flatMap((group) => group.addresses);
    case 'asGroupedAddresses': return parseGroups(value);
    case 'asMessageIds': return parseMessageIds(value);
    case 'asDate': return parseDate(value);
    case 'asURLs': return parseUrls(value);
  }
}

/** The value of one header property. Without `:all`, the last header of that name, or null. */
export function headerValue(form: HeaderForm, headers: readonly RawHeader[]): unknown {
  const wanted = form.name.toLowerCase();
  const found = headers.filter((header) => header.name.toLowerCase() === wanted);
  if (form.all) return found.map((header) => convert(header.value, form.form));
  const last = found[found.length - 1];
  return last ? convert(last.value, form.form) : null;
}
