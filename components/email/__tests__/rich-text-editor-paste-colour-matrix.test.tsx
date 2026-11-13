import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import React from 'react';
import type { Editor } from '@tiptap/core';

import { RichTextEditor } from '../rich-text-editor';

// Where a real Office/WPS clipboard can put the font colour of a cell's
// text, pasted into the real composer. The background is always inline on
// the td (it survives every variant); the colour moves around, and each
// place needs its own rescue in table-paste.ts:
// - a class rule on the cell's wrapping div        (carried onto the cell)
// - inline colour on a span / a <font color>       (textStyle mark)
// - a class rule on a <b>/<i>/<u>/<a> run          (rewrapped in a span)
// - a class rule on a div around the whole table   (moved onto the table)
// - a class rule on the td itself
// Compact no-space rule syntax included (that is how WPS writes them).

const shell = (css: string, body: string) =>
  `<html xmlns:o="urn:schemas-microsoft-com:office:office">
<head><meta name=ProgId content=Excel.Sheet>
<style><!--\n${css}\n--></style></head>
<body>\n${body}\n</body>
</html>`;

const VARIANTS: Record<string, string> = {
  div_class_compact: shell(
    `.cr{color:#FF0000;}`,
    `<table style='border-collapse:collapse;table-layout:fixed'><tr>
<td style='background-color:#FFF2CC'><div class=cr><span class=cr>红字</span></div></td>
</tr></table>`,
  ),
  span_inline: shell(
    `td {border:none;}`,
    `<table style='border-collapse:collapse;table-layout:fixed'><tr>
<td style='background-color:#FFF2CC'><div><span style='color:#FF0000'>红字</span></div></td>
</tr></table>`,
  ),
  bold_run_class: shell(
    `.cr {color:#FF0000;}`,
    `<table style='border-collapse:collapse;table-layout:fixed'><tr>
<td style='background-color:#FFF2CC'><div><b class=cr>红字</b></div></td>
</tr></table>`,
  ),
  wrapper_div_class: shell(
    `.cr {color:#FF0000;}`,
    `<div class=cr><table style='border-collapse:collapse;table-layout:fixed'><tr>
<td style='background-color:#FFF2CC'><div>红字</div></td>
</tr></table></div>`,
  ),
  td_class: shell(
    `.xl65 {color:#FF0000;background:#FFF2CC;}`,
    `<table style='border-collapse:collapse;table-layout:fixed'><tr>
<td class=xl65><div>红字</div></td>
</tr></table>`,
  ),
  font_element: shell(
    `td {border:none;}`,
    `<table style='border-collapse:collapse;table-layout:fixed'><tr>
<td style='background-color:#FFF2CC'><div><font color=#FF0000>红字</font></div></td>
</tr></table>`,
  ),
};

async function setup() {
  let editor: Editor | null = null;
  render(<RichTextEditor content="<p></p>" onChange={() => {}} onEditorReady={(e) => { editor = e; }} />);
  await waitFor(() => expect(editor).not.toBeNull());
  return editor as unknown as Editor;
}

describe('pasting a table with coloured text into the real composer', () => {
  for (const [name, html] of Object.entries(VARIANTS)) {
    it(`keeps the font colour: ${name}`, async () => {
      const editor = await setup();
      editor.view.pasteHTML(html, new Event('paste') as ClipboardEvent);
      // Somewhere it must survive: on the cell/table, or as a text mark.
      expect(editor.getHTML()).toMatch(/#ff0000|rgb\(255,\s*0,\s*0\)/i);
      editor.destroy();
    });
  }
});
