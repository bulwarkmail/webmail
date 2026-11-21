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

// The composer's table configuration (rich-text-editor.tsx).
function makeEditor(content = '<p></p>') {
  return new Editor({
    element: document.createElement('div'),
    extensions: [
      StarterKit,
      StyledTable.configure({
        resizable: true,
        HTMLAttributes: {
          border: '1',
          cellpadding: '6',
          cellspacing: '0',
          width: '100%',
          style: 'width:100%;border-collapse:collapse;',
        },
      }),
      StyledTableRow,
      StyledTableHeader.configure({
        HTMLAttributes: {
          style: 'padding:6px 8px;border:1px solid #ccc;background-color:#f5f5f5;color:#1f2937;text-align:left;',
        },
      }),
      StyledTableCell.configure({
        HTMLAttributes: {
          style: 'padding:6px 8px;border:1px solid #ccc;vertical-align:top;',
        },
      }),
      TablePaste,
    ],
    content,
  });
}

const cellStyles = (editor: Editor) => {
  const styles: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') styles.push(node.attrs.style ?? '');
  });
  return styles;
};

const OVERLAY = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:99999;background-image:url(https://tracker.example/x.png)';

describe('style attributes on table nodes', () => {
  it('filters the inline style of a table copied from a web page', () => {
    const editor = makeEditor();
    editor.view.pasteHTML(
      `<table style="${OVERLAY}"><tr style="${OVERLAY}"><td style="${OVERLAY};color:#c00000">x</td></tr></table>`,
      new Event('paste') as ClipboardEvent,
    );
    const html = editor.getHTML();
    expect(html).toMatch(/<td/);
    expect(html).not.toMatch(/position|z-index|100vw|100vh|tracker\.example|url\(/i);
    // Presentation the allowlist knows survives.
    expect(cellStyles(editor)[0]).toMatch(/color:\s*#c00000/i);
    editor.destroy();
  });

  it('filters the same style in a reopened draft', () => {
    const editor = makeEditor(`<table><tr><td style="${OVERLAY}">x</td></tr></table>`);
    expect(editor.getHTML()).not.toMatch(/position|z-index|100vw|tracker\.example/i);
    editor.destroy();
  });

  it('drops escaped url() and image-set() and clamps lengths', () => {
    const editor = makeEditor(
      `<table><tr>
        <td style="background:\\75rl(https://tracker.example/a.png)">a</td>
        <td style='background-image:image-set("https://tracker.example/b.png" 1x)'>b</td>
        <td style="color:red\\3b position:fixed">c</td>
        <td style="width:99999px;padding:500px;border:1px solid rgb(10, 20, 30)">d</td>
        <td style="width:calc(100vw + 1px);font-size:1000pt">e</td>
      </tr></table>`,
    );
    const html = editor.getHTML();
    expect(html).not.toMatch(/tracker\.example|position/i);
    const styles = cellStyles(editor);
    expect(styles[3]).toMatch(/width:\s*4000px/);
    expect(styles[3]).toMatch(/padding:\s*200px/);
    // A colour's numbers aren't lengths.
    expect(styles[3]).toMatch(/border:\s*1px solid rgb\(10, 20, 30\)/);
    expect(styles[4]).not.toMatch(/calc|vw/);
    expect(styles[4]).toMatch(/font-size:\s*96px/);
    editor.destroy();
  });

  it('drops the same tricks from a pasted style block', () => {
    const html = inlineClipboardStyles(
      `<html><head><style>
      .a { background: \\75rl(https://tracker.example/a.png); width: 99999px; }
      </style></head><body><table><tr><td class="a">x</td></tr></table></body></html>`,
    );
    expect(html).not.toMatch(/tracker\.example|\\75/i);
    expect(html).not.toMatch(/99999/);
  });
});

describe('text colour from the sheet-wide rules', () => {
  const sheet = (body: string) => `<html><head><meta name=ProgId content=Excel.Sheet><style>
td {color:black;font-size:11pt;}
.xl65 {color:windowtext;font-weight:700;}
.xl66 {color:#000000;background:#FFFF00;}
.xl67 {color:#FF0000;}
body {color:#000000;}
</style></head><body>${body}</body></html>`;

  it('drops black text where nothing sets a background, keeps it on coloured cells', () => {
    const html = inlineClipboardStyles(
      sheet(`<table><tr>
        <td>plain</td><td class=xl65>bold</td><td class=xl66>yellow</td><td class=xl67>red</td><td bgcolor="#DDDDDD">grey</td>
      </tr></table>`),
    );
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const [plain, bold, yellow, red, grey] = Array.from(doc.querySelectorAll('td'));
    expect(plain.style.color).toBe('');
    expect(bold.style.color).toBe('');
    expect(bold.style.fontWeight).toBe('700');
    expect(yellow.style.color).toMatch(/#000000|rgb\(0, 0, 0\)/);
    expect(red.style.color).toMatch(/#ff0000|rgb\(255, 0, 0\)/i);
    expect(grey.style.color).toMatch(/black/);
    // The body rule carried onto the table is dropped too.
    expect(doc.querySelector('table')!.style.color).toBe('');
  });
});

describe('the sent table', () => {
  it('has the summed column width of a pasted grid, as the composer shows it', () => {
    const editor = makeEditor();
    editor.view.pasteHTML(
      `<html><head><meta name=ProgId content=Excel.Sheet><style>td{}</style></head><body>
      <table style="width:96pt"><col width=64 span=2><tr><td>a</td><td>b</td></tr></table></body></html>`,
      new Event('paste') as ClipboardEvent,
    );
    const html = editor.getHTML();
    const table = new DOMParser().parseFromString(html, 'text/html').querySelector('table')!;
    expect(table.style.width).toBe('128px');
    expect(table.style.tableLayout).toBe('fixed');
    editor.destroy();
  });
});

describe('a draft round trip', () => {
  it('does not bake the header defaults into the cells', () => {
    const first = makeEditor();
    first.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true });
    const draft = first.getHTML();
    first.destroy();

    const editor = makeEditor(draft);
    let headerStyles: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'tableHeader') headerStyles.push(node.attrs.style ?? '');
    });
    expect(headerStyles).toHaveLength(2);
    for (const style of headerStyles) expect(style).not.toMatch(/background|color/i);

    // Turning the header row off leaves plain cells, not grey ones.
    let cellPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (cellPos < 0 && node.type.name === 'tableHeader') cellPos = pos;
    });
    editor.commands.setTextSelection(cellPos + 2);
    editor.commands.toggleHeaderRowStyled();
    headerStyles = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'tableHeader') headerStyles.push(node.attrs.style ?? '');
    });
    expect(headerStyles).toHaveLength(0);
    expect(editor.getHTML()).not.toMatch(/245,\s*245,\s*245|#f5f5f5/i);
    editor.destroy();
  });

  it('marks header cells with their own background in the editor only', () => {
    const editor = makeEditor(
      '<table><tr><th style="background-color:#ffff00">own</th><th>theme</th></tr><tr><td>a</td><td>b</td></tr></table>',
    );
    const ths = editor.view.dom.querySelectorAll('th');
    expect(ths[0].hasAttribute('data-cell-background')).toBe(true);
    expect(ths[1].hasAttribute('data-cell-background')).toBe(false);
    expect(editor.getHTML()).not.toMatch(/data-cell-background/);
    editor.destroy();
  });
});
