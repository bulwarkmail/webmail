/**
 * The desktop app's preload bridge as the webmail sees it. Feature checks ask
 * `window.bulwarkDesktop?.<area>`; in a browser the object isn't there.
 *
 * Only what the webmail uses so far. The desktop shell fills it in.
 */

export interface DesktopWindowsBridge {
  /**
   * Opens a pop-out window itself. A `name` that is already open focuses that
   * window and doesn't load `url` again: one window per message. Left out, the
   * page uses window.open with a features string, which the shell's
   * window-open handler sees too.
   */
  open?: (url: string, options: { name: string; width: number; height: number }) => void;
}

export interface BulwarkDesktopBridge {
  windows?: DesktopWindowsBridge;
}

declare global {
  interface Window {
    bulwarkDesktop?: BulwarkDesktopBridge;
  }
}
