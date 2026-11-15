import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import React from 'react';
import type { Editor } from '@tiptap/core';
// Top-level ESM import: require() would load the CJS copy and hand back a
// different CellSelection class than the one the editor uses.
import { CellSelection } from 'prosemirror-tables';

import { RichTextEditor } from '../rich-text-editor';

// End-to-end at the component level: the composer's real extension set
// (all ~100 plugins, the real configure() options), not the hand-built
// editor of table-paste.test.ts. Guards the registration itself: a pasted
// Office table must parse as native table nodes with the source grid, and
// the column-width transaction the resize plugin dispatches must reach the
// DOM and the serialization. (The mouse-event chain - handle activation,
// dragging - needs a real layout engine and is covered by manual testing.)

const EXCEL_HTML = `<html xmlns:o="urn:schemas-microsoft-com:office:office">
<head><meta name=ProgId content=Excel.Sheet>
<style><!--
.xl65{font-weight:700;color:WindowText;}
td{padding-top:1px;padding-right:1px;border:none;}
--></style></head>
<body>
<table border=0 cellpadding=0 cellspacing=0 width=128 style='border-collapse:collapse;width:96pt'>
<col width=64 span=2 style='width:48pt'>
<tr height=20 style='height:15.0pt'>
  <td height=20 class=xl65 width=64 style='height:15.0pt;width:48pt'>Name</td>
  <td class=xl65 width=64 style='width:48pt'>Qty</td>
 </tr>
</table>
</body>
</html>`;

async function setup() {
  let editor: Editor | null = null;
  render(<RichTextEditor content="<p></p>" onChange={() => {}} onEditorReady={(e) => { editor = e; }} />);
  await waitFor(() => expect(editor).not.toBeNull());
  return editor as unknown as Editor & { destroy(): void };
}

describe('pasting an Office table into the real composer', () => {
  it('parses as native table nodes carrying the source grid and styles', async () => {
    const editor = await setup();
    editor.view.pasteHTML(EXCEL_HTML, new Event('paste') as ClipboardEvent);

    const table = editor.state.doc.firstChild;
    expect(table?.type.name).toBe('table');
    expect(table?.attrs.style).toMatch(/table-layout:\s*fixed/i);
    const cell = table?.firstChild?.firstChild;
    expect(cell?.type.name).toBe('tableCell');
    expect(cell?.attrs.colwidth).toEqual([64]);
    // The class-rule styling reached the cell (and will reach the sent mail).
    expect(cell?.attrs.style).toMatch(/font-weight:\s*700/i);

    // span=2 was expanded: two cols, both carrying the grid width.
    const cols = editor.view.dom.querySelectorAll('col');
    expect(Array.from(cols).map((c) => c.style.width)).toEqual(['64px', '64px']);
    editor.destroy();
  });

  it('applies and clears cell background colour through the composer command', async () => {
    const editor = await setup();
    editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: false });
    // A cell selection across all four cells - what selecting the table in
    // the composer produces.
    const cellPositions: number[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'tableCell') cellPositions.push(pos);
    });
    editor.view.dispatch(
      editor.state.tr.setSelection(
        CellSelection.create(editor.state.doc, cellPositions[0], cellPositions[3]),
      ),
    );
    editor.commands.setCellBackground('#fff2cc');

    expect(cellStyles(editor)).toHaveLength(4);

    // It round-trips into the sent-mail HTML (jsdom serializes the colour
    // as rgb()).
    expect(editor.getHTML()).toMatch(/background-color:\s*rgb\(255,\s*242,\s*204\)/i);

    // null clears it back off the style attribute.
    editor.commands.setCellBackground(null);
    expect(editor.getHTML()).not.toMatch(/background/i);
    editor.destroy();
  });

  const cellStyles = (editor: Editor) => {
    const styles: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'tableCell') styles.push(node.attrs.style ?? '');
    });
    return styles.filter((s) => /background-color:\s*#fff2cc/i.test(s));
  };

  it('follows the column-width transaction the resize drag dispatches', async () => {
    const editor = await setup();
    editor.view.pasteHTML(EXCEL_HTML, new Event('paste') as ClipboardEvent);

    // What prosemirror-tables' mouseup does: colwidth on the first cell of
    // the column, in every row. Under the inline fixed layout the DOM
    // colgroup and the serialized HTML follow.
    const tr = editor.state.tr;
    editor.state.doc.descendants((node, pos, parent, index) => {
      if (parent?.type.name === 'tableRow' && index === 0) {
        tr.setNodeMarkup(pos, null, { ...node.attrs, colwidth: [120] });
      }
    });
    editor.view.dispatch(tr);
    expect(Array.from(editor.view.dom.querySelectorAll('col')).map((c) => c.style.width))
      .toEqual(['120px', '64px']);
    expect(editor.getHTML()).toMatch(/<col[^>]*style="[^"]*width:\s*120px/i);
    editor.destroy();
  });
});
