import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

import {
  inlineClipboardStyles,
  StyledTable,
  StyledTableRow,
  StyledTableHeader,
  StyledTableCell,
  TablePaste,
} from '../table-paste';

// Trimmed from what Excel 365 on Windows puts on the clipboard for a table
// with a bold, red-headed column and a right-aligned numeric column.
const EXCEL_HTML = `<html xmlns:o="urn:schemas-microsoft-com:office:office"
xmlns:x="urn:schemas-microsoft-com:office:excel">
<head><meta name=ProgId content=Excel.Sheet><meta name=Generator content="Microsoft Excel 15">
<style>
<!--table
{mso-displayed-decimal-separator:".";
mso-displayed-thousand-separator:",";}
.xl65{font-weight:700;color:WindowText;}
.xl66{background:#FFC7CE;}
td{padding-top:1px;padding-right:1px;}
-->
</style></head>
<body link="#0563C1" vlink="#954F72">
<table border=0 cellpadding=0 cellspacing=0 width=128 style='border-collapse:collapse;width:96pt'>
<col width=64 span=2 style='width:48pt'>
<tr height=20 style='height:15.0pt'>
<!--StartFragment-->
  <td height=20 class=xl65 width=64 style='height:15.0pt;width:48pt'>Name</td>
  <td class=xl66 bgcolor="#DDDDDD" width=64 style='width:48pt'>Qty</td>
 </tr>
 <tr height=20 style='height:15.0pt'>
  <td height=20 style='height:15.0pt'>Apples</td>
  <td align=right>3</td>
<!--EndFragment-->
 </tr>
</table>
</body>
</html>`;

describe('inlineClipboardStyles', () => {
  it('moves class rules and legacy attributes onto the elements as inline styles', () => {
    const html = inlineClipboardStyles(EXCEL_HTML);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const cells = Array.from(doc.querySelectorAll('td'));

    expect(cells[0].getAttribute('class')).toBeNull();
    expect(cells[0].style.fontWeight).toBe('700');
    // The td rule survives; the spreadsheet's own width pin stays so the
    // column keeps its grid size (height, a row property, stays too).
    expect(cells[0].style.paddingTop).toBe('1px');
    expect(cells[0].getAttribute('style')).toMatch(/width:\s*48pt/i);
    expect(cells[0].style.height).toBe('15pt');
    // No nowrap is injected: a cell that wrapped in the source wraps again.
    expect(cells[0].style.whiteSpace).toBe('');
    // The pasted table carries its own fixed layout: the editor stylesheet
    // pins .tiptap table to fixed/100% too, but the inline style is what the
    // sent mail renders, and fixed is what makes the colgroup widths bind.
    expect(doc.querySelector('table')!.style.tableLayout).toBe('fixed');
    // The spreadsheet's col widths stay: they become the schema's colwidth,
    // which the column-resize handles edit. (span=2 is expanded to two cols.)
    const cols = doc.querySelectorAll('col');
    expect(cols.length).toBe(2);
    expect(cols[0].getAttribute('width')).toBe('64');
    expect(cols[1].getAttribute('width')).toBe('64');
    expect(cells[1].style.backgroundColor).toMatch(/#ffc7ce|rgb/i);
    // bgcolor maps to background-color, class rule first, attribute second.
    expect(cells[1].style.backgroundColor).toBeTruthy();
    // Legacy align=right maps to a style the schema's align parser reads.
    expect(cells[3].style.textAlign).toBe('right');
  });
  it('drops declarations outside the property whitelist and dangerous values', () => {
    const html = inlineClipboardStyles(
      `<html><head><style>
      td { font-weight: 700; position: fixed; background: url(https://tracker.example/pixel.png); }
      .evil { behavior: url(#default#time2); color: red; }
      </style></head><body>
      <table><tr><td class="evil" style="color: blue">x</td></tr></table>
      </body></html>`,
    );
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const td = doc.querySelector('td')!;
    expect(td.style.fontWeight).toBe('700');
    expect(td.style.position).toBe('');
    expect(td.style.background).toBe('');
    expect(td.getAttribute('style')).not.toMatch(/behavior|url\(/i);
    // The own inline style still wins over the class rule.
    expect(td.style.color).toBe('blue');
  });

  it('returns non-table HTML and tables without a style block unchanged', () => {
    const plain = '<p>hello</p>';
    expect(inlineClipboardStyles(plain)).toBe(plain);
    const bare = '<table><tr><td>a</td></tr></table>';
    const result = inlineClipboardStyles(bare);
    expect(result).toContain('<td');
    // Nothing to inline, no legacy attributes: only whitespace-level changes.
    expect(new DOMParser().parseFromString(result, 'text/html').querySelector('td')!.textContent).toBe('a');
  });

  it('pins pasted tables to the source grid: fixed layout, no nowrap', () => {
    const html = inlineClipboardStyles(`<html><head><meta name=ProgId content=Excel.Sheet>
<style><!--td{white-space:nowrap;}--></style></head><body>
<table style='table-layout:fixed;width:300pt'>
<tr><td class=xl65 style='white-space:nowrap'>a long cell value</td><td>x</td></tr>
</table></body></html>`);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // The spreadsheet's grid is the source's format: the table keeps a fixed
    // layout (only the table-level width pin goes - the colgroup/cell widths
    // carry the grid), and the cell's own nowrap is stripped so long text
    // wraps at its column instead of spilling into the next cell.
    expect(doc.querySelector('table')!.style.tableLayout).toBe('fixed');
    expect(doc.querySelector('table')!.getAttribute('style')).not.toMatch(/width/i);
    expect(doc.querySelector('td')!.style.whiteSpace).toBe('');
  });

  it('keeps the spreadsheet column widths so the grid binds in mail', () => {
    const html = inlineClipboardStyles(`<html><head><meta name=ProgId content=Excel.Sheet></head><body>
<table style='border-collapse:collapse;width:300pt'>
<col width=100><col width=300>
<tr><td style='width:48pt'>a long cell value</td><td>x</td></tr>
</table></body></html>`);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // The table width pin goes, but the col widths and the cell's own width
    // stay: they are the grid the fixed layout binds to (and the schema's
    // colwidth, which the resize handles edit).
    expect(doc.querySelector('table')!.getAttribute('style')).not.toMatch(/width/i);
    const cols = doc.querySelectorAll('col');
    expect(cols[0].getAttribute('width')).toBe('100');
    expect(cols[1].getAttribute('width')).toBe('300');
    expect(doc.querySelector('td')!.getAttribute('style')).toMatch(/width:\s*48pt/i);
    expect(doc.querySelector('td')!.style.whiteSpace).toBe('');
  });

  it('normalizes a bare fixed-layout table even without a style block or ProgId', () => {
    const html = '<table style="table-layout:fixed"><tr><td style="white-space:nowrap">t</td></tr></table>';
    const doc = new DOMParser().parseFromString(inlineClipboardStyles(html), 'text/html');
    expect(doc.querySelector('table')!.style.tableLayout).toBe('fixed');
    expect(doc.querySelector('td')!.style.whiteSpace).toBe('');
  });
});

describe('pasting an Office table into the composer', () => {
  // The composer's own configure() options, so the static fallback styling
  // (borders/padding for tables without their own) is part of the test.
  function makeEditor() {
    return new Editor({
      element: document.createElement('div'),
      extensions: [
        StarterKit,
        StyledTable.configure({
          resizable: true,
          HTMLAttributes: {
            border: "1",
            cellpadding: "6",
            cellspacing: "0",
            width: "100%",
            style: "width:100%;border-collapse:collapse;",
          },
        }),
        StyledTableRow,
        StyledTableHeader.configure({
          HTMLAttributes: {
            style: "padding:6px 8px;border:1px solid #ccc;background-color:#f5f5f5;color:#1f2937;text-align:left;",
          },
        }),
        StyledTableCell.configure({
          HTMLAttributes: {
            style: "padding:6px 8px;border:1px solid #ccc;vertical-align:top;",
          },
        }),
        TablePaste,
      ],
      content: '<p></p>',
    });
  }

  it('keeps the cells and their styling', () => {
    const editor = makeEditor();
    editor.view.pasteHTML(EXCEL_HTML, new Event('paste') as ClipboardEvent);

    const table = editor.view.dom.querySelector('table');
    expect(table).not.toBeNull();
    const cells = Array.from(table!.querySelectorAll('td, th')).map((c) => c.textContent);
    expect(cells).toEqual(['Name', 'Qty', 'Apples', '3']);

    // Table-level style survives the parse (jsdom normalizes hex to rgb),
    // and the pasted table's inline fixed layout is what the sent mail
    // renders without the editor stylesheet.
    expect(table!.getAttribute('style')).toMatch(/border-collapse/i);
    expect(table!.style.tableLayout).toBe('fixed');
    // Cell-level style from the class rule and the own inline style; the
    // spreadsheet's width pin stays so the column keeps its grid size, and
    // no nowrap is injected, so wrapped source cells wrap again.
    expect(cells.length && table!.querySelectorAll('td')[0].style.fontWeight).toBe('700');
    expect(table!.querySelectorAll('td')[0].getAttribute('style')).toMatch(/width:\s*48pt/i);
    expect(table!.querySelectorAll('td')[0].style.whiteSpace).toBe('');
    expect(table!.querySelectorAll('td')[1].getAttribute('style')).toMatch(/background/i);
    // Column widths come through the colgroup: the <col> widths parsed into
    // the schema's colwidth and are rendered back as col elements.
    const cols = table!.querySelectorAll('col');
    expect(cols.length).toBeGreaterThanOrEqual(2);
    expect(cols[0].style.width).toBe('64px');
    expect(cols[1].style.width).toBe('64px');
    editor.destroy();
  });

  it('keeps a wrapped source cell wrapping at its column', () => {
    const editor = makeEditor();
    // A 64px column holding text that only fits when wrapped: the column
    // keeps the source's width (the cell's colwidth) and carries no nowrap,
    // so the text wraps at 64px exactly as it did in the spreadsheet.
    editor.view.pasteHTML(
      `<html><head><meta name=ProgId content=Excel.Sheet></head><body><table>
      <col width=64><col width=64>
      <tr><td>a cell with text far too long for one line</td><td>x</td></tr>
      </table></body></html>`,
      new Event('paste') as ClipboardEvent,
    );
    const row = editor.state.doc.firstChild!.firstChild!;
    expect(row.child(0).attrs.colwidth).toEqual([64]);
    expect(row.child(1).attrs.colwidth).toEqual([64]);
    const td = editor.view.dom.querySelector('td')!;
    expect(td.style.whiteSpace).toBe('');
    editor.destroy();
  });

  it('honours column resizing on a pasted table', () => {
    const editor = makeEditor();
    editor.view.pasteHTML(EXCEL_HTML, new Event('paste') as ClipboardEvent);
    expect(editor.view.dom.querySelector('table')!.querySelectorAll('col')[0].style.width).toBe('64px');

    // The resize plugin drags by writing colwidth on every cell of the
    // column, in every row (a column-wide change also keeps prosemirror's
    // fixTables from "repairing" it back); under the fixed layout the
    // colgroup follows and the drag visibly takes effect. (With
    // table-layout: auto this was a no-op: the col width was only a
    // suggestion the content could outvote.)
    const tr = editor.state.tr;
    editor.state.doc.descendants((node, pos, parent, index) => {
      if (parent?.type.name === 'tableRow' && index === 0) {
        tr.setNodeMarkup(pos, null, { ...node.attrs, colwidth: [120] });
      }
    });
    editor.view.dispatch(tr);
    // Re-query: the view may rebuild the table's node view around the edit.
    const cols = editor.view.dom.querySelector('table')!.querySelectorAll('col');
    expect(cols[0].style.width).toBe('120px');
    // And the serialization (what a resize leaves in the sent mail) follows.
    expect(editor.getHTML()).toMatch(/<col[^>]*style="[^"]*width:\s*120px/i);
    editor.destroy();
  });

  it('serializes the styling back out for sending', () => {
    const editor = makeEditor();
    editor.view.pasteHTML(EXCEL_HTML, new Event('paste') as ClipboardEvent);

    const html = editor.getHTML();
    expect(html).toMatch(/<table[^>]*style="[^"]*border-collapse/i);
    expect(html).toMatch(/<table[^>]*style="[^"]*table-layout:\s*fixed/i);
    expect(html).toMatch(/<td[^>]*style="[^"]*font-weight/i);
    // The sent mail keeps the grid: colgroup widths inline (no editor
    // stylesheet to lean on), and no nowrap stretching cells to one line.
    expect(html).toMatch(/<col[^>]*style="[^"]*width:\s*64px/i);
    expect(html).not.toMatch(/white-space:\s*nowrap/i);
    editor.destroy();
  });

  it('renders a plain inserted table with the default styling intact', () => {
    const editor = makeEditor();
    editor.commands.setContent('<table><tr><th>H</th></tr><tr><td>a</td></tr></table>');
    const td = editor.view.dom.querySelector('td')!;
    expect(td.getAttribute('style')).toMatch(/border/i);
    expect(td.getAttribute('style')).toMatch(/padding/i);
    editor.destroy();
  });

  it('keeps merged cells together with their style (addAttributes must not drop colspan)', () => {
    const editor = makeEditor();
    editor.commands.setContent(
      '<table><tr><td colspan="2" rowspan="2" style="background-color: #ffecb3">a</td><td>b</td></tr>'
      + '<tr><td>c</td></tr></table>',
    );
    const merged = editor.state.doc.firstChild!.firstChild!.firstChild!;
    expect(merged.attrs.colspan).toBe(2);
    expect(merged.attrs.rowspan).toBe(2);
    expect(merged.attrs.style).toMatch(/background-color/i);
    editor.destroy();
  });
});
