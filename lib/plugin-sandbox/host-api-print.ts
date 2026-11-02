// Host side of api.ui.print: print a page a plugin made, such as an
// invoice drawn from its XML. A plugin frame can't print (its sandbox has
// no allow-modals, and the user would get the whole frame), so the host
// prints the page from a hidden frame of its own.
//
// The page is treated like a message body: sanitised as for the reader
// (styles allowed, no scripts, forms or frames), shown in a frame that
// may not run scripts, under the reader's strict CSP, so it loads nothing
// from the network. Images have to come as data: URLs.

import type { InstalledPlugin } from '../plugin-types';
import { emailIframeCsp, escapeHtml, sanitizeEmailHtmlForIframe } from '../email-sanitization';
import { readObject, readString, withinRate } from './host-api-input';
import { canPrintAnywhere, getStrictestDevices, watermarkAddress, watermarkText } from '../device-policy';
import { watermarkForPrint } from '../watermark';

const MAX_TITLE = 200;
const MAX_HTML = 2 * 1024 * 1024;
/** Print dialogs a plugin may open per minute. */
export const MAX_PRINTS_PER_MINUTE = 3;
/** How long the frame stays when the browser never says printing ended. */
const CLEANUP_MS = 60_000;

/** The document the frame prints. Exported for tests. */
export function printDocument(title: string, html: string, dir: string, watermark?: string | null): string {
  const mark = watermark ? watermarkForPrint(watermark) : null;
  return `<!DOCTYPE html>
<html dir="${dir === 'rtl' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${emailIframeCsp(true)}">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #000; background: #fff; margin: 0; }
  img { max-width: 100%; height: auto; }
  @page { margin: 15mm; }
</style>${mark ? mark.style : ''}</head><body>${mark ? mark.html : ''}${sanitizeEmailHtmlForIframe(html)}</body></html>`;
}

/**
 * Open the browser's print dialog for `page.html`. Resolves to true once
 * the dialog was asked for (the user may still cancel it there).
 */
export async function doUiPrint(plugin: InstalledPlugin, input: unknown): Promise<boolean> {
  const method = 'ui.print';
  const page = readObject(input, method, 'page', ['title', 'html']);
  const title = page.title === undefined ? plugin.name || plugin.id : readString(page.title, method, 'title', MAX_TITLE);
  // eslint-disable-next-line no-control-regex -- a title is one line
  if (/[\u0000-\u001f\u007f]/.test(title)) throw new Error(`${method}: title must be one line`);
  const html = readString(page.html, method, 'html', MAX_HTML);
  // Organisation > Devices > No printing, in any signed-in account.
  if (!canPrintAnywhere()) throw new Error(`${method}: printing is turned off by the organisation`);
  if (!withinRate(method, plugin.id, MAX_PRINTS_PER_MINUTE)) {
    throw new Error(`${method}: at most ${MAX_PRINTS_PER_MINUTE} times a minute`);
  }

  const frame = document.createElement('iframe');
  // Same origin so the host can call print() on it; no allow-scripts, so
  // nothing in the page runs.
  frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  // Off screen but laid out: some browsers print an empty page from a
  // frame with display: none.
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:600px;border:0;visibility:hidden;';
  const watermark = getStrictestDevices().watermark ? watermarkText(watermarkAddress(null)) : null;
  frame.srcdoc = printDocument(title, html, document.documentElement.dir, watermark);

  await new Promise<void>((resolve, reject) => {
    frame.addEventListener('load', () => resolve(), { once: true });
    frame.addEventListener('error', () => reject(new Error(`${method}: the page could not be prepared`)), { once: true });
    document.body.appendChild(frame);
  });

  const view = frame.contentWindow;
  if (!view) {
    frame.remove();
    throw new Error(`${method}: the page could not be prepared`);
  }
  const remove = () => frame.remove();
  view.addEventListener('afterprint', remove, { once: true });
  setTimeout(remove, CLEANUP_MS);
  view.focus();
  view.print();
  return true;
}
