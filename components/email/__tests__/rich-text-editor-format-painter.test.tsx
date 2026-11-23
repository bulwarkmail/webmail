import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import React from 'react';
import type { Editor } from '@tiptap/core';
import { closeHistory, undoDepth } from '@tiptap/pm/history';

import { RichTextEditor } from '../rich-text-editor';

// The format painter: a click copies the formatting at the selection and
// applies it to the next selection (replace semantics, as in a word
// processor); a double click keeps it armed; Escape or another click puts
// it down. A selection dragged with the mouse grows one step at a time,
// firing selectionUpdate at every step, so the apply waits for the
// selection to be finished: the pointer coming up, or the Shift key after
// a shift+arrows extension. Block formatting (headings, lists) stays out.

async function setup(content: string) {
  let editor: Editor | null = null;
  render(<RichTextEditor content={content} onChange={() => {}} onEditorReady={(ed) => { editor = ed as unknown as Editor; }} />);
  await waitFor(() => expect(editor).not.toBeNull());
  const ed = editor as unknown as Editor;
  const button = () =>
    screen.getByRole('toolbar', { name: 'formatting' }).querySelector<HTMLButtonElement>('[data-toolbar-item="format-painter"]')!;
  const select = (from: number, to: number) => act(() => { ed.commands.setTextSelection({ from, to }); });
  // Releasing the pointer over the editor paints at once — the end of a
  // drag, of a double click, of a long-press.
  const pointerUp = () => fireEvent.pointerUp(ed.view.dom);
  // The end of a shift+arrows extension.
  const shiftUp = () => fireEvent.keyUp(ed.view.dom, { key: 'Shift' });
  return { editor: ed, button, select, pointerUp, shiftUp };
}

describe('the format painter', () => {
  it('copies a mark onto the next selection once, then puts itself down', async () => {
    // "bold" (strong) is 1–5, " plain" is 5–11.
    const { editor, button, select, pointerUp } = await setup('<p><strong>bold</strong> plain</p>');

    select(1, 5);
    fireEvent.click(button());
    expect(button()).toHaveAttribute('aria-pressed', 'true');

    select(6, 11);
    pointerUp();
    expect(editor.getHTML()).toContain('<strong>plain</strong>');
    expect(button()).toHaveAttribute('aria-pressed', 'false');

    // One shot: a further selection isn't painted again (nothing left to copy).
    editor.commands.setContent('<p><strong>bold</strong> more</p>');
    select(6, 10);
    pointerUp();
    expect(editor.getHTML()).not.toContain('<strong>more');
  });

  it('waits for a dragged selection to finish before painting it', async () => {
    // Dragging extends the selection a step at a time; only the settled
    // range is painted, not the first character the drag covered.
    const { editor, button, select, pointerUp } = await setup('<p><strong>bold</strong> hello</p>');

    select(1, 5);
    fireEvent.click(button());

    select(6, 7);
    expect(editor.getHTML()).not.toContain('<strong>h');
    select(6, 11);
    expect(editor.getHTML()).not.toContain('<strong>hello');

    pointerUp();
    expect(editor.getHTML()).toContain('<strong>hello</strong>');
  });

  it('paints a dragged selection whose drag ends outside the text', async () => {
    const { editor, button, select } = await setup('<p><strong>bold</strong> hello</p>');

    select(1, 5);
    fireEvent.click(button());

    // The press starts in the text, the drag runs past the last line and the
    // button comes up over something else.
    fireEvent.pointerDown(editor.view.dom);
    select(6, 11);
    fireEvent.pointerUp(document.body);
    expect(editor.getHTML()).toContain('<strong>hello</strong>');
  });

  it('ignores a pointer that comes up outside the text after a press outside it', async () => {
    const { editor, button, select } = await setup('<p><strong>bold</strong> hello</p>');

    select(1, 5);
    fireEvent.click(button());
    select(6, 11);
    // A click somewhere else on the page (another field, a button).
    fireEvent.pointerDown(document.body);
    fireEvent.pointerUp(document.body);
    expect(editor.getHTML()).not.toContain('<strong>hello');
    expect(button()).toHaveAttribute('aria-pressed', 'true');
  });

  it('paints in one step that a single undo takes back', async () => {
    const { editor, button, select, pointerUp } = await setup('<p><strong>bold</strong> plain</p>');

    // Loading the content already left a step in the history: close it, so
    // the paint can't merge into it and an undo of that step can't pass
    // for the undo of the paint.
    act(() => { editor.view.dispatch(closeHistory(editor.state.tr)); });
    const depth = undoDepth(editor.state);

    select(1, 5);
    fireEvent.click(button());
    select(6, 11);
    pointerUp();
    expect(editor.getHTML()).toContain('<strong>plain</strong>');
    expect(undoDepth(editor.state)).toBe(depth + 1);

    act(() => { editor.commands.undo(); });
    expect(editor.getHTML()).not.toContain('<strong>plain');
    expect(editor.getHTML()).toContain('<strong>bold</strong>');
  });

  it('paints a shift+arrows selection when the Shift key comes up', async () => {
    const { editor, button, select, shiftUp } = await setup('<p><strong>bold</strong> plain</p>');

    select(1, 5);
    fireEvent.click(button());
    // Let the focus restore (tiptap does it in a rAF) run before selecting.
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    // Extending with shift+arrows fires selectionUpdate at every step, and
    // none of them paint — the Shift key coming up ends the selection.
    select(6, 11);
    expect(editor.getHTML()).not.toContain('<strong>plain');
    shiftUp();
    expect(editor.getHTML()).toContain('<strong>plain</strong>');
  });

  it('stays armed after a double click, until Escape', async () => {
    const { editor, button, select, pointerUp } = await setup('<p><strong>bold</strong> one two</p>');

    select(1, 5);
    // The sequence a browser dispatches for a double click: two clicks, the
    // second with detail 2, then dblclick. The second click used to reach the
    // toggle and put the painter down before dblclick could make it sticky.
    fireEvent.click(button(), { detail: 1 });
    fireEvent.click(button(), { detail: 2 });
    fireEvent.doubleClick(button());

    select(6, 9);
    pointerUp();
    select(10, 13);
    pointerUp();
    expect(editor.getHTML()).toContain('<strong>one</strong>');
    expect(editor.getHTML()).toContain('<strong>two</strong>');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(button()).toHaveAttribute('aria-pressed', 'false');
  });

  it('a second click cancels it without painting anything', async () => {
    const { editor, button, select, pointerUp } = await setup('<p><strong>bold</strong> plain</p>');

    select(1, 5);
    fireEvent.click(button());
    fireEvent.click(button());
    expect(button()).toHaveAttribute('aria-pressed', 'false');

    select(6, 11);
    pointerUp();
    expect(editor.getHTML()).not.toContain('<strong>plain');
  });

  it('copies the text colour, and takes off what the source did not have', async () => {
    // "red" is 1–4, " bold" is 4–9.
    const { editor, button, select, pointerUp } = await setup('<p><span style="color:#ff0000">red</span> <strong>bold</strong></p>');

    select(1, 4);
    fireEvent.click(button());
    select(5, 9);
    pointerUp();

    const html = editor.getHTML();
    // The colour reached the target (the browser serialises it as rgb()).
    expect((html.match(/color: rgb\(255, 0, 0\)/g) ?? []).length).toBe(2);
    // Replace semantics: the target's bold came off.
    expect(html).not.toContain('<strong>');
  });

  it('leaves block formatting alone: a heading word onto a paragraph', async () => {
    // "Title" is 1–6 in the h1 (node size 8), "para" is 9–13.
    const { editor, button, select, pointerUp } = await setup('<h1>Title</h1><p>para</p>');

    select(1, 6);
    fireEvent.click(button());
    select(9, 13);
    pointerUp();

    // The paragraph keeps its block: painting a word out of a heading used
    // to turn its whole target paragraph into one.
    expect(editor.getHTML()).toMatch(/<p[^>]*>para<\/p>/);
    expect(editor.getHTML()).not.toMatch(/<h1[^>]*>para/);
  });

  it('leaves block formatting alone: a heading word onto a list item', async () => {
    // "T" is 1–2 in the h1 (node size 8), "one" is 9–12 in the list item.
    const { editor, button, select, pointerUp } = await setup('<h1>T</h1><ul><li>one</li></ul>');

    select(1, 2);
    fireEvent.click(button());
    select(9, 12);
    pointerUp();

    // The item keeps its list: painting a heading onto it used to lift it
    // out of the list.
    expect(editor.getHTML()).toMatch(/<li[^>]*><p[^>]*>one<\/p>/);
    expect(editor.getHTML()).not.toMatch(/<h1[^>]*>one/);
  });

  // A span styled with a font size or background colour, but no colour of its
  // own, parses with color: "" (the CSSOM's value for an unset property), not
  // null. That "" used to reach the painter's copy, where the apply's
  // `color ?? backgroundColor ?? fontSize` picked it ("" is not nullish) and
  // took the no-textStyle branch: painting a font size or background colour
  // applied nothing at all unless the source also had a colour.
  it('copies a font size from text with no colour of its own', async () => {
    // "big" is 1–4, " plain" is 4–10; paint onto "plain" (5–10).
    const { editor, button, select, pointerUp } = await setup('<p><span style="font-size: 20px">big</span> plain</p>');

    select(1, 4);
    fireEvent.click(button());
    select(5, 10);
    pointerUp();

    expect(editor.getHTML()).toMatch(/<span style="font-size: 20px[^"]*">plain<\/span>/);
  });

  it('copies a background colour from text with no colour of its own', async () => {
    // "bg" is 1–3, " plain" is 3–9; paint onto "plain" (4–9).
    const { editor, button, select, pointerUp } = await setup('<p><span style="background-color: yellow">bg</span> plain</p>');

    select(1, 3);
    fireEvent.click(button());
    select(4, 9);
    pointerUp();

    expect(editor.getHTML()).toMatch(/<span style="background-color: yellow[^"]*">plain<\/span>/);
  });
});
