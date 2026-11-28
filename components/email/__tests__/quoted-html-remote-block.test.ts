import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import type { Editor as ReactEditor } from '@tiptap/react';

import { QuotedHtml, buildQuotedHtmlBlock, serializeEditorContent } from '../quoted-html';
import { parkRemoteResources, restoreRemoteResources } from '@/lib/email-sanitization';
import { useSettingsStore } from '@/stores/settings-store';
import { usePolicyStore } from '@/stores/policy-store';
import { decodeRemoteUrl } from '@/lib/remote-content-proxy';

function setProxyGate(on: boolean) {
  usePolicyStore.setState((s) => ({ policy: { ...s.policy, features: { ...s.policy.features, remoteContentProxyEnabled: on } } }));
}

/** The remote addresses the shown HTML loads, decoded when they go through the proxy. */
function loadedAddresses(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/(?:\s(?:src|background)="|url\(&quot;|url\(")([^"&)]+)/g)) {
    const url = m[1];
    const token = url.split('/api/remote-content/')[1];
    out.push(token ? `proxied:${decodeRemoteUrl(token)}` : url);
  }
  return out;
}

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
  setProxyGate(false);
});

describe('quoted island layout containment', () => {
  it('confines the quoted original to its own box, so a fixed overlay in it cannot cover the app', () => {
    // The shadow root isolates styles, not layout: without containment a
    // sender's `position:fixed; inset:0` element painted over the composer.
    editor = mount(buildQuotedHtmlBlock('<div style="position:fixed;inset:0;z-index:2147483647;background:#fff">Session expired</div>'));
    const host = editor.view.dom.querySelector('.quoted-html-island') as HTMLElement;
    expect(host.style.contain).toBe('paint');
    expect(host.style.position).toBe('relative');
    expect(host.style.overflow).toBe('hidden');
  });
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

  // #1872: with "Remote pictures through this server" on, an allowed quote
  // loads its pictures through this server too, and is still sent as written.
  it('loads an allowed quote through this server while the proxy gate is on', async () => {
    setProxyGate(true);
    editor = mount(buildQuotedHtmlBlock(QUOTE, { remoteAllowed: true }));
    const inner = shadowInner(editor);
    expect(inner.innerHTML).not.toMatch(/\s(src|background)="https:\/\/t\.example/);
    expect(loadedAddresses(inner.innerHTML).sort()).toEqual([
      'proxied:https://t.example/bg.gif',
      'proxied:https://t.example/cell.gif',
      'proxied:https://t.example/pixel.gif',
    ]);

    inner.querySelector('p')!.textContent = 'Hi (edited)';
    inner.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    const sent = serializeEditorContent(editor as unknown as ReactEditor);
    expect(sent).toContain('Hi (edited)');
    expect(sent).toContain('src="https://t.example/pixel.gif"');
    expect(sent).toContain('background="https://t.example/bg.gif"');
    expect(sent).toContain('url(https://t.example/cell.gif)');
    expect(sent).not.toContain('/api/remote-content/');
    expect(sent).not.toContain('data-bulwark-remote');
  });

  it('keeps a held-back quote parked while the proxy gate is on', () => {
    setProxyGate(true);
    editor = mount(buildQuotedHtmlBlock(QUOTE));
    expect(loadedAddresses(shadowInner(editor).innerHTML)).toEqual([]);
  });
});
