import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Editor } from '@tiptap/core';
import { RichTextEditor } from '../rich-text-editor';

// The composer's font size menu at 150 % zoom ran off the bottom of the window.
// A popover that doesn't fit under its button opens above it when there's more
// room there, and scrolls inside either way.

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

afterEach(() => {
  vi.restoreAllMocks();
});

async function openFontSize(triggerTop: number, height = 300) {
  Object.defineProperty(window, 'innerHeight', { value: 480, configurable: true });
  Object.defineProperty(window, 'innerWidth', { value: 853, configurable: true });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.getAttribute('role') === 'menu') return rect(100, triggerTop + 36, 120, height);
    if (this.getAttribute('role') === 'toolbar') return rect(0, triggerTop - 4, 853, 40);
    if (this.dataset.toolbarItem === 'font-size') return rect(100, triggerTop, 32, 32);
    return rect(0, 0, 0, 0);
  });
  let editor: Editor | null = null;
  render(<RichTextEditor content="<p>Hello</p>" onChange={() => {}} onEditorReady={(ed) => { editor = ed as unknown as Editor; }} />);
  await waitFor(() => expect(editor).not.toBeNull());
  fireEvent.click(document.querySelector<HTMLButtonElement>('[data-toolbar-item="font-size"]')!);
  return screen.getByRole('menu', { name: 'font_size' });
}

describe('a composer toolbar popover in a short window', () => {
  it('opens above its button when there is more room there, capped to it', async () => {
    const menu = await openFontSize(360);
    expect(menu.style.bottom).toBe('100%');
    expect(menu.style.maxHeight).toBe('300px');
    expect(menu.style.overflowY).toBe('auto');
  });

  it('stays under its button and scrolls when there is more room below', async () => {
    const menu = await openFontSize(100, 400);
    expect(menu.style.bottom).toBe('');
    expect(menu.style.maxHeight).toBe(`${480 - 10 - 136}px`);
    expect(menu.style.overflowY).toBe('auto');
  });
});
