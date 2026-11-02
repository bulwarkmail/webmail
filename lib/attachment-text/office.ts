// Text out of Office files: Word, Excel and PowerPoint (docx, xlsx, pptx)
// and OpenDocument (odt, ods, odp). All are ZIP archives of XML; only the
// entries holding text are unpacked (fflate, through the mail import's ZIP
// reader) and read with DOMParser. No layout, no styles: the reader of the
// text is a language model.
//
// The sizes in a ZIP's headers are whatever the sender wrote, so the bytes
// actually unpacked are counted, and reading stops past MAX_INFLATED_BYTES
// for the whole file (a ZIP bomb answers too_big).

import { listZipEntries, streamZipEntry, ZipFormatError, type ZipEntry } from '@/lib/mail-import/zip-reader';
import { MAX_INFLATED_BYTES, MAX_SHEET_ROWS, MAX_SHEETS, type ExtractedText, type TextFormat } from './types';

export type OfficeFormat = Extract<TextFormat, 'docx' | 'xlsx' | 'pptx' | 'odt' | 'ods' | 'odp'>;
type Result = Omit<ExtractedText, 'format'>;

/** The file unpacks to more than the cap. */
class TooBig extends Error {}
/** The file is protected by a password. */
class Encrypted extends Error {}

/** Inflated chunks at most this big per step (a deflate block expands about 1000 times). */
const INPUT_CHUNK = 16 * 1024;

/** Reads entries of one archive, counting every byte unpacked against one cap. */
class Unpacker {
  private used = 0;
  constructor(private readonly file: Blob, readonly entries: ZipEntry[], private readonly cap: number) {}

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
      if (this.used > this.cap) throw new TooBig();
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
    const doc = new DOMParser().parseFromString(new TextDecoder('utf-8').decode(data), 'application/xml');
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

const tidy = (lines: string[]) => lines.map((l) => l.replace(/[ \t]+$/g, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();

/** A cell for CSV-like rows: quoted when it holds a comma, a quote or a line break. */
function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csvRow(cells: string[]): string {
  let end = cells.length;
  while (end > 0 && !cells[end - 1]) end--;
  return cells.slice(0, end).map(csvCell).join(',');
}

// ─── Word (docx) ─────────────────────────────────────────────

function wordRuns(el: Element): string {
  let out = '';
  for (const c of Array.from(el.children)) {
    switch (c.localName) {
      case 't': out += c.textContent ?? ''; break;
      case 'tab': out += '\t'; break;
      case 'br': case 'cr': out += '\n'; break;
      // Deleted text of tracked changes, field codes: not part of what the reader sees.
      case 'delText': case 'instrText': case 'del': break;
      default: out += wordRuns(c);
    }
  }
  return out;
}

function wordBlocks(el: Element, out: string[]): void {
  for (const c of Array.from(el.children)) {
    if (c.localName === 'p') out.push(wordRuns(c));
    else if (c.localName === 'tbl') {
      for (const row of kids(c, 'tr')) {
        out.push(kids(row, 'tc').map((cell) => all(cell, 'p').map(wordRuns).join(' ').trim()).join(' | '));
      }
      out.push('');
    } else if (c.localName !== 'sectPr') wordBlocks(c, out);
  }
}

async function docx(zip: Unpacker): Promise<Result> {
  const doc = await zip.xml('word/document.xml');
  if (!doc) return { status: 'failed', text: '', truncated: false };
  const body = all(doc, 'body')[0] ?? doc.documentElement;
  const lines: string[] = [];
  wordBlocks(body, lines);
  return { status: 'ok', text: tidy(lines), truncated: false };
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

/** rId → target path inside the archive, from a .rels file next to `base`. */
async function relations(zip: Unpacker, relsPath: string, baseDir: string): Promise<Map<string, string>> {
  const rels = await zip.xml(relsPath);
  const map = new Map<string, string>();
  if (!rels) return map;
  for (const rel of all(rels, 'Relationship')) {
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    if (!id || !target) continue;
    map.set(id, target.startsWith('/') ? target.slice(1) : normalisePath(`${baseDir}/${target}`));
  }
  return map;
}

function normalisePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

async function xlsx(zip: Unpacker): Promise<Result> {
  const book = await zip.xml('xl/workbook.xml');
  if (!book) return { status: 'failed', text: '', truncated: false };
  const rels = await relations(zip, 'xl/_rels/workbook.xml.rels', 'xl');
  const shared: string[] = [];
  const strings = await zip.xml('xl/sharedStrings.xml');
  if (strings) {
    for (const si of all(strings, 'si')) {
      // Phonetic runs (rPh) are reading aids, not the cell's text.
      shared.push(all(si, 't').filter((t) => t.parentElement?.localName !== 'rPh').map((t) => t.textContent ?? '').join(''));
    }
  }
  const sheets = all(book, 'sheet');
  const names: string[] = [];
  const blocks: string[] = [];
  let truncated = sheets.length > MAX_SHEETS;
  for (const sheet of sheets.slice(0, MAX_SHEETS)) {
    const name = sheet.getAttribute('name') ?? `Sheet ${names.length + 1}`;
    const rid = attr(sheet, 'id');
    const path = rid ? rels.get(rid) : undefined;
    const doc = path ? await zip.xml(path) : null;
    names.push(name);
    const rows: string[] = [];
    if (doc) {
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
          else if (type === 'inlineStr') value = all(c, 't').map((t) => t.textContent ?? '').join('');
          else if (type === 'b') value = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : v;
          else value = v;
          while (cells.length < col) cells.push('');
          cells[col] = value;
        }
        const line = csvRow(cells);
        if (line) rows.push(line);
      }
    }
    blocks.push(`Sheet: ${name}\n${rows.join('\n')}`.trim());
  }
  return { status: 'ok', text: blocks.join('\n\n'), truncated, sheets: names };
}

// ─── PowerPoint (pptx) ───────────────────────────────────────

async function pptx(zip: Unpacker): Promise<Result> {
  const slides = zip.entries
    .map((e) => ({ name: e.name, n: Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(e.name)?.[1]) }))
    .filter((s) => Number.isFinite(s.n))
    .sort((a, b) => a.n - b.n);
  if (!slides.length && !zip.has('ppt/presentation.xml')) return { status: 'failed', text: '', truncated: false };
  const blocks: string[] = [];
  for (const [i, slide] of slides.entries()) {
    const doc = await zip.xml(slide.name);
    if (!doc) continue;
    const paras = all(doc, 'p').map((p) => all(p, 't').map((t) => t.textContent ?? '').join('').trim()).filter(Boolean);
    blocks.push([`Slide ${i + 1}`, ...paras].join('\n'));
  }
  return { status: 'ok', text: blocks.join('\n\n'), truncated: false };
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

/** Rows of a table:table as cell texts; repeated rows and cells expanded, but only up to the caps. */
function odfTableRows(table: Element, maxRows: number): { rows: string[][]; more: boolean } {
  const rows: string[][] = [];
  let more = false;
  for (const row of all(table, 'table-row')) {
    // Only rows of this table, not of a table nested in a cell.
    let owner: Element | null = row.parentElement;
    while (owner && owner.localName !== 'table') owner = owner.parentElement;
    if (owner !== table) continue;
    const cells: string[] = [];
    for (const cell of kids(row).filter((c) => c.localName === 'table-cell' || c.localName === 'covered-table-cell')) {
      const text = all(cell, 'p').map(odfRuns).join('\n').trim();
      const repeat = Math.max(1, Number(attr(cell, 'number-columns-repeated')) || 1);
      // A run of empty cells to the sheet's edge says "repeated 16384 times".
      const times = text ? Math.min(repeat, 100) : Math.min(repeat, 1000 - cells.length);
      for (let i = 0; i < times && cells.length < 1000; i++) cells.push(text);
    }
    const repeatRows = Math.max(1, Number(attr(row, 'number-rows-repeated')) || 1);
    const empty = cells.every((c) => !c);
    for (let i = 0; i < (empty ? 1 : Math.min(repeatRows, maxRows)); i++) {
      if (rows.length >= maxRows) { more = true; break; }
      rows.push(cells);
    }
    if (more) break;
  }
  return { rows, more };
}

function odfBlocks(el: Element, out: string[]): void {
  for (const c of Array.from(el.children)) {
    if (c.localName === 'p' || c.localName === 'h') out.push(odfRuns(c));
    else if (c.localName === 'table') {
      for (const row of odfTableRows(c, MAX_SHEET_ROWS).rows) {
        const line = row.filter(Boolean).join(' | ');
        if (line) out.push(line);
      }
      out.push('');
    } else if (c.localName !== 'tracked-changes' && c.localName !== 'sequence-decls') odfBlocks(c, out);
  }
}

async function odf(zip: Unpacker, format: 'odt' | 'ods' | 'odp'): Promise<Result> {
  const manifest = await zip.bytes('META-INF/manifest.xml');
  if (manifest && /encryption-data/.test(new TextDecoder('utf-8').decode(manifest))) throw new Encrypted();
  const doc = await zip.xml('content.xml');
  if (!doc) return { status: 'failed', text: '', truncated: false };
  if (format === 'odt') {
    const body = all(doc, 'text')[0];
    const lines: string[] = [];
    if (body) odfBlocks(body, lines);
    return { status: 'ok', text: tidy(lines), truncated: false };
  }
  if (format === 'ods') {
    const sheet = all(doc, 'spreadsheet')[0];
    const tables = sheet ? kids(sheet, 'table') : [];
    const names: string[] = [];
    const blocks: string[] = [];
    let truncated = tables.length > MAX_SHEETS;
    for (const table of tables.slice(0, MAX_SHEETS)) {
      const name = attr(table, 'name') ?? `Sheet ${names.length + 1}`;
      names.push(name);
      const { rows, more } = odfTableRows(table, MAX_SHEET_ROWS);
      if (more) truncated = true;
      const lines = rows.map(csvRow).filter(Boolean);
      blocks.push(`Sheet: ${name}\n${lines.join('\n')}`.trim());
    }
    return { status: 'ok', text: blocks.join('\n\n'), truncated, sheets: names };
  }
  const pres = all(doc, 'presentation')[0];
  const blocks: string[] = [];
  for (const [i, page] of (pres ? kids(pres, 'page') : []).entries()) {
    const paras = all(page, 'p').map((p) => odfRuns(p).trim()).filter(Boolean);
    blocks.push([`Slide ${i + 1}`, ...paras].join('\n'));
  }
  return { status: 'ok', text: blocks.join('\n\n'), truncated: false };
}

// ─── Entry point ─────────────────────────────────────────────

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** True for an OLE compound file: legacy .doc/.xls/.ppt, or an Office file with a password. */
export function isCompoundFile(bytes: Uint8Array): boolean {
  return CFB_MAGIC.every((b, i) => bytes[i] === b);
}

/**
 * The text of an Office file. A password-protected docx, xlsx or pptx is a
 * compound file, not a ZIP: encrypted. `cap` (tests) replaces MAX_INFLATED_BYTES.
 */
export async function officeText(bytes: Uint8Array, format: OfficeFormat, cap = MAX_INFLATED_BYTES): Promise<Result> {
  if (isCompoundFile(bytes)) return { status: 'encrypted', text: '', truncated: false };
  try {
    const file = new Blob([bytes as BlobPart]);
    const zip = new Unpacker(file, await listZipEntries(file), cap);
    switch (format) {
      case 'docx': return await docx(zip);
      case 'xlsx': return await xlsx(zip);
      case 'pptx': return await pptx(zip);
      default: return await odf(zip, format);
    }
  } catch (err) {
    if (err instanceof TooBig) return { status: 'too_big', text: '', truncated: false };
    if (err instanceof Encrypted) return { status: 'encrypted', text: '', truncated: false };
    if (err instanceof ZipFormatError && /Encrypted entry/.test(err.message)) return { status: 'encrypted', text: '', truncated: false };
    return { status: 'failed', text: '', truncated: false };
  }
}
