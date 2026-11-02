import { afterEach, describe, expect, it } from 'vitest';
import { Editor, Node, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Paragraph from '@tiptap/extension-paragraph';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableCell } from '@tiptap/extension-table-cell';
import { QuotedHtml } from '@/components/email/quoted-html';
import { SignatureBlock } from '@/components/email/signature-block';
import { MentionChip } from '@/components/email/mention-chip';
import { styledBlockAttributes } from '@/components/email/styled-block-attributes';
import { readOwnContent } from '@/lib/plugin-sandbox/composer-edit';
import { OBJECT_CHAR, plainSegments, richSegments, segmentsAsText } from '@/lib/proofreading/segments';

// The composer's paragraph carries the signature markers.
const StyledParagraph = Paragraph.extend({
  addAttributes() {
    return { ...this.parent?.(), ...styledBlockAttributes };
  },
});
// The composer's image is an inline leaf named "image".
const InlineImage = Node.create({
  name: 'image',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes: () => ({ src: { default: null } }),
  parseHTML: () => [{ tag: 'img[src]' }],
  renderHTML: ({ HTMLAttributes }) => ['img', HTMLAttributes],
});

const editors: Editor[] = [];
afterEach(() => { while (editors.length) editors.pop()!.destroy(); });

function editorWith(content: JSONContent[]): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      StarterKit.configure({ paragraph: false, link: false, underline: false }),
      StyledParagraph, Table, TableRow, TableHeader, TableCell,
      QuotedHtml, SignatureBlock, MentionChip, InlineImage,
    ],
    content: { type: 'doc', content },
  });
  editors.push(editor);
  return editor;
}

const p = (...parts: (string | JSONContent)[]): JSONContent => ({
  type: 'paragraph',
  content: parts.filter((x) => x !== '').map((x) => (typeof x === 'string' ? { type: 'text', text: x } : x)),
});
const marker = (kind: string, text = ''): JSONContent => ({ type: 'paragraph', attrs: { 'data-signature-block': kind }, content: text ? [{ type: 'text', text }] : [] });
const chip = (label: string) => ({ type: 'mentionChip', attrs: { label, email: `${label}@example.org` } });
const img = { type: 'image', attrs: { src: 'cid:1' } };
const br = { type: 'hardBreak' };

/** Non-empty lines, the way readOwnContent's text and the segments must agree. */
const lines = (text: string) => text.split('\n').map((l) => l.split(OBJECT_CHAR).join('')).filter((l) => l.trim());

describe('richSegments', () => {
  it('leaves out the quote and the reply header above it', () => {
    const editor = editorWith([
      p('Ich habe gestern dem Brief geschrieben.'),
      p(),
      p('Am Montag schrieb Bob:'),
      { type: 'quotedHtml', attrs: { html: '<p>Alter Text mit Fehlern</p>' } },
    ]);
    const segs = richSegments(editor.state.doc, { replyLike: true });
    expect(segs.map((s) => s.text)).toEqual(['Ich habe gestern dem Brief geschrieben.']);
    expect(lines(segmentsAsText(segs))).toEqual(lines(readOwnContent(editor, { replyLike: true }).text));
  });

  it('leaves out the signature, as an atom and as unlocked paragraphs', () => {
    const atom = editorWith([p('Hello Anna'), marker('separator', '-- '), { type: 'signatureBlock', attrs: { html: '<p>Bob Smiht</p>' } }]);
    expect(richSegments(atom.state.doc).map((s) => s.text)).toEqual(['Hello Anna']);
    const unlocked = editorWith([p('Hello Anna'), marker('start'), p('Bob Smiht'), p('Sales'), marker('end')]);
    expect(richSegments(unlocked.state.doc).map((s) => s.text)).toEqual(['Hello Anna']);
  });

  it('leaves out a forwarded message', () => {
    const editor = editorWith([p('See below.'), p('---------- Forwarded message ----------'), p('From: Bob')]);
    expect(richSegments(editor.state.doc, { forwardedSeparator: '---------- Forwarded message ----------' }).map((s) => s.text)).toEqual(['See below.']);
  });

  it('puts one character per position, so offsets map straight to the document', () => {
    const editor = editorWith([p('Hi ', chip('Anna'), ', see ', img, ' teh pic', br, 'and 👋 café')]);
    const [seg] = richSegments(editor.state.doc);
    expect(seg.text).toBe(`Hi ${OBJECT_CHAR}, see ${OBJECT_CHAR} teh pic\nand 👋 café`);
    for (const word of ['teh', '👋', 'café', 'see']) {
      const offset = seg.text.indexOf(word);
      expect(editor.state.doc.textBetween(seg.start + offset, seg.start + offset + word.length)).toBe(word);
    }
    // Same text as readOwnContent, less the objects.
    expect(lines(segmentsAsText([seg]))).toEqual(lines(readOwnContent(editor).text));
  });

  it('keeps combining marks and right-to-left text as they are', () => {
    const decomposed = 'cafe\u0301 au lait';
    const arabic = 'مرحبا بالعالم';
    const editor = editorWith([p(decomposed), p(arabic)]);
    const segs = richSegments(editor.state.doc);
    expect(segs.map((s) => s.text)).toEqual([decomposed, arabic]);
    const at = decomposed.indexOf('au');
    expect(editor.state.doc.textBetween(segs[0].start + at, segs[0].start + at + 2)).toBe('au');
    const word = 'بالعالم';
    const o = arabic.indexOf(word);
    expect(editor.state.doc.textBetween(segs[1].start + o, segs[1].start + o + word.length)).toBe(word);
  });

  it('gives a segment per list item, heading and table cell, and skips empty lines and code', () => {
    const editor = editorWith([
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Agenda' }] },
      { type: 'bulletList', content: [
        { type: 'listItem', content: [p('First pont')] },
        { type: 'listItem', content: [p('Second')] },
      ] },
      p(),
      { type: 'table', content: [{ type: 'tableRow', content: [
        { type: 'tableCell', content: [p('Cel one')] },
        { type: 'tableCell', content: [p('Cell two')] },
      ] }] },
      { type: 'codeBlock', content: [{ type: 'text', text: 'const x = teh;' }] },
      p('Bye'),
    ]);
    const segs = richSegments(editor.state.doc);
    expect(segs.map((s) => s.text)).toEqual(['Agenda', 'First pont', 'Second', 'Cel one', 'Cell two', 'Bye']);
    for (const s of segs) expect(editor.state.doc.textBetween(s.start, s.start + s.text.length)).toBe(s.text);
  });

  it('keeps the id of a paragraph that did not change, and gives a changed one a new id', () => {
    const editor = editorWith([p('Same line'), p('Same line'), p('Other line')]);
    const before = richSegments(editor.state.doc);
    expect(new Set(before.map((s) => s.id)).size).toBe(3);
    // Type into the last paragraph.
    editor.view.dispatch(editor.state.tr.insertText('!', before[2].start + before[2].text.length));
    const after = richSegments(editor.state.doc);
    expect(after[0].id).toBe(before[0].id);
    expect(after[1].id).toBe(before[1].id);
    expect(after[2].id).not.toBe(before[2].id);
  });
});

describe('plainSegments', () => {
  it('cuts the own text at blank lines, without signature and quote', () => {
    const body = 'Hallo Anna,\n\nich habe gestern dem Brief\ngeschrieben.\n\nAm Montag schrieb Bob:\n> alter Text\n\n-- \nBob';
    const segs = plainSegments(body, { replyLike: true, signature: 'Bob' });
    expect(segs.map((s) => s.text)).toEqual(['Hallo Anna,', 'ich habe gestern dem Brief\ngeschrieben.']);
    for (const s of segs) expect(body.slice(s.start, s.start + s.text.length)).toBe(s.text);
  });

  it('maps offsets into the textarea value with emoji', () => {
    const body = '  👋 Grüße, teh team\n\n-- \nSig';
    const [seg] = plainSegments(body);
    const o = seg.text.indexOf('teh');
    expect(body.slice(seg.start + o, seg.start + o + 3)).toBe('teh');
  });
});
