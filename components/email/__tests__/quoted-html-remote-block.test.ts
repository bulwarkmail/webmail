import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import type { Editor as ReactEditor } from '@tiptap/react';

import { QuotedHtml, buildQuotedHtmlBlock, serializeEditorContent } from '../quoted-html';
import { parkRemoteResources, restoreRemoteResources } from '@/lib/email-sanitization';
import { useSettingsStore } from '@/stores/settings-store';

// The quoted original in a reply renders in the app document (a shadow
// root), where the viewer's iframe CSP does not reach, so opening a reply
// loaded every tracker the viewer had held back.

const QUOTE = '<p>Hi</p><img src="https://t.example/pixel.gif" alt="logo"><table background="https://t.example/bg.gif"><tr><td style="background:url(https://t.example/cell.gif)">x</td></tr></table>';

function mount(html: string): Editor {
  return new Editor({ extensions: [Document, Paragraph, Text, QuotedHtml], content: html });
}

function shadowInner(editor: Editor): HTMLElement {
  const host = editor.view.dom.querySelector('.quoted-html-island') as HTMLElement;
  return host.shadowRoot!.firstElementChild as HTMLElement;
}

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
  useSettingsStore.setState({ externalContentPolicy: 'ask' });
});

describe('parkRemoteResources', () => {
  it('parks every external reference and restores it exactly', () => {
    const { html, parked } = parkRemoteResources(QUOTE);
    expect(parked).toBe(true);
    expect(html).not.toMatch(/\s(src|background)="https:/);
    expect(html).not.toMatch(/ style="[^"]*t\.example/);
    const restored = restoreRemoteResources(html);
    expect(restored).toContain('src="https://t.example/pixel.gif"');
    expect(restored).toContain('background="https://t.example/bg.gif"');
    expect(restored).toContain('url(https://t.example/cell.gif)');
    expect(restored).not.toContain('data-bulwark-remote');
  });

  it('leaves HTML without remote references untouched', () => {
    const html = '<p>plain <img src="data:image/png;base64,AAAA"></p>';
    expect(parkRemoteResources(html)).toEqual({ html, parked: false });
  });
});

describe('QuotedHtml node view', () => {
  it('shows the quote without remote resources but sends it as written', () => {
    editor = mount(buildQuotedHtmlBlock(QUOTE));
    const inner = shadowInner(editor);
    expect(inner.innerHTML).not.toMatch(/\s(src|background)="https:/);
    expect(inner.innerHTML).not.toMatch(/ style="[^"]*t\.example/);

    const sent = serializeEditorContent(editor as unknown as ReactEditor);
    expect(sent).toContain('src="https://t.example/pixel.gif"');
    expect(sent).not.toContain('data-bulwark-remote');
    expect(sent).not.toContain('data-quoted-remote');
  });

  it('keeps the parked references when the user edits inside the quote', async () => {
    editor = mount(buildQuotedHtmlBlock(QUOTE));
    const inner = shadowInner(editor);
    inner.querySelector('p')!.textContent = 'Hi (redacted)';
    inner.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    const sent = serializeEditorContent(editor as unknown as ReactEditor);
    expect(sent).toContain('Hi (redacted)');
    expect(sent).toContain('src="https://t.example/pixel.gif"');
    expect(sent).not.toContain('data-bulwark-remote');
  });

  it('shows remote resources for a trusted sender or under the allow policy', () => {
    editor = mount(buildQuotedHtmlBlock(QUOTE, { remoteAllowed: true }));
    expect(shadowInner(editor).innerHTML).toContain('src="https://t.example/pixel.gif"');
    editor.destroy();

    useSettingsStore.setState({ externalContentPolicy: 'allow' });
    editor = mount(buildQuotedHtmlBlock(QUOTE));
    expect(shadowInner(editor).innerHTML).toContain('src="https://t.example/pixel.gif"');
  });
});
