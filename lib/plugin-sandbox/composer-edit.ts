// Edits a plugin makes to the message being written (api.composer.*).
//
// The rich editor: every change is one ProseMirror transaction on the live
// editor, so it lands in the editor's history as one step and Ctrl+Z takes
// it back whole. Not through the composer's body state: that rebuilds the
// whole document from HTML a render later, and in the plain-text composer
// setting the textarea's value wipes its undo history.
//
// "The message" a plugin reads or replaces as a whole is the user's own
// text: everything above the signature and the quoted original. Those, and
// inline images, are never removed by an edit:
// - the signature (SignatureBlock atom, or the paragraphs bracketed by
//   data-signature-block markers) and the quote (QuotedHtml atom, a
//   blockquote, or the forwarded-message header) end the user's text;
// - in a reply the line just above the quote is its header ("On ... wrote:")
//   and goes with it;
// - images inside a replaced range are put back right after the new text.
//
// The plain-text composer (a textarea) uses the same rules on the string,
// and edits through the browser's own editing command, so the textarea's
// undo still works.

import type { Editor } from '@tiptap/core';
import { DOMParser as PMDOMParser, DOMSerializer, Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { TextSelection, type Transaction } from '@tiptap/pm/state';
import { closeHistory } from '@tiptap/pm/history';
import { textToEditorHtml } from './editor-html';
import { ATOM_BOUNDARIES, SIGNATURE_MARKER_ATTR, ownRange, type OwnTextOptions } from './composer-own-text';

export { textToEditorHtml };
export { ownRange, plainOwnRange, replaceInputText, replaceTextareaRange, type OwnRange, type OwnTextOptions, type PlainOwnOptions } from './composer-own-text';

// The editor's history merges changes made within half a second of each
// other into one undo step. A plugin's edit always starts a step of its own,
// so Ctrl+Z never takes back what the user typed just before with it.
const ownStep = (tr: Transaction) => closeHistory(tr);

function fragmentHtml(editor: Editor, fragment: Fragment): string {
  const serializer = DOMSerializer.fromSchema(editor.schema);
  const container = document.createElement('div');
  container.appendChild(serializer.serializeFragment(fragment));
  return container.innerHTML;
}

function textOf(doc: PMNode, from: number, to: number): string {
  return doc.textBetween(from, to, '\n', (leaf) => (leaf.type.name === 'hardBreak' ? '\n' : ''));
}

/** The user's own text, as HTML and as plain text. */
export function readOwnContent(editor: Editor, opts: OwnTextOptions = {}): { html: string; text: string } {
  const { doc } = editor.state;
  const { from, to } = ownRange(doc, opts);
  return { html: fragmentHtml(editor, doc.slice(from, to).content), text: textOf(doc, from, to).trim() };
}

/** The selected text, as HTML and plain text, and whether it is empty. */
export function readSelection(editor: Editor): { html: string; text: string; empty: boolean } {
  const { doc, selection } = editor.state;
  if (selection.empty) return { html: '', text: '', empty: true };
  return {
    html: fragmentHtml(editor, doc.slice(selection.from, selection.to).content),
    text: textOf(doc, selection.from, selection.to),
    empty: false,
  };
}

function imagesIn(doc: PMNode, from: number, to: number): PMNode[] {
  const out: PMNode[] = [];
  doc.nodesBetween(from, to, (node) => {
    if (node.type.name === 'image') out.push(node);
  });
  return out;
}

function containsAtom(doc: PMNode, from: number, to: number): boolean {
  let found = false;
  doc.nodesBetween(from, to, (node) => {
    if (ATOM_BOUNDARIES.has(node.type.name) || (node.attrs?.[SIGNATURE_MARKER_ATTR] && node.isBlock)) found = true;
    return !found;
  });
  return found;
}

function parseBlocks(editor: Editor, html: string): Fragment {
  const dom = document.createElement('div');
  dom.innerHTML = html;
  return PMDOMParser.fromSchema(editor.schema).parse(dom).content;
}

/**
 * Replace the user's own text with `html` (already sanitised), in one
 * transaction. Inline images that were in it follow the new text. Returns
 * false when the editor is gone.
 */
export function replaceOwnContent(editor: Editor, html: string, opts: OwnTextOptions = {}): boolean {
  if (editor.isDestroyed) return false;
  return editor.chain().focus().command(({ tr, state }) => {
    ownStep(tr);
    const { from, to } = ownRange(state.doc, opts);
    const images = imagesIn(state.doc, from, to);
    let content = parseBlocks(editor, html);
    if (images.length) {
      const paragraph = state.schema.nodes.paragraph;
      content = content.addToEnd(paragraph.create(null, images.map((img) => img.copy(img.content))));
    }
    tr.replaceWith(from, to, content);
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(from + content.size, tr.doc.content.size)), -1));
    tr.scrollIntoView();
    return true;
  }).run();
}

/**
 * Replace the selection with `html` (or insert it at the caret), in one
 * transaction. Refused (false) when the selection holds the signature or a
 * quoted original as a whole: replacing it would delete them.
 */
export function replaceSelection(editor: Editor, html: string, { below = false }: { below?: boolean } = {}): boolean {
  if (editor.isDestroyed) return false;
  const { doc, selection } = editor.state;
  if (!below && containsAtom(doc, selection.from, selection.to)) return false;
  const images = below ? [] : imagesIn(doc, selection.from, selection.to);
  return editor.chain().focus().command(({ tr, commands }) => {
    ownStep(tr);
    if (below) {
      // After the block the selection ends in.
      const $to = tr.doc.resolve(selection.to);
      const after = $to.depth > 0 ? $to.after(1) : selection.to;
      tr.insert(after, parseBlocks(editor, html));
      return true;
    }
    return commands.insertContentAt({ from: selection.from, to: selection.to }, html, { updateSelection: true });
  }).command(({ tr }) => {
    if (!images.length) return true;
    const at = tr.selection.to;
    const $at = tr.doc.resolve(at);
    if ($at.parent.inlineContent) tr.insert(at, Fragment.from(images.map((img) => img.copy(img.content))));
    else tr.insert(at, editor.schema.nodes.paragraph.create(null, images.map((img) => img.copy(img.content))));
    return true;
  }).run();
}
