import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

import { PlainTextPaste } from '../plain-text-paste';

function makeEditor(content = '<p></p>') {
  return new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit, PlainTextPaste],
    coreExtensionOptions: { clipboardTextSerializer: { blockSeparator: '\n' } },
    content,
  });
}

// jsdom has no ClipboardEvent, which pasteText constructs when given none.
function paste(editor: Editor, text: string) {
  editor.view.pasteText(text, new Event('paste') as ClipboardEvent);
}

describe('plain-text paste', () => {
  // A paste that ends in a list leaves the empty paragraph the cursor was in
  // below it, hence the trailing <p></p> in those expectations.
  it('keeps blank lines as empty paragraphs', () => {
    const editor = makeEditor();
    paste(editor, 'Hi Joost,\n\nThanks for the write-up.\n\n\nPHASE 1');
    expect(editor.getHTML()).toBe(
      '<p>Hi Joost,</p><p></p><p>Thanks for the write-up.</p><p></p><p></p><p>PHASE 1</p>',
    );
    editor.destroy();
  });

  it('treats CRLF and CR line endings like LF', () => {
    const editor = makeEditor();
    paste(editor, 'one\r\n\r\ntwo\rthree');
    expect(editor.getHTML()).toBe('<p>one</p><p></p><p>two</p><p>three</p>');
    editor.destroy();
  });

  it('pastes a single line inline without splitting the paragraph', () => {
    const editor = makeEditor('<p>Hello world</p>');
    editor.commands.setTextSelection(7);
    paste(editor, 'big ');
    expect(editor.getHTML()).toBe('<p>Hello big world</p>');
    editor.destroy();
  });

  it('turns dash items into a bullet list, dropping the blank lines between them', () => {
    const editor = makeEditor();
    paste(editor, 'How it works:\n\n- One\n\n- Two\n\nAfter');
    expect(editor.getHTML()).toBe(
      '<p>How it works:</p><p></p>' +
        '<ul><li><p>One</p></li><li><p>Two</p></li></ul>' +
        '<p></p><p>After</p>',
    );
    editor.destroy();
  });

  it('accepts * and • as bullet markers', () => {
    const editor = makeEditor();
    paste(editor, '* One\n• Two');
    expect(editor.getHTML()).toBe('<ul><li><p>One</p></li><li><p>Two</p></li></ul><p></p>');
    editor.destroy();
  });

  it('turns numbered items into an ordered list that keeps its first number', () => {
    const editor = makeEditor();
    paste(editor, '1. One\n2) Two\n\nText\n\n3. Three\n4. Four');
    expect(editor.getHTML()).toBe(
      '<ol><li><p>One</p></li><li><p>Two</p></li></ol><p></p><p>Text</p><p></p>' +
        '<ol start="3"><li><p>Three</p></li><li><p>Four</p></li></ol><p></p>',
    );
    editor.destroy();
  });

  it('starts a new list where a numbered list switches to dashes', () => {
    const editor = makeEditor();
    paste(editor, '1. One\n\n- Dash');
    expect(editor.getHTML()).toBe(
      '<ol><li><p>One</p></li></ol><p></p><ul><li><p>Dash</p></li></ul><p></p>',
    );
    editor.destroy();
  });

  it('keeps indented lines inside the item above them', () => {
    const editor = makeEditor();
    paste(editor, '- Both drafts:\n  filenode-14\n  blobext-01\n\nAfter');
    expect(editor.getHTML()).toBe(
      '<ul><li><p>Both drafts:</p><p>filenode-14</p><p>blobext-01</p></li></ul>' +
        '<p></p><p>After</p>',
    );
    editor.destroy();
  });

  it('nests indented items', () => {
    const editor = makeEditor();
    paste(editor, '- Outer\n  - Inner\n- Next');
    expect(editor.getHTML()).toBe(
      '<ul><li><p>Outer</p><ul><li><p>Inner</p></li></ul></li><li><p>Next</p></li></ul><p></p>',
    );
    editor.destroy();
  });

  it('keeps a hard-wrapped item whole', () => {
    const editor = makeEditor();
    paste(editor, '- A long item that the\nsender wrapped\n- Next');
    expect(editor.getHTML()).toBe(
      '<ul><li><p>A long item that the</p><p>sender wrapped</p></li><li><p>Next</p></li></ul><p></p>',
    );
    editor.destroy();
  });

  it('leaves a signature delimiter and a dash inside a sentence alone', () => {
    const editor = makeEditor();
    paste(editor, 'Costs - roughly\n-- \nLinus');
    expect(editor.getHTML()).toBe('<p>Costs - roughly</p><p>-- </p><p>Linus</p>');
    editor.destroy();
  });

  it('copies back out as the same text', () => {
    const text = 'Hi Joost,\n\nThanks for the write-up.\n\n\nPHASE 1';
    const editor = makeEditor();
    paste(editor, text);
    // TipTap's serializer reads the editor selection, not the slice it gets.
    editor.commands.selectAll();
    const slice = editor.state.selection.content();
    const copied = editor.view.someProp('clipboardTextSerializer', (f) => f(slice, editor.view));
    expect(copied).toBe(text);
    editor.destroy();
  });
});
