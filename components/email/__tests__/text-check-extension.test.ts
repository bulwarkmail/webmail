import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { undo } from '@tiptap/pm/history';
import {
  applyIssueReplacement, createTextCheckExtension, drawnIssues, selectNextIssue, setTextIssues, type TextIssueRange,
} from '../proofreading/text-check-extension';

const editors: Editor[] = [];
afterEach(() => { while (editors.length) editors.pop()!.destroy(); });

function setup(text: string, onOpen = vi.fn()) {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit, createTextCheckExtension(() => ({ onOpen }))],
    content: `<p>${text}</p>`,
  });
  editors.push(editor);
  return { editor, onOpen };
}

/** The range of `word` (first occurrence) in a one-paragraph document. */
function range(editor: Editor, word: string, key = word): TextIssueRange {
  const text = editor.state.doc.textContent;
  const from = 1 + text.indexOf(word);
  return { key, from, to: from + word.length, kind: 'grammar', text: word };
}

const type = (editor: Editor, pos: number, text: string) => editor.view.dispatch(editor.state.tr.insertText(text, pos));

describe('text check underlines', () => {
  it('draws issues whose text matches and drops those that do not', () => {
    const { editor } = setup('Ich habe dem Brief geschrieben');
    setTextIssues(editor, [range(editor, 'dem'), { ...range(editor, 'Brief', 'stale'), text: 'Briefe' }]);
    expect(drawnIssues(editor.state).map((r) => r.key)).toEqual(['dem']);
    expect(editor.view.dom.querySelector('[data-text-issue="dem"]')?.className).toContain('text-issue-grammar');
    // Screen readers hear it as they do the browser's own markers.
    expect(editor.view.dom.querySelector('[data-text-issue="dem"]')?.getAttribute('aria-invalid')).toBe('grammar');
  });

  it('moves with typing before it, keeps still for typing after it, and goes when its text is edited', () => {
    const { editor } = setup('Ich habe dem Brief geschrieben');
    const dem = range(editor, 'dem');
    setTextIssues(editor, [dem]);
    type(editor, 1, 'Ja, ');
    expect(drawnIssues(editor.state)[0]).toMatchObject({ from: dem.from + 4, to: dem.to + 4 });
    type(editor, editor.state.doc.content.size - 1, ' heute');
    expect(drawnIssues(editor.state)[0]).toMatchObject({ from: dem.from + 4 });
    // Typing right next to it leaves it.
    type(editor, dem.to + 4, '!');
    expect(drawnIssues(editor.state)).toHaveLength(1);
    // Typing inside it drops it.
    type(editor, dem.from + 5, 'x');
    expect(drawnIssues(editor.state)).toHaveLength(0);
  });

  it('applies a replacement as one undo step', () => {
    const { editor } = setup('Ich habe dem Brief geschrieben');
    setTextIssues(editor, [range(editor, 'dem')]);
    expect(applyIssueReplacement(editor, 'dem', 'den')).toBe(true);
    expect(editor.state.doc.textContent).toBe('Ich habe den Brief geschrieben');
    // Typing right after the fix is a step of its own.
    type(editor, editor.state.selection.from, 'x');
    undo(editor.state, editor.view.dispatch);
    expect(editor.state.doc.textContent).toBe('Ich habe den Brief geschrieben');
    undo(editor.state, editor.view.dispatch);
    expect(editor.state.doc.textContent).toBe('Ich habe dem Brief geschrieben');
  });

  it('keeps the replacement apart from typing just before it', () => {
    const { editor } = setup('Ich habe dem Brief');
    setTextIssues(editor, [range(editor, 'dem')]);
    type(editor, editor.state.doc.content.size - 1, ' heute');
    applyIssueReplacement(editor, 'dem', 'den');
    undo(editor.state, editor.view.dispatch);
    expect(editor.state.doc.textContent).toBe('Ich habe dem Brief heute');
  });

  it('refuses a replacement when the text is not what the checker saw', () => {
    const { editor } = setup('Ich habe dem Brief');
    setTextIssues(editor, [range(editor, 'dem')]);
    expect(applyIssueReplacement(editor, 'unknown', 'x')).toBe(false);
    // The underlined word changed (here from another edit than typing).
    const dem = range(editor, 'dem');
    editor.view.dispatch(editor.state.tr.insertText('D', dem.from, dem.from + 1).setMeta('addToHistory', false));
    expect(editor.state.doc.textContent).toBe('Ich habe Dem Brief');
    expect(applyIssueReplacement(editor, 'dem', 'den')).toBe(false);
  });

  it('steps through issues from the caret and selects them', () => {
    const { editor } = setup('teh cat and teh dog');
    const text = editor.state.doc.textContent;
    const first = { key: 'a', from: 1, to: 4, kind: 'spelling' as const, text: 'teh' };
    const second = { key: 'b', from: 1 + text.lastIndexOf('teh'), to: 4 + text.lastIndexOf('teh'), kind: 'spelling' as const, text: 'teh' };
    setTextIssues(editor, [first, second]);
    editor.commands.setTextSelection(1);
    expect(selectNextIssue(editor, 1)).toBe('a');
    expect(selectNextIssue(editor, 1)).toBe('b');
    expect(selectNextIssue(editor, 1)).toBe('a');
    expect(selectNextIssue(editor, -1)).toBe('b');
    expect(editor.state.selection).toMatchObject({ from: second.from, to: second.to });
  });

  it('opens the popup on a right-click on an underline instead of the browser menu', () => {
    const { editor, onOpen } = setup('Ich habe dem Brief');
    setTextIssues(editor, [range(editor, 'dem')]);
    const el = editor.view.dom.querySelector('[data-text-issue="dem"]')!;
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 });
    el.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onOpen).toHaveBeenCalledWith('dem', expect.anything(), 'contextmenu');
    const plain = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
    editor.view.dom.querySelector('p')!.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
  });
});
