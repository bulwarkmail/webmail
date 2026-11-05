import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import React from 'react';
import type { Editor } from '@tiptap/core';

import { RichTextEditor } from '../rich-text-editor';

// The format painter: a click copies the formatting at the selection and
// applies it to the next selection (replace semantics, as in a word
// processor); a double click keeps it armed; Escape or another click puts
// it down.

async function setup(content: string) {
  let editor: Editor | null = null;
  render(<RichTextEditor content={content} onChange={() => {}} onEditorReady={(ed) => { editor = ed as unknown as Editor; }} />);
  await waitFor(() => expect(editor).not.toBeNull());
  const ed = editor as unknown as Editor;
  const button = () =>
    screen.getByRole('toolbar', { name: 'formatting' }).querySelector<HTMLButtonElement>('[data-toolbar-item="format-painter"]')!;
  const select = (from: number, to: number) => act(() => { ed.commands.setTextSelection({ from, to }); });
  return { editor: ed, button, select };
}

describe('the format painter', () => {
  it('copies a mark onto the next selection once, then puts itself down', async () => {
    // "bold" (strong) is 1–5, " plain" is 5–11.
    const { editor, button, select } = await setup('<p><strong>bold</strong> plain</p>');

    select(1, 5);
    fireEvent.click(button());
    expect(button()).toHaveAttribute('aria-pressed', 'true');

    select(6, 11);
    expect(editor.getHTML()).toContain('<strong>plain</strong>');
    expect(button()).toHaveAttribute('aria-pressed', 'false');

    // One shot: a further selection isn't painted again (nothing left to copy).
    editor.commands.setContent('<p><strong>bold</strong> more</p>');
    select(6, 10);
    expect(editor.getHTML()).not.toContain('<strong>more');
  });

  it('stays armed after a double click, until Escape', async () => {
    const { editor, button, select } = await setup('<p><strong>bold</strong> one two</p>');

    select(1, 5);
    fireEvent.click(button());
    fireEvent.doubleClick(button());

    select(6, 9);
    select(10, 13);
    expect(editor.getHTML()).toContain('<strong>one</strong>');
    expect(editor.getHTML()).toContain('<strong>two</strong>');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(button()).toHaveAttribute('aria-pressed', 'false');
  });

  it('a second click cancels it without painting anything', async () => {
    const { editor, button, select } = await setup('<p><strong>bold</strong> plain</p>');

    select(1, 5);
    fireEvent.click(button());
    fireEvent.click(button());
    expect(button()).toHaveAttribute('aria-pressed', 'false');

    select(6, 11);
    expect(editor.getHTML()).not.toContain('<strong>plain');
  });

  it('copies the text colour, and takes off what the source did not have', async () => {
    // "red" is 1–4, " bold" is 4–9.
    const { editor, button, select } = await setup('<p><span style="color:#ff0000">red</span> <strong>bold</strong></p>');

    select(1, 4);
    fireEvent.click(button());
    select(5, 9);

    const html = editor.getHTML();
    // The colour reached the target (the browser serialises it as rgb()).
    expect((html.match(/color: rgb\(255, 0, 0\)/g) ?? []).length).toBe(2);
    // Replace semantics: the target's bold came off.
    expect(html).not.toContain('<strong>');
  });

  it('copies a heading level onto the selected paragraphs', async () => {
    // "Title" is 1–6 in the h1 (node size 8), "para" is 9–13.
    const { editor, button, select } = await setup('<h1>Title</h1><p>para</p>');

    select(1, 6);
    fireEvent.click(button());
    select(9, 13);

    expect(editor.getHTML()).toMatch(/<h1[^>]*>para<\/h1>/);
  });
});
