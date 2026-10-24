import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

import { tabIndentKeyDown } from '../tab-indent';

// Rich-text Tab indent: the composer's editor used to ignore Tab in plain
// text blocks - the browser default moved focus to the next field, so users
// indented with spaces. tabIndentKeyDown (wired as editorProps.handleKeyDown
// in rich-text-editor.tsx) now inserts 4 non-breaking spaces at depth-1 text
// blocks and leaves deeper (list/table) and Shift+Tab handling alone.
//
// Mirrors font-size.test.ts: exercise the handler against a real @tiptap/core
// Editor with the composer's editorProps, instead of rendering the React
// component (whose full extension set needs the app shell).

function keydownEvent(key: string, shiftKey = false) {
  return new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
}

function makeEditor(content = '<p>hello</p>') {
  return new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit],
    content,
    // The same wiring as the composer's editorProps.
    editorProps: { handleKeyDown: tabIndentKeyDown },
  });
}

function pressTab(editor: Editor, shiftKey = false) {
  const event = keydownEvent('Tab', shiftKey);
  editor.view.dom.dispatchEvent(event);
  return event;
}

describe('rich editor Tab indent', () => {
  it('inserts four non-breaking spaces in a top-level text block', () => {
    const editor = makeEditor();
    // Caret at doc start - inside the depth-1 paragraph.
    editor.commands.setTextSelection(1);
    const event = pressTab(editor);
    expect(event.defaultPrevented).toBe(true);
    expect(editor.getHTML()).toContain('&nbsp;&nbsp;&nbsp;&nbsp;hello');
    editor.destroy();
  });

  it('defers inside a list (Tab stays owned by the list keymap)', () => {
    const editor = makeEditor('<ul><li>one</li><li>two</li></ul>');
    // Caret inside the last item's paragraph (depth 3, not depth 1): three
    // closing tokens back from the end of the doc.
    editor.commands.setTextSelection(editor.state.doc.content.size - 3);
    const event = keydownEvent('Tab');
    // The handler must not claim it; whatever list keymap the app registers
    // on top (sink on Tab) still gets the event.
    expect(tabIndentKeyDown(editor.view, event)).toBe(false);
    expect(editor.getHTML()).not.toContain('&nbsp;');
    editor.destroy();
  });

  it('does not handle Shift+Tab (reverse focus navigation stays native)', () => {
    const editor = makeEditor();
    editor.commands.setTextSelection(1);
    const event = pressTab(editor, /* shift */ true);
    expect(event.defaultPrevented).toBe(false);
    expect(editor.getHTML()).toBe('<p>hello</p>');
    editor.destroy();
  });

  it('returns the caret right after the inserted indentation', () => {
    const editor = makeEditor();
    editor.commands.setTextSelection(1);
    pressTab(editor);
    expect(editor.state.selection.from).toBe(5);
    editor.destroy();
  });
});
