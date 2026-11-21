/**
 * Print in the desktop app: the shell's own print preview (print.preview, src/main/print-preview.ts
 * in the desktop repo) in place of the OS's dialog, which shows no pages under Electron.
 *
 * - A print window (one message, a plugin's page) opens with a name `bulwark-print-…`, so
 *   the shell keeps it hidden, and the preview shows what was written into it.
 * - A page's print copy (mail, calendar, contacts; components/print/print-root.tsx) is
 *   written into such a window too (writePrintCopy). The page itself is never laid out for
 *   printing: the preview does that at every change, at the sheet's width, and the app's
 *   width breakpoints then folded the sidebar and unfolded it again on screen.
 * - A PDF goes over as bytes.
 *
 * Without the bridge (a browser, Lite, an older shell) the helpers print as before: a tab
 * and the browser's dialog.
 */

import { getDesktopBridge } from './bridge';
import { readDialogTheme } from './dialog-window';
import type { DesktopPrintBridge, DesktopPrintPreviewOutcome, DesktopPrintPreviewRequest } from './types';

export const PRINT_WINDOW_PREFIX = 'bulwark-print-';

function printBridge(): DesktopPrintBridge | null {
  const print = getDesktopBridge()?.print;
  return print && typeof print.preview === 'function' ? print : null;
}

export function desktopPrintPreviewAvailable(): boolean {
  return printBridge() !== null;
}

function preview(bridge: DesktopPrintBridge, request: DesktopPrintPreviewRequest): Promise<DesktopPrintPreviewOutcome> {
  return bridge.preview({ ...request, theme: readDialogTheme() }).catch(() => 'failed' as const);
}

function windowName(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return PRINT_WINDOW_PREFIX + Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A window to write a printout into: hidden for the preview in the desktop app, a tab elsewhere. */
export function openPrintWindow(): Window | null {
  return window.open('', printBridge() ? windowName() : '_blank');
}

function isPreviewWindow(win: Window): boolean {
  try {
    return win.name.startsWith(PRINT_WINDOW_PREFIX);
  } catch {
    return false;
  }
}

/**
 * Prints what was written into a window from openPrintWindow: the shell's preview in the
 * desktop app, the browser's dialog elsewhere. Resolves once the preview closed (at once in
 * a browser).
 */
export async function printPrintWindow(win: Window, title: string): Promise<DesktopPrintPreviewOutcome | null> {
  const bridge = printBridge();
  if (bridge && isPreviewWindow(win)) return preview(bridge, { source: 'window', name: win.name, title });
  win.focus();
  win.print();
  return null;
}

/** This page as it prints, in the shell's preview. Null without one. */
export function previewDesktopPage(title?: string): Promise<DesktopPrintPreviewOutcome> | null {
  const bridge = printBridge();
  return bridge ? preview(bridge, { source: 'page', title: title ?? document.title }) : null;
}

/**
 * A PDF in the shell's preview: its Blob, or a blob: URL of this page. Null without one.
 * Pass the Blob where there is one: the CSP's connect-src keeps a blob: URL from being
 * fetched (#871).
 */
export async function previewDesktopPdf(pdf: string | Blob, title?: string): Promise<DesktopPrintPreviewOutcome | null> {
  const bridge = printBridge();
  if (!bridge) return null;
  let data: Uint8Array;
  try {
    data = new Uint8Array(await (typeof pdf === 'string' ? await fetch(pdf) : pdf).arrayBuffer());
  } catch {
    return 'failed';
  }
  return preview(bridge, { source: 'pdf', data, ...(title ? { title } : {}) });
}

function escapeText(text: string): string {
  return text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
}

const SHADOW_MARK = 'data-print-shadow';

/**
 * An element's markup with its pictures' and links' addresses made absolute, for a document
 * elsewhere. An open shadow root (a message's body is drawn in one) can't go into markup:
 * its host gets a mark, and `shadows` the content to put back there.
 */
function markupOf(element: Element, shadows: string[]): string {
  const copy = element.cloneNode(true) as Element;
  const originals = [element, ...element.querySelectorAll('*')];
  const clones = [copy, ...copy.querySelectorAll('*')];
  originals.forEach((original, index) => {
    const clone = clones[index];
    if (original instanceof HTMLImageElement && original.getAttribute('src')) clone.setAttribute('src', original.src);
    if (original instanceof HTMLLinkElement && original.getAttribute('href')) clone.setAttribute('href', original.href);
    if (original.shadowRoot) {
      clone.setAttribute(SHADOW_MARK, String(shadows.length));
      shadows.push(original.shadowRoot.innerHTML);
    }
  });
  copy.querySelectorAll('script').forEach((script) => script.remove());
  return copy.outerHTML;
}

/**
 * Writes this page's print copies (`body > [data-print-root]`, rendered just now) into a
 * print window, with the page's style sheets, so the preview lays that window out and never
 * this page. Without a copy, a still picture of the page as it stands. Nothing in it runs.
 */
export function writePrintCopy(win: Window, title: string): void {
  const root = document.documentElement;
  const attributes = ['lang', 'dir', 'class', 'style']
    .map((name) => [name, root.getAttribute(name)] as const)
    .filter(([, value]) => value !== null)
    .map(([name, value]) => ` ${name}="${escapeText(value!)}"`)
    .join('');
  const shadows: string[] = [];
  const styles = Array.from(document.head.querySelectorAll('link[rel="stylesheet"], style'), (element) => markupOf(element, shadows)).join('');
  const copies = Array.from(document.querySelectorAll('body > [data-print-root]'));
  const parts = copies.length > 0 ? copies : Array.from(document.body.children).filter((child) => child.tagName !== 'SCRIPT');
  const body = parts.map((element) => markupOf(element, shadows)).join('');
  win.document.open();
  win.document.write(`<!DOCTYPE html><html${attributes}><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'">`
    + `<title>${escapeText(title)}</title>${styles}</head><body>${body}</body></html>`);
  win.document.close();
  // The shadow roots, put back from here: the window itself runs nothing.
  win.document.querySelectorAll(`[${SHADOW_MARK}]`).forEach((host) => {
    const content = shadows[Number(host.getAttribute(SHADOW_MARK))];
    host.removeAttribute(SHADOW_MARK);
    if (content === undefined) return;
    try {
      (host.shadowRoot ?? host.attachShadow({ mode: 'open' })).innerHTML = content;
    } catch {
      // An element that can't hold a shadow root: it keeps what it has.
    }
  });
}

/**
 * File > Print and Ctrl+P in the desktop app: the shell asks the page, and `print` (the
 * print store's) prints its copy. Returns the unsubscribe.
 */
export function listenForDesktopPrintRequests(print: () => void): () => void {
  const bridge = printBridge();
  if (!bridge || typeof bridge.onRequest !== 'function') return () => {};
  return bridge.onRequest(print);
}
