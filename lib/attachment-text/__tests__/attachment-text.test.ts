import { afterEach, describe, expect, it } from 'vitest';
import { strToU8, zipSync, type Zippable } from 'fflate';
import { extractText, setPdfLoader, textFormatOf, type PdfLib } from '@/lib/attachment-text';
import { officeText } from '@/lib/attachment-text/office';

// Office files are ZIPs of XML: the fixtures are built here, as small as a
// real file of each kind can be while still holding the parts read.

const zip = (files: Record<string, string | Uint8Array>): Uint8Array => {
  const entries: Zippable = {};
  for (const [name, value] of Object.entries(files)) entries[name] = typeof value === 'string' ? strToU8(value) : value;
  return zipSync(entries, { level: 6 });
};

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const DOCX = zip({
  '[Content_Types].xml': '<Types/>',
  'word/document.xml': `<?xml version="1.0"?><w:document ${W}><w:body>
    <w:p><w:r><w:t>Minutes of the meeting</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">Budget: </w:t></w:r><w:r><w:tab/><w:t>4,500 EUR</w:t></w:r><w:del><w:r><w:delText>9,000 EUR</w:delText></w:r></w:del></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Who</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>What</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>Carol</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Press release</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:sectPr/></w:body></w:document>`,
});

const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const xlsxFiles = (rows = 2) => ({
  'xl/workbook.xml': `<workbook ${S}><sheets><sheet name="Figures" sheetId="1" r:id="rId1"/><sheet name="Empty" sheetId="2" r:id="rId2"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
  'xl/sharedStrings.xml': `<sst ${S}><si><t>month</t></si><si><t>visitors</t></si><si><r><t>Aug</t></r><r><t>ust, late</t></r></si></sst>`,
  'xl/worksheets/sheet1.xml': `<worksheet ${S}><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
    ${Array.from({ length: rows - 1 }, (_, i) => `<row r="${i + 2}"><c r="A${i + 2}" t="s"><v>2</v></c><c r="C${i + 2}"><v>${1200 + i}</v></c><c r="D${i + 2}" t="b"><v>1</v></c></row>`).join('')}
  </sheetData></worksheet>`,
  'xl/worksheets/sheet2.xml': `<worksheet ${S}><sheetData/></worksheet>`,
});

const P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const slide = (texts: string[]) => `<p:sld ${P}><p:cSld><p:spTree>${texts.map((t) => `<p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`).join('')}</p:spTree></p:cSld></p:sld>`;
const PPTX = zip({
  'ppt/presentation.xml': `<p:presentation ${P}/>`,
  'ppt/slides/slide10.xml': slide(['Thanks']),
  'ppt/slides/slide2.xml': slide(['Launch plan', 'Codeword PELICAN']),
  'ppt/slides/slide1.xml': slide(['Welcome']),
});

const O = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"';
const odf = (body: string, extra: Record<string, string> = {}) => zip({
  mimetype: 'application/vnd.oasis.opendocument.text',
  'META-INF/manifest.xml': '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>',
  'content.xml': `<office:document-content ${O}><office:body>${body}</office:body></office:document-content>`,
  ...extra,
});
const ODT = odf('<office:text><text:h>Report</text:h><text:p>Two<text:s text:c="3"/>spaces<text:tab/>and a<text:line-break/>break<text:note><text:note-body><text:p>a footnote</text:p></text:note-body></text:note></text:p></office:text>');
const ODS = odf(`<office:spreadsheet><table:table table:name="Budget">
  <table:table-row><table:table-cell><text:p>item</text:p></table:table-cell><table:table-cell><text:p>cost</text:p></table:table-cell></table:table-row>
  <table:table-row table:number-rows-repeated="2"><table:table-cell><text:p>ads, print</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"><text:p>4500</text:p></table:table-cell></table:table-row>
  <table:table-row table:number-rows-repeated="1048570"><table:table-cell table:number-columns-repeated="16384"/></table:table-row>
</table:table></office:spreadsheet>`);
const ODP = odf('<office:presentation><draw:page draw:name="p1"><draw:frame><draw:text-box><text:p>Hello slide</text:p></draw:text-box></draw:frame></draw:page><draw:page draw:name="p2"><draw:frame><draw:text-box><text:p>Second</text:p></draw:text-box></draw:frame></draw:page></office:presentation>');

const text = (s: string) => new TextEncoder().encode(s);

afterEach(() => setPdfLoader());

describe('textFormatOf', () => {
  it('goes by the extension first, then the media type', () => {
    expect(textFormatOf('notes.TXT', 'application/octet-stream')).toBe('text');
    expect(textFormatOf('report', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('docx');
    expect(textFormatOf('x.ods', '')).toBe('ods');
    expect(textFormatOf('', 'text/x-python')).toBe('text');
    expect(textFormatOf('old.doc', 'application/msword')).toBe('other');
    expect(textFormatOf('photo.jpg', 'image/jpeg')).toBe('other');
  });
});

describe('plain formats', () => {
  it('reads text in UTF-8 and Windows-1252 and keeps CSV as it is', async () => {
    expect(await extractText(text('Grüße\r\nfrom Bob'), { name: 'a.txt' })).toMatchObject({ format: 'text', status: 'ok', text: 'Grüße\nfrom Bob', truncated: false });
    expect((await extractText(new Uint8Array([0x47, 0x72, 0xfc, 0xdf, 0x65]), { name: 'a.txt' })).text).toBe('Grüße');
    expect(await extractText(text('month,visitors\nAugust,1200\n'), { name: 'figures.csv' })).toMatchObject({ format: 'csv', text: 'month,visitors\nAugust,1200' });
  });

  it('turns HTML into text', async () => {
    const out = await extractText(text('<html><body><h1>Agenda</h1><p>Launch <b>plan</b></p><script>alert(1)</script><img alt="logo"></body></html>'), { type: 'text/html' });
    expect(out.status).toBe('ok');
    expect(out.text).toContain('Agenda');
    expect(out.text).toContain('Launch plan');
    expect(out.text).toContain('[Image: logo]');
    expect(out.text).not.toContain('alert');
  });

  it('writes one line per event of a calendar file', async () => {
    const ics = [
      'BEGIN:VCALENDAR', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'SUMMARY:Launch review\\, part 2',
      'DTSTART;TZID=Europe/Berlin:20261105T090000', 'DTEND;TZID=Europe/Berlin:20261105T100000',
      'LOCATION:Room 4', 'ORGANIZER;CN="Bob, the boss":mailto:bob@example.org', 'DESCRIPTION:Bring the', ' figures', 'END:VEVENT',
      'BEGIN:VEVENT', 'SUMMARY:Holiday', 'DTSTART;VALUE=DATE:20261224', 'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n');
    const out = await extractText(text(ics), { name: 'invite.ics' });
    expect(out.text).toBe([
      'event: Launch review, part 2, 2026-11-05 09:00 (Europe/Berlin), 2026-11-05 10:00 (Europe/Berlin), Room 4, organiser Bob, the boss <bob@example.org>',
      '  Bring thefigures',
      'event: Holiday, 2026-12-24',
    ].join('\n'));
  });

  it('writes name, addresses, phones and organisation of an address card', async () => {
    const vcf = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Carol Example\r\nN:Example;Carol;;;\r\nEMAIL;TYPE=work:carol@example.org\r\nTEL;TYPE=cell:+49 170 123\r\nORG:Example GmbH\r\nEND:VCARD\r\n';
    const out = await extractText(text(vcf), { name: 'carol.vcf' });
    expect(out.status).toBe('ok');
    expect(out.text).toContain('contact: Carol Example');
    expect(out.text).toContain('email: carol@example.org');
    expect(out.text).toContain('phone: +49 170 123');
    expect(out.text).toContain('organisation: Example GmbH');
  });

  it('cuts at maxChars and says so', async () => {
    const out = await extractText(text('word '.repeat(100)), { name: 'a.txt', maxChars: 42 });
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(42);
    expect(out.text.endsWith('word')).toBe(true);
  });

  it('answers no_text for an empty file and unsupported for binary bytes and images', async () => {
    expect((await extractText(text('  \n'), { name: 'a.txt' })).status).toBe('no_text');
    expect((await extractText(new Uint8Array([1, 0, 2, 0]), { name: 'a.txt' })).status).toBe('unsupported');
    expect((await extractText(new Uint8Array([0xff, 0xd8, 0xff]), { name: 'a.jpg', type: 'image/jpeg' })).status).toBe('unsupported');
  });

  it('refuses a file over 20 MB without reading it', async () => {
    expect(await extractText(new Uint8Array(20 * 1024 * 1024 + 1), { name: 'a.txt' })).toMatchObject({ status: 'too_big', text: '' });
  });
});

describe('Office files', () => {
  it('reads a docx: paragraphs, tabs, tables, no deleted text', async () => {
    const out = await extractText(DOCX, { name: 'minutes.docx' });
    expect(out).toMatchObject({ format: 'docx', status: 'ok' });
    expect(out.text).toBe('Minutes of the meeting\nBudget: \t4,500 EUR\nWho | What\nCarol | Press release');
  });

  it('reads an xlsx sheet by sheet as CSV rows, shared strings resolved, columns kept', async () => {
    const out = await extractText(zip(xlsxFiles()), { name: 'figures.xlsx' });
    expect(out).toMatchObject({ format: 'xlsx', status: 'ok', truncated: false, sheets: ['Figures', 'Empty'] });
    expect(out.text).toBe('Sheet: Figures\nmonth,visitors\n"August, late",,1200,TRUE\n\nSheet: Empty');
  });

  it('reads at most 2,000 rows of a sheet', async () => {
    const out = await extractText(zip(xlsxFiles(2005)), { name: 'big.xlsx', maxChars: 100_000 });
    expect(out.truncated).toBe(true);
    expect(out.text.split('\n').filter((l) => l.startsWith('"August')).length).toBe(1999);
  });

  it('reads a pptx slide by slide in their order', async () => {
    const out = await extractText(PPTX, { name: 'deck.pptx' });
    expect(out.text).toBe('Slide 1\nWelcome\n\nSlide 2\nLaunch plan\nCodeword PELICAN\n\nSlide 3\nThanks');
  });

  it('reads odt, ods and odp', async () => {
    expect((await extractText(ODT, { name: 'r.odt' })).text).toBe('Report\nTwo   spaces\tand a\nbreak');
    const ods = await extractText(ODS, { name: 'b.ods' });
    expect(ods).toMatchObject({ status: 'ok', sheets: ['Budget'] });
    expect(ods.text).toBe('Sheet: Budget\nitem,cost\n"ads, print",4500,4500\n"ads, print",4500,4500');
    expect((await extractText(ODP, { name: 'p.odp' })).text).toBe('Slide 1\nHello slide\n\nSlide 2\nSecond');
  });

  it('refuses a ZIP bomb: stops unpacking past the cap', async () => {
    const bomb = zip({ 'word/document.xml': `<w:document ${W}><w:body><w:p><w:r><w:t>${'A'.repeat(3 * 1024 * 1024)}</w:t></w:r></w:p></w:body></w:document>` });
    expect(bomb.byteLength).toBeLessThan(64 * 1024);
    expect(await officeText(bomb, 'docx', { inflateCap: 1024 * 1024 })).toMatchObject({ status: 'too_big', text: '' });
    // The same file under the real cap is read.
    expect((await officeText(bomb, 'docx')).status).toBe('ok');
  });

  it('answers unsupported for the legacy formats and encrypted for a protected file', async () => {
    const cfb = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    expect((await extractText(cfb, { name: 'old.doc', type: 'application/msword' })).status).toBe('unsupported');
    expect((await extractText(cfb, { name: 'old.xls' })).status).toBe('unsupported');
    // A compound file without an EncryptedPackage stream is a legacy file under a new name (limits.test.ts has the protected one).
    expect((await extractText(cfb, { name: 'secret.docx' })).status).toBe('unsupported');
    const odfLocked = odf('<office:text/>', { 'META-INF/manifest.xml': '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry><manifest:encryption-data/></manifest:file-entry></manifest:manifest>' });
    expect((await extractText(odfLocked, { name: 'secret.odt' })).status).toBe('encrypted');
  });

  it('answers failed for a file that is not a ZIP', async () => {
    expect((await extractText(text('not a zip at all'), { name: 'broken.docx' })).status).toBe('failed');
  });
});

describe('PDF', () => {
  const fakePdf = (pages: string[][], error?: Error): PdfLib => ({
    getDocument: () => ({
      promise: error ? Promise.reject(error) : Promise.resolve({
        numPages: pages.length,
        getPage: async (n: number) => ({
          getTextContent: async () => ({ items: pages[n - 1].map((str, i, all) => ({ str, hasEOL: i < all.length - 1 })) }),
        }),
      }),
      destroy: async () => {},
    }),
  });

  it('reads the text of each page', async () => {
    setPdfLoader(async () => fakePdf([['Workshop agenda', '09:30 Launch plan (codeword PELICAN)'], ['11:00 Budget and the rest of the day']]));
    const out = await extractText(text('%PDF-1.4'), { name: 'agenda.pdf' });
    expect(out).toMatchObject({ format: 'pdf', status: 'ok', pages: 2, truncated: false });
    expect(out.text).toBe('Page 1\nWorkshop agenda\n09:30 Launch plan (codeword PELICAN)\n\nPage 2\n11:00 Budget and the rest of the day');
  });

  it('reads at most 50 pages', async () => {
    setPdfLoader(async () => fakePdf(Array.from({ length: 60 }, (_, i) => [`This is page number ${i + 1} of the report`])));
    const out = await extractText(text('%PDF'), { name: 'long.pdf', maxChars: 100_000 });
    expect(out).toMatchObject({ status: 'ok', pages: 60, truncated: true });
    expect(out.text).toContain('page number 50 ');
    expect(out.text).not.toContain('page number 51 ');
  });

  it('says a scan has no text, and a protected PDF is encrypted', async () => {
    setPdfLoader(async () => fakePdf([[''], ['3'], ['']]));
    expect(await extractText(text('%PDF'), { name: 'scan.pdf' })).toMatchObject({ status: 'no_text', pages: 3, text: '' });
    setPdfLoader(async () => fakePdf([], Object.assign(new Error('No password given'), { name: 'PasswordException' })));
    expect((await extractText(text('%PDF'), { name: 'locked.pdf' })).status).toBe('encrypted');
    setPdfLoader(async () => fakePdf([], new Error('Invalid PDF structure')));
    expect((await extractText(text('%PDF'), { name: 'broken.pdf' })).status).toBe('failed');
  });
});
