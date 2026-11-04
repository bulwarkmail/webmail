import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import React from 'react';
import type { Editor } from '@tiptap/core';

import { RichTextEditor } from '../rich-text-editor';
import { serializeEditorContent } from '../quoted-html';

// A reply's quoted inline images load while the caret already waits in the
// body, and swapping them in re-sets the editor's content. That threw the caret
// onto the quote as a node, where the first key typed replaced the whole quote
// and the reply went out without the original or its images, or below the quote.

const PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const IMAGE = 'data:image/png;base64,iVBORw0KGgo=';
const body = (src: string, below: string) => `<p></p><p data-reply-quote-start="true">On Tuesday, C wrote:</p><div data-quoted-html=""><p>Original text</p><img src="${src}" alt="logo" data-cid="logo@x"></div>${below}`;

async function openReply(below: string) {
  let editor: Editor | null = null;
  const element = (content: string) => (
    <RichTextEditor content={content} onChange={() => {}} onEditorReady={(ed) => { editor = ed as unknown as Editor; }} />
  );
  const view = render(element(body(PLACEHOLDER, below)));
  await waitFor(() => expect(editor).not.toBeNull());
  const ed = editor as unknown as Editor;
  // Where focus('start') puts it; focus itself waits for a frame.
  act(() => { ed.commands.setTextSelection(1); });
  return { editor: ed, setContent: (content: string) => view.rerender(element(content)) };
}

const type = (editor: Editor, text: string) => act(() => { editor.view.dispatch(editor.state.tr.insertText(text)); });

describe.each([
  ['with a line below the quote', '<p></p>'],
  ['with the quote at the very end', ''],
])('typing in a reply once its inline images have loaded, %s', (_name, below) => {
  it('goes above the quote and keeps it and its image', async () => {
    const { editor, setContent } = await openReply(below);

    setContent(body(IMAGE, below));
    type(editor, 'My answer');

    const sent = serializeEditorContent(editor);
    expect(editor.state.doc.child(0).textContent).toBe('My answer');
    expect(sent).toContain('Original text');
    expect(sent).toContain(IMAGE);
  });

  it('carries on where the user was already typing', async () => {
    const { editor, setContent } = await openReply(below);
    type(editor, 'Hel');

    setContent(body(IMAGE, `${below}`).replace('<p></p>', '<p>Hel</p>'));
    type(editor, 'lo');

    expect(editor.state.doc.child(0).textContent).toBe('Hello');
    expect(serializeEditorContent(editor)).toContain('Original text');
  });
});

describe('a body replaced by a shorter one', () => {
  it('leaves the caret inside it', async () => {
    const { editor, setContent } = await openReply('<p>A long line below the quote</p>');
    act(() => { editor.commands.setTextSelection(editor.state.doc.content.size - 2); });

    setContent('<p>Short</p>');
    type(editor, '!');

    expect(editor.state.doc.textContent).toContain('Short');
    expect(editor.state.doc.textContent).toContain('!');
  });
});
