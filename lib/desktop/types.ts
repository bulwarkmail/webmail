/**
 * The desktop app's preload bridge as the webmail sees it. Feature checks ask
 * `window.bulwarkDesktop?.<area>`; in a browser the object isn't there.
 *
 * The shell side lives in the desktop repo (src/shared/bridge.ts), a copy of
 * this contract. Add a member here and there together. A breaking change bumps
 * `version`; adding a member doesn't.
 */

export const DESKTOP_BRIDGE_VERSION = 1;

export type DesktopWindowType = 'main' | 'message' | 'composer' | 'settings';

export interface DesktopWindowInfo {
  id: number;
  type: DesktopWindowType;
  title: string;
  focused: boolean;
  /** False for a main window hidden while pop-outs are open. */
  visible?: boolean;
}

export interface DesktopWindowsBridge {
  /**
   * Opens a pop-out window itself. The name is the window's identity: opening
   * the same name again focuses the window that has it. Left out, the page uses
   * window.open with a features string, which the shell's window-open handler
   * sees too.
   */
  open?: (url: string, options: { name: string; width: number; height: number }) => void;
  /** One window per message: opening it again focuses it. */
  openMessage?: (target: { url: string; emailId: string }) => void;
  openComposer?: (target: { url: string; name?: string }) => void;
  /** Focuses a window from `list()`, or the main window with no id. */
  focus?: (id?: number) => void;
  list?: () => Promise<DesktopWindowInfo[]>;
  /** Fires when a window opens, closes, retitles or takes the focus. Returns the unsubscribe. */
  onChanged?: (listener: (windows: DesktopWindowInfo[]) => void) => () => void;
  /**
   * This page has saved or discarded and closes its window. Goes through the shell
   * so bounds get stored and no second save runs. Works however the window opened.
   */
  closeSelf?: () => void;
  /** What this window's open drafts come back as at the next start: pop-out composer addresses. */
  setRestore?: (urls: string[]) => void;
  setRestoreEnabled?: (enabled: boolean) => void;
  /** Signed in, with a session to lend: windows from last time can open. */
  sessionReady?: () => void;
  /** The warm spare's page, see components/popout/popout-spare-app.tsx. */
  spare?: {
    ready: () => void;
    taken: () => void;
    onActivate: (listener: (url: string) => void) => () => void;
  };
}

export interface DesktopThemeBridge {
  /** The page's colours, for title bar buttons and the first frame of new windows. */
  set: (theme: { dark: boolean; background: string; foreground?: string }) => void;
  /** Fires when the OS switches between light and dark, contrast or accent. Returns the unsubscribe. */
  onSystemChange?: (listener: (system: DesktopSystemTheme) => void) => () => void;
  /** How the OS looks now. */
  system?: () => Promise<DesktopSystemTheme>;
}

export interface DesktopSystemTheme {
  dark: boolean;
  highContrast: boolean;
  /** The OS accent colour as #rrggbb, where the OS has one and tells. */
  accent?: string;
}

export type DesktopMenuState = Record<string, boolean | { enabled?: boolean; checked?: boolean }>;

/** A native menu built from an HTML one (lib/desktop/native-menu.ts). */
export interface DesktopNativeMenuItem {
  /** Handed back when this item is chosen. Left out of separators and submenus. */
  id?: string;
  label?: string;
  type?: 'normal' | 'separator' | 'checkbox' | 'radio';
  enabled?: boolean;
  checked?: boolean;
  submenu?: DesktopNativeMenuItem[];
}

export interface DesktopMenuBarEntry {
  id: string;
  label: string;
  /** The letter that opens it with Alt, lower case. */
  mnemonic?: string;
}

export interface DesktopMenuBarEvent {
  visible: boolean;
  /** Open this menu right away: Alt plus its letter. */
  open?: string;
}

/** What a page answers when asked to save before a window goes. */
export interface DesktopFlushAnswer {
  failed?: number;
  timedOut?: boolean;
  /** Mail waiting to be sent. */
  unsent?: number;
}

export interface DesktopMenuBridge {
  /**
   * What the app menu shows as enabled or checked, by command id. The shell
   * keeps the last state per window and applies it when that window has focus.
   */
  setState: (state: DesktopMenuState) => void;
  /** A menu command to run. Returns the unsubscribe. */
  onCommand?: (listener: (id: string) => void) => () => void;
  /** Shows a native menu. At the pointer when `at` is left out. Answers with the id picked, or null. */
  popup?: (items: DesktopNativeMenuItem[], at?: { x: number; y: number }) => Promise<string | null>;
  /** The strip that stands in for a menu bar in a window with no native bar. */
  bar?: {
    entries: () => Promise<DesktopMenuBarEntry[]>;
    /** Opens that menu natively, at page coordinates. */
    open: (id: string, at: { x: number; y: number }) => void;
    onEvent: (listener: (event: DesktopMenuBarEvent) => void) => () => void;
  };
}

export interface DesktopShellBridge {
  /** http, https and mailto only. */
  openExternal: (url: string) => void;
  /** The shell's menus follow `ui`. Spellcheck follows both. */
  setLanguages?: (languages: { ui: string; composer?: string[] }) => void;
}

export interface DesktopDialogsBridge {
  /** A native question. Answers with the index of the button chosen. The last button is the safe one. */
  confirm: (options: {
    message: string;
    detail?: string;
    buttons: string[];
    defaultId?: number;
    type?: 'none' | 'info' | 'warning' | 'question';
  }) => Promise<number>;
}

export interface DesktopClipboardBridge {
  /** Puts a file on the clipboard, for pasting into a folder. False when that didn't work. */
  copyFile: (name: string, data: ArrayBuffer) => Promise<boolean>;
}

export type DesktopServerPrepareResult =
  | { ok: true; approved: boolean }
  | { ok: false; reason: 'declined' | 'invalid' };

export interface DesktopServersBridge {
  /**
   * Call before signing in to a server. Asks the user first when it is on the
   * LAN or plain http, and lets the app reach it. Standalone mode only.
   */
  prepare: (serverUrl: string) => Promise<DesktopServerPrepareResult>;
  /**
   * The sign-in worked, so the server stays: what `prepare` added lasts only until
   * the app quits before this. Other origins a session names get a prompt.
   */
  noteSession: (
    serverUrl: string,
    urls: { apiUrl?: string; downloadUrl?: string; uploadUrl?: string; eventSourceUrl?: string },
  ) => void;
  /** A sign-in that failed, or the last account on this server signing out. */
  forget?: (serverUrl: string, reason: 'failed' | 'signed-out') => void;
}

export interface DesktopLifecycleBridge {
  /**
   * Before a window closes or the app quits, the shell asks the page to save what
   * it has and waits a few seconds. A window with no handler closes at once.
   */
  onFlushRequest: (handler: () => Promise<DesktopFlushAnswer | unknown>) => () => void;
}

export type DesktopBrowserSignInResult =
  | { ok: true; code: string; state: string }
  | { ok: false; error: string };

export interface DesktopAuthBridge {
  /** Starts a short-lived loopback listener for one sign-in. */
  beginBrowserSignIn: () => Promise<{ flowId: string; redirectUri: string }>;
  /** Opens the system browser on `authorizeUrl` and waits for the redirect. */
  completeBrowserSignIn: (flowId: string, authorizeUrl: string) => Promise<DesktopBrowserSignInResult>;
  cancelBrowserSignIn: (flowId: string) => void;
}

export type DesktopPluginInstallResult =
  | { ok: true; id: string; version: string }
  | { ok: false; error: string; code?: string };

export interface DesktopPluginsBridge {
  /**
   * Installs from the directory through the local admin API, with its signature
   * and hash checks, after a native prompt. No version means the latest. The
   * renderer never holds an admin session. Standalone only.
   */
  install: (slug: string, version?: string) => Promise<DesktopPluginInstallResult>;
}

export interface BulwarkDesktopBridge {
  version: number;
  platform: 'win32' | 'darwin' | 'linux';
  mode?: 'standalone' | 'instance';
  windows?: DesktopWindowsBridge;
  theme?: DesktopThemeBridge;
  menu?: DesktopMenuBridge;
  shell?: DesktopShellBridge;
  dialogs?: DesktopDialogsBridge;
  clipboard?: DesktopClipboardBridge;
  lifecycle?: DesktopLifecycleBridge;
  servers?: DesktopServersBridge;
  auth?: DesktopAuthBridge;
  plugins?: DesktopPluginsBridge;
}

declare global {
  interface Window {
    bulwarkDesktop?: BulwarkDesktopBridge;
  }
}
