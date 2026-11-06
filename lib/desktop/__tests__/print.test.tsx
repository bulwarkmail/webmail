import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { BulwarkDesktopBridge, DesktopPrintPreviewRequest } from '../types';

/**
 * Print in the desktop app goes to the shell's own preview: print windows open hidden under a
 * `bulwark-print-…` name and go over by that name, PDFs as bytes, pages as themselves. In a
 * browser (no bridge) everything prints as before.
 */

type Preview = (request: DesktopPrintPreviewRequest) => Promise<string>;

function setBridge(preview?: Preview, onRequest?: (listener: () => void) => () => void) {
  window.bulwarkDesktop = (preview
    ? { version: 1, platform: 'win32', print: { preview, onRequest: onRequest ?? (() => () => {}) } }
    : undefined) as BulwarkDesktopBridge | undefined;
}

/** A window as window.open gives one, that records print(). */
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
  vi.resetModules();
  document.querySelectorAll('iframe').forEach((frame) => frame.remove());
});

describe('print windows', () => {
  it('open as a tab and print with the browser\'s dialog without the desktop app', async () => {
    const { openPrintWindow, printPrintWindow } = await import('../print');
    const win = openPrintWindow()!;
    expect(opened[0].name).toBe('_blank');
    expect(await printPrintWindow(win, 'Hello')).toBeNull();
    expect(opened[0].win.print).toHaveBeenCalledOnce();
  });

  it('open hidden under a print name in the desktop app and go to its preview by that name', async () => {
    const preview = vi.fn<Preview>(async () => 'printed');
    setBridge(preview);
    const { openPrintWindow, printPrintWindow } = await import('../print');
    const win = openPrintWindow()!;
    expect(opened[0].name).toMatch(/^bulwark-print-[0-9a-f]{16}$/);
    expect(await printPrintWindow(win, 'Quarterly report')).toBe('printed');
    expect(preview).toHaveBeenCalledOnce();
    expect(preview.mock.calls[0][0]).toMatchObject({ source: 'window', name: opened[0].name, title: 'Quarterly report' });
    expect(preview.mock.calls[0][0].theme).toBeDefined();
    expect(opened[0].win.print).not.toHaveBeenCalled();
  });

  it('two print windows get two names', async () => {
    setBridge(vi.fn<Preview>(async () => 'printed'));
    const { openPrintWindow } = await import('../print');
    openPrintWindow();
    openPrintWindow();
    expect(opened[0].name).not.toBe(opened[1].name);
  });

  it('a shell that fails answers "failed", not an error', async () => {
    setBridge(vi.fn<Preview>(async () => { throw new Error('Not allowed'); }));
    const { openPrintWindow, printPrintWindow } = await import('../print');
    expect(await printPrintWindow(openPrintWindow()!, 'x')).toBe('failed');
  });
});

describe('a message', () => {
  const fields = { subject: 'Lunch on Friday', sender: 'Ana <ana@example.org>', to: 'me@example.org', cc: '', date: '6 Nov 2026', attachments: '', plain: false, bodyHtml: '<p>Hello</p>' };
  const labels = { from: 'From', to: 'To', cc: 'Cc', date: 'Date', attachments: 'Attachments' };

  it('goes to the desktop preview from a hidden window, with its subject', async () => {
    const preview = vi.fn<Preview>(async () => 'printed');
    setBridge(preview);
    const { printMessageInWindow } = await import('@/components/email/message-print-window');
    printMessageInWindow(fields as never, { externalBlocked: true, labels });
    await vi.waitFor(() => expect(preview).toHaveBeenCalledOnce());
    expect(opened[0].name).toMatch(/^bulwark-print-/);
    expect(opened[0].win.document.body.textContent).toContain('Hello');
    expect(preview.mock.calls[0][0]).toMatchObject({ source: 'window', name: opened[0].name, title: 'Lunch on Friday' });
    expect(opened[0].win.print).not.toHaveBeenCalled();
  });

  it('prints with the browser\'s dialog without the desktop app', async () => {
    const { printMessageInWindow } = await import('@/components/email/message-print-window');
    printMessageInWindow(fields as never, { externalBlocked: true, labels });
    expect(opened[0].name).toBe('_blank');
    expect(opened[0].win.print).toHaveBeenCalledOnce();
  });

  it('from the list\'s row menu, the window opened in the click is a print window too', async () => {
    setBridge(vi.fn<Preview>(async () => 'printed'));
    vi.doMock('@/lib/device-policy', async (original) => ({ ...(await original<typeof import('@/lib/device-policy')>()), canPrint: () => true }));
    const { requestPrint } = await import('@/hooks/use-message-file-actions');
    expect(requestPrint('k1')).toBe(true);
    expect(opened[0].name).toMatch(/^bulwark-print-/);
    vi.doUnmock('@/lib/device-policy');
  });
});

describe('a PDF', () => {
  it('goes to the desktop preview as bytes, not into a frame', async () => {
    const preview = vi.fn<Preview>(async () => 'printed');
    setBridge(preview);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([37, 80, 68, 70])));
    const { printPdfUrl } = await import('@/lib/print-pdf');
    expect(await printPdfUrl('blob:https://mail.example/pdf-1')).toBe(true);
    expect(fetch).toHaveBeenCalledWith('blob:https://mail.example/pdf-1');
    const request = preview.mock.calls[0][0] as { source: string; data: Uint8Array };
    expect(request.source).toBe('pdf');
    expect(Array.from(request.data)).toEqual([37, 80, 68, 70]);
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('answers false when printing is off and the shell refused', async () => {
    setBridge(vi.fn<Preview>(async () => 'refused'));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([1])));
    const { printPdfUrl } = await import('@/lib/print-pdf');
    expect(await printPdfUrl('blob:https://mail.example/pdf-2')).toBe(false);
  });
});

describe('File > Print and Ctrl+P', () => {
  it('the page previews itself when the shell asks', async () => {
    const preview = vi.fn<Preview>(async () => 'cancelled');
    let asked: (() => void) | null = null;
    const unsubscribe = vi.fn();
    setBridge(preview, (listener) => {
      asked = listener;
      return unsubscribe;
    });
    document.title = 'Inbox';
    const { listenForDesktopPrintRequests } = await import('../print');
    const stop = listenForDesktopPrintRequests();
    expect(asked).not.toBeNull();
    asked!();
    expect(preview).toHaveBeenCalledOnce();
    expect(preview.mock.calls[0][0]).toMatchObject({ source: 'page', title: 'Inbox' });
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('nothing listens without the desktop app', async () => {
    const { listenForDesktopPrintRequests } = await import('../print');
    expect(() => listenForDesktopPrintRequests()()).not.toThrow();
  });
});

describe('a Print button with a print copy (calendar, contacts)', () => {
  it('shows the asked-for copy in each of the preview\'s layouts, and no browser dialog', async () => {
    const { listenForPrinting, requestPrint, usePrintStore } = await import('@/stores/print-store');
    function Page() {
      const printing = usePrintStore((s) => s.printing);
      const target = usePrintStore((s) => s.target);
      return printing ? <div data-print-root="">{target?.kind ?? 'default'}</div> : null;
    }
    const copy = () => document.querySelector('[data-print-root]')?.textContent ?? null;
    render(<Page />);
    const stop = listenForPrinting();
    const seen: (string | null)[] = [];
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    // The shell lays the page out once per preview and once to print: beforeprint, afterprint each time.
    const preview = vi.fn<Preview>(async () => {
      for (let i = 0; i < 2; i += 1) {
        window.dispatchEvent(new Event('beforeprint'));
        seen.push(copy());
        window.dispatchEvent(new Event('afterprint'));
        seen.push(usePrintStore.getState().printing ? 'printing' : 'done');
      }
      return 'printed';
    });
    setBridge(preview);
    await requestPrint({ kind: 'calendar-view' });
    expect(preview).toHaveBeenCalledOnce();
    expect(preview.mock.calls[0][0]).toMatchObject({ source: 'page' });
    expect(seen).toEqual(['calendar-view', 'done', 'calendar-view', 'done']);
    expect(print).not.toHaveBeenCalled();
    // Closed: Ctrl+P prints the page's own copy again.
    window.dispatchEvent(new Event('beforeprint'));
    expect(copy()).toBe('default');
    window.dispatchEvent(new Event('afterprint'));
    stop();
  });
});

describe('a plugin\'s page (ui.print with html)', () => {
  it('goes to the desktop preview from a hidden print window under the reader\'s strict CSP', async () => {
    const preview = vi.fn<Preview>(async () => 'printed');
    setBridge(preview);
    vi.doMock('@/lib/device-policy', async (original) => ({ ...(await original<typeof import('@/lib/device-policy')>()), canPrintAnywhere: () => true }));
    const { doUiPrint } = await import('@/lib/plugin-sandbox/host-api-print');
    const plugin = { id: 'invoice', name: 'Invoice' } as never;
    expect(await doUiPrint(plugin, { title: 'Invoice 42', html: '<h1>Invoice</h1><script>alert(1)</script>' })).toBe(true);
    await vi.waitFor(() => expect(preview).toHaveBeenCalledOnce());
    expect(preview.mock.calls[0][0]).toMatchObject({ source: 'window', name: opened[0].name, title: 'Invoice 42' });
    const doc = opened[0].win.document;
    expect(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain("default-src 'none'");
    expect(doc.querySelector('script')).toBeNull();
    expect(document.querySelector('iframe')).toBeNull();
    vi.doUnmock('@/lib/device-policy');
  });
});
