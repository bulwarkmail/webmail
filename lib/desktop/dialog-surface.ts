/**
 * The app's dialogs as windows of their own, in the desktop app. The page opens an
 * about:blank window named `bulwark-dialog-…`; the shell makes it a frameless,
 * transparent child of the window that opened it, modal to it and the size of its page
 * (src/main/dialog-surfaces.ts in the desktop repo). The page copies its stylesheets,
 * theme, language and direction into it and keeps them in step, and React draws the
 * dialog into it through a portal (components/ui/dialog-surface.tsx), so the dialog keeps
 * its state, its handlers and its look. The card stands in the middle as it does over the
 * page; the rest of the window is transparent.
 *
 * Without the shell's `dialogs.showWindow` (the browser, Lite, an older shell) nothing
 * here opens anything, and the dialog shows in the page.
 */

import { getDesktopBridge } from './bridge';

const PREFIX = 'bulwark-dialog-';
const MIRROR = 'data-bulwark-mirror';
/** How long the window waits for the stylesheets before it shows anyway. */
const STYLE_WAIT_MS = 3000;

export interface DialogSurface {
  name: string;
  win: Window;
  doc: Document;
  /** Where the dialog is drawn: fills the window, the card in its middle. */
  root: HTMLElement;
  /** Closes the window. Not a user's close: `onUserClose` doesn't run. */
  close: () => void;
}

export interface DialogSurfaceOptions {
  title: string;
  /** The user closed the window itself (Alt+F4, Cmd+W): close the dialog as Escape would. */
  onUserClose: () => void;
  /** The shell didn't take the window: draw the dialog in the page. */
  onFailed: () => void;
}

export function dialogSurfacesAvailable(): boolean {
  return typeof getDesktopBridge()?.dialogs?.showWindow === 'function';
}

let counter = 0;

/** The rules the window needs on top of the app's: a transparent page, a draggable header. */
const SURFACE_CSS = `
html, body { background: transparent !important; margin: 0 !important; height: 100%; overflow: hidden; }
#bulwark-dialog-root { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; box-sizing: border-box; padding: 1rem; padding-top: calc(1rem + var(--titlebar-row-height, 0px)); }
[data-dialog-drag] { -webkit-app-region: drag; }
[data-dialog-drag] :is(a, button, input, select, textarea, label, summary, [role="button"], [contenteditable], [tabindex]) { -webkit-app-region: no-drag; }
[data-modal-backdrop] { background: transparent !important; backdrop-filter: none !important; animation: none !important; }
`;

/** The page's stylesheets in the window, in their order, kept in step with the page's head. */
function mirrorStyles(source: Document, target: Document): { stop: () => void; loaded: Promise<void> } {
  const clones = new Map<Element, Element>();
  const pending: Promise<void>[] = [];
  const isStyle = (node: Element) => node.matches('style, link[rel~="stylesheet"]');
  const cloneOf = (node: Element): Element => {
    const clone = target.importNode(node, true) as Element;
    if (clone.tagName === 'LINK' && node instanceof HTMLLinkElement) {
      (clone as HTMLLinkElement).href = node.href;
      pending.push(new Promise((resolve) => {
        clone.addEventListener('load', () => resolve(), { once: true });
        clone.addEventListener('error', () => resolve(), { once: true });
      }));
    }
    clone.setAttribute(MIRROR, '');
    return clone;
  };
  const sync = () => {
    const current = [...source.head.children].filter(isStyle);
    for (const [original, clone] of clones) {
      if (!current.includes(original)) {
        clone.remove();
        clones.delete(original);
      }
    }
    let previous: Element | null = null;
    for (const original of current) {
      let clone = clones.get(original);
      if (!clone) {
        clone = cloneOf(original);
        clones.set(original, clone);
        if (previous?.nextSibling) target.head.insertBefore(clone, previous.nextSibling);
        else if (previous) target.head.appendChild(clone);
        else target.head.insertBefore(clone, target.head.firstChild);
      } else if (original instanceof HTMLStyleElement && clone.textContent !== original.textContent) {
        clone.textContent = original.textContent;
      }
      previous = clone;
    }
  };
  sync();
  const observer = new MutationObserver(sync);
  observer.observe(source.head, { childList: true, subtree: true, characterData: true });
  const wait = new Promise<void>((resolve) => setTimeout(resolve, STYLE_WAIT_MS));
  return { stop: () => observer.disconnect(), loaded: Promise.race([Promise.all(pending).then(() => undefined), wait]) };
}

/** The page's root and body attributes (theme class, CSS variables, lang, dir) in the window. */
function mirrorAttributes(source: Element, target: Element, skip: string[] = []): () => void {
  const sync = () => {
    for (const attribute of [...target.attributes]) {
      if (!skip.includes(attribute.name) && !source.hasAttribute(attribute.name)) target.removeAttribute(attribute.name);
    }
    for (const attribute of [...source.attributes]) {
      if (!skip.includes(attribute.name) && target.getAttribute(attribute.name) !== attribute.value) target.setAttribute(attribute.name, attribute.value);
    }
  };
  sync();
  const observer = new MutationObserver(sync);
  observer.observe(source, { attributes: true });
  return () => observer.disconnect();
}

/**
 * Opens a window for one dialog from `opener` (this page's window, or the window of the
 * dialog this one is opened from). Null when the shell can't, so the dialog shows in the page.
 */
export function openDialogSurface(opener: Window, options: DialogSurfaceOptions): DialogSurface | null {
  const bridge = getDesktopBridge()?.dialogs;
  if (typeof bridge?.showWindow !== 'function') return null;
  counter += 1;
  const name = `${PREFIX}${counter}-${Math.random().toString(36).slice(2, 8)}`;
  let win: Window | null = null;
  try {
    win = opener.open('', name);
  } catch {
    win = null;
  }
  if (!win) return null;
  let doc: Document;
  try {
    doc = win.document;
    if (!doc.body) throw new Error('no body');
  } catch {
    win.close();
    return null;
  }

  const source = document;
  doc.title = options.title || 'Bulwark';
  const base = doc.createElement('base');
  base.href = source.baseURI;
  doc.head.appendChild(base);
  const own = doc.createElement('style');
  own.textContent = SURFACE_CSS;
  const styles = mirrorStyles(source, doc);
  doc.head.appendChild(own);
  const stopRoot = mirrorAttributes(source.documentElement, doc.documentElement);
  const stopBody = mirrorAttributes(source.body, doc.body, ['style']);
  const root = doc.createElement('div');
  root.id = 'bulwark-dialog-root';
  // The page's zoom (Ctrl + and -): the window itself is at 100%.
  const zoom = Math.round((window.devicePixelRatio / (win.devicePixelRatio || window.devicePixelRatio)) * 100) / 100;
  if (Number.isFinite(zoom) && zoom > 0 && zoom !== 1) root.style.zoom = String(zoom);
  doc.body.appendChild(root);

  let closing = false;
  const stopAll = () => {
    styles.stop();
    stopRoot();
    stopBody();
    window.removeEventListener('pagehide', closeWindow);
  };
  const closeWindow = () => {
    if (closing) return;
    closing = true;
    stopAll();
    try {
      win!.close();
    } catch {
      // Gone already.
    }
  };
  // The page going away takes its dialog with it.
  window.addEventListener('pagehide', closeWindow);
  // Alt+F4 or Cmd+W on the window: the dialog closes as with Escape.
  win.addEventListener('pagehide', () => {
    if (closing) return;
    closing = true;
    stopAll();
    options.onUserClose();
  });

  // Shown once it looks like the app: the stylesheets in, the fonts there.
  void styles.loaded
    .then(() => Promise.race([doc.fonts?.ready, new Promise((resolve) => setTimeout(resolve, 1000))]))
    .then(() => (closing ? true : bridge.showWindow!(name)))
    .then((shown) => {
      if (shown || closing) return;
      closeWindow();
      options.onFailed();
    }, () => {
      if (closing) return;
      closeWindow();
      options.onFailed();
    });

  return { name, win, doc, root, close: closeWindow };
}
