import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BulwarkDesktopBridge, DesktopPrintPreviewRequest } from '../desktop/types';
import { fileDocument, printFile } from '../print-file';

/**
 * A previewed image, text, Markdown or HTML file prints as a page of its own
 * that runs nothing: the shell's print preview in the desktop app, a hidden
 * frame's print dialog in a browser.
 */

type Preview = (request: DesktopPrintPreviewRequest) => Promise<string>;

function setBridge(preview?: Preview) {
  window.bulwarkDesktop = (preview
    ? { version: 1, platform: 'win32', print: { preview, onRequest: () => () => {} } }
    : undefined) as BulwarkDesktopBridge | undefined;
}

function fakeWindow(name: string) {
  const doc = document.implementation.createHTMLDocument('');
  return { name, document: doc, opener: {}, print: vi.fn(), focus: vi.fn(), close: vi.fn(), closed: false } as unknown as Window & { print: ReturnType<typeof vi.fn> };
}

let opened: { name: string; win: Window & { print: ReturnType<typeof vi.fn> } }[] = [];

beforeEach(() => {
  opened = [];
  vi.spyOn(window, 'open').mockImplementation(((_url: string, name: string) => {
    const win = fakeWindow(name);
    opened.push({ name, win });
    return win;
  }) as typeof window.open);
});

afterEach(() => {
  setBridge(undefined);
  vi.restoreAllMocks();
  document.querySelectorAll('iframe').forEach((frame) => frame.remove());
});

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('fileDocument', () => {
  it('puts an image in as a data: URL, fitted to the page, under the strict CSP', () => {
    const doc = fileDocument('scan "1".png', { kind: 'image', src: PNG });
    expect(doc).toContain(`<img src="${PNG}" alt="scan &quot;1&quot;.png">`);
    expect(doc).toContain('max-width: 100%; max-height: 100%; object-fit: contain;');
    expect(doc).toContain('<title>scan &quot;1&quot;.png</title>');
    expect(doc).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:;`);
    expect(doc).not.toContain('blob:test');
  });

  it('escapes text into a wrapping <pre>', () => {
    const doc = fileDocument('notes.txt', { kind: 'text', text: '</pre><script>alert(1)</script> & co' });
    expect(doc).toContain('<pre>&lt;/pre&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; co</pre>');
    expect(doc).not.toContain('<script>');
    expect(doc).toContain('white-space: pre-wrap; word-break: break-word;');
  });

  it('styles rendered Markdown for paper', () => {
    const doc = fileDocument('README.md', { kind: 'markdown', html: '<h1>Title</h1><blockquote>q</blockquote>' });
    expect(doc).toContain('<h1>Title</h1><blockquote>q</blockquote>');
    expect(doc).toMatch(/h1 \{[^}]+\}/);
    expect(doc).toMatch(/blockquote \{[^}]+\}/);
    // The preview marks numbered items with Tailwind's class, which the printout lacks.
    expect(doc).toContain('li.list-decimal { list-style-type: decimal; }');
    expect(doc).toContain('margin-inline-start: 24px;');
  });

  it('gives an HTML attachment the CSP its remote content setting asks for', () => {
    expect(fileDocument('a.html', { kind: 'html', html: '<p>x</p>', blockRemote: true })).toContain("img-src data: blob:;");
    expect(fileDocument('a.html', { kind: 'html', html: '<p>x</p>', blockRemote: false })).toContain("img-src data: blob: http: https:;");
  });

  it('carries the watermark when there is one', () => {
    expect(fileDocument('notes.txt', { kind: 'text', text: 'x' }, 'ana@example.org')).toContain('ana@example.org');
    expect(fileDocument('notes.txt', { kind: 'text', text: 'x' }, 'ana@example.org')).toContain('data-testid="watermark"');
    expect(fileDocument('notes.txt', { kind: 'text', text: 'x' })).not.toContain('data-testid="watermark"');
  });
});

describe('printFile', () => {
  it('goes to the desktop preview from a hidden print window', async () => {
    const preview = vi.fn<Preview>(async () => 'printed');
    setBridge(preview);
    expect(await printFile('scan.png', { kind: 'image', src: PNG }, 'ana@example.org')).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0].name).toMatch(/^bulwark-print-/);
    expect(opened[0].win.opener).toBeNull();
    expect(opened[0].win.document.querySelector('img')?.getAttribute('src')).toBe(PNG);
    expect(opened[0].win.document.body.textContent).toContain('ana@example.org');
    await vi.waitFor(() => expect(preview).toHaveBeenCalledOnce());
    expect(preview.mock.calls[0][0]).toMatchObject({ source: 'window', name: opened[0].name, title: 'scan.png' });
    expect(opened[0].win.print).not.toHaveBeenCalled();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('prints from a hidden sandboxed frame in a browser, not a tab', async () => {
    const print = vi.fn();
    const appendChild = document.body.appendChild.bind(document.body);
    vi.spyOn(document.body, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
      appendChild(node);
      if (node instanceof HTMLIFrameElement) {
        Object.defineProperty(node.contentWindow!, 'print', { configurable: true, value: print });
        node.dispatchEvent(new Event('load'));
      }
      return node;
    });
    expect(await printFile('notes.txt', { kind: 'text', text: 'hello' })).toBe(true);
    expect(window.open).not.toHaveBeenCalled();
    const frame = document.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin allow-modals');
    expect(frame.srcdoc).toContain('<pre>hello</pre>');
    expect(print).toHaveBeenCalledOnce();
    // Gone once printing ended.
    frame.contentWindow!.dispatchEvent(new Event('afterprint'));
    expect(document.querySelector('iframe')).toBeNull();
  });
});
