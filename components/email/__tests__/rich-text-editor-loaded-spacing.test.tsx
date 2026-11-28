import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import React from 'react';
import type { Editor } from '@tiptap/core';

import { RichTextEditor } from '../rich-text-editor';
import { serializeEditorContent } from '../quoted-html';

async function setup(content: string) {
  let editor: Editor | null = null;
  render(
    <RichTextEditor
      content={content}
      onChange={() => {}}
      onEditorReady={(ed) => { editor = ed as unknown as Editor; }}
    />
  );
  await waitFor(() => expect(editor).not.toBeNull());
  return editor as unknown as Editor;
}

const serialize = (editor: Editor) => serializeEditorContent(editor).replace(/ dir="auto"/g, '');
const margins = (html: string) => Array.from(html.matchAll(/margin: ?([^;"]+)/g)).map((m) => m[1].trim());

describe('RichTextEditor spacing of a loaded message (#1416)', () => {
  it('sends a draft written by another client with the spacing it came with', async () => {
    const editor = await setup('<p>one</p><p>two</p>');

    expect(margins(serialize(editor))).toEqual(['1em 0px', '1em 0px']);
  });

  it('shows that spacing in the editor, so what is proofread is what is sent', async () => {
    const editor = await setup('<p>one</p>');

    expect(margins(editor.getHTML())).toEqual(['1em 0px']);
  });

  it('keeps a paragraph that states a spacing of its own', async () => {
    const editor = await setup('<p style="margin:24px 0">wide</p>');

    expect(margins(serialize(editor))).toEqual(['24px 0px']);
  });

  it('leaves the empty paragraph a new message starts with to the composer', async () => {
    const editor = await setup('<p></p>');

    expect(serialize(editor)).toBe('<p style="margin:4px 0;"></p>');
  });

  it('does not stack a margin when the draft is opened again', async () => {
    const editor = await setup('<p>one</p><p>two</p>');
    const saved = serialize(editor);

    act(() => { editor.commands.setContent(saved, { emitUpdate: false }); });

    expect(serialize(editor)).toBe(saved);
  });

  it('leaves the reply attribution line to the composer (#1405)', async () => {
    const editor = await setup('<p></p><p data-reply-quote-start="true">On Monday, Anna wrote:</p><blockquote><p>hi</p></blockquote>');

    const attribution = serialize(editor).match(/<p[^>]*data-reply-quote-start[^>]*>/)![0];
    expect(margins(attribution)).toEqual(['4px 0']);
  });

  it('leaves the forward header to the composer', async () => {
    const editor = await setup('<p></p><p data-forward-header="true">---------- Forwarded message ----------<br>From: Anna</p><div data-quoted-html=""><p>hi</p></div>');

    const header = serialize(editor).match(/<p[^>]*data-forward-header[^>]*>/)![0];
    expect(margins(header)).toEqual(['4px 0']);
  });

  it('leaves the quoted original and an embedded signature alone', async () => {
    const editor = await setup(
      '<p>reply</p>'
      + '<div data-signature-block-node=""><p>Alice</p></div>'
      + '<div data-quoted-html=""><p>quoted</p></div>',
    );

    const html = serialize(editor);

    expect(html).toContain('<p>quoted</p>');
    expect(html).toContain('<p>Alice</p>');
  });

  it('leaves a table cell flush, in the mail as in the composer', async () => {
    const editor = await setup('<table><tbody><tr><td><p>cell</p></td></tr></tbody></table>');

    expect(serialize(editor)).toContain('<p style="margin:0;">cell</p>');
  });
});
