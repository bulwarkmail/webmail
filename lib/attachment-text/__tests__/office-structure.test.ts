import { describe, expect, it } from 'vitest';
import { strToU8, zipSync, type Zippable } from 'fflate';
import { extractText } from '@/lib/attachment-text';

// What an Office file means rather than how it is stored: text boxes once,
// moved text once, slides in the order the deck shows them, the main part
// wherever the package says it is, dates as dates.

const zip = (files: Record<string, string>): Uint8Array => {
  const entries: Zippable = {};
  for (const [name, value] of Object.entries(files)) entries[name] = strToU8(value);
  return zipSync(entries);
};

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:v="urn:schemas-microsoft-com:vml"';
const PKG = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
const OFFICE_DOC = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';

describe('Word', () => {
  it('reads a text box once, on its own line, and moved text once', async () => {
    const box = (text: string) => `<w:txbxContent><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:txbxContent>`;
    const doc = zip({
      'word/document.xml': `<w:document ${W}><w:body>
        <w:p><w:r><w:t>Before the box.</w:t></w:r><w:r><mc:AlternateContent>
          <mc:Choice Requires="wps"><w:drawing><wps:wsp><wps:txbx>${box('Box text')}</wps:txbx></wps:wsp></w:drawing></mc:Choice>
          <mc:Fallback><w:pict><v:shape><v:textbox>${box('Box text')}</v:textbox></v:shape></w:pict></mc:Fallback>
        </mc:AlternateContent></w:r></w:p>
        <w:p><w:moveFrom><w:r><w:t>Old place</w:t></w:r></w:moveFrom><w:moveTo><w:r><w:t>New place</w:t></w:r></w:moveTo></w:p>
      </w:body></w:document>`,
    });
    expect((await extractText(doc, { name: 'box.docx' })).text).toBe('Before the box.\nBox text\nNew place');
  });

  it('finds the main part where the package says it is', async () => {
    const doc = zip({
      '_rels/.rels': `<Relationships ${PKG}><Relationship Id="rId1" Type="${OFFICE_DOC}" Target="/word/main.xml"/></Relationships>`,
      'word/main.xml': `<w:document ${W}><w:body><w:p><w:r><w:t>From the main part</w:t></w:r></w:p></w:body></w:document>`,
    });
    expect(await extractText(doc, { name: 'moved.docx' })).toMatchObject({ status: 'ok', text: 'From the main part' });
  });
});

const P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
const shape = (text: string) => `<p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
const slide = (body: string) => `<p:sld ${P}><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`;

describe('PowerPoint', () => {
  it('reads the slides in the order of the deck, not of the files', async () => {
    const deck = zip({
      '_rels/.rels': `<Relationships ${PKG}><Relationship Id="rId1" Type="${OFFICE_DOC}" Target="ppt/presentation.xml"/></Relationships>`,
      'ppt/presentation.xml': `<p:presentation ${P}><p:sldIdLst><p:sldId id="256" r:id="rId8"/><p:sldId id="257" r:id="rId7"/></p:sldIdLst></p:presentation>`,
      'ppt/_rels/presentation.xml.rels': `<Relationships ${PKG}><Relationship Id="rId7" Target="slides/slide1.xml"/><Relationship Id="rId8" Target="slides/slide2.xml"/></Relationships>`,
      'ppt/slides/slide1.xml': slide(shape('Shown second')),
      'ppt/slides/slide2.xml': slide(shape('Shown first')),
    });
    expect((await extractText(deck, { name: 'deck.pptx' })).text).toBe('Slide 1\nShown first\n\nSlide 2\nShown second');
  });

  it('reads a shape with a fallback copy once', async () => {
    const deck = zip({
      'ppt/presentation.xml': `<p:presentation ${P}/>`,
      'ppt/slides/slide1.xml': slide(`<mc:AlternateContent><mc:Choice Requires="p14">${shape('Shape text')}</mc:Choice><mc:Fallback>${shape('Shape text')}</mc:Fallback></mc:AlternateContent>`),
    });
    expect((await extractText(deck, { name: 'deck.pptx' })).text).toBe('Slide 1\nShape text');
  });
});

const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const book = (cells: string, { date1904 = false } = {}) => zip({
  'xl/workbook.xml': `<workbook ${S}>${date1904 ? '<workbookPr date1904="1"/>' : ''}<sheets><sheet name="Dates" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': `<Relationships ${PKG}><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
  'xl/styles.xml': `<styleSheet ${S}><numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy\\ hh:mm"/><numFmt numFmtId="165" formatCode="0.00&quot; days&quot;"/></numFmts>
    <cellXfs count="5"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="20"/></cellXfs></styleSheet>`,
  'xl/worksheets/sheet1.xml': `<worksheet ${S}><sheetData><row r="1">${cells}</row></sheetData></worksheet>`,
});

describe('Excel dates', () => {
  it('writes date cells as ISO dates, by built-in and custom formats', async () => {
    const out = await extractText(book('<c r="A1" s="1"><v>46326</v></c><c r="B1" s="2"><v>46326.5</v></c><c r="C1" s="0"><v>46326</v></c><c r="D1" s="3"><v>46326</v></c><c r="E1" s="4"><v>0.75</v></c>'), { name: 'dates.xlsx' });
    expect(out.text).toBe('Sheet: Dates\n2026-10-31,2026-10-31 12:00,46326,46326,18:00');
  });

  it('counts from 1904 when the workbook says so', async () => {
    const out = await extractText(book('<c r="A1" s="1"><v>44864</v></c>', { date1904: true }), { name: 'mac.xlsx' });
    expect(out.text).toBe('Sheet: Dates\n2026-10-31');
  });
});
