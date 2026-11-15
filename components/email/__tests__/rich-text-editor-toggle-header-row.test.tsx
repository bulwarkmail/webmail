import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import React from 'react';
import type { Editor } from '@tiptap/core';
import { RichTextEditor } from '../rich-text-editor';

// A pasted table the way the clipboard parser leaves it: every cell is a
// plain td with its colours inlined on the style attribute, so an inline
// colour beats the th default the StyledTableHeader HTMLAttributes add.
const PLAIN = `<html><body><table border=1 style='border-collapse:collapse;'>
 <tr><td style='color:#000000;background-color:#ffffff;padding:6px;'>Header A</td>
     <td style='color:#000000;background-color:#ffffff;padding:6px;'>Header B</td></tr>
 <tr><td style='color:#000000;background-color:#ffffff;'>Cell 1</td>
     <td style='color:#000000;background-color:#ffffff;'>Cell 2</td></tr>
</table></body></html>`;

// The WPS shape: a first row that is white text on a dark background.
const COLOURED = `<html><body><table border=1 style='border-collapse:collapse;'>
 <tr><td style='color:#ffffff;background-color:#595959;'>Title</td></tr>
 <tr><td style='color:#000000;background-color:#ffffff;'>Cell 1</td></tr>
</table></body></html>`;

// A bold pasted header: WPS inlines font-weight:700, which the Bold
// extension also parses into a bold mark on the text.
const BOLD = `<html><body><table border=1 style='border-collapse:collapse;'>
 <tr><td style='color:#000000;font-weight:700;'>Title</td></tr>
 <tr><td style='color:#000000;'>Cell 1</td></tr>
</table></body></html>`;

async function setup() {
  let editor: Editor | null = null;
  render(<RichTextEditor content="<p></p>" onChange={() => {}} onEditorReady={(e) => { editor = e; }} />);
  await waitFor(() => expect(editor).not.toBeNull());
  return editor as unknown as Editor;
}

const paste = (editor: Editor, html: string) => {
  editor.view.pasteHTML(html, new Event('paste') as ClipboardEvent);
  // Cursor into the table.
  let cellPos = -1;
  editor.state.doc.descendants((node, pos) => {
    if (cellPos < 0 && (node.type.name === 'tableCell' || node.type.name === 'tableHeader')) cellPos = pos;
  });
  editor.commands.setTextSelection(cellPos + 1);
};

const firstRow = (editor: Editor) => {
  let row: Array<{ tag: string; style: string }> = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'tableRow' && row.length === 0) {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child.type.name === 'tableHeader' || child.type.name === 'tableCell') {
          row.push({ tag: child.type.name, style: child.attrs.style || '' });
        }
      }
    }
    return true;
  });
  return row;
};

describe('toggleHeaderRowStyled', () => {
  it('turns a pasted first row into headers whose default look shows', async () => {
    const editor = await setup();
    paste(editor, PLAIN);
    expect(editor.chain().focus().toggleHeaderRowStyled().run()).toBe(true);
    const row = firstRow(editor);
    expect(row.map((c) => c.tag)).toEqual(['tableHeader', 'tableHeader']);
    // The pasted white background and black colour are gone from the cells'
    // own style, so the th default grey (#f5f5f5) is what the cascade shows.
    for (const cell of row) {
      expect(cell.style).not.toMatch(/background/i);
      expect(cell.style).not.toMatch(/(^|;)\s*color\s*:/i);
    }
    // The second row keeps its pasted colours.
    const body = editor.getHTML();
    expect(body).toMatch(/Cell 1/);
    editor.destroy();
  });

  it('clears a coloured pasted first row so the header stays readable', async () => {
    const editor = await setup();
    paste(editor, COLOURED);
    editor.chain().focus().toggleHeaderRowStyled().run();
    const [cell] = firstRow(editor);
    // White-on-dark from the paste would have left white text on the light
    // header grey; both declarations are dropped instead.
    expect(cell.tag).toBe('tableHeader');
    expect(cell.style).not.toMatch(/background/i);
    expect(cell.style).not.toMatch(/(^|;)\s*color\s*:/i);
    editor.destroy();
  });

  it('turns the header row off without touching the cells styles', async () => {
    const editor = await setup();
    paste(editor, PLAIN);
    editor.chain().focus().toggleHeaderRowStyled().run();
    editor.chain().focus().toggleHeaderRowStyled().run();
    const row = firstRow(editor);
    expect(row.map((c) => c.tag)).toEqual(['tableCell', 'tableCell']);
    editor.destroy();
  });

  it('drops a pasted bold so turning the header off restores normal weight', async () => {
    const editor = await setup();
    paste(editor, BOLD);
    // The Bold extension parsed font-weight:700 into a bold mark.
    expect(editor.getHTML()).toContain('<strong>');

    editor.chain().focus().toggleHeaderRowStyled().run();
    const row = firstRow(editor);
    expect(row[0].tag).toBe('tableHeader');
    // Neither the inline weight nor the bold mark survives into the header.
    expect(row[0].style).not.toMatch(/font-weight/i);
    expect(editor.getHTML()).not.toContain('<strong>');

    editor.chain().focus().toggleHeaderRowStyled().run();
    const html = editor.getHTML();
    expect(firstRow(editor)[0].tag).toBe('tableCell');
    // Normal weight, and the bold button would now work on it.
    expect(html).not.toContain('<strong>');
    expect(firstRow(editor)[0].style).not.toMatch(/font-weight/i);
    // The body row keeps its own look.
    expect(html).toContain('Cell 1');
    editor.destroy();
  });
});
