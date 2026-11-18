/**
 * Print a previewed file (components/files/file-preview-modal.tsx): an image,
 * a text or Markdown file, or an HTML attachment, alone on the page, without
 * the app around it. A PDF prints through lib/print-pdf.ts, an attached
 * message like one from the reader (printMessageInWindow).
 *
 * The document is a page of its own that runs nothing: the reader's strict
 * CSP (or the HTML preview's, which follows the remote content setting), an
 * image as a data: URL, so it needs no blob: URL of the preview and an SVG
 * stays a picture.
 *
 * In the desktop app it goes to the shell's print preview from a hidden print
 * window (lib/desktop/print.ts); in a browser it prints from a hidden frame,
 * like a plugin's page (lib/plugin-sandbox/host-api-print.ts).
 */

import { emailIframeCsp, escapeHtml } from './email-sanitization';
import { watermarkForPrint } from './watermark';
import { desktopPrintPreviewAvailable, openPrintWindow, printPrintWindow } from './desktop/print';

/** How long the frame stays when the browser never says printing ended. */
const CLEANUP_MS = 60_000;

export type PrintableFile =
  /** `src`: the image as a data: URL. */
  | { kind: 'image'; src: string }
  | { kind: 'text'; text: string }
  /** `html`: the preview's rendered Markdown (React-escaped markup). */
  | { kind: 'markdown'; html: string }
  /** `html`: the sanitised body the preview shows; `blockRemote` as it was sanitised. */
  | { kind: 'html'; html: string; blockRemote: boolean };

const BASE_CSS = `body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #000; background: #fff; margin: 0; }
  @page { margin: 15mm; }`;

const KIND_CSS: Record<PrintableFile['kind'], string> = {
  image: `html, body { height: 100%; }
  body { display: flex; align-items: center; justify-content: center; }
  img { display: block; max-width: 100%; max-height: 100%; object-fit: contain; }
  @page { margin: 10mm; }`,
  text: `pre { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-word; }`,
  markdown: `body { font-size: 14px; line-height: 1.5; }
  h1 { font-size: 24px; margin: 24px 0 12px; }
  h2 { font-size: 20px; margin: 20px 0 8px; }
  h3 { font-size: 17px; margin: 16px 0 8px; }
  p { margin: 4px 0; }
  li { margin: 2px 0 2px 24px; }
  blockquote { margin: 8px 0; padding-inline-start: 16px; border-inline-start: 4px solid #ccc; color: #444; font-style: italic; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; background: #f2f2f2; padding: 1px 4px; border-radius: 3px; }
  pre { background: #f2f2f2; padding: 12px; border-radius: 4px; white-space: pre-wrap; word-break: break-word; }
  pre code { background: none; padding: 0; }
  hr { border: 0; border-top: 1px solid #ccc; margin: 16px 0; }`,
  html: `img { max-width: 100%; height: auto; }`,
};

function bodyOf(file: PrintableFile, title: string): string {
  switch (file.kind) {
    case 'image':
      return `<img src="${escapeHtml(file.src)}" alt="${escapeHtml(title)}">`;
    case 'text':
      return `<pre>${escapeHtml(file.text)}</pre>`;
    case 'markdown':
    case 'html':
      return file.html;
  }
}

/** The page that prints for `file`. Exported for tests. */
export function fileDocument(title: string, file: PrintableFile, watermark?: string | null): string {
  const mark = watermark ? watermarkForPrint(watermark) : null;
  const csp = emailIframeCsp(file.kind === 'html' ? file.blockRemote : true);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>
  ${BASE_CSS}
  ${KIND_CSS[file.kind]}
</style>${mark ? mark.style : ''}</head><body dir="auto">${mark ? mark.html : ''}${bodyOf(file, title)}</body></html>`;
}

/**
 * Print `file` alone. Resolves to true once the print dialog or the desktop
 * app's preview was asked for (the user may still cancel it there).
 */
export async function printFile(title: string, file: PrintableFile, watermark?: string | null): Promise<boolean> {
  const doc = fileDocument(title, file, watermark);

  if (desktopPrintPreviewAvailable()) {
    const win = openPrintWindow();
    if (!win) return false;
    // A link in the page that navigates the window must not get the app as its opener.
    win.opener = null;
    win.document.write(doc);
    win.document.close();
    void printPrintWindow(win, title);
    return true;
  }

  const frame = document.createElement('iframe');
  // Same origin so print() can be called on it; no allow-scripts, so
  // nothing in the page runs.
  frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  // Off screen but laid out: some browsers print an empty page from a
  // frame with display: none.
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:600px;border:0;visibility:hidden;';
  frame.srcdoc = doc;

  const loaded = await new Promise<boolean>((resolve) => {
    frame.addEventListener('load', () => resolve(true), { once: true });
    frame.addEventListener('error', () => resolve(false), { once: true });
    document.body.appendChild(frame);
  });
  const view = frame.contentWindow;
  if (!loaded || !view) {
    frame.remove();
    return false;
  }
  const remove = () => frame.remove();
  view.addEventListener('afterprint', remove, { once: true });
  setTimeout(remove, CLEANUP_MS);
  try {
    // No focus() first, as for a PDF (lib/print-pdf.ts): the frame would keep
    // the keyboard, and Escape would no longer close the preview behind it.
    view.print();
    return true;
  } catch {
    remove();
    return false;
  }
}
