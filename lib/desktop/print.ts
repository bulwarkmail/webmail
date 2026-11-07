/**
 * Print in the desktop app: the shell's own print preview (print.preview, src/main/print-preview.ts
 * in the desktop repo) in place of the OS's dialog, which shows no pages under Electron.
 *
 * - A print window (one message, a plugin's page) opens with a name `bulwark-print-…`, so
 *   the shell keeps it hidden, and the preview shows what was written into it.
 * - A page with a print copy (calendar, contacts) is previewed as it prints.
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

/** A PDF (a blob: URL of this page) in the shell's preview. Null without one. */
export async function previewDesktopPdf(url: string, title?: string): Promise<DesktopPrintPreviewOutcome | null> {
  const bridge = printBridge();
  if (!bridge) return null;
  let data: Uint8Array;
  try {
    data = new Uint8Array(await (await fetch(url)).arrayBuffer());
  } catch {
    return 'failed';
  }
  return preview(bridge, { source: 'pdf', data, ...(title ? { title } : {}) });
}

/**
 * File > Print and Ctrl+P in the desktop app: the shell asks the page, which previews
 * itself with its look. Returns the unsubscribe.
 */
export function listenForDesktopPrintRequests(): () => void {
  const bridge = printBridge();
  if (!bridge || typeof bridge.onRequest !== 'function') return () => {};
  return bridge.onRequest(() => {
    void previewDesktopPage();
  });
}
