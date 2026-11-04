/**
 * Contacts from a CSV file, as Outlook (English and German) and Google
 * Contacts (current and older format) export them.
 *
 * Three steps, so the import dialog can show the middle one: read the file
 * into a table (`readCsvFile`), match each column to a contact field
 * (`matchColumns`, which the user may change), then build the cards
 * (`csvToContacts`).
 *
 * German Outlook writes `;` between fields and Windows-1252 bytes; Google
 * writes UTF-8 with "E-mail 1 - Value" / "E-mail 1 - Type" column pairs and
 * several values in one cell, joined by " ::: ".
 */

import type { AddressComponent, ContactAddress, ContactCard, NameComponent, PartialDate } from '@/lib/jmap/types';
import { generateUUID } from '@/lib/utils';

// ─── Reading the file ───────────────────────────────────────────────────────

/** Windows-1252 bytes 0x80–0x9F; the rest of the code page is Latin-1. */
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];

function decodeWindows1252(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += String.fromCharCode(b >= 0x80 && b < 0xa0 ? CP1252_HIGH[b - 0x80] : b);
  }
  return out;
}

/**
 * The text of a CSV file. A byte order mark says UTF-8 or UTF-16; without one
 * the bytes are UTF-8 if they are valid UTF-8, else Windows-1252 (what
 * Outlook writes on a Western Windows).
 */
export function decodeCsvBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    // Swap to little-endian: not every TextDecoder knows utf-16be.
    const swapped = new Uint8Array(bytes.length - 2);
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      swapped[i - 2] = bytes[i + 1];
      swapped[i - 1] = bytes[i];
    }
    return new TextDecoder('utf-16le').decode(swapped);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return decodeWindows1252(bytes);
  }
}

/** `,`, `;` or tab: whichever the header line has most of, outside quotes. */
export function detectDelimiter(text: string): string {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && ch in counts) counts[ch]++;
  }
  let best = ',';
  for (const d of [';', '\t']) if (counts[d] > counts[best]) best = d;
  return best;
}

/** RFC 4180 records: quoted fields may hold the delimiter, `""` and line breaks. */
export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const endRow = () => {
    row.push(field);
    rows.push(row);
    row = [];
    field = '';
  };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += ch;
      }
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\r' || ch === '\n') {
      endRow();
      if (ch === '\r' && text[i + 1] === '\n') i++;
    } else {
      field += ch;
    }
    i++;
  }
  if (field !== '' || row.length > 0) endRow();
  // Blank lines (a trailing newline, Excel's empty rows) are no records.
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

export interface CsvTable {
  headers: string[];
  rows: string[][];
}

export function readCsv(text: string): CsvTable {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const [headers = [], ...rows] = parseCsv(clean);
  return { headers: headers.map((h) => h.trim()), rows };
}

/** A .csv by name or type, or text that isn't a vCard and has a delimited header line. */
export function isCsvFile(file: { name: string; type?: string }): boolean {
  const name = file.name.toLowerCase();
  const type = (file.type ?? '').toLowerCase();
  return name.endsWith('.csv') || type === 'text/csv' || type === 'application/csv' || type === 'text/comma-separated-values';
}

// ─── Fields a column can go to ──────────────────────────────────────────────

export const ADDRESS_CONTEXTS = ['any', 'home', 'work', 'other'] as const;
export type AddressContext = typeof ADDRESS_CONTEXTS[number];
export const ADDRESS_PARTS = ['street', 'pobox', 'locality', 'region', 'postcode', 'country'] as const;
export type AddressPart = typeof ADDRESS_PARTS[number];
type AddressTarget = `adr.${AddressContext}.${AddressPart}`;

export const CSV_TARGET_GROUPS = [
  { id: 'name', targets: ['name.full', 'name.given', 'name.middle', 'name.surname', 'name.prefix', 'name.suffix', 'nickname'] },
  { id: 'email', targets: ['email', 'email.home', 'email.work'] },
  { id: 'phone', targets: ['phone', 'phone.mobile', 'phone.home', 'phone.work', 'phone.fax', 'phone.fax.home', 'phone.fax.work', 'phone.pager'] },
  { id: 'org', targets: ['org.name', 'org.unit', 'org.title'] },
  ...ADDRESS_CONTEXTS.map((ctx) => ({ id: `adr.${ctx}`, targets: ADDRESS_PARTS.map((part) => `adr.${ctx}.${part}` as AddressTarget) })),
  { id: 'more', targets: ['web', 'birthday', 'anniversary', 'notes', 'categories', 'type'] },
] as const;

export type CsvTarget = 'skip' | typeof CSV_TARGET_GROUPS[number]['targets'][number];

/** What a numbered Google column belongs to ("E-mail 2 - Value": email, slot 2). */
export type CsvFamily = 'email' | 'phone' | 'address' | 'web' | 'org';

export interface CsvColumn {
  index: number;
  header: string;
  /** The first value in the column, to show next to it. */
  sample: string;
  target: CsvTarget;
  /** Google's number: columns of one slot make one address, organisation or typed value. */
  slot: string;
  family?: CsvFamily;
}

/** Lower case, no punctuation: "E-Mail 2: Adresse" → "e mail 2 adresse". */
export function normalizeHeader(header: string): string {
  return header
    .normalize('NFC')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[-_:/().,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const HEADER_TARGETS: Record<string, CsvTarget> = {};
function known(target: CsvTarget, ...headers: string[]) {
  for (const header of headers) HEADER_TARGETS[header] = target;
}

// Names: Outlook (en, de), Google (current, older).
known('name.given', 'first name', 'given name', 'vorname');
known('name.middle', 'middle name', 'additional name', 'weitere vornamen', 'zweiter vorname');
known('name.surname', 'last name', 'family name', 'surname', 'nachname');
known('name.prefix', 'title', 'name prefix', 'anrede', 'titel');
known('name.suffix', 'suffix', 'name suffix', 'namenszusatz');
known('name.full', 'name', 'full name', 'display name', 'anzeigename');
known('nickname', 'nickname', 'spitzname');
// E-mail.
known('email', 'e mail address', 'e mail 2 address', 'e mail 3 address', 'email address', 'email', 'e mail',
  'e mail adresse', 'e mail 2 adresse', 'e mail 3 adresse', 'email 2 address', 'email 3 address');
// Outlook's numbered e-mail columns look like Google's; these are not types.
known('skip', 'e mail 2 type', 'e mail 3 type', 'e mail 2 display name', 'e mail 3 display name',
  'e mail 2 typ', 'e mail 3 typ', 'e mail 2 angezeigter name', 'e mail 3 angezeigter name');
known('email.home', 'home e mail', 'home email', 'personal e mail', 'e mail privat');
known('email.work', 'work e mail', 'work email', 'business e mail', 'e mail geschäftlich');
// Phones.
known('phone.mobile', 'mobile phone', 'mobile phone 2', 'mobile', 'cell phone', 'mobiltelefon', 'mobiltelefon 2', 'handy');
known('phone.home', 'home phone', 'home phone 2', 'telefon privat', 'telefon privat 2');
known('phone.work', 'business phone', 'business phone 2', 'work phone', 'company main phone',
  'telefon geschäftlich', 'telefon geschäftlich 2', 'telefon firma');
known('phone.fax.work', 'business fax', 'work fax', 'fax geschäftlich');
known('phone.fax.home', 'home fax', 'fax privat');
known('phone.fax', 'other fax', 'fax', 'weiteres fax');
known('phone.pager', 'pager');
known('phone', 'other phone', 'primary phone', 'car phone', 'callback', 'radio phone', 'assistants phone', 'isdn',
  'tty tdd phone', 'phone', 'weiteres telefon', 'haupttelefon', 'autotelefon', 'rückmeldung', 'telefon assistent',
  'telefon für hörbehinderte');
// Organisation.
known('org.name', 'company', 'organization', 'organization name', 'firma', 'unternehmen');
known('org.unit', 'department', 'organization department', 'abteilung');
known('org.title', 'job title', 'organization title', 'position', 'berufsbezeichnung');
// Outlook addresses.
for (const [ctx, en, de] of [['work', 'business', 'geschäftlich'], ['home', 'home', 'privat']] as const) {
  known(`adr.${ctx}.street`, `${en} street`, `${en} street 2`, `${en} street 3`, `straße ${de}`, `straße ${de} 2`, `straße ${de} 3`);
  known(`adr.${ctx}.locality`, `${en} city`, `ort ${de}`);
  known(`adr.${ctx}.region`, `${en} state`, `region ${de}`, `bundesland kanton ${de}`, `bundesland ${de}`);
  known(`adr.${ctx}.postcode`, `${en} postal code`, `postleitzahl ${de}`);
  known(`adr.${ctx}.country`, `${en} country region`, `${en} country`, `land region ${de}`, `land ${de}`);
  known(`adr.${ctx}.pobox`, `${en} address po box`, `postfach ${de}`);
}
known('adr.other.street', 'other street', 'other street 2', 'other street 3', 'weitere straße', 'weitere straße 2', 'weitere straße 3');
known('adr.other.locality', 'other city', 'weiterer ort');
known('adr.other.region', 'other state', 'weitere region', 'weiteres bundesland kanton', 'weiteres r bundesland kanton');
known('adr.other.postcode', 'other postal code', 'weitere postleitzahl');
known('adr.other.country', 'other country region', 'other country', 'weiteres land region', 'weiteres r land region');
known('adr.other.pobox', 'other address po box', 'weiteres postfach');
// More.
known('web', 'web page', 'personal web page', 'website', 'web site', 'webseite', 'homepage', 'webpage');
known('birthday', 'birthday', 'geburtstag');
known('anniversary', 'anniversary', 'jahrestag');
known('notes', 'notes', 'note', 'notizen');
known('categories', 'categories', 'kategorien', 'labels', 'group membership');

const FAMILIES: Record<string, CsvFamily> = {
  'e mail': 'email', email: 'email', phone: 'phone', address: 'address', website: 'web', organization: 'org',
};

const GOOGLE_FIELDS: Record<CsvFamily, Record<string, CsvTarget>> = {
  email: { value: 'email', type: 'type', label: 'type' },
  phone: { value: 'phone', type: 'type', label: 'type' },
  web: { value: 'web', type: 'type', label: 'type' },
  org: { name: 'org.name', title: 'org.title', department: 'org.unit' },
  address: {
    type: 'type', label: 'type',
    street: 'adr.any.street', 'extended address': 'adr.any.street', 'po box': 'adr.any.pobox',
    city: 'adr.any.locality', region: 'adr.any.region', 'postal code': 'adr.any.postcode', country: 'adr.any.country',
  },
};

/** "E-mail 2 - Value" → email, slot 2, field "value". */
function googleColumn(normalized: string): { family: CsvFamily; slot: string; field: string } | null {
  const m = normalized.match(/^(e mail|email|phone|address|website|organization) (\d+) (.+)$/);
  if (!m) return null;
  return { family: FAMILIES[m[1]], slot: m[2], field: m[3] };
}

/** Each column with a sample value and the field it goes to: known headers matched, the rest "Don't import". */
export function matchColumns(table: CsvTable): CsvColumn[] {
  return table.headers.map((header, index) => {
    const sample = table.rows.map((r) => (r[index] ?? '').trim()).find((v) => v !== '') ?? '';
    const normalized = normalizeHeader(header);
    if (normalized in HEADER_TARGETS) return { index, header, sample, slot: '', target: HEADER_TARGETS[normalized] };
    const google = googleColumn(normalized);
    if (google) {
      return { index, header, sample, slot: google.slot, family: google.family, target: GOOGLE_FIELDS[google.family][google.field] ?? 'skip' };
    }
    return { index, header, sample, slot: '', target: 'skip' };
  });
}

// ─── Building the cards ─────────────────────────────────────────────────────

/** Google's several values in one cell. */
function splitValues(value: string): string[] {
  return value.split(/\s*:::\s*/).map((v) => v.trim()).filter(Boolean);
}

interface ParsedType {
  primary: boolean;
  words: string[];
}

function parseType(value: string | undefined): ParsedType {
  const raw = (value ?? '').trim();
  const primary = raw.startsWith('*');
  const words = raw.replace(/^\*\s*/, '').toLowerCase().split(/[\s,/:]+/).filter(Boolean);
  return { primary, words };
}

const HOME_WORDS = ['home', 'personal', 'private', 'privat', 'zuhause'];
const WORK_WORDS = ['work', 'business', 'office', 'arbeit', 'geschäftlich', 'büro'];

function contextsFor(ctx: 'home' | 'work' | 'other' | 'any', type?: ParsedType): Record<string, boolean> | undefined {
  if (ctx === 'home') return { private: true };
  if (ctx === 'work') return { work: true };
  if (ctx === 'other' || !type) return undefined;
  if (type.words.some((w) => HOME_WORDS.includes(w))) return { private: true };
  if (type.words.some((w) => WORK_WORDS.includes(w))) return { work: true };
  return undefined;
}

function phoneFeaturesFor(target: CsvTarget, type?: ParsedType): Record<string, boolean> | undefined {
  if (target === 'phone.mobile') return { mobile: true };
  if (target === 'phone.fax' || target === 'phone.fax.home' || target === 'phone.fax.work') return { fax: true };
  if (target === 'phone.pager') return { pager: true };
  if (target !== 'phone' || !type) return undefined;
  if (type.words.some((w) => ['mobile', 'cell', 'mobil', 'handy'].includes(w))) return { mobile: true };
  if (type.words.includes('fax')) return { fax: true };
  if (type.words.includes('pager')) return { pager: true };
  return undefined;
}

function phoneContextFor(target: CsvTarget): 'home' | 'work' | 'any' {
  if (target === 'phone.home' || target === 'phone.fax.home') return 'home';
  if (target === 'phone.work' || target === 'phone.fax.work') return 'work';
  return 'any';
}

/**
 * A birthday as Outlook (en "4/12/1985", de "12.04.1985", "0/0/00" for none)
 * or Google ("1985-04-12", "--04-12" without a year) writes it.
 */
export function parseCsvDate(value: string): PartialDate | undefined {
  const v = value.trim();
  if (!v) return undefined;
  const mk = (year: number | undefined, month: number, day: number): PartialDate | undefined => {
    if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return undefined;
    return year ? { year, month, day } : { month, day };
  };
  const fullYear = (y: string) => {
    const n = parseInt(y, 10);
    if (!n) return undefined;
    return y.length <= 2 ? (n > 30 ? 1900 + n : 2000 + n) : n;
  };
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return mk(fullYear(m[1]), +m[2], +m[3]);
  m = v.match(/^--(\d{1,2})-?(\d{2})$/);
  if (m) return mk(undefined, +m[1], +m[2]);
  m = v.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (m) return mk(fullYear(m[3]), +m[2], +m[1]);
  m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    // Month first (US Outlook), unless the first number can't be a month.
    const [a, b] = [+m[1], +m[2]];
    return a > 12 ? mk(fullYear(m[3]), b, a) : mk(fullYear(m[3]), a, b);
  }
  return undefined;
}

interface AddressDraft {
  ctx: AddressContext;
  slot: string;
  parts: Partial<Record<AddressPart, string[]>>;
}

const ADDRESS_COMPONENT_KIND: Record<AddressPart, AddressComponent['kind']> = {
  street: 'name', pobox: 'postOfficeBox', locality: 'locality', region: 'region', postcode: 'postcode', country: 'country',
};

/** The cards in the table, one per row with a name, an address to write to, a phone or a company. */
export function csvToContacts(table: CsvTable, columns: CsvColumn[]): ContactCard[] {
  const used = columns.filter((c) => c.target !== 'skip' && c.target !== 'type');
  const typeColumn = (col: CsvColumn) =>
    col.family ? columns.find((c) => c.target === 'type' && c.family === col.family && c.slot === col.slot) : undefined;

  const cards: ContactCard[] = [];
  for (const row of table.rows) {
    const cell = (col: CsvColumn) => (row[col.index] ?? '').trim();
    const card: ContactCard = { id: `import-${generateUUID()}`, addressBookIds: {} };
    const name: Partial<Record<'full' | 'given' | 'middle' | 'surname' | 'prefix' | 'suffix', string[]>> = {};
    const orgs = new Map<string, { name: string[]; unit: string[]; title: string[] }>();
    const addresses = new Map<string, AddressDraft>();
    let birthday: PartialDate | undefined;
    let anniversary: PartialDate | undefined;

    const add = <T>(key: 'emails' | 'phones' | 'onlineServices' | 'notes' | 'nicknames', prefix: string, entry: T) => {
      const map = ((card as unknown as Record<string, Record<string, T>>)[key] ??= {});
      map[`${prefix}${Object.keys(map).length}`] = entry;
    };

    for (const col of used) {
      const value = cell(col);
      if (!value) continue;
      const type = typeColumn(col);
      const parsedType = type ? parseType(cell(type)) : undefined;
      const pref = parsedType?.primary ? { pref: 1 } : {};
      const target = col.target;

      if (target.startsWith('name.')) {
        const part = target.slice(5) as keyof typeof name;
        (name[part] ??= []).push(value);
      } else if (target === 'nickname') {
        add('nicknames', 'n', { name: value });
      } else if (target === 'email' || target === 'email.home' || target === 'email.work') {
        const ctx = target === 'email.home' ? 'home' : target === 'email.work' ? 'work' : 'any';
        for (const address of splitValues(value)) {
          const contexts = contextsFor(ctx, parsedType);
          add('emails', 'e', { address, ...(contexts ? { contexts } : {}), ...pref });
        }
      } else if (target === 'phone' || target.startsWith('phone.')) {
        for (const number of splitValues(value)) {
          const contexts = contextsFor(phoneContextFor(target), parsedType);
          const features = phoneFeaturesFor(target, parsedType);
          add('phones', 'p', { number, ...(contexts ? { contexts } : {}), ...(features ? { features } : {}), ...pref });
        }
      } else if (target === 'org.name' || target === 'org.unit' || target === 'org.title') {
        const org = orgs.get(col.slot) ?? { name: [], unit: [], title: [] };
        org[target.slice(4) as 'name' | 'unit' | 'title'].push(value);
        orgs.set(col.slot, org);
      } else if (target.startsWith('adr.')) {
        const [, ctx, part] = target.split('.') as [string, AddressContext, AddressPart];
        const key = `${ctx}|${col.slot}`;
        const draft = addresses.get(key) ?? { ctx, slot: col.slot, parts: {} };
        (draft.parts[part] ??= []).push(value);
        addresses.set(key, draft);
      } else if (target === 'web') {
        for (const uri of splitValues(value)) {
          const contexts = contextsFor('any', parsedType);
          add('onlineServices', 'u', { uri, ...(contexts ? { contexts } : {}) });
        }
      } else if (target === 'birthday') {
        birthday ??= parseCsvDate(value);
      } else if (target === 'anniversary') {
        anniversary ??= parseCsvDate(value);
      } else if (target === 'notes') {
        add('notes', 'n', { note: value });
      } else if (target === 'categories') {
        for (const label of value.split(/\s*(?::::|;)\s*/)) {
          const clean = label.trim();
          // Google's own labels ("* myContacts", "* starred") are no categories.
          if (!clean || clean.startsWith('*') || clean === 'myContacts') continue;
          (card.keywords ??= {})[clean] = true;
        }
      }
    }

    const join = (parts?: string[]) => (parts ?? []).join(' ').trim();
    const components: NameComponent[] = [];
    if (join(name.prefix)) components.push({ kind: 'title', value: join(name.prefix) });
    if (join(name.given)) components.push({ kind: 'given', value: join(name.given) });
    if (join(name.middle)) components.push({ kind: 'given2', value: join(name.middle) });
    if (join(name.surname)) components.push({ kind: 'surname', value: join(name.surname) });
    if (join(name.suffix)) components.push({ kind: 'generation', value: join(name.suffix) });
    const full = join(name.full);
    if (components.length === 0 && full) {
      // As a vCard FN alone: first word given name, the rest surname.
      const words = full.split(/\s+/);
      components.push({ kind: 'given', value: words[0] });
      if (words.length > 1) components.push({ kind: 'surname', value: words.slice(1).join(' ') });
    }
    if (components.length > 0) card.name = { components, isOrdered: true, ...(full ? { full } : {}) };

    let o = 0;
    for (const org of orgs.values()) {
      const orgName = join(org.name);
      const unit = join(org.unit);
      if (orgName || unit) {
        (card.organizations ??= {})[`o${o}`] = { name: orgName || undefined, ...(unit ? { units: [{ name: unit }] } : {}) };
      }
      const title = join(org.title);
      if (title) (card.titles ??= {})[`t${o}`] = { name: title, kind: 'title', ...(orgName || unit ? { organizationId: `o${o}` } : {}) };
      o++;
    }

    let a = 0;
    for (const draft of addresses.values()) {
      const type = draft.ctx === 'any'
        ? columns.find((c) => c.target === 'type' && c.family === 'address' && c.slot === draft.slot)
        : undefined;
      const contexts = contextsFor(draft.ctx, type ? parseType(cell(type)) : undefined);
      const parts: AddressComponent[] = [];
      for (const part of ADDRESS_PARTS) {
        const values = (draft.parts[part] ?? []).map((v) => v.trim()).filter(Boolean);
        if (values.length) parts.push({ kind: ADDRESS_COMPONENT_KIND[part], value: values.join(part === 'street' ? '\n' : ' ') });
      }
      if (parts.length === 0) continue;
      const address: ContactAddress = { components: parts, isOrdered: true, defaultSeparator: ', ', ...(contexts ? { contexts } : {}) };
      (card.addresses ??= {})[`a${a++}`] = address;
    }

    if (birthday) (card.anniversaries ??= {}).a0 = { kind: 'birth', date: birthday };
    if (anniversary) (card.anniversaries ??= {})[`a${Object.keys(card.anniversaries ?? {}).length}`] = { kind: 'wedding', date: anniversary };

    if (card.name || card.emails || card.phones || card.organizations) cards.push(card);
  }
  return cards;
}
