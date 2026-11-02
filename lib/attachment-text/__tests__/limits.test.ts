import { describe, expect, it } from 'vitest';
import { strToU8, zipSync, type Zippable } from 'fflate';
import { clipText, extractText } from '@/lib/attachment-text';
import { officeText } from '@/lib/attachment-text/office';

// The limits of the text extraction: whatever the file says, a read stays
// within its character budget, a sheet within its caps, an XML part within
// its size, and nothing a file names (a DTD) is followed.

const zip = (files: Record<string, string>): Uint8Array => {
  const entries: Zippable = {};
  for (const [name, value] of Object.entries(files)) entries[name] = strToU8(value);
  return zipSync(entries, { level: 9 });
};

const O = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"';
const ods = (tables: string) => zip({
  mimetype: 'application/vnd.oasis.opendocument.spreadsheet',
  'content.xml': `<office:document-content ${O}><office:body><office:spreadsheet>${tables}</office:spreadsheet></office:body></office:document-content>`,
});
const odsTable = (name: string, rows: string) => `<table:table table:name="${name}">${rows}</table:table>`;
const odsRow = (cells: string[], repeat = 1) => `<table:table-row table:number-rows-repeated="${repeat}">${cells.map((c) => `<table:table-cell><text:p>${c}</text:p></table:table-cell>`).join('')}</table:table-row>`;

const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const xlsx = (sheets: string[], shared: string[] = []) => zip({
  'xl/workbook.xml': `<workbook ${S}><sheets>${sheets.map((_, i) => `<sheet name="S${i + 1}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
  'xl/sharedStrings.xml': `<sst ${S}>${shared.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`,
  ...Object.fromEntries(sheets.map((rows, i) => [`xl/worksheets/sheet${i + 1}.xml`, `<worksheet ${S}><sheetData>${rows}</sheetData></worksheet>`])),
});

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const docx = (body: string, prolog = '') => zip({ 'word/document.xml': `${prolog}<w:document ${W}><w:body>${body}</w:body></w:document>` });

describe('the character budget', () => {
  it('stops a tiny ODS that repeats a cell 100 × 2,000 times at the budget', async () => {
    // One 100-character cell, repeated across 100 columns and 2,000 rows:
    // without a budget that makes 20 million characters out of a few hundred
    // bytes (200 million with a 1,000-character cell).
    const bomb = ods(odsTable('Bomb', `<table:table-row table:number-rows-repeated="2000"><table:table-cell table:number-columns-repeated="100"><text:p>${'x'.repeat(100)}</text:p></table:table-cell></table:table-row>`));
    expect(bomb.byteLength).toBeLessThan(1024);
    const out = await officeText(bomb, 'ods', { budget: 5_000 });
    expect(out.status).toBe('ok');
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(5_000);
    const read = await extractText(bomb, { name: 'bomb.ods', maxChars: 3_000 });
    expect(read.text.length).toBeLessThanOrEqual(3_000);
    expect(read.truncated).toBe(true);
  });

  it('stops an xlsx whose cells all point at one big shared string, and caps a cell', async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="s"><v>0</v></c></row>`).join('');
    const file = xlsx([rows], ['y'.repeat(50_000)]);
    const out = await officeText(file, 'xlsx', { budget: 20_000 });
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(20_000);
    const firstRow = (await extractText(file, { name: 'big.xlsx', maxChars: 100_000 })).text.split('\n')[1];
    expect(firstRow.length).toBeLessThanOrEqual(4_000);
  });

  it('stops a long Word file at the budget', async () => {
    const long = docx(Array.from({ length: 5000 }, (_, i) => `<w:p><w:r><w:t>Paragraph ${i} with some words in it.</w:t></w:r></w:p>`).join(''));
    const out = await officeText(long, 'docx', { budget: 1_000 });
    expect(out).toMatchObject({ status: 'ok', truncated: true });
    expect(out.text.length).toBeLessThanOrEqual(1_000);
  });
});

describe('sheet caps', () => {
  it('reads at most 5 sheets of an xlsx and of an ods, and says so', async () => {
    const x = await extractText(xlsx(Array.from({ length: 7 }, () => '<row r="1"><c r="A1"><v>1</v></c></row>')), { name: 'many.xlsx' });
    expect(x).toMatchObject({ status: 'ok', truncated: true, sheets: ['S1', 'S2', 'S3', 'S4', 'S5'] });
    const o = await extractText(ods(Array.from({ length: 7 }, (_, i) => odsTable(`T${i + 1}`, odsRow(['1']))).join('')), { name: 'many.ods' });
    expect(o).toMatchObject({ status: 'ok', truncated: true, sheets: ['T1', 'T2', 'T3', 'T4', 'T5'] });
  });

  it('reads at most 2,000 rows of an ods sheet', async () => {
    const out = await extractText(ods(odsTable('Rows', Array.from({ length: 2005 }, (_, i) => odsRow([`r${i}`])).join(''))), { name: 'rows.ods', maxChars: 100_000 });
    expect(out.truncated).toBe(true);
    expect(out.text.split('\n').filter((l) => /^r\d+$/.test(l))).toHaveLength(2000);
  });
});

describe('what a file may not do', () => {
  it('answers too_big for one XML part over the part cap', async () => {
    const big = docx(`<w:p><w:r><w:t>${'z'.repeat(200_000)}</w:t></w:r></w:p>`);
    expect((await officeText(big, 'docx', { partCap: 100_000 })).status).toBe('too_big');
    expect((await officeText(big, 'docx')).status).toBe('ok');
  });

  it('refuses an Office XML part with a DTD', async () => {
    const dtd = docx('<w:p><w:r><w:t>&a;&a;&a;</w:t></w:r></w:p>', '<?xml version="1.0"?><!DOCTYPE w:document [<!ENTITY a "aaaaaaaaaa">]>');
    expect(await extractText(dtd, { name: 'dtd.docx' })).toMatchObject({ status: 'failed', text: '' });
  });

  it('answers encrypted for a ZIP entry with the encryption flag', async () => {
    const file = docx('<w:p><w:r><w:t>secret</w:t></w:r></w:p>');
    // Set bit 0 of the general purpose flag in the central directory entry.
    for (let i = file.length - 22; i >= 0; i--) {
      if (file[i] === 0x50 && file[i + 1] === 0x4b && file[i + 2] === 0x01 && file[i + 3] === 0x02) { file[i + 8] |= 1; break; }
    }
    expect((await extractText(file, { name: 'locked.docx' })).status).toBe('encrypted');
  });

  it('answers failed for a docx without its document part', async () => {
    expect((await extractText(zip({ '[Content_Types].xml': '<Types/>' }), { name: 'empty.docx' })).status).toBe('failed');
  });

  it('tells a password-protected Office file from a legacy one under a new name', async () => {
    const cfb = (extra: number[]) => new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Array(64).fill(0), ...extra]);
    const utf16 = (s: string) => [...s].flatMap((c) => [c.charCodeAt(0), 0]);
    expect((await extractText(cfb(utf16('EncryptedPackage')), { name: 'locked.docx' })).status).toBe('encrypted');
    expect((await extractText(cfb(utf16('WordDocument')), { name: 'renamed.docx' })).status).toBe('unsupported');
  });

  it('answers unsupported for a message file instead of its raw MIME', async () => {
    const eml = new TextEncoder().encode('From: a@example.org\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\nSGVsbG8=\r\n');
    expect((await extractText(eml, { name: 'forwarded.eml', type: 'message/rfc822' })).status).toBe('unsupported');
  });
});

describe('maxChars', () => {
  const words = (n: number) => new TextEncoder().encode('word '.repeat(n));

  it('is at most 100,000 even when a caller asks for more', async () => {
    const out = await extractText(words(30_000), { name: 'a.txt', maxChars: 500_000 });
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(100_000);
  });

  it('falls back to 20,000 for a value that is not a number', async () => {
    const out = await extractText(words(10_000), { name: 'a.txt', maxChars: Number.NaN });
    expect(out.text.length).toBeGreaterThan(19_000);
    expect(out.text.length).toBeLessThanOrEqual(20_000);
  });

  it('never cuts a character in half', () => {
    const out = clipText(`${'a'.repeat(9)}😀b`, 10);
    expect(out).toEqual({ text: 'aaaaaaaaa', truncated: true });
  });
});
