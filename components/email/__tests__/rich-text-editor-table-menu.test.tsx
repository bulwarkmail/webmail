import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import React from 'react';
import type { Editor } from '@tiptap/core';

import { RichTextEditor } from '../rich-text-editor';

// The table menu keeps its colour palette in a "cell background" submenu
// rather than flat between the insert and delete items, and picking a
// swatch there colours the selected cells (setCellBackground) and closes
// both menus. Keys double as labels: next-intl's test setup returns them
// untranslated ('cell_background', 'colors.yellow').

async function setup() {
  let editor: Editor | null = null;
  render(
    <RichTextEditor
      content="<p>Hello</p>"
      onChange={() => {}}
      onEditorReady={(ed) => { editor = ed as unknown as Editor; }}
    />
  );
  await waitFor(() => expect(editor).not.toBeNull());
  return editor as unknown as Editor;
}

describe('the table menu cell-background submenu', () => {
  const openSubmenu = async () => {
    const tableButton = screen.getByRole('toolbar', { name: 'formatting' })
      .querySelector<HTMLButtonElement>('[data-toolbar-item="table"]')!;
    fireEvent.click(tableButton);
    const menu = await screen.findByRole('menu', { name: 'table' });
    // The submenu item sits right below "add column after".
    const items = within(menu).getAllByRole('menuitem');
    const names = items.map((el) => el.textContent?.trim());
    expect(names[names.indexOf('add_column_after') + 1]).toContain('cell_background');
    fireEvent.click(within(menu).getByRole('menuitem', { name: /cell_background/ }));
    return screen.findByRole('menu', { name: 'cell_background' });
  };

  it('colours the selected cells and closes both menus', async () => {
    const editor = await setup();
    editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true });
    const submenu = await openSubmenu();
    // 16 swatches plus the remove entry.
    expect(within(submenu).getAllByRole('menuitemradio')).toHaveLength(16);
    fireEvent.click(within(submenu).getByRole('menuitemradio', { name: 'colors.yellow' }));
    // #f9ab00; jsdom serializes colours as rgb().
    expect(editor.getHTML()).toMatch(/background-color:\s*rgb\(249,\s*171,\s*0\)/i);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    editor.destroy();
  });

  it('clears the colour again through the remove entry', async () => {
    const editor = await setup();
    editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true });
    editor.commands.setCellBackground('#f9ab00');
    const submenu = await openSubmenu();
    fireEvent.click(within(submenu).getByRole('menuitem', { name: /remove_background_color/ }));
    // The yellow is gone, and the header cells no longer show the
    // extension's default grey tint either: clearing a th overrides it
    // with transparent (white on the sent mail's page) rather than
    // dropping the property back to #f5f5f5.
    expect(editor.getHTML()).not.toMatch(/249,\s*171,\s*0/);
    const header = editor.view.dom.querySelector('th');
    expect(header?.style.backgroundColor).toBe('transparent');
    editor.destroy();
  });
});
