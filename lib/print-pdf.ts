/**
 * Print a PDF through the browser's own PDF viewer (Chromium's in the desktop
 * app): the file goes into a frame off screen, and that frame's print()
 * brings up the print dialog with the PDF's pages, not the app around it.
 * Used by the file preview's Print button (components/files/file-preview-modal.tsx)
 * and by a plugin printing a PDF it made (api.ui.print with `pdf`).
 *
 * `url` is a blob: URL of the app's own origin, so the frame's window can be
 * reached. The frame goes after printing, or after a minute when the
 * browser never says printing ended.
 */

const CLEANUP_MS = 60_000;
const LOAD_TIMEOUT_MS = 15_000;

export function printPdfUrl(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    // Off screen but laid out: some browsers print nothing from a frame
    // with display: none.
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:600px;border:0;visibility:hidden;';
    let done = false;
    const remove = () => frame.remove();
    const finish = (printed: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(loadTimer);
      if (!printed) remove();
      resolve(printed);
    };
    const loadTimer = setTimeout(() => finish(false), LOAD_TIMEOUT_MS);
    frame.addEventListener('load', () => {
      const view = frame.contentWindow;
      if (!view) {
        finish(false);
        return;
      }
      try {
        view.addEventListener('afterprint', remove, { once: true });
      } catch {
        // The PDF viewer's window may not take listeners; the timer cleans up.
      }
      setTimeout(remove, CLEANUP_MS);
      try {
        view.focus();
        view.print();
        finish(true);
      } catch {
        finish(false);
      }
    }, { once: true });
    frame.src = url;
    document.body.appendChild(frame);
  });
}
