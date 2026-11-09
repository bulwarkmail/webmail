import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import React from 'react';
import type { Editor } from '@tiptap/core';

import { RichTextEditor } from '../rich-text-editor';

// The format painter: a click copies the formatting at the selection and
// applies it to the next selection (replace semantics, as in a word
// processor); a double click keeps it armed; Escape or another click puts
// it down. A selection dragged with the mouse grows one step at a time,
// firing selectionUpdate at every step, so the apply waits for the
// selection to settle — the mouse button coming up, or 250ms of quiet.

async function setup(content: string) {
  let editor: Editor | null = null;
  render(<RichTextEditor content={content} onChange={() => {}} onEditorReady={(ed) => { editor = ed as unknown as Editor; }} />);
  await waitFor(() => expect(editor).not.toBeNull());
  const ed = editor as unknown as Editor;
  const button = () =>
    screen.getByRole('toolbar', { name: 'formatting' }).querySelector<HTMLButtonElement>('[data-toolbar-item="format-painter"]')!;
  const select = (from: number, to: number) => act(() => { ed.commands.setTextSelection({ from, to }); });
  // Releasing the mouse over the editor paints at once.
  const mouseUp = () => act(() => { ed.view.dom.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
  return { editor: ed, button, select, mouseUp };
}

describe('the format painter', () => {
  it('copies a mark onto the next selection once, then puts itself down', async () => {
    // "bold" (strong) is 1–5, " plain" is 5–11.
    const { editor, button, select, mouseUp } = await setup('<p><strong>bold</strong> plain</p>');

    select(1, 5);
    fireEvent.click(button());
    expect(button()).toHaveAttribute('aria-pressed', 'true');

    select(6, 11);
    mouseUp();
    expect(editor.getHTML()).toContain('<strong>plain</strong>');
    expect(button()).toHaveAttribute('aria-pressed', 'false');

    // One shot: a further selection isn't painted again (nothing left to copy).
    editor.commands.setContent('<p><strong>bold</strong> more</p>');
    select(6, 10);
    mouseUp();
    expect(editor.getHTML()).not.toContain('<strong>more');
  });

  it('waits for a dragged selection to finish before painting it', async () => {
    // Dragging extends the selection a step at a time; only the settled
    // range is painted, not the first character the drag covered.
    const { editor, button, select, mouseUp } = await setup('<p><strong>bold</strong> hello</p>');

    select(1, 5);
    fireEvent.click(button());

    select(6, 7);
    expect(editor.getHTML()).not.toContain('<strong>h');
    select(6, 11);
    expect(editor.getHTML()).not.toContain('<strong>hello');

    mouseUp();
    expect(editor.getHTML()).toContain('<strong>hello</strong>');
  });

  it('paints a keyboard selection once it settles', async () => {
    const { editor, button, select } = await setup('<p><strong>bold</strong> plain</p>');

    select(1, 5);
    fireEvent.click(button());
    // Let the focus restore (tiptap does it in a rAF) run before selecting.
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    // No mouseup: the 250ms of quiet after the last selectionUpdate applies.
    select(6, 11);
    await waitFor(() => expect(editor.getHTML()).toContain('<strong>plain</strong>'), { timeout: 2000 });
  });

  it('stays armed after a double click, until Escape', async () => {
    const { editor, button, select, mouseUp } = await setup('<p><strong>bold</strong> one two</p>');

    select(1, 5);
    fireEvent.click(button());
    fireEvent.doubleClick(button());

    select(6, 9);
    mouseUp();
    select(10, 13);
    mouseUp();
    expect(editor.getHTML()).toContain('<strong>one</strong>');
    expect(editor.getHTML()).toContain('<strong>two</strong>');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(button()).toHaveAttribute('aria-pressed', 'false');
  });

  it('a second click cancels it without painting anything', async () => {
    const { editor, button, select, mouseUp } = await setup('<p><strong>bold</strong> plain</p>');

    select(1, 5);
    fireEvent.click(button());
    fireEvent.click(button());
    expect(button()).toHaveAttribute('aria-pressed', 'false');

    select(6, 11);
    mouseUp();
    expect(editor.getHTML()).not.toContain('<strong>plain');
  });

  it('copies the text colour, and takes off what the source did not have', async () => {
    // "red" is 1–4, " bold" is 4–9.
    const { editor, button, select, mouseUp } = await setup('<p><span style="color:#ff0000">red</span> <strong>bold</strong></p>');

    select(1, 4);
    fireEvent.click(button());
    select(5, 9);
    mouseUp();

    const html = editor.getHTML();
    // The colour reached the target (the browser serialises it as rgb()).
    expect((html.match(/color: rgb\(255, 0, 0\)/g) ?? []).length).toBe(2);
    // Replace semantics: the target's bold came off.
    expect(html).not.toContain('<strong>');
  });

  it('copies a heading level onto the selected paragraphs', async () => {
    // "Title" is 1–6 in the h1 (node size 8), "para" is 9–13.
    const { editor, button, select, mouseUp } = await setup('<h1>Title</h1><p>para</p>');

    select(1, 6);
    fireEvent.click(button());
    select(9, 13);
    mouseUp();

    expect(editor.getHTML()).toMatch(/<h1[^>]*>para<\/h1>/);
  });

  // A span styled with a font size or background colour, but no colour of its
  // own, parses with color: "" (the CSSOM's value for an unset property), not
  // null. That "" used to reach the painter's copy, where the apply's
  // `color ?? backgroundColor ?? fontSize` picked it ("" is not nullish) and
  // took the no-textStyle branch: painting a font size or background colour
  // applied nothing at all unless the source also had a colour.
  it('copies a font size from text with no colour of its own', async () => {
    // "big" is 1–4, " plain" is 4–10; paint onto "plain" (5–10).
    const { editor, button, select, mouseUp } = await setup('<p><span style="font-size: 20px">big</span> plain</p>');

    select(1, 4);
    fireEvent.click(button());
    select(5, 10);
    mouseUp();

    expect(editor.getHTML()).toMatch(/<span style="font-size: 20px[^"]*">plain<\/span>/);
  });

  it('copies a background colour from text with no colour of its own', async () => {
    // "bg" is 1–3, " plain" is 3–9; paint onto "plain" (4–9).
    const { editor, button, select, mouseUp } = await setup('<p><span style="background-color: yellow">bg</span> plain</p>');

    select(1, 3);
    fireEvent.click(button());
    select(4, 9);
    mouseUp();

    expect(editor.getHTML()).toMatch(/<span style="background-color: yellow[^"]*">plain<\/span>/);
  });
});
