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
}

export interface DesktopThemeBridge {
  /** The page's colours, for title bar buttons and the first frame of new windows. */
  set: (theme: { dark: boolean; background: string; foreground?: string }) => void;
  /** Fires when the OS switches between light and dark. Returns the unsubscribe. */
  onSystemChange?: (listener: (system: { dark: boolean; highContrast: boolean }) => void) => () => void;
}

export interface DesktopMenuBridge {
  /**
   * What the app menu shows as enabled or checked, by command id. The shell
   * keeps the last state per window and applies it when that window has focus.
   */
  setState: (state: Record<string, boolean | { enabled?: boolean; checked?: boolean }>) => void;
}

export interface DesktopShellBridge {
  /** http, https and mailto only. */
  openExternal: (url: string) => void;
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
  onFlushRequest: (handler: () => Promise<unknown>) => () => void;
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

export interface DesktopOsSettings {
  /** Closing the main window leaves the app running in the tray. */
  closeToTray: boolean;
  startAtLogin: boolean;
  /** At login: no window, only the tray. */
  startMinimized: boolean;
  /** Taskbar flash or dock bounce on new mail. */
  attentionOnNewMail: boolean;
  quietHoursEnabled: boolean;
  /** HH:MM, local time. */
  quietHoursStart: string;
  quietHoursEnd: string;
  /** "Show Bulwark", an Electron accelerator. Null: off. */
  showShortcut: string | null;
}

export interface DesktopOsStatus {
  settings: DesktopOsSettings;
  pausedUntil: number | null;
  /** The shortcut in settings is really held. Another app can have it. */
  shortcutActive: boolean;
}

export interface DesktopOsFile {
  name: string;
  data: Uint8Array;
}

/** What the OS asks the app to do: a tray item, a jump list entry, a toast, a double-clicked file. */
export type DesktopOsCommand =
  | { type: 'new-message' }
  | { type: 'navigate'; target: 'inbox' | 'calendar' | 'contacts' }
  | { type: 'open-message'; emailId: string; accountId?: string; context?: string }
  | { type: 'open-mailbox'; mailboxId: string }
  | { type: 'mailto'; url: string }
  | { type: 'webcal'; url: string }
  | { type: 'files'; reason: 'open' | 'attach'; files: DesktopOsFile[]; failed: string[] }
  | { type: 'notification'; action: string; context: string; reply?: string };

export interface DesktopOsNotification {
  /** Tag of the toast. Showing an id again within a few minutes does nothing. */
  id: string;
  group?: string;
  title: string;
  body: string;
  /** Handed back with the action. Keep it short: Windows keeps it in the toast. */
  context: string;
  actions?: { id: string; label: string }[];
  reply?: { label: string; placeholder: string };
  /** The user wants a sound with this. */
  sound?: boolean;
  /** New mail: flash the taskbar or bounce the dock if that's on. */
  attention?: boolean;
}

export interface DesktopOsNotifyResult {
  shown: boolean;
  reason?: 'duplicate' | 'paused' | 'quiet-hours' | 'focused' | 'unsupported' | 'invalid';
  /** The page should play the sound the user picked. */
  playSound: boolean;
}

export interface DesktopOsTrayMessage {
  emailId: string;
  accountId: string;
  sender: string;
  subject: string;
  context?: string;
}

export interface DesktopOsSummary {
  unread: DesktopOsTrayMessage[];
  /** Newest conversations, whether read or not, for the jump list. */
  recent: DesktopOsTrayMessage[];
  nextEvent: { title: string; when: string } | null;
}

export type DesktopOsPowerEvent = 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen';

export interface DesktopOsDefaultAppStatus {
  /** Offered to the OS as a mail app. */
  registered: boolean;
  mailto: boolean;
  webcal: boolean;
}

export interface DesktopOsBridge {
  /**
   * What the OS asks for. Main holds these until the main window's page subscribes,
   * so a cold start loses nothing.
   */
  onCommand: (listener: (command: DesktopOsCommand) => void) => () => void;
  getStatus: () => Promise<DesktopOsStatus>;
  setSettings: (patch: Partial<DesktopOsSettings>) => Promise<DesktopOsStatus>;
  /** Pause notifications until this time, or null to end the pause. */
  setPaused: (until: number | null) => void;
  onStatusChange: (listener: (status: DesktopOsStatus) => void) => () => void;
  /** The unread count: overlay on Windows, setBadgeCount on macOS and Linux, the tray's dot. */
  setBadge: (count: number) => void;
  /** What the tray and the jump list show. */
  setSummary: (summary: DesktopOsSummary) => void;
  /** The taskbar's progress bar: lib/desktop/file-drag.ts setTaskbarProgress. */
  setProgress: (progress: number | null, mode?: 'normal' | 'indeterminate' | 'paused' | 'error') => void;
  /** App lock's state: main clears the tray, jump list and toasts and strips what comes through. */
  setLocked: (locked: boolean) => void;
  notify: (notification: DesktopOsNotification) => Promise<DesktopOsNotifyResult>;
  onPower: (listener: (event: DesktopOsPowerEvent) => void) => () => void;
  /** Writes the files to a private folder and starts a drag. Only with the mouse held. */
  startDrag: (files: DesktopOsFile[]) => Promise<boolean>;
  /** The same, onto the clipboard as files. */
  copyFiles: (files: DesktopOsFile[]) => Promise<boolean>;
  defaultAppStatus: () => Promise<DesktopOsDefaultAppStatus>;
  /** Offers the app to the OS and opens where the user chooses. */
  openDefaultAppSettings: () => Promise<DesktopOsDefaultAppStatus>;
}

export interface BulwarkDesktopBridge {
  version: number;
  platform: 'win32' | 'darwin' | 'linux';
  mode?: 'standalone' | 'instance';
  windows?: DesktopWindowsBridge;
  theme?: DesktopThemeBridge;
  menu?: DesktopMenuBridge;
  shell?: DesktopShellBridge;
  lifecycle?: DesktopLifecycleBridge;
  os?: DesktopOsBridge;
  servers?: DesktopServersBridge;
  auth?: DesktopAuthBridge;
  plugins?: DesktopPluginsBridge;
}

declare global {
  interface Window {
    bulwarkDesktop?: BulwarkDesktopBridge;
  }
}
