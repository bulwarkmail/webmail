import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import React from 'react';
import type { Editor } from '@tiptap/core';
import { RichTextEditor } from '../rich-text-editor';
import { serializeEditorContent } from '../quoted-html';

// The real WPS shape: the sheet-wide td rule carries Excel's
// "text-align:general" placeholder, which is not a valid CSS value.
const PASTED = `<html><head><style>
td {color:#000000;font-size:12.0pt;text-align:general;vertical-align:middle;}
</style></head><body><table border=1 style='border-collapse:collapse;'>
 <tr><td>Header A</td><td>Header B</td></tr>
 <tr><td>Cell 1</td><td>Cell 2</td></tr>
</table></body></html>`;

async function setup() {
  let editor: Editor | null = null;
  render(<RichTextEditor content="<p></p>" onChange={() => {}} onEditorReady={(e) => { editor = e; }} />);
  await waitFor(() => expect(editor).not.toBeNull());
  return editor as unknown as Editor;
}

describe('invalid text-align from a WPS paste', () => {
  it('never reaches a cell, so a header stays left-aligned in sent mail', async () => {
    const editor = await setup();
    editor.view.pasteHTML(PASTED, new Event('paste') as ClipboardEvent);
    // The placeholder is dropped at paste time: a browser would ignore it
    // anyway, and left in place it blocks the th default from applying.
    expect(editor.getHTML()).not.toMatch(/text-align:\s*general/i);

    let cellPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (cellPos < 0 && node.type.name === 'tableCell') cellPos = pos;
    });
    editor.commands.setTextSelection(cellPos + 1);
    editor.chain().focus().toggleHeaderRowStyled().run();

    const html = serializeEditorContent(editor);
    const th = /<th[^>]*>/.exec(html)?.[0] ?? '';
    // The default header alignment fills in and survives the wire, so the
    // recipient's client does not fall back to the UA th default (centre).
    expect(th).toMatch(/text-align:\s*left/i);
    expect(th).toMatch(/background-color:\s*rgb\(245,\s*245,\s*245\)/i);
    editor.destroy();
  });
});
