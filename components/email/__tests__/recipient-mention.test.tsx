import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { Editor, type AnyExtension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableCell } from '@tiptap/extension-table-cell';
import type { SuggestionProps } from '@tiptap/suggestion';

import { RichTextEditor } from '../rich-text-editor';
import { RecipientMention, insertMention } from '../recipient-mention';
import { buildMentionCandidates, type MentionCandidate } from '@/lib/recipient-mentions';

// The avatar resolves app config and favicons; neither matters here.
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));

const PEOPLE = buildMentionCandidates(
  [{ name: 'Max Mustermann', email: 'max.mustermann@dornig.de' }, { email: 'eva.weber@dornig.de' }],
  [],
);

/** Lets the suggestion's async item lookup finish. */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

/** Lets the editor's delayed focus (and scroll to the cursor) run inside the test. */
const nextFrame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

const type = (editor: Editor, text: string) => act(() => {
  editor.view.dispatch(editor.state.tr.insertText(text));
});

const press = (editor: Editor, key: string) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  act(() => { editor.view.dom.dispatchEvent(event); });
  return event;
};

/** An editor whose suggestion list picks the first item on Enter or Tab. */
function setup(content: string, candidates: MentionCandidate[] = PEOPLE, extensions: AnyExtension[] = [StarterKit]) {
  const suggestion: { props: SuggestionProps<MentionCandidate, MentionCandidate> | null } = { props: null };
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      ...extensions,
      RecipientMention.configure({
        getCandidates: () => candidates,
        render: () => ({
          onStart: (props) => { suggestion.props = props; },
          onUpdate: (props) => { if (!props.loading) suggestion.props = props; },
          onKeyDown: ({ event }) => {
            if ((event.key !== 'Enter' && event.key !== 'Tab') || !suggestion.props?.items.length) return false;
            suggestion.props.command(suggestion.props.items[0]);
            return true;
          },
          onExit: () => { suggestion.props = null; },
        }),
      }),
    ],
    content,
  });
  editor.commands.setTextSelection(endOfText(editor));
  return { editor, suggestion };
}

/** Position after the document's last text (or inside an empty first block). */
function endOfText(editor: Editor): number {
  let end = 1;
  editor.state.doc.descendants((node, pos) => {
    if (node.isText) end = pos + node.nodeSize;
  });
  return end;
}

const labels = (suggestion: { props: SuggestionProps<MentionCandidate, MentionCandidate> | null }) =>
  suggestion.props?.items.map((c) => c.label) ?? null;

describe('RecipientMention trigger', () => {
  it('offers the recipients after an @ that starts a word', async () => {
    const { editor, suggestion } = setup('<p>Hallo</p>');
    await type(editor, ' @');
    await settle();
    expect(labels(suggestion)).toEqual(['Max', 'Eva']);
    await type(editor, 'ev');
    await settle();
    expect(labels(suggestion)).toEqual(['Eva']);
    editor.destroy();
  });

  it('also triggers after a non-breaking space', async () => {
    const { editor, suggestion } = setup('<p>Hallo&nbsp;</p>');
    await type(editor, '@');
    await settle();
    expect(labels(suggestion)).toEqual(['Max', 'Eva']);
    editor.destroy();
  });

  it('never triggers inside a word, so typing an address stays untouched', async () => {
    const { editor, suggestion } = setup('<p>info</p>');
    await type(editor, '@');
    await settle();
    expect(suggestion.props).toBeNull();
    editor.destroy();
  });

  it('stays inactive while nobody matches, leaving Enter and Escape to the editor', async () => {
    const { editor, suggestion } = setup('<p>Hallo</p>');
    await type(editor, ' @xy');
    await settle();
    expect(suggestion.props).toBeNull();
    expect(press(editor, 'Escape').defaultPrevented).toBe(false);
    editor.destroy();
  });

  it('is off without recipients (e.g. the vacation reply editor)', async () => {
    const { editor, suggestion } = setup('<p>Hallo</p>', []);
    await type(editor, ' @');
    await settle();
    expect(suggestion.props).toBeNull();
    editor.destroy();
  });

  it('is off in code blocks and inline code', async () => {
    // The cursor lands right after the @ inside the code.
    for (const content of ['<pre><code>x @</code></pre>', '<p><code>x @</code></p>']) {
      const { editor, suggestion } = setup(content);
      await settle();
      expect(suggestion.props).toBeNull();
      editor.destroy();
    }
    // The same text outside code does offer the list.
    const { editor, suggestion } = setup('<p>x @</p>');
    await settle();
    expect(labels(suggestion)).toEqual(['Max', 'Eva']);
    editor.destroy();
  });
});

describe('RecipientMention insertion', () => {
  it('replaces the typed @query with the first name and a space', async () => {
    const { editor, suggestion } = setup('<p>Hallo</p>');
    await type(editor, ' @ma');
    await settle();
    const enter = press(editor, 'Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(editor.getHTML()).toBe('<p>Hallo @Max </p>');
    expect(suggestion.props).toBeNull();
    // The cursor sits after the space, ready to go on typing.
    await type(editor, 'bitte');
    expect(editor.getHTML()).toBe('<p>Hallo @Max bitte</p>');
    editor.destroy();
  });

  it('reuses a space that already follows the cursor', async () => {
    const { editor, suggestion } = setup('<p>Hallo @ma welt</p>');
    act(() => { editor.commands.setTextSelection(1 + 'Hallo @ma'.length); });
    await settle();
    expect(labels(suggestion)).toEqual(['Max']);
    press(editor, 'Enter');
    expect(editor.getHTML()).toBe('<p>Hallo @Max welt</p>');
    editor.destroy();
  });

  it('inserts the label as text, never as markup', () => {
    const { editor } = setup('<p></p>');
    insertMention(editor, { from: 1, to: 1 }, '<img src=x onerror=alert(1)>');
    expect(editor.getHTML()).toBe('<p>@&lt;img src=x onerror=alert(1)&gt; </p>');
    editor.destroy();
  });

  it('takes Enter from a list item and Tab from a table cell while the list is open', async () => {
    const list = setup('<ul><li><p>Hallo</p></li></ul>');
    await type(list.editor, ' @ma');
    await settle();
    press(list.editor, 'Enter');
    // Still one item: the Enter did not split it. (StarterKit's trailing
    // node adds an empty paragraph after the list.)
    expect(list.editor.getHTML()).toContain('<ul><li><p>Hallo @Max </p></li></ul>');
    list.editor.destroy();

    const table = setup(
      '<table><tbody><tr><td><p>x</p></td><td><p>y</p></td></tr></tbody></table>',
      PEOPLE,
      [StarterKit, Table, TableRow, TableHeader, TableCell],
    );
    // After the "x" in the first cell: table, row, cell and paragraph open first.
    act(() => { table.editor.commands.setTextSelection(4 + 'x'.length); });
    await type(table.editor, ' @ev');
    await settle();
    expect(labels(table.suggestion)).toEqual(['Eva']);
    press(table.editor, 'Tab');
    expect(table.editor.getText()).toContain('x @Eva ');
    expect(table.editor.state.selection.$from.parent.textContent).toBe('x @Eva ');
    table.editor.destroy();
  });

  it('closes on Escape without letting the key through, and stays closed while typing on', async () => {
    const { editor, suggestion } = setup('<p>Hallo</p>');
    await type(editor, ' @ma');
    await settle();
    expect(press(editor, 'Escape').defaultPrevented).toBe(true);
    expect(suggestion.props).toBeNull();
    await type(editor, 'x');
    await settle();
    expect(suggestion.props).toBeNull();
    expect(editor.getHTML()).toBe('<p>Hallo @max</p>');
    editor.destroy();
  });
});

describe('RichTextEditor recipient list', () => {
  // jsdom has no layout. After an insertion the editor focuses a frame later
  // and ProseMirror measures a Range to scroll the cursor into view.
  const range = Range.prototype as unknown as Record<string, unknown>;
  beforeAll(() => {
    range.getClientRects = () => [];
    range.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 });
  });
  afterAll(() => {
    delete range.getClientRects;
    delete range.getBoundingClientRect;
  });

  async function renderEditor(onChange = vi.fn()) {
    let editor: Editor | null = null;
    render(
      <RichTextEditor
        content="<p></p>"
        onChange={onChange}
        mentionCandidates={PEOPLE}
        onEditorReady={(ed) => { editor = ed; }}
      />
    );
    await waitFor(() => expect(editor).not.toBeNull());
    const ed = editor as unknown as Editor;
    act(() => { ed.commands.setTextSelection(1); });
    return { editor: ed, onChange };
  }

  it('lists the recipients, moves with the arrows and inserts on Enter', async () => {
    const { editor, onChange } = await renderEditor();
    await type(editor, '@');
    await settle();
    const list = await screen.findByRole('listbox', { name: 'mention_recipients' });
    const options = within(list).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      '@MaxMax Mustermann · max.mustermann@dornig.de',
      '@Evaeva.weber@dornig.de',
    ]);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');

    press(editor, 'ArrowDown');
    expect(within(list).getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');

    press(editor, 'Enter');
    await nextFrame();
    expect(editor.getText()).toBe('@Eva ');
    expect(onChange.mock.lastCall?.[0]).toContain('>@Eva </p>');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  });

  it('does not pick a recipient on Ctrl+Enter, the composer\'s send shortcut', async () => {
    const { editor } = await renderEditor();
    await type(editor, '@');
    await settle();
    await screen.findByRole('listbox');
    // Standing alone, the editor's own keymap makes it a line break.
    act(() => { editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true })); });
    expect(editor.getText()).not.toMatch(/@(Max|Eva)/);
  });

  it('inserts the clicked recipient', async () => {
    const { editor } = await renderEditor();
    await type(editor, '@');
    await settle();
    const list = await screen.findByRole('listbox');
    fireEvent.mouseDown(within(list).getAllByRole('option')[0]);
    await nextFrame();
    expect(editor.getText()).toBe('@Max ');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  });

  it('narrows the list as the name is typed', async () => {
    const { editor } = await renderEditor();
    await type(editor, '@');
    await settle();
    await screen.findByRole('listbox');
    await type(editor, 'e');
    await settle();
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    expect(screen.getByRole('option')).toHaveTextContent('Eva');
  });
});
