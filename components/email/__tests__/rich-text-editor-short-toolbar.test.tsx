import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import React from 'react';

import { RichTextEditor } from '../rich-text-editor';

// settings-p2-19: a three-line out-of-office reply doesn't need the
// composer's headings, code block and table. The short toolbar keeps bold,
// italic, underline, the lists and link.

async function setup(toolbar?: 'full' | 'short') {
  let ready = false;
  render(<RichTextEditor content="<p>Hello</p>" onChange={() => {}} toolbar={toolbar} onEditorReady={() => { ready = true; }} />);
  await waitFor(() => expect(ready).toBe(true));
  return Array.from(screen.getByRole('toolbar', { name: 'formatting' }).querySelectorAll<HTMLElement>('[data-toolbar-item]'))
    .map((el) => el.dataset.toolbarItem);
}

describe('the short formatting toolbar', () => {
  it('has only bold, italic, underline, the lists and link', async () => {
    expect(await setup('short')).toEqual(['bold', 'italic', 'underline', 'bullet-list', 'ordered-list', 'link']);
  });

  it('leaves the full toolbar as it was', async () => {
    const items = await setup();
    for (const name of ['font-size', 'heading-1', 'code-block', 'table', 'text-color', 'undo']) expect(items).toContain(name);
  });
});
