import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { Editor } from '@tiptap/core';

import { RichTextEditor, withLinkScheme } from '../rich-text-editor';

// Insert link asks in the app's own dialog (R4), not window.prompt("URL"),
// and a link already there can be removed from it.

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

describe('Insert link', () => {
  it('asks for the address in a dialog and links the selection', async () => {
    const prompt = vi.spyOn(window, 'prompt');
    const editor = await setup('<p>docs here</p>');
    act(() => { editor.commands.setTextSelection({ from: 1, to: 5 }); });

    fireEvent.click(screen.getByTitle('link'));
    expect(prompt).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'insert_link' });
    fireEvent.change(dialog.querySelector('input')!, { target: { value: 'example.com/docs' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    expect(editor.getHTML()).toContain('href="https://example.com/docs"');
  });

  it('opens on Ctrl+K in the text, as in Gmail, Outlook and Word', async () => {
    const editor = await setup('<p>docs here</p>');
    act(() => { editor.commands.setTextSelection({ from: 1, to: 5 }); });

    const event = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true });
    act(() => { editor.view.dom.dispatchEvent(event); });

    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByRole('dialog', { name: 'insert_link' })).toBeInTheDocument();
  });

  it('removes a link from the dialog', async () => {
    const editor = await setup('<p><a href="https://example.com">docs</a> here</p>');
    act(() => { editor.commands.setTextSelection(2); });

    fireEvent.click(screen.getByTitle('link'));
    expect(screen.getByRole('dialog', { name: 'edit_link' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'remove_link' }));

    expect(editor.getHTML()).not.toContain('href=');
  });

  it('keeps addresses that name their scheme', () => {
    expect(withLinkScheme('mailto:a@example.org')).toBe('mailto:a@example.org');
    expect(withLinkScheme('http://example.org')).toBe('http://example.org');
    expect(withLinkScheme('example.org')).toBe('https://example.org');
  });
});
