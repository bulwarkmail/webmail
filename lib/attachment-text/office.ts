// Text out of Office files: Word, Excel and PowerPoint (docx, xlsx, pptx)
// and OpenDocument (odt, ods, odp). All are ZIP archives of XML; only the
// entries holding text are unpacked (fflate, through the mail import's ZIP
// reader) and read with DOMParser. No layout, no styles: the reader of the
// text is a language model.
//
// Nothing in the file is trusted. The sizes in a ZIP's headers are whatever
// the sender wrote, so the bytes actually unpacked are counted: reading
// stops past MAX_INFLATED_BYTES for the whole file and MAX_XML_PART_BYTES
// for one part (too_big). A few bytes of XML can stand for millions of
// characters (a cell repeated across a sheet), so every reader writes into
// a TextSink and stops when the read's budget is used up. Parts with a DTD
// are refused.

import { listZipEntries, streamZipEntry, ZipFormatError, type ZipEntry } from '@/lib/mail-import/zip-reader';
import {
  MAX_CELL_CHARS, MAX_INFLATED_BYTES, MAX_SHEET_ROWS, MAX_SHEETS, MAX_TEXT_CHARS, MAX_XML_PART_BYTES, TEXT_BUDGET_SLACK,
  type ExtractedText, type TextFormat,
} from './types';
import { TextSink } from './sink';

export type OfficeFormat = Extract<TextFormat, 'docx' | 'xlsx' | 'pptx' | 'odt' | 'ods' | 'odp'>;
type Result = Omit<ExtractedText, 'format'>;

export interface OfficeOptions {
  /** Characters to write at most (default MAX_TEXT_CHARS plus slack). */
  budget?: number;
  /** Bytes the whole file may unpack to (default MAX_INFLATED_BYTES). */
  inflateCap?: number;
  /** Bytes one XML part may unpack to (default MAX_XML_PART_BYTES). */
  partCap?: number;
}

/** The file unpacks to more than a cap. */
class TooBig extends Error {}
/** The file is protected by a password. */
class Encrypted extends Error {}
/** The file asks for something a reader never does (a DTD). */
class Refused extends Error {}

/** Inflated chunks at most this big per step (a deflate block expands about 1000 times). */
const INPUT_CHUNK = 16 * 1024;

/** Reads entries of one archive, counting every byte unpacked against the caps. */
class Unpacker {
  private used = 0;
  constructor(
    private readonly file: Blob,
    readonly entries: ZipEntry[],
    private readonly cap: number,
    private readonly partCap: number,
  ) {}

  has(name: string): boolean {
    return this.entries.some((e) => e.name === name);
  }

  async bytes(name: string): Promise<Uint8Array | null> {
    const entry = this.entries.find((e) => e.name === name && !e.directory);
    if (!entry) return null;
    if (entry.encrypted) throw new Encrypted();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of streamZipEntry(this.file, entry, INPUT_CHUNK)) {
      total += chunk.byteLength;
      this.used += chunk.byteLength;
      if (this.used > this.cap || total > this.partCap) throw new TooBig();
      chunks.push(chunk);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }
    return out;
  }

  async xml(name: string): Promise<Document | null> {
    const data = await this.bytes(name);
    if (!data) return null;
    const source = new TextDecoder('utf-8').decode(data);
    // Office parts never need a DTD; entities from one only blow text up.
    if (/<!DOCTYPE/i.test(source)) throw new Refused();
    const doc = new DOMParser().parseFromString(source, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length > 0) throw new ZipFormatError(`${name} is not XML`);
    return doc;
  }
}

// ─── XML helpers (by local name, whatever the prefix) ────────

function kids(el: Element, local?: string): Element[] {
  return Array.from(el.children).filter((c) => !local || c.localName === local);
}

function all(root: Document | Element, local: string): Element[] {
  return Array.from(root.getElementsByTagNameNS('*', local));
}

function attr(el: Element, local: string): string | null {
  for (const a of Array.from(el.attributes)) if (a.localName === local) return a.value;
  return null;
}

/** The r:id of a reference to another part (an attribute named id in a namespace, not a plain id). */
function relId(el: Element): string | null {
  for (const a of Array.from(el.attributes)) if (a.localName === 'id' && a.namespaceURI) return a.value;
  return null;
}

const cell = (text: string) => (text.length > MAX_CELL_CHARS ? text.slice(0, MAX_CELL_CHARS) : text);

/** A cell for CSV-like rows: quoted when it holds a comma, a quote or a line break. */
function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csvRow(cells: string[]): string {
  let end = cells.length;
  while (end > 0 && !cells[end - 1]) end--;
  return cells.slice(0, end).map(csvCell).join(',');
}

// ─── Package parts (docx, xlsx, pptx) ────────────────────────

function normalisePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

interface Relation { target: string; type: string }

/** The relations of `part` (its _rels/<name>.rels next to it): rId → target path and type. */
async function relationsOf(zip: Unpacker, part: string): Promise<Map<string, Relation>> {
  const slash = part.lastIndexOf('/');
  const dir = slash === -1 ? '' : part.slice(0, slash);
  const relsPath = part === '' ? '_rels/.rels' : `${dir ? `${dir}/` : ''}_rels/${part.slice(slash + 1)}.rels`;
  const rels = await zip.xml(relsPath);
  const map = new Map<string, Relation>();
  if (!rels) return map;
  for (const rel of all(rels, 'Relationship')) {
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    if (!id || !target || rel.getAttribute('TargetMode') === 'External') continue;
    map.set(id, {
      target: target.startsWith('/') ? normalisePath(target) : normalisePath(`${dir}/${target}`),
      type: rel.getAttribute('Type') ?? '',
    });
  }
  return map;
}

/** The package's main part (document, workbook, presentation), as its _rels/.rels names it. */
async function mainPart(zip: Unpacker, fallback: string): Promise<string> {
  for (const rel of (await relationsOf(zip, '')).values()) {
    if (rel.type.endsWith('/officeDocument')) return rel.target;
  }
  return fallback;
}

/** Elements of `local` name under `root`, in document order, leaving out mc:Fallback copies. */
function without(root: Element, local: string, skip: ReadonlySet<string> = FALLBACK): Element[] {
  const out: Element[] = [];
  const walk = (el: Element) => {
    for (const c of Array.from(el.children)) {
      if (skip.has(c.localName)) continue;
      if (c.localName === local) out.push(c);
      else walk(c);
    }
  };
  walk(root);
  return out;
}
const FALLBACK: ReadonlySet<string> = new Set(['Fallback']);

// ─── Word (docx) ─────────────────────────────────────────────

/**
 * Not part of what the reader sees: deleted and moved-away text of tracked
 * changes, field codes, and the Fallback copy of anything in
 * mc:AlternateContent (the Choice holds the same).
 */
const WORD_SKIP: ReadonlySet<string> = new Set(['delText', 'instrText', 'del', 'moveFrom', 'Fallback', 'sectPr']);

/** A paragraph's text; the paragraphs of text boxes in it go to `boxes`, each its own line. */
function wordRuns(el: Element, boxes: string[]): string {
  let out = '';
  for (const c of Array.from(el.children)) {
    if (WORD_SKIP.has(c.localName)) continue;
    switch (c.localName) {
      case 't': out += c.textContent ?? ''; break;
      case 'tab': out += '\t'; break;
      case 'br': case 'cr': out += '\n'; break;
      case 'txbxContent': {
        const inner = new TextSink(MAX_CELL_CHARS);
        wordBlocks(c, inner);
        const text = inner.text();
        if (text) boxes.push(text);
        break;
      }
      default: out += wordRuns(c, boxes);
    }
  }
  return out;
}

function wordBlocks(el: Element, out: TextSink): void {
  for (const c of Array.from(el.children)) {
    if (out.full) return;
    if (WORD_SKIP.has(c.localName)) continue;
    if (c.localName === 'p') {
      const boxes: string[] = [];
      const text = wordRuns(c, boxes);
      if (text || !boxes.length) out.line(text);
      for (const box of boxes) out.line(box);
    } else if (c.localName === 'tbl') {
      for (const row of kids(c, 'tr')) {
        const cells = kids(row, 'tc').map((td) => {
          const inner = new TextSink(MAX_CELL_CHARS);
          wordBlocks(td, inner);
          return inner.text().replace(/\s*\n\s*/g, ' ');
        });
        if (!out.line(cells.join(' | '))) return;
      }
      out.line('');
    } else wordBlocks(c, out);
  }
}

async function docx(zip: Unpacker, sink: TextSink): Promise<Result> {
  const doc = await zip.xml(await mainPart(zip, 'word/document.xml'));
  if (!doc) return { status: 'failed', text: '', truncated: false };
  wordBlocks(all(doc, 'body')[0] ?? doc.documentElement, sink);
  return { status: 'ok', text: sink.text(), truncated: sink.full };
}

// ─── Excel (xlsx) ────────────────────────────────────────────

/** "BC12" → 54 (0-based column of the cell reference). */
function columnOf(ref: string | null): number | null {
  const m = /^([A-Z]+)\d*$/i.exec(ref ?? '');
  if (!m) return null;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Built-in number formats that are dates or times (ECMA-376 18.8.30). */
const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** True for a custom format code that shows a date or a time (d, m with y, y, h, s outside quotes and brackets). */
export function isDateFormatCode(code: string): boolean {
  const bare = code.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '');
  return /[dyhs]/i.test(bare);
}

/** The cell styles (index in cellXfs) whose number format is a date or a time. */
async function dateStyles(zip: Unpacker, path: string): Promise<Set<number>> {
  const out = new Set<number>();
  const styles = await zip.xml(path);
  if (!styles) return out;
  const custom = new Map<number, string>();
  for (const fmt of all(styles, 'numFmt')) custom.set(Number(fmt.getAttribute('numFmtId')), fmt.getAttribute('formatCode') ?? '');
  const xfs = all(styles, 'cellXfs')[0];
  kids(xfs ?? styles.documentElement, 'xf').forEach((xf, index) => {
    if (!xfs) return;
    const id = Number(xf.getAttribute('numFmtId') ?? 0);
    const code = custom.get(id);
    if (code !== undefined ? isDateFormatCode(code) : DATE_FORMAT_IDS.has(id)) out.add(index);
  });
  return out;
}

/** A date serial as "2026-10-31", "2026-10-31 12:00" or, below one day, "12:00". */
export function excelDate(serial: number, date1904 = false): string | null {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) return null;
  const days = Math.floor(serial);
  const seconds = Math.round((serial - days) * 86400);
  // 1899-12-30 makes Excel's day 60 (a 29 February 1900 that never was) come out right after it.
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const iso = new Date(base + days * 86_400_000 + seconds * 1000).toISOString();
  if (days === 0 && !date1904) return iso.slice(11, 16);
  return seconds ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}

async function xlsx(zip: Unpacker, sink: TextSink): Promise<Result> {
  const bookPath = await mainPart(zip, 'xl/workbook.xml');
  const book = await zip.xml(bookPath);
  if (!book) return { status: 'failed', text: '', truncated: false };
  const rels = await relationsOf(zip, bookPath);
  const dir = bookPath.includes('/') ? bookPath.slice(0, bookPath.lastIndexOf('/')) : '';
  const related = (type: string, fallback: string) => [...rels.values()].find((r) => r.type.endsWith(type))?.target ?? fallback;
  const shared: string[] = [];
  const strings = await zip.xml(related('/sharedStrings', `${dir}/sharedStrings.xml`));
  if (strings) {
    for (const si of all(strings, 'si')) {
      // Phonetic runs (rPh) are reading aids, not the cell's text.
      shared.push(cell(all(si, 't').filter((t) => t.parentElement?.localName !== 'rPh').map((t) => t.textContent ?? '').join('')));
    }
  }
  const dates = await dateStyles(zip, related('/styles', `${dir}/styles.xml`));
  const pr = all(book, 'workbookPr')[0];
  const date1904 = pr?.getAttribute('date1904') === '1' || pr?.getAttribute('date1904') === 'true';
  const sheets = all(book, 'sheet');
  const names: string[] = [];
  let truncated = sheets.length > MAX_SHEETS;
  for (const sheet of sheets.slice(0, MAX_SHEETS)) {
    if (sink.full) break;
    const name = sheet.getAttribute('name') ?? `Sheet ${names.length + 1}`;
    const rid = relId(sheet);
    const path = rid ? rels.get(rid)?.target : undefined;
    const doc = path ? await zip.xml(path) : null;
    names.push(name);
    if (names.length > 1) sink.line('');
    sink.line(`Sheet: ${name}`);
    if (!doc) continue;
    const rowEls = all(doc, 'row');
    if (rowEls.length > MAX_SHEET_ROWS) truncated = true;
    for (const row of rowEls.slice(0, MAX_SHEET_ROWS)) {
      const cells: string[] = [];
      for (const c of kids(row, 'c')) {
        const col = columnOf(c.getAttribute('r')) ?? cells.length;
        if (col > 1000) continue;
        const type = c.getAttribute('t');
        const v = kids(c, 'v')[0]?.textContent ?? '';
        let value: string;
        if (type === 's') value = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') value = cell(all(c, 't').map((t) => t.textContent ?? '').join(''));
        else if (type === 'b') value = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : v;
        else if ((!type || type === 'n') && v && dates.has(Number(c.getAttribute('s') ?? 0))) value = excelDate(Number(v), date1904) ?? v;
        else value = cell(v);
        while (cells.length < col) cells.push('');
        cells[col] = value;
      }
      const line = csvRow(cells);
      if (line && !sink.line(line)) break;
    }
  }
  return { status: 'ok', text: sink.text(), truncated: truncated || sink.full, sheets: names };
}

// ─── PowerPoint (pptx) ───────────────────────────────────────

/** The slides in the order the deck shows them (sldIdLst), else by their file numbers. */
async function slidePaths(zip: Unpacker, presentation: string): Promise<string[]> {
  const pres = await zip.xml(presentation);
  if (pres) {
    const rels = await relationsOf(zip, presentation);
    const ordered = all(pres, 'sldId').map((s) => rels.get(relId(s) ?? '')?.target).filter((p): p is string => !!p);
    if (ordered.length) return ordered;
  }
  return zip.entries
    .map((e) => ({ name: e.name, n: Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(e.name)?.[1]) }))
    .filter((s) => Number.isFinite(s.n))
    .sort((a, b) => a.n - b.n)
    .map((s) => s.name);
}

async function pptx(zip: Unpacker, sink: TextSink): Promise<Result> {
  const presentation = await mainPart(zip, 'ppt/presentation.xml');
  const slides = await slidePaths(zip, presentation);
  if (!slides.length && !zip.has(presentation)) return { status: 'failed', text: '', truncated: false };
  for (const [i, slide] of slides.entries()) {
    if (sink.full) break;
    const doc = await zip.xml(slide);
    if (!doc) continue;
    if (i > 0) sink.line('');
    sink.line(`Slide ${i + 1}`);
    for (const p of without(doc.documentElement, 'p')) {
      const text = all(p, 't').map((t) => t.textContent ?? '').join('').trim();
      if (text && !sink.line(text)) break;
    }
  }
  return { status: 'ok', text: sink.text(), truncated: sink.full };
}

// ─── OpenDocument (odt, ods, odp) ────────────────────────────

/** A paragraph's text: spans, spaces (text:s), tabs and line breaks; notes left out. */
function odfRuns(el: Element): string {
  let out = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3) { out += node.nodeValue ?? ''; continue; }
    if (node.nodeType !== 1) continue;
    const c = node as Element;
    switch (c.localName) {
      case 's': out += ' '.repeat(Math.min(100, Math.max(1, Number(attr(c, 'c')) || 1))); break;
      case 'tab': out += '\t'; break;
      case 'line-break': out += '\n'; break;
      case 'note': case 'annotation': break;
      default: out += odfRuns(c);
    }
  }
  return out;
}

/** Most columns of one row read. */
const MAX_COLUMNS = 1000;

/**
 * The rows of a table:table, repeated rows and cells expanded, handed to
 * `onRow` one by one until it answers false or MAX_SHEET_ROWS are done.
 * A row's cells stop once their text passes `rowChars`, so one row never
 * holds more than the read can use. True when rows were left over.
 */
function odfTableRows(table: Element, rowChars: number, onRow: (cells: string[]) => boolean): boolean {
  let rows = 0;
  for (const row of all(table, 'table-row')) {
    // Only rows of this table, not of a table nested in a cell.
    let owner: Element | null = row.parentElement;
    while (owner && owner.localName !== 'table') owner = owner.parentElement;
    if (owner !== table) continue;
    const cells: string[] = [];
    let chars = 0;
    for (const td of kids(row).filter((c) => c.localName === 'table-cell' || c.localName === 'covered-table-cell')) {
      if (chars > rowChars || cells.length >= MAX_COLUMNS) break;
      const text = cell(all(td, 'p').map(odfRuns).join('\n').trim());
      const repeat = Math.max(1, Number(attr(td, 'number-columns-repeated')) || 1);
      // A run of empty cells to the sheet's edge says "repeated 16384 times".
      for (let i = 0; i < repeat && cells.length < MAX_COLUMNS && chars <= rowChars; i++) {
        cells.push(text);
        chars += text.length + 1;
      }
    }
    const repeatRows = Math.max(1, Number(attr(row, 'number-rows-repeated')) || 1);
    const empty = cells.every((c) => !c);
    for (let i = 0; i < (empty ? 1 : repeatRows); i++) {
      if (rows >= MAX_SHEET_ROWS) return true;
      rows++;
      if (!onRow(cells)) return true;
    }
  }
  return false;
}

function odfBlocks(el: Element, out: TextSink): void {
  for (const c of Array.from(el.children)) {
    if (out.full) return;
    if (c.localName === 'p' || c.localName === 'h') out.line(odfRuns(c));
    else if (c.localName === 'table') {
      odfTableRows(c, out.budget, (row) => {
        const line = row.filter(Boolean).join(' | ');
        return line ? out.line(line) : true;
      });
      out.line('');
    } else if (c.localName !== 'tracked-changes' && c.localName !== 'sequence-decls') odfBlocks(c, out);
  }
}

async function odf(zip: Unpacker, format: 'odt' | 'ods' | 'odp', sink: TextSink): Promise<Result> {
  const manifest = await zip.bytes('META-INF/manifest.xml');
  if (manifest && /encryption-data/.test(new TextDecoder('utf-8').decode(manifest))) throw new Encrypted();
  const doc = await zip.xml('content.xml');
  if (!doc) return { status: 'failed', text: '', truncated: false };
  if (format === 'odt') {
    const body = all(doc, 'text')[0];
    if (body) odfBlocks(body, sink);
    return { status: 'ok', text: sink.text(), truncated: sink.full };
  }
  if (format === 'ods') {
    const sheet = all(doc, 'spreadsheet')[0];
    const tables = sheet ? kids(sheet, 'table') : [];
    const names: string[] = [];
    let truncated = tables.length > MAX_SHEETS;
    for (const table of tables.slice(0, MAX_SHEETS)) {
      if (sink.full) break;
      const name = attr(table, 'name') ?? `Sheet ${names.length + 1}`;
      names.push(name);
      if (names.length > 1) sink.line('');
      sink.line(`Sheet: ${name}`);
      const more = odfTableRows(table, sink.budget, (row) => {
        const line = csvRow(row);
        return line ? sink.line(line) : true;
      });
      if (more) truncated = true;
    }
    return { status: 'ok', text: sink.text(), truncated: truncated || sink.full, sheets: names };
  }
  const pres = all(doc, 'presentation')[0];
  for (const [i, page] of (pres ? kids(pres, 'page') : []).entries()) {
    if (sink.full) break;
    if (i > 0) sink.line('');
    sink.line(`Slide ${i + 1}`);
    for (const p of all(page, 'p')) {
      const text = odfRuns(p).trim();
      if (text && !sink.line(text)) break;
    }
  }
  return { status: 'ok', text: sink.text(), truncated: sink.full };
}

// ─── Entry point ─────────────────────────────────────────────

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** True for an OLE compound file: legacy .doc/.xls/.ppt, or an Office file with a password. */
export function isCompoundFile(bytes: Uint8Array): boolean {
  return CFB_MAGIC.every((b, i) => bytes[i] === b);
}

/** The UTF-16LE bytes of `name`, as a compound file's directory stores stream names. */
function utf16(name: string): number[] {
  return [...name].flatMap((c) => [c.charCodeAt(0), 0]);
}
const ENCRYPTED_STREAMS = [utf16('EncryptedPackage'), utf16('EncryptionInfo')];

function includesBytes(haystack: Uint8Array, needle: number[]): boolean {
  const first = needle[0];
  for (let i = haystack.indexOf(first); i !== -1 && i <= haystack.length - needle.length; i = haystack.indexOf(first, i + 1)) {
    let j = 1;
    while (j < needle.length && haystack[i + j] === needle[j]) j++;
    if (j === needle.length) return true;
  }
  return false;
}

/** A compound file holding an encrypted Office package (a docx, xlsx or pptx with a password). */
export function isEncryptedPackage(bytes: Uint8Array): boolean {
  return ENCRYPTED_STREAMS.some((name) => includesBytes(bytes, name));
}

/**
 * The text of an Office file. A password-protected docx, xlsx or pptx is a
 * compound file holding an EncryptedPackage stream: encrypted; any other
 * compound file is a legacy .doc/.xls/.ppt under a new name: unsupported.
 */
export async function officeText(bytes: Uint8Array, format: OfficeFormat, options: OfficeOptions = {}): Promise<Result> {
  const { budget = MAX_TEXT_CHARS + TEXT_BUDGET_SLACK, inflateCap = MAX_INFLATED_BYTES, partCap = MAX_XML_PART_BYTES } = options;
  if (isCompoundFile(bytes)) return { status: isEncryptedPackage(bytes) ? 'encrypted' : 'unsupported', text: '', truncated: false };
  try {
    const file = new Blob([bytes as BlobPart]);
    const zip = new Unpacker(file, await listZipEntries(file), inflateCap, partCap);
    const sink = new TextSink(budget);
    switch (format) {
      case 'docx': return await docx(zip, sink);
      case 'xlsx': return await xlsx(zip, sink);
      case 'pptx': return await pptx(zip, sink);
      default: return await odf(zip, format, sink);
    }
  } catch (err) {
    if (err instanceof TooBig) return { status: 'too_big', text: '', truncated: false };
    if (err instanceof Encrypted) return { status: 'encrypted', text: '', truncated: false };
    if (err instanceof ZipFormatError && /Encrypted entry/.test(err.message)) return { status: 'encrypted', text: '', truncated: false };
    return { status: 'failed', text: '', truncated: false };
  }
}
