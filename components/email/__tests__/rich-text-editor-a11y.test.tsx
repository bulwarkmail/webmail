import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { Editor } from '@tiptap/core';

import { RichTextEditor } from '../rich-text-editor';

type Props = Partial<React.ComponentProps<typeof RichTextEditor>>;

async function setup(props: Props = {}) {
  let editor: Editor | null = null;
  const view = render(
    <RichTextEditor
      content="<p>Hello</p>"
      onChange={() => {}}
      onEditorReady={(ed) => { editor = ed as unknown as Editor; }}
      {...props}
    />
  );
  await waitFor(() => expect(editor).not.toBeNull());
  const rerender = (next: Props) => view.rerender(
    <RichTextEditor content="<p>Hello</p>" onChange={() => {}} {...props} {...next} />
  );
  return { ...view, editor: editor as unknown as Editor, rerender };
}

describe('RichTextEditor editing area (SR-07)', () => {
  it('is a named multi-line textbox', async () => {
    const { editor } = await setup({ ariaLabel: 'Message' });
    const dom = editor.view.dom;
    expect(dom).toHaveAttribute('role', 'textbox');
    expect(dom).toHaveAttribute('aria-multiline', 'true');
    expect(dom).toHaveAttribute('aria-label', 'Message');
    expect(dom).not.toHaveAttribute('aria-invalid');
  });

  it('marks the body invalid and points at the error once validation fails', async () => {
    const { editor, rerender } = await setup({ ariaLabel: 'Message', ariaDescribedBy: 'body-error' });
    expect(editor.view.dom).not.toHaveAttribute('aria-describedby');

    rerender({ ariaInvalid: true });
    await waitFor(() => expect(editor.view.dom).toHaveAttribute('aria-invalid', 'true'));
    expect(editor.view.dom).toHaveAttribute('aria-describedby', 'body-error');
    // Still the editor's own class and name.
    expect(editor.view.dom).toHaveClass('tiptap');
    expect(editor.view.dom).toHaveAttribute('aria-label', 'Message');

    rerender({ ariaInvalid: false });
    await waitFor(() => expect(editor.view.dom).not.toHaveAttribute('aria-invalid'));
  });
});

describe('RichTextEditor formatting toolbar (SR-08)', () => {
  const toolbar = () => screen.getByRole('toolbar', { name: 'formatting' });
  const item = (name: string) => toolbar().querySelector<HTMLButtonElement>(`[data-toolbar-item="${name}"]`)!;
  const tabStops = () => Array.from(toolbar().querySelectorAll<HTMLElement>('[data-toolbar-item]')).filter((el) => el.tabIndex === 0);

  it('is one Tab stop and moves with the arrows, Home and End', async () => {
    await setup();
    expect(tabStops()).toEqual([item('font-size')]);

    item('font-size').focus();
    fireEvent.keyDown(item('font-size'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(item('bold'));
    expect(tabStops()).toEqual([item('bold')]);
    fireEvent.keyDown(item('bold'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(item('font-size'));
    // End goes to the last button that can be used (disabled ones are skipped).
    const enabled = Array.from(toolbar().querySelectorAll<HTMLButtonElement>('[data-toolbar-item]')).filter((b) => !b.disabled);
    fireEvent.keyDown(item('font-size'), { key: 'End' });
    expect(document.activeElement).toBe(enabled[enabled.length - 1]);
    fireEvent.keyDown(enabled[enabled.length - 1], { key: 'Home' });
    expect(document.activeElement).toBe(item('font-size'));
  });

  it('says which toggles are on', async () => {
    // As in the composer, a change re-renders the editor through its parent.
    let editor: Editor | null = null;
    function Host() {
      const [html, setHtml] = React.useState('<p>Hello</p>');
      return <RichTextEditor content={html} onChange={setHtml} onEditorReady={(ed) => { editor = ed as unknown as Editor; }} />;
    }
    render(<Host />);
    await waitFor(() => expect(editor).not.toBeNull());
    expect(item('bold')).toHaveAttribute('aria-pressed', 'false');
    act(() => { editor!.chain().selectAll().toggleBold().run(); });
    await waitFor(() => expect(item('bold')).toHaveAttribute('aria-pressed', 'true'));
    expect(item('italic')).toHaveAttribute('aria-pressed', 'false');
  });

  it('follows the caret into and out of bold text without a text change', async () => {
    const { editor } = await setup({ content: '<p><strong>Bold</strong> plain</p>' });
    act(() => { editor.commands.setTextSelection(3); });
    await waitFor(() => expect(item('bold')).toHaveAttribute('aria-pressed', 'true'));
    act(() => { editor.commands.setTextSelection(9); });
    await waitFor(() => expect(item('bold')).toHaveAttribute('aria-pressed', 'false'));
  });

  it('opens the font size menu by keyboard, moves inside it and gives the focus back on Escape', async () => {
    await setup();
    const button = item('font-size');
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(button).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('menu', { name: 'font_size' });
    const entries = within(menu).getAllByRole('menuitemradio');
    await waitFor(() => expect(document.activeElement).toBe(entries[0]));
    fireEvent.keyDown(entries[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(entries[1]);

    fireEvent.keyDown(entries[1], { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'font_size' })).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('names the colour swatches and moves through them as a grid', async () => {
    await setup();
    fireEvent.click(item('text-color'));
    const menu = screen.getByRole('menu', { name: 'text_color' });
    const swatches = within(menu).getAllByRole('menuitemradio');
    expect(swatches[0]).toHaveAccessibleName('colors.black');
    await waitFor(() => expect(document.activeElement).toBe(swatches[0]));
    fireEvent.keyDown(swatches[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(swatches[8]);
    fireEvent.keyDown(swatches[8], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(swatches[9]);
  });

  it('jumps from the text to the toolbar with Alt+F10', async () => {
    const { editor } = await setup();
    editor.commands.focus();
    fireEvent.keyDown(editor.view.dom, { key: 'F10', altKey: true });
    expect(document.activeElement).toBe(item('font-size'));
  });
});

describe('RichTextEditor default text style (CO-16)', () => {
  it('shows the text in the chosen font and size', async () => {
    const { editor } = await setup({ defaultTextStyle: { fontFamily: 'monospace', fontSize: '20px' } });
    expect(editor.view.dom.style.fontFamily).toBe('monospace');
    expect(editor.view.dom.style.fontSize).toBe('20px');
  });
});

describe('RichTextEditor image descriptions (MA-02)', () => {
  function imageDrop(file: File) {
    const event = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(event, 'dataTransfer', {
      value: { files: [file], types: ['Files'], getData: () => '' },
    });
    return event;
  }

  async function dropImage() {
    const onChange = vi.fn();
    const { editor } = await setup({ onChange, onImageUpload: async () => ({ src: 'data:image/png;base64,AAAA' }) });
    editor.view.posAtCoords = () => ({ pos: 1, inside: -1 });
    await act(async () => { editor.view.dom.dispatchEvent(imageDrop(new File(['png'], 'IMG_2041.png', { type: 'image/png' }))); });
    return { editor, onChange };
  }

  const altDialog = () => screen.getByRole('dialog', { name: 'title' });
  const html = (editor: Editor) => editor.getHTML();

  it('asks for a description when an image is dropped in, and never uses the file name', async () => {
    const { editor } = await dropImage();
    const dialog = await waitFor(() => altDialog());
    expect(html(editor)).not.toContain('IMG_2041');
    expect(html(editor)).not.toMatch(/alt=/);

    fireEvent.change(within(dialog).getByLabelText('label'), { target: { value: 'A red bicycle' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'save' }));
    await waitFor(() => expect(html(editor)).toContain('alt="A red bicycle"'));
    expect(screen.queryByRole('dialog', { name: 'title' })).toBeNull();
  });

  it('marks an image decorative with an empty alt', async () => {
    const { editor } = await dropImage();
    const dialog = await waitFor(() => altDialog());
    fireEvent.click(within(dialog).getByLabelText('decorative'));
    expect(within(dialog).getByLabelText('label')).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'save' }));
    await waitFor(() => expect(html(editor)).toContain('alt=""'));
  });

  it('edits the description of an image already in the text from the toolbar', async () => {
    const { editor } = await setup({ content: '<p>See <img src="data:image/png;base64,BBBB" alt="Old chart"></p>' });
    let imagePos = -1;
    editor.state.doc.descendants((node, pos) => { if (node.type.name === 'image') imagePos = pos; });
    act(() => { editor.commands.setNodeSelection(imagePos); });

    const button = await waitFor(() => {
      const el = screen.getByRole('toolbar', { name: 'formatting' }).querySelector<HTMLButtonElement>('[data-toolbar-item="image-alt"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(button).toHaveAccessibleName('image_alt.edit');
    fireEvent.click(button);

    const dialog = altDialog();
    const input = within(dialog).getByLabelText('label') as HTMLInputElement;
    expect(input.value).toBe('Old chart');
    fireEvent.change(input, { target: { value: 'Sales by month, rising from March' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'save' }));
    await waitFor(() => expect(html(editor)).toContain('alt="Sales by month, rising from March"'));
  });
});

describe('streamlined composer formatting', () => {
  it('reveals all typography controls and applies a font to the retained text selection', async () => {
    const {editor}=await setup({streamlinedToolbar:true});
    expect(screen.queryByRole('button',{name:'Font family'})).toBeNull();
    const more=screen.getByRole('button',{name:'More formatting'});
    expect(more).toHaveAttribute('aria-expanded','false');
    act(()=>{editor.commands.selectAll();});
    fireEvent.click(more);
    const group=screen.getByRole('group',{name:'Typography and spacing'});
    expect(more).toHaveAttribute('aria-controls',group.id);
    fireEvent.click(within(group).getByRole('button',{name:'Font family'}));
    fireEvent.click(screen.getByRole('menuitemradio',{name:'Georgia'}));
    expect(editor.getText()).toBe('Hello');
    expect(editor.getAttributes('textStyle').fontFamily).toContain('Georgia');
    expect(within(group).getByRole('button',{name:'Font family'})).toHaveTextContent('Georgia');
    act(()=>{editor.chain().focus().setFontFamily('Aptos, sans-serif').run();});
    expect(within(group).getByRole('button',{name:'Font family'})).toHaveTextContent('Aptos');
    expect(within(group).getByRole('button',{name:'Paragraph spacing'})).toBeInTheDocument();
    expect(within(group).getByRole('button',{name:'Line height'})).toBeInTheDocument();
    expect(within(group).getByRole('button',{name:'Insert Markdown or HTML'})).toBeInTheDocument();
  });
  it('lets a nested menu consume Escape before closing the expanded row and returning focus', async () => {
    await setup({streamlinedToolbar:true});
    const more=screen.getByRole('button',{name:'More formatting'});
    fireEvent.click(more);
    const font=screen.getByRole('button',{name:'Font family'});
    fireEvent.click(font);
    fireEvent.keyDown(screen.getByRole('menu',{name:'Font family'}),{key:'Escape'});
    expect(screen.getByRole('group',{name:'Typography and spacing'})).toBeInTheDocument();
    expect(font).toHaveFocus();
    fireEvent.keyDown(font,{key:'Escape'});
    expect(screen.queryByRole('group',{name:'Typography and spacing'})).toBeNull();
    expect(more).toHaveFocus();
    expect(more).toHaveAttribute('aria-expanded','false');
    const stops=screen.getByRole('toolbar',{name:'formatting'}).querySelectorAll('[data-toolbar-item][tabindex="0"]');
    expect([...stops]).toEqual([more]);
  });
  it('keeps arrow navigation within the mounted formatting controls', async () => {
    await setup({streamlinedToolbar:true});
    const more=screen.getByRole('button',{name:'More formatting'});
    more.focus();
    fireEvent.keyDown(more,{key:'ArrowRight'});
    expect(document.activeElement).toHaveAttribute('data-toolbar-item','font-size');
    fireEvent.click(more);
    fireEvent.keyDown(more,{key:'ArrowRight'});
    expect(document.activeElement).toHaveAttribute('data-toolbar-item','font-family');
  });
  it('tracks fonts inherited from pasted paragraphs when the caret moves without editing', async () => {
    const {editor}=await setup({streamlinedToolbar:true,content:'<p style="font-family:Georgia,serif">Hello</p><p style="font-family:Arial,sans-serif">World</p>'});
    const before=editor.getHTML();
    fireEvent.click(screen.getByRole('button',{name:'More formatting'}));
    act(()=>{editor.commands.setTextSelection(2);});
    expect(screen.getByRole('button',{name:'Font family'})).toHaveTextContent('Georgia');
    act(()=>{editor.commands.setTextSelection(9);});
    expect(screen.getByRole('button',{name:'Font family'})).toHaveTextContent('Arial');
    expect(editor.getHTML()).toBe(before);
  });

  it('retains the complete default action set when the compact toolbar expands', async () => {
    const {rerender}=await setup();
    const actions=()=>Array.from(screen.getByRole('toolbar',{name:'formatting'}).querySelectorAll('[data-toolbar-item]')).map(button=>button.getAttribute('data-toolbar-item')).filter(item=>item!=='more-formatting').sort();
    const full=actions();
    rerender({streamlinedToolbar:true});
    fireEvent.click(screen.getByRole('button',{name:'More formatting'}));
    expect(actions()).toEqual(full);
  });

});
