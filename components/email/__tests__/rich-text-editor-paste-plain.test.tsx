import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { Editor } from '@tiptap/core';

// #1890: Mod+Shift+V pastes without formatting in the real composer editor.
// On a Mac, Cmd+Shift+V has no browser action, so the editor reads the
// clipboard text itself; Ctrl+Shift+V elsewhere and Cmd+Option+Shift+V are
// the browser's own plain paste, which arrives as a paste event while Shift
// is down.

const platform = vi.hoisted(() => ({ apple: true }));
vi.mock('@/lib/shortcut-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shortcut-keys')>();
  return { ...actual, isApplePlatform: () => platform.apple };
});

const { RichTextEditor } = await import('../rich-text-editor');

async function setup() {
  let editor: Editor | null = null;
  render(<RichTextEditor content="<p></p>" onChange={() => {}} onEditorReady={(e) => { editor = e; }} />);
  await waitFor(() => expect(editor).not.toBeNull());
  return editor as unknown as Editor;
}

// Paragraphs carry dir="auto" for RTL text; not what these tests are about.
const html = (editor: Editor) => editor.getHTML().replace(/ dir="auto"/g, '');

function press(editor: Editor, init: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  editor.view.dom.dispatchEvent(event);
  return event;
}

const readText = vi.fn<() => Promise<string>>();

beforeEach(() => {
  platform.apple = true;
  readText.mockReset().mockResolvedValue('First line\n\nSecond line');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText } });
  // jsdom has no ClipboardEvent; view.pasteText makes one.
  if (typeof globalThis.ClipboardEvent === 'undefined') {
    vi.stubGlobal('ClipboardEvent', class extends Event { clipboardData = null; });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('paste as plain text with Mod+Shift+V (#1890)', () => {
  it('pastes the clipboard text on Cmd+Shift+V on a Mac, one paragraph per line', async () => {
    const editor = await setup();
    const event = press(editor, { key: 'V', code: 'KeyV', metaKey: true, shiftKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(readText).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(editor.getText()).toContain('Second line'));
    expect(html(editor)).toBe('<p>First line</p><p></p><p>Second line</p>');
    editor.destroy();
  });

  it('takes the V key by its position on other layouts', async () => {
    const editor = await setup();
    const event = press(editor, { key: 'М', code: 'KeyV', metaKey: true, shiftKey: true });
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(editor.getText()).toContain('First line'));
    editor.destroy();
  });

  it('pastes nothing when the clipboard read is refused', async () => {
    readText.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    const editor = await setup();
    press(editor, { key: 'V', code: 'KeyV', metaKey: true, shiftKey: true });
    await Promise.resolve();
    expect(html(editor)).toBe('<p></p>');
    editor.destroy();
  });

  it("leaves Cmd+Option+Shift+V to the browser's Paste and Match Style", async () => {
    const editor = await setup();
    const event = press(editor, { key: '◊', code: 'KeyV', metaKey: true, altKey: true, shiftKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(readText).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("leaves Ctrl+Shift+V on Windows and Linux to the browser's plain paste", async () => {
    platform.apple = false;
    const editor = await setup();
    const event = press(editor, { key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(readText).not.toHaveBeenCalled();
    editor.destroy();
  });

  it('pastes a formatted clipboard as text when the paste comes with Shift held', async () => {
    platform.apple = false;
    const editor = await setup();
    press(editor, { key: 'Shift', keyCode: 16, shiftKey: true });
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    const data: Record<string, string> = {
      'text/html': '<p><b style="color:red">Bold</b> and <i>slanted</i></p>',
      'text/plain': 'Bold and slanted',
    };
    Object.defineProperty(paste, 'clipboardData', { value: { getData: (type: string) => data[type] ?? '', files: [] } });
    editor.view.dom.dispatchEvent(paste);
    expect(html(editor)).toBe('<p>Bold and slanted</p>');
    editor.destroy();
  });
});
