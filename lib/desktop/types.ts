/**
 * The desktop app's preload bridge as the webmail sees it. Feature checks ask
 * `window.bulwarkDesktop?.<area>`; in a browser the object isn't there.
 *
 * The shell side lives in the desktop repo (src/shared/bridge.ts), a copy of
 * this contract. Add a member here and there together. A breaking change bumps
 * `version`; adding a member doesn't.
 */

import type { PolicySnapshot } from './policy-schema';

export const DESKTOP_BRIDGE_VERSION = 1;

export type DesktopWindowType = 'main' | 'message' | 'composer' | 'settings';

export interface DesktopWindowInfo {
  id: number;
  type: DesktopWindowType;
  title: string;
  /** What the page calls the window in the Window menu (`setMenuName`), if it said. */
  menuName?: string;
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
  /** `quick`: a composer at quick compose's size and place (a new message from outside, an Undo). */
  open?: (url: string, options: { name: string; width: number; height: number; quick?: boolean }) => void;
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
  /** This window's name in the Window menu: lib/desktop/window-name.ts. */
  setMenuName?: (name: string) => void;
  /** Signed in, with a session to lend: windows from last time can open. */
  sessionReady?: () => void;
  /** Nobody is signed in any more: a pop-out would find no session. */
  sessionEnded?: () => void;
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

/**
 * A native menu the shell can show. The page shows its own HTML menus in the desktop app
 * too, so they have their icons and the app's key names; this stays for older pages.
 */
export interface DesktopNativeMenuItem {
  /** Handed back when this item is chosen. Left out of separators and submenus. */
  id?: string;
  label?: string;
  type?: 'normal' | 'separator' | 'checkbox' | 'radio';
  enabled?: boolean;
  checked?: boolean;
  /**
   * The key the page answers for this item, in Electron's accelerator syntax ("D",
   * "Shift+I", "Ctrl+X"). Only shown, apart from the label: never registered.
   */
  accelerator?: string;
  submenu?: DesktopNativeMenuItem[];
}

export interface DesktopMenuBarEntry {
  id: string;
  label: string;
  /** The letter that opens it with Alt, lower case. */
  mnemonic?: string;
}

export interface DesktopMenuBarEvent {
  /** The bar has the keys: Alt was pressed. With `pinned` it shows either way. */
  visible: boolean;
  /** Open this menu right away: Alt plus its letter. */
  open?: string;
  /** "Always show the menu bar". */
  pinned?: boolean;
}

/** One line of a menu the page draws as the menu bar's. */
export interface DesktopMenuBarItem {
  /** Its place in the app menu: handed back with its text when it's picked. */
  key: string;
  /** The line's command id (`message.reply`), or `role.<role>`: the page draws its icon by it. Newer shells only. */
  id?: string;
  label: string;
  type: 'normal' | 'checkbox' | 'radio' | 'separator' | 'submenu';
  enabled: boolean;
  checked?: boolean;
  /** As Electron writes it: `CmdOrCtrl+N`. */
  accelerator?: string;
  /** Where in `label` the letter for it is. */
  mnemonic?: number;
  items?: DesktopMenuBarItem[];
}

export interface DesktopMenuBarMenu extends DesktopMenuBarEntry {
  items: DesktopMenuBarItem[];
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
  /**
   * File > Change connection…, once the page asked: restarts on the first screen. False
   * where a policy forces the connection. An older shell has none.
   */
  changeConnection?: () => Promise<boolean>;
  /** Shows a native menu. At the pointer when `at` is left out. Answers with the id picked, or null. */
  popup?: (items: DesktopNativeMenuItem[], at?: { x: number; y: number }) => Promise<string | null>;
  /** The strip that stands in for a menu bar in a window with no native bar. */
  bar?: {
    entries: () => Promise<DesktopMenuBarEntry[]>;
    /** Opens that menu natively, at page coordinates. */
    open: (id: string, at: { x: number; y: number }) => void;
    onEvent: (listener: (event: DesktopMenuBarEvent) => void) => () => void;
    /** Every menu, with what's enabled and ticked in this window now. An older shell has none. */
    menus?: () => Promise<DesktopMenuBarMenu[]>;
    /** Runs a line of `menus`, by its key and text. */
    run?: (key: string, label: string) => void;
    /** The room the bar takes now (CSS pixels, 0 when gone), and whether it has the keys. */
    report?: (report: { height: number; active: boolean }) => void;
    /** "Always show the menu bar", in every window. */
    setPinned?: (pinned: boolean) => void;
  };
}

export interface DesktopShellBridge {
  /** http, https and mailto only. */
  openExternal: (url: string) => void;
  /** The shell's menus follow `ui`, in `labels` (lib/desktop/languages.ts). Spellcheck follows `ui` and `composer`. */
  setLanguages?: (languages: { ui: string; composer?: string[]; labels?: Record<string, string> }) => void;
}

export interface DesktopSpellcheckBridge {
  /** Languages with neither an OS checker nor a dictionary here. */
  missing: () => Promise<string[]>;
  onMissing: (listener: (language: string) => void) => () => void;
  /** The user said yes: dictionaries may come from Google. Never with no-third-party mode on. */
  allowDownload: () => void;
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
  /**
   * A short question in a window of the app's own, modal to this one and drawn like the
   * in-page dialog (lib/desktop/dialog-window.ts). One at a time per page; the next waits.
   * Absent on older shells.
   */
  show?: (request: DesktopDialogWindowRequest) => Promise<DesktopDialogWindowAnswer>;
  /** Takes back a question asked with `show`, showing or waiting. */
  cancel?: (id: string) => void;
  /**
   * Shows the window this page opened with `window.open('', name)`, a name starting
   * `bulwark-dialog-`: main made it a frameless, transparent modal child the size of this
   * page, and the page has drawn one of its dialogs into it (lib/desktop/dialog-surface.ts).
   * False when there is no such window. Absent on older shells.
   */
  showWindow?: (name: string) => Promise<boolean>;
}

/**
 * The shell's print preview (src/main/print-preview.ts in the desktop repo): this page as
 * its print CSS lays it out, a print window it opened as `window.open('', name)` with a
 * name `bulwark-print-…` (main keeps it hidden), or a PDF's bytes.
 */
export type DesktopPrintPreviewRequest = (
  | { source: 'page' }
  | { source: 'window'; name: string }
  | { source: 'pdf'; data: Uint8Array }
) & {
  title?: string;
  theme?: DesktopDialogWindowTheme;
};

export type DesktopPrintPreviewOutcome = 'printed' | 'saved' | 'system' | 'cancelled' | 'refused' | 'busy' | 'failed';

export interface DesktopPrintBridge {
  /** Opens the preview over this window. Resolves when it closes. */
  preview: (request: DesktopPrintPreviewRequest) => Promise<DesktopPrintPreviewOutcome>;
  /** File > Print and Ctrl+P ask the page to run its own Print. Returns the unsubscribe. */
  onRequest: (listener: () => void) => () => void;
}

/** Plain text throughout: the shell sets textContent only. */
export interface DesktopDialogWindowRequest {
  /** The page's own name for it, for `cancel`. */
  id: string;
  title: string;
  /** The text under the title, in runs; `bold` runs are drawn bold. */
  message?: { text: string; bold?: boolean }[];
  /** "From the plugin …": who is asking, when it isn't the app. Drawn under the title. */
  source?: string;
  /** The warning sign of a destructive confirm. */
  icon?: 'warning';
  /** In the order they stand, start to end. At most four. */
  buttons: { label: string; variant?: 'primary' | 'secondary' | 'destructive' }[];
  /** The button Enter takes and the focus starts on. */
  defaultIndex?: number;
  /** The ⋮ menu at the top end: a plugin's options. */
  menu?: { label: string; items: { id: string; label: string; destructive?: boolean }[] };
  theme?: DesktopDialogWindowTheme;
  lang?: string;
  dir?: 'ltr' | 'rtl';
}

export interface DesktopDialogWindowTheme {
  dark?: boolean;
  /** #rrggbb[aa] or rgb(a)(); anything else is dropped by the shell. */
  colours?: Partial<Record<DesktopDialogWindowColour, string>>;
  font?: string;
  fontSize?: number;
  radius?: number;
  radiusSmall?: number;
}

export type DesktopDialogWindowColour =
  | 'background'
  | 'foreground'
  | 'muted'
  | 'mutedForeground'
  | 'border'
  | 'input'
  | 'primary'
  | 'primaryForeground'
  | 'destructive'
  | 'destructiveForeground'
  | 'accent'
  | 'accentForeground'
  | 'ring';

/** A button by its index, a menu item by its id. Null: closed without an answer (Escape, Alt+F4, the page went). */
export type DesktopDialogWindowAnswer = { button: number } | { menu: string } | null;

export interface DesktopClipboardBridge {
  /** Puts a file on the clipboard, for pasting into a folder. False when that didn't work. */
  copyFile: (name: string, data: ArrayBuffer) => Promise<boolean>;
  /** Signed out: nothing copied from that account stays on disk. */
  clearFiles?: () => void;
}

export type DesktopServerPrepareResult =
  | { ok: true; approved: boolean }
  | { ok: false; reason: 'declined' | 'invalid' | 'policy' };

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

/** Standalone: a mail server's own OAuth. Instance: the instance's own login page. */
export type DesktopBrowserSignInRequest = { kind: 'oauth'; serverUrl: string } | { kind: 'instance' };

export type DesktopBrowserSignInBegin =
  | { ok: true; flowId: string; redirectUri: string; state: string }
  | { ok: false; error: string };

export type DesktopBrowserSignInResult =
  | { ok: true; code: string; state: string; iss?: string }
  | { ok: false; error: string };

export type DesktopPasswordSignInStart = { ok: true; host: string } | { ok: false; error: string };

export type DesktopPasswordSignInAttempt =
  | { ok: true; username: string; password: string; totp?: string }
  | { ok: false; error: string };

export type DesktopPasswordSignInAnswer =
  | { ok: true }
  | { ok: false; error: 'invalid_credentials' | 'totp_required' | 'other' };

/** Sign-in through the system browser. See lib/desktop/browser-sign-in.ts. */
export interface DesktopBrowserSignInControls {
  /** A short-lived loopback listener for one sign-in. Only from a click. */
  begin: (request: DesktopBrowserSignInRequest) => Promise<DesktopBrowserSignInBegin>;
  /** Opens the system browser on `url` and waits for the redirect. */
  complete: (flowId: string, url: string) => Promise<DesktopBrowserSignInResult>;
  /** The server refused loopback and took the `bulwark:` scheme. */
  useScheme: (flowId: string) => Promise<string | null>;
  cancel: (flowId: string) => void;
  /** The server has no OAuth: a page main serves on a stable loopback port. */
  beginPassword: (flowId: string) => Promise<DesktopPasswordSignInStart>;
  nextPassword: (flowId: string) => Promise<DesktopPasswordSignInAttempt>;
  answerPassword: (flowId: string, answer: DesktopPasswordSignInAnswer) => void;
  outcome: (flowId: string) => Promise<DesktopBrowserSignInResult>;
}

export interface DesktopAuthBridge {
  /** Once per document, in the first render: a same-origin frame can reach this bridge. */
  claim: () => DesktopBrowserSignInControls | null;
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

export type DesktopUpdateChannel = 'stable' | 'beta';

export interface DesktopUpdateState {
  /** The running version. */
  version: string;
  channel: DesktopUpdateChannel;
  /** Set by the `UpdateChannel` policy. */
  channelLocked: boolean;
  /** False when the `AutoUpdate` policy turned updates off. */
  allowed: boolean;
  /** `install`: replaces itself. `notify`: an MSI, deb, rpm or unsigned macOS, says a version exists. `none`: a development run. */
  ability: 'install' | 'notify' | 'none';
  /** Windows, and not the per-user installer: an MSI, whose updates come the way it did. */
  perMachine: boolean;
  /**
   * `available`: a newer version, for `notify` installs. `older-available`: on stable, with
   * a beta running, and the newest stable is older than it. `off`: the policy.
   */
  status: 'idle' | 'checking' | 'up-to-date' | 'downloading' | 'ready' | 'available' | 'older-available' | 'error' | 'off';
  /** The version the status is about. */
  target?: string;
  percent?: number;
}

export interface DesktopUpdatesBridge {
  state: () => Promise<DesktopUpdateState>;
  check: () => Promise<DesktopUpdateState>;
  /** Going to beta asks natively first. A locked channel stays as it is. */
  setChannel: (channel: DesktopUpdateChannel) => Promise<DesktopUpdateState>;
  /** Beta to stable, with a native question that says what it means. */
  installOlder: () => Promise<DesktopUpdateState>;
  /** Saves drafts through the normal quit, then installs. Nothing happens unless an update is ready. */
  restart: () => void;
  openDownload: () => void;
  onChanged: (listener: (state: DesktopUpdateState) => void) => () => void;
}

export type DesktopKeystoreHash = 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512';

export interface DesktopKeystoreCertificate {
  /** Opaque: the only ids sign, decrypt and agree accept. */
  id: string;
  /** The leaf, DER. */
  certificate: Uint8Array;
  /** Intermediates, DER, without leaf and root. May be empty. */
  chain: Uint8Array[];
  subject: string;
  issuer: string;
  /** Hex. */
  serial: string;
  /** Milliseconds since 1970. */
  notBefore: number;
  notAfter: number;
  /** keyUsage names. Empty without the extension. */
  usages: string[];
  /** extendedKeyUsage OIDs. Empty without the extension. */
  extendedUsages: string[];
  /** The key's algorithm OID. */
  algorithm: string;
  keyType: 'rsa' | 'ec';
  curve?: 'P-256' | 'P-384' | 'P-521';
  keyBits: number;
  /** A hint for the UI. */
  source: 'software' | 'smartcard' | 'keychain' | 'unknown';
  signSchemes: string[];
  decryptSchemes: string[];
  canAgree: boolean;
  /** The key can also sign the user in somewhere: the user is asked per use. */
  askEachUse: boolean;
}

/** Whether this origin may use the keystore at all. `app` is standalone. */
export type DesktopKeystoreAccessState = 'app' | 'policy' | 'stored' | 'off';

export type DesktopKeystoreSignScheme =
  | { scheme: 'rsa-pkcs1'; hash: DesktopKeystoreHash }
  /** MGF1 on the same hash, salt as long as the hash. */
  | { scheme: 'rsa-pss'; hash: DesktopKeystoreHash }
  /** `hash` names the digest's length. */
  | { scheme: 'ecdsa'; hash: DesktopKeystoreHash };

export type DesktopKeystoreDecryptScheme =
  | { scheme: 'rsa-pkcs1' }
  /** MGF1 on the same hash. */
  | { scheme: 'rsa-oaep'; hash: DesktopKeystoreHash; label?: Uint8Array };

/** `quiet`: answer from what's already allowed, with keystore:ask-first in place of a dialog. */
export interface DesktopKeystoreUseOptions {
  quiet?: boolean;
}

/**
 * The OS certificate store and smart cards. Present only where the native helper
 * loaded, the OS has one and policy allows it. Failures reject with a bare code as the
 * message: keystore:cancelled, ask-first, not-found, unsupported, locked, invalid, failed.
 * The shell asks the user in a native dialog before any of this, on top of which the OS
 * has its own prompts, so a call may take a while. On an instance it stays off until
 * policy or the user allows it. The key never leaves the OS.
 */
export interface DesktopKeystoreBridge {
  /** Certificates fit for mail that have a private key. The OS doesn't prompt. */
  list: (options?: DesktopKeystoreUseOptions) => Promise<DesktopKeystoreCertificate[]>;
  /**
   * Signs a CMS message's signed attributes, given as their DER (a SET): content type,
   * message digest and signing time at least. The shell checks them and hashes them itself,
   * and asks at every call. RSA gives the raw signature, ECDSA a DER ECDSA-Sig-Value.
   */
  sign: (id: string, signedAttributes: Uint8Array, scheme: DesktopKeystoreSignScheme) => Promise<Uint8Array>;
  /** Unwraps a CMS content key. */
  decrypt: (id: string, data: Uint8Array, scheme: DesktopKeystoreDecryptScheme, options?: DesktopKeystoreUseOptions) => Promise<Uint8Array>;
  /** The raw shared secret, big-endian. The peer's key is an EC SubjectPublicKeyInfo. */
  agree: (id: string, peerPublicKey: Uint8Array, options?: DesktopKeystoreUseOptions) => Promise<Uint8Array>;
  accessState: () => Promise<DesktopKeystoreAccessState>;
  /** Takes back a stored yes and this session's grants. Only ever narrows. */
  revokeAccess: () => Promise<void>;
  /** Takes back this session's grants, for the next account. Absent on older shells. */
  clearGrants?: () => Promise<void>;
}

export interface DesktopCertificatesBridge {
  /**
   * Forgets client certificates chosen for servers. `account`: those chosen while that account was
   * active, at its own sign-out. `last`: all of them, and what the app keeps of them in memory, at
   * the sign-out that leaves nobody. Only narrows.
   */
  clearChoices: (scope: { account?: string; last?: boolean }) => Promise<void>;
  /** The account a choice made from now on belongs to. */
  setAccount: (account: string | null) => Promise<void>;
  /** The app's connections were closed: a request under way will never settle by itself. */
  onConnectionsReset: (listener: () => void) => () => void;
}

export interface DesktopPolicyBridge {
  /** What's in force now. Synchronous: a page can read it in its first render. */
  get: () => PolicySnapshot;
  onChange: (listener: (snapshot: PolicySnapshot) => void) => () => void;
}

export type DesktopOsUnlockKind = 'hello' | 'touchid';

export type DesktopOsUnlockAnswer = { ok: true; key: Uint8Array } | { ok: false; reason: 'unavailable' | 'denied' | 'not-locked' | 'failed' };

/** A signature from the lock's Windows Hello key credential, or why there's none. */
export type DesktopHelloAnswer =
  | { ok: true; signature: Uint8Array }
  | { ok: false; reason: 'cancelled' | 'busy' | 'unavailable' | 'missing' | 'unsupported' | 'policy' | 'not-locked' | 'failed' };

/** Windows Hello for the lock. Absent off Windows and on an older shell. */
export interface DesktopHelloStatus {
  /** Windows can show the prompt here. */
  available: boolean;
  /** The AppLockHelloAllowed policy. */
  allowed: boolean;
  /** This profile has a key credential for the lock. */
  enrolled: boolean;
}

/**
 * App lock in the desktop app. Main holds whether it's locked, and nothing a page says can
 * lift that: `prove` needs what only a real unlock gives, Windows Hello and Touch ID run in
 * main, and `forget` asks natively without the proof. A same-origin plugin frame can reach
 * this through `parent`, so that has to hold on a call alone. What it mustn't reach at all,
 * `lock` and `osUnlock`, the page takes once with `claim` before any frame exists.
 */
/** A PIN guess through main. Blocked: too many wrong ones. Neither: main can't open its secret here. */
export type DesktopPinStepAnswer = { ok: true; bytes: Uint8Array } | { ok: false; blockedUntil?: number };

export interface DesktopAppLockControls {
  lock: () => void;
  osUnlock: () => Promise<DesktopOsUnlockAnswer>;
  /** Through safeStorage, for this origin only. Null where the OS has no real key store. Absent on an older shell. */
  wrap?: (data: Uint8Array) => Promise<Uint8Array | null>;
  unwrap?: (data: Uint8Array) => Promise<Uint8Array | null>;
  /** The key under the PIN takes a secret only main has, and every trip is counted there. */
  pinStep?: (data: Uint8Array) => Promise<DesktopPinStepAnswer>;
  /** Ends this page's renderer and loads the page in a new one. Only while main says locked. */
  replaceRenderer?: () => void;
  /** Whether the screen locking locks the app. Only while unlocked. Absent on an older shell. */
  setScreenLock?: (on: boolean) => Promise<boolean>;
  /**
   * Windows Hello: a new key credential and its signature for this salt. Unlocked, with the proof.
   * Absent on an older shell.
   */
  helloEnroll?: (proof: Uint8Array, salt: Uint8Array) => Promise<DesktopHelloAnswer>;
  /** The signature for this salt, behind a Hello prompt. Locked it needs nothing, unlocked the proof. */
  helloSign?: (salt: Uint8Array, proof?: Uint8Array) => Promise<DesktopHelloAnswer>;
  /** Ends a Hello prompt that's waiting. */
  helloCancel?: () => void;
  /** Deletes the key credential. */
  helloRemove?: () => Promise<void>;
  /**
   * What only main can delete. `account` null: everything on this device, and then `finishLocalWipe`.
   * `failed` names what didn't go, and the wipe isn't reported as done. Absent on an older shell.
   */
  localWipe?: (request: { reason: 'remote' | 'settings'; account: string | null }) => Promise<{ failed: string[] }>;
  /** Clears what the page still stood on, and restarts the app. */
  finishLocalWipe?: (options: { keepLocalStorage: boolean }) => Promise<void>;
}

export interface DesktopAppLockBridge {
  status: () => Promise<{ locked: boolean; enrolled: boolean; os: DesktopOsUnlockKind | null; osEnrolled: boolean; wrap?: boolean; hello?: DesktopHelloStatus }>;
  /** Once per document: the calls only the page itself may make. Null for whoever comes second. */
  claim: () => DesktopAppLockControls | null;
  /** Sets up the proof. False when one exists. */
  enroll: (proof: Uint8Array) => Promise<boolean>;
  /** Lifts the lock when the proof is the right one. */
  prove: (proof: Uint8Array) => Promise<boolean>;
  /** The lock goes off for good. */
  disable: (proof: Uint8Array) => Promise<boolean>;
  /** The PIN is lost, or everyone signed out. With no proof, main asks the user natively. */
  forget: (proof?: Uint8Array) => Promise<boolean>;
  /** Main keeps a lock and this profile has no PIN for it. Main asks the user natively, once a run. */
  clearOrphan?: () => Promise<boolean>;
  /** Asks Windows Hello or Touch ID, then keeps the key in the OS's encrypted storage. */
  osEnroll: (proof: Uint8Array, lockKey: Uint8Array) => Promise<boolean>;
  osRemove: () => Promise<void>;
  /** The screen locked, or "Lock now" in the menu or tray. Returns the unsubscribe. */
  onLockRequest: (listener: () => void) => () => void;
}

export type DesktopLocalImportKind = 'mbox' | 'maildir' | 'pst';

/** Something a scan found. The handle is all the page can ask for it by. */
export interface DesktopLocalImportCandidate {
  handle: string;
  app: 'thunderbird' | 'outlook';
  kind: DesktopLocalImportKind;
  /** The Thunderbird profile's name, or "Outlook". */
  group: string;
  account?: string;
  /** Where the mail goes: `Archives.sbd/2020` is ["Archives", "2020"]. Empty for a PST, which has its own. */
  folder: string[];
  name: string;
  size: number;
  lastModified: number;
  /** Maildir only. */
  messages?: number;
}

export interface DesktopLocalImportBook {
  handle: string;
  group: string;
  name: string;
  contacts: number;
}

export type DesktopLocalImportScanResult =
  | {
      ok: true;
      candidates: DesktopLocalImportCandidate[];
      books: DesktopLocalImportBook[];
      /** Seen and not offered. */
      refused: { name: string; reason: 'ost' | 'in-use' }[];
      /** Thunderbird calendars seen, which aren't read. */
      calendars: number;
      thunderbirdRunning: boolean;
      /** The search took too long and was stopped: this is what it found until then. */
      incomplete?: boolean;
    }
  | { ok: false; reason: 'declined' | 'busy' | 'failed' };

/** A file the user confirmed. `url` takes Range requests; a Maildir's messages are at `url/<position>`. */
export interface DesktopLocalImportFile {
  url: string;
  name: string;
  kind: DesktopLocalImportKind;
  folder: string[];
  size: number;
  lastModified: number;
  entrySizes?: number[];
}

export type DesktopLocalImportGrantResult =
  | {
      ok: true;
      jobId: string;
      files: DesktopLocalImportFile[];
      /** Contacts of the confirmed address books, as vCard text. */
      contacts: string[];
      /** Names that couldn't be read after all. */
      refused: string[];
      thunderbirdRunning: boolean;
    }
  | { ok: false; reason: 'declined' | 'busy' | 'invalid'; refused?: string[] };

export type DesktopLocalImportResumeResult =
  | Extract<DesktopLocalImportGrantResult, { ok: true }>
  /** `in-use`: none can be read right now, which may pass, so the job stays. `invalid`: they're gone, and so is the job. */
  | { ok: false; reason: 'later' | 'stopped' | 'busy' | 'invalid' | 'in-use' | 'unknown'; refused?: string[] };

/**
 * Thunderbird and Outlook data on this computer. Each step that widens access asks the
 * user natively in main: looking, reading the confirmed files, going on after a restart.
 */
export interface DesktopLocalImportBridge {
  scan: () => Promise<DesktopLocalImportScanResult>;
  grant: (handles: string[]) => Promise<DesktopLocalImportGrantResult>;
  resume: (jobId: string) => Promise<DesktopLocalImportResumeResult>;
  release: (jobId: string) => Promise<void>;
  releaseAll: () => Promise<void>;
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
  /** Quick compose, an Electron accelerator. Null: off. Unset: nobody chose, so the policy's or the built-in one. */
  quickComposeShortcut?: string | null;
}

export interface DesktopQuickComposeStatus {
  /** What's in force after policy and the user's choice. Null: off. */
  shortcut: string | null;
  /** Really held. False with a shortcut: another app has it. */
  active: boolean;
  /** Set by the `QuickComposeShortcut` policy. */
  locked: boolean;
  /** What turning it on again gives. */
  builtIn: string | null;
}

export interface DesktopOsStatus {
  settings: DesktopOsSettings;
  pausedUntil: number | null;
  /** The shortcut in settings is really held. Another app can have it. */
  shortcutActive: boolean;
  quickCompose?: DesktopQuickComposeStatus;
}

export interface DesktopOsFile {
  name: string;
  data: Uint8Array;
}

/** What the OS asks the app to do: a tray item, a jump list entry, a toast, a double-clicked file. */
export type DesktopOsCommand =
  /** `params`: a bulwark://new link's x-<plugin id>-<name> parameters (lib/plugin-link-params.ts). */
  | { type: 'new-message'; params?: Record<string, string> }
  /** `settings/files_sync`: Settings > Files on this computer, from the drive's status in Explorer. */
  | { type: 'navigate'; target: 'inbox' | 'calendar' | 'contacts' | 'settings/files_sync' }
  | { type: 'open-message'; emailId: string; accountId?: string; context?: string }
  | { type: 'open-mailbox'; mailboxId: string }
  | { type: 'mailto'; url: string }
  | { type: 'webcal'; url: string }
  /** `ask`: opened with the app, so the user picks between a new message and Files. Without it, attach. */
  | { type: 'files'; reason: 'open' | 'attach'; files: DesktopOsFile[]; failed: string[]; ask?: boolean }
  | { type: 'notification'; action: string; context: string; reply?: string }
  /** The tray's "Pause syncing" and "Resume syncing": every drive and synced folder. */
  | { type: 'files-sync'; action: 'pause-all' | 'resume-all' };

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
  /**
   * What a locked app says instead: new mail unless this says otherwise. `undo`: the answer
   * to the user's own click (a discarded draft's Undo), shown past pause, quiet hours and focus.
   */
  kind?: 'mail' | 'reminder' | 'undo';
}

export interface DesktopOsNotifyResult {
  shown: boolean;
  reason?: 'duplicate' | 'paused' | 'quiet-hours' | 'focused' | 'unsupported' | 'invalid' | 'failed';
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
  /** The account `unread` is from, when more than one is signed in. */
  account?: string;
}

export type DesktopOsPowerEvent = 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen';

export interface DesktopOsDefaultAppStatus {
  /** Offered to the OS as a mail app. */
  registered: boolean;
  mailto: boolean;
  webcal: boolean;
}

export interface DesktopOsCommandOptions {
  messageFileWindows?: boolean;
}

export interface DesktopOsBridge {
  /**
   * What the OS asks for. Main holds these until the main window's page subscribes,
   * so a cold start loses nothing. `messageFileWindows`: the page opens an .eml in a
   * window of its own, so main leaves the main window where it is (older shells ignore it).
   */
  onCommand: (listener: (command: DesktopOsCommand) => void, options?: DesktopOsCommandOptions) => () => void;
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
  /**
   * App lock's state. Main counts as locked until the main window's page says otherwise,
   * and clears the tray, jump list and toasts and strips what comes through.
   */
  setLocked: (locked: boolean) => void;
  /** Sign-out or a wipe: delivered toasts, badge, tray and jump list go, and temporary files. */
  clearSurfaces: () => void;
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

export interface DesktopPrivacyState {
  /** `forcedOff`: a policy says no, so `on` is false and the user can't change it. */
  telemetry: { on: boolean; forcedOff: boolean };
  /** `uploadUrl` is where "Send crash report" goes. Empty: nowhere, and the action says so. */
  crashReports: { on: boolean; forcedOff: boolean; uploadUrl: string };
}

export interface DesktopCrashFile {
  /** Opaque: the only values `sendCrash` accepts. */
  id: string;
  /** Milliseconds since 1970. */
  createdAt: number;
  bytes: number;
}

export type DesktopCrashSendResult =
  | { ok: true }
  | { ok: false; reason: 'no-consent' | 'no-url' | 'not-found' | 'cancelled' | 'failed' };

/**
 * Telemetry and crash reports, each with its own consent, both off until the user says
 * yes. A same-origin plugin can reach this, so saying yes and sending a crash file both
 * ask in a native dialog that names where it goes.
 */
export interface DesktopPrivacyBridge {
  get: () => Promise<DesktopPrivacyState>;
  setTelemetry: (on: boolean) => Promise<DesktopPrivacyState>;
  setCrashReports: (on: boolean) => Promise<DesktopPrivacyState>;
  /** https, or http on this computer. Empty clears it. */
  setCrashUploadUrl: (url: string) => Promise<{ ok: boolean; state: DesktopPrivacyState }>;
  listCrashes: () => Promise<DesktopCrashFile[]>;
  sendCrash: (id: string) => Promise<DesktopCrashSendResult>;
  deleteCrashes: () => Promise<void>;
  /** Also fires when a policy changes. Returns the unsubscribe. */
  onChange: (listener: (state: DesktopPrivacyState) => void) => () => void;
}

/** `forcedOff`: the DeveloperToolsAvailability policy says no. `locked`: the app lock is on, so nothing changes. */
export interface DesktopDevToolsState {
  on: boolean;
  forcedOff: boolean;
  locked: boolean;
}

/**
 * Chromium's developer tools on Ctrl+Shift+I and F12, off by default. Main keeps the switch.
 * Turning it on takes a real click and a native warning; the app lock turns it off again.
 */
export interface DesktopDevToolsBridge {
  get: () => Promise<DesktopDevToolsState>;
  set: (on: boolean) => Promise<DesktopDevToolsState>;
  onChange: (listener: (state: DesktopDevToolsState) => void) => () => void;
}

/** One of the user's recently used files, as the Attach menu shows it. Nothing more of it reaches the page. */
export interface DesktopRecentFile {
  /** Opaque. `attach` takes it, from the window that listed it, until that window lists again. */
  id: string;
  name: string;
  /** The folder it's in, for display. */
  folder: string;
  /** The whole path, for a tooltip. */
  path: string;
  /** When it was last used, in milliseconds since 1970. */
  usedAt: number;
  /** Its size in bytes; absent from an older shell. */
  size?: number;
  /** A small icon as a data: URL, when the OS gave one in time. */
  icon?: string;
}

/** `gesture`: no click or key press just now. `policy`: RecentFilesInAttach is off. */
export type DesktopRecentFilesResult =
  | { ok: true; files: DesktopRecentFile[] }
  | { ok: false; reason: 'policy' | 'locked' | 'gesture' };

export type DesktopRecentFileAttachResult =
  | { ok: true; file: DesktopOsFile }
  | { ok: false; reason: 'policy' | 'locked' | 'gesture' | 'unknown' | 'missing' | 'too-large' | 'failed' };

/**
 * The files the OS says were used last, for the composer's Attach menu. Main wants a click
 * or key press of its own for each call, reads only a file it just listed, and never logs.
 */
export interface DesktopRecentFilesBridge {
  list: () => Promise<DesktopRecentFilesResult>;
  attach: (id: string) => Promise<DesktopRecentFileAttachResult>;
}

/** An attachment copied to a private folder and open in its default program. */
export interface DesktopEditSession {
  id: string;
  name: string;
  type: string;
  /** The local account it belongs to. */
  account: string;
  /** What the page said it came from. Main only keeps it. */
  source: string;
  /** Saved differently from what the page last took. */
  changed: boolean;
  /** Goes up with each save. */
  version: number;
  /** What the file holds now: a chip holding this version has nothing to update. */
  hash: string;
  /** A composer has it and offers the update itself. */
  claimed: boolean;
  /** Wanted gone, and another program has it open. */
  held: boolean;
  /** Saved under a new name in that program. */
  savedAs: boolean;
  /** Not used for 30 days: this offer is the last. */
  lastChance: boolean;
}

/** What couldn't be deleted because another program has it open, by file name. `refused`: nothing happened. */
export interface DesktopEditClearResult {
  held: string[];
  refused?: boolean;
}

export interface DesktopEditFile {
  /** One session per key: Edit on the same attachment opens the same file. */
  key: string;
  name: string;
  type: string;
  data: Uint8Array;
  account: string;
  source: string;
}

export type DesktopEditBeginResult =
  /** One click, one ticket, for that key. A session for it exists: reopen this one. */
  | { ok: true; ticket: string; open?: string }
  | { ok: false; reason: 'locked' | 'gesture' };

export type DesktopEditOpenResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'locked' | 'ticket' | 'type' | 'too-large' | 'full' | 'no-app' | 'failed' };

export type DesktopEditReadResult =
  | { ok: true; name: string; type: string; data: Uint8Array; hash: string }
  | { ok: false; reason: 'locked' | 'missing' | 'busy' | 'too-large' };

/**
 * Edit on an attachment: a private copy opened in its default program, watched for saves.
 * Main refuses file types that run something and anything while locked. It can't know the
 * organisation's rules, so lib/desktop/edit-attachments.ts asks those at each step.
 */
export interface DesktopEditBridge {
  /** Whether this file may go through Edit at all: the same rule main enforces. */
  canEdit: (name: string) => boolean;
  /** Straight from the click: main spends it. The ticket lasts long enough to fetch the bytes, for this key only. */
  begin: (key: string) => Promise<DesktopEditBeginResult>;
  open: (ticket: string, file: DesktopEditFile) => Promise<DesktopEditOpenResult>;
  reopen: (ticket: string, id: string) => Promise<DesktopEditOpenResult>;
  /** Empty while locked. */
  list: () => Promise<DesktopEditSession[]>;
  /** The list after looking at each file now, for a decision that can't wait for the watcher. */
  settle: () => Promise<DesktopEditSession[]>;
  read: (id: string) => Promise<DesktopEditReadResult>;
  /** This version is where it should be, so it's no longer a change. */
  taken: (id: string, hash: string) => Promise<void>;
  /** The draft it was on has gone: deleted, unless it holds a save nobody took. Main decides, as it knows. */
  release: (id: string, source: string) => Promise<void>;
  /** Asks natively if it holds edits. */
  discard: (id: string) => Promise<DesktopEditClearResult>;
  /** The organisation said no: no question. */
  forceDiscard: (id: string) => Promise<DesktopEditClearResult>;
  /** The question before a sign-out, native, naming what a program has open. A yes covers the `clear` that follows. */
  askClear: (account: string) => Promise<boolean>;
  /** An account's copies, or with null all of this origin's. Asks natively about edits, without that yes. */
  clear: (account: string | null) => Promise<DesktopEditClearResult>;
  /** A wipe: no question. */
  wipe: (account: string | null) => Promise<DesktopEditClearResult>;
  /** The page has shown a last offer. */
  shown: (id: string) => void;
  setSource: (id: string, source: string) => void;
  /** A composer holds it, or stopped. Ends by itself with the page. */
  claim: (id: string, on: boolean) => void;
  onChange: (listener: (sessions: DesktopEditSession[]) => void) => () => void;
}

/*
 * Files on this computer: folders kept the same as a Files folder, and on Windows the
 * Files drive (Cloud Files API placeholders). The sync engine is the page's
 * (lib/files-sync in the webmail): it holds the JMAP session and decides. Main only does
 * what the page can't: the disk, the folder picker, the OS's sync root, and the
 * callbacks Windows makes when someone opens a file that isn't on the disk yet.
 *
 * Paths here are always relative to a root, with `/` between parts, never `..`, never
 * absolute. Main resolves them inside the root and refuses anything that leaves it,
 * through a link or otherwise.
 */

/** A place on this computer kept the same as Files: a folder the user picked, or the drive. */
export interface FilesRoot {
  /** Main's id for it. Random, never a path. */
  id: string;
  kind: 'folder' | 'drive';
  /** The page's local account id it belongs to. */
  account: string;
  /** Where it is on disk, to show and nothing else. */
  path: string;
  /** A folder: the Files folder it pairs with (null: the top of Files). The drive: null. */
  remoteId: string | null;
  /** What the page called the Files side when it was added, to show. */
  remoteLabel: string;
  paused: boolean;
  createdAt: number;
}

/** One file or folder under a root, as it is on disk now. */
export interface FilesLocalEntry {
  /** Relative to the root, `/` between parts. */
  path: string;
  kind: 'file' | 'directory';
  size: number;
  mtimeMs: number;
  /** The same across a rename on the same volume (file id, inode), to tell a move from a delete and a create. */
  fileId: string;
  /** The drive only: what the placeholder says. */
  placeholder?: FilesPlaceholderState;
}

export interface FilesPlaceholderState {
  /** The FileNode id written into it. Null for something made in Explorer that isn't a placeholder yet. */
  identity: string | null;
  /** Main or the page marked it in sync and nobody changed it since. */
  inSync: boolean;
  /** The content is on this disk. */
  hydrated: boolean;
  pin: 'pinned' | 'unpinned' | 'unspecified';
}

/** What the page expects a path to be, so main refuses to act on something that changed meanwhile. */
export interface FilesExpect {
  fileId: string;
  size: number;
  mtimeMs: number;
}

export type FilesError =
  /** Not there. */
  | 'missing'
  /** Something is already at the target. */
  | 'exists'
  /** It changed since the page looked (`expect` didn't match). */
  | 'changed'
  /** Another program has it open. */
  | 'busy'
  | 'denied'
  /** The path leaves the root, or goes through a link. */
  | 'outside'
  /** A name this file system can't hold. */
  | 'name'
  /** The disk is full. */
  | 'full'
  /** The organisation's policy says no. */
  | 'policy'
  /** No real click came with a call that needs one. */
  | 'gesture'
  /** The user closed the picker. */
  | 'cancelled'
  /** The folder is inside another root, holds one, or is a system folder. */
  | 'overlap'
  /** The root is paused, gone, or the app is locked. */
  | 'inactive'
  | 'unsupported'
  | 'failed';

export type FilesResult<T> = { ok: true; value: T } | { ok: false; error: FilesError };

/** Something on disk under a root changed. `paths: null`: too much at once, scan it all. */
export interface FilesChangeEvent {
  rootId: string;
  paths: string[] | null;
}

/** Windows wants bytes of a file that isn't on the disk yet: someone opened it. */
export interface FilesFetchRequest {
  fetchId: string;
  rootId: string;
  /** The FileNode id in the placeholder. */
  identity: string;
  path: string;
  /** What Windows asked for. Supplying from 0 to the end is always fine. */
  offset: number;
  length: number;
  /** The size in the placeholder. */
  total: number;
}

/** A remote file or folder the drive should show, before any content is fetched. */
export interface FilesPlaceholder {
  path: string;
  kind: 'file' | 'directory';
  size: number;
  mtimeMs: number;
  identity: string;
}

export interface FilesDriveLetterState {
  /** In use now. */
  letter: string | null;
  /** The user's own choice, kept even while a policy overrides it. */
  chosen: string | null;
  /** `FilesDriveLetter` forces it (a letter, or `none`). */
  locked: boolean;
  /** Letters free now, D to Z. */
  available: string[];
}

export interface FilesDriveState {
  /** Windows 10 1809 or later with the helper loaded. */
  supported: boolean;
  /** `FilesDriveEnabled` is off. */
  forcedOff: boolean;
  /** Accounts the user turned the drive on for, whether or not it's registered right now. */
  wanted: string[];
  letter: FilesDriveLetterState;
}

/**
 * What Explorer shows for the drive on Windows 11, where OneDrive shows its own: the sync
 * state and the storage used. The page's engine knows both, and says them in its language.
 */
export interface FilesDriveStatus {
  state: 'synced' | 'syncing' | 'paused' | 'offline' | 'error';
  /** Short, next to the state: "Up to date", "Syncing". */
  label: string;
  /** The line under it: "Syncing: 3 done, 5 to go", "Stopped: The disk is full". */
  detail: string;
  /** From the server's Quota/get. `total` null: no limit, only what's used. Null: nothing known. */
  quota: { used: number; total: number | null; label: string } | null;
  /** Storage nearly full or full, in words. */
  notice: string | null;
  /** The tray menu's line: "Bulwark Files: Up to date". Older shells ignore it. */
  tray?: string;
}

/**
 * What the main page takes once, in its first render (`files.claim()`), like `auth.claim`:
 * a same-origin frame reaches the bridge through `parent`, and main can't tell its calls
 * apart. Main also takes these calls only from the main window.
 */
export interface FilesControls {
  roots: () => Promise<FilesRoot[]>;
  /**
   * Shows the OS folder picker. Needs a real click, unless `chosen` names a folder the user
   * already picked with `chooseFolder`: then it's added without another picker.
   */
  addFolder: (request: { account: string; remoteId: string | null; remoteLabel: string; chosen?: string }) => Promise<FilesResult<FilesRoot>>;
  /** The folder on this computer first (settings-p3-4): the OS picker, a token for `addFolder` and the name. Absent in older shells. */
  chooseFolder?: () => Promise<FilesResult<{ token: string; name: string }>>;
  /** A folder: forgotten, its files stay. The drive: as `drive.disable(account, 'user')`. */
  removeRoot: (rootId: string) => Promise<void>;
  setPaused: (rootId: string, paused: boolean) => Promise<void>;
  /** Everything under `under` (default: the whole root). Skips links and main's own temporary files. */
  scan: (rootId: string, under?: string) => Promise<FilesResult<FilesLocalEntry[]>>;
  stat: (rootId: string, path: string) => Promise<FilesResult<FilesLocalEntry | null>>;
  /** A URL the page fetches once for the file's bytes (Range works). Refused for a drive file that isn't on the disk. */
  openRead: (rootId: string, path: string) => Promise<FilesResult<{ url: string; entry: FilesLocalEntry }>>;
  /**
   * Writing a file: chunks go to a temporary file next to it, `commitWrite` puts it in place
   * if what's there is still `expect` (null: nothing may be there), and sets `mtimeMs`.
   */
  beginWrite: (rootId: string, path: string, options: { expect: FilesExpect | null; mtimeMs: number; size: number }) => Promise<FilesResult<string>>;
  writeChunk: (writeId: string, data: Uint8Array) => Promise<FilesResult<null>>;
  commitWrite: (writeId: string) => Promise<FilesResult<FilesLocalEntry>>;
  abortWrite: (writeId: string) => Promise<void>;
  mkdir: (rootId: string, path: string) => Promise<FilesResult<FilesLocalEntry>>;
  /** Never overwrites. A case-only rename works on a case-insensitive disk. */
  move: (rootId: string, from: string, to: string, expect: FilesExpect | null) => Promise<FilesResult<FilesLocalEntry>>;
  /** A folder: to the OS's trash where it has one. Refused when it changed since `expect`. */
  remove: (rootId: string, path: string, expect: FilesExpect | null) => Promise<FilesResult<'trash' | 'deleted'>>;
  onChange: (listener: (event: FilesChangeEvent) => void) => () => void;
  /** The engine's own record of a root (what both sides looked like at the last sync). */
  loadState: (rootId: string) => Promise<string | null>;
  saveState: (rootId: string, state: string) => Promise<void>;
  /** Opens Explorer, Finder or the file manager on it. */
  showInFolder: (rootId: string, path: string) => Promise<boolean>;
  /** Windows only. Absent elsewhere. */
  drive?: FilesDriveControls;
}

export interface FilesDriveControls {
  state: () => Promise<FilesDriveState>;
  onStateChange: (listener: (state: FilesDriveState) => void) => () => void;
  /**
   * Registers and connects the account's sync root. Needs a real click unless the user
   * turned it on before (a sign-in brings it back). `label` is the address, shown when
   * there are several accounts.
   */
  enable: (account: string, label: string) => Promise<FilesResult<FilesRoot>>;
  /**
   * `user`: turned off. `signed-out`: the account signed out, and comes back at the next
   * sign-in, pins included. Both unregister the sync root and delete its folder, after
   * copying what wasn't uploaded to `Documents\Bulwark – not uploaded\<date>` (`rescued`;
   * older shells answer nothing and copy nothing). `suspended`: a sign-out nobody chose; only
   * disconnects, the folder stays. `wipe` and `refused` delete everything, nothing is copied.
   */
  disable: (account: string, reason: 'user' | 'signed-out' | 'suspended' | 'wipe' | 'refused') => Promise<FilesDriveDisableResult | void>;
  /**
   * Main is about to remove these accounts' drives (the policy): say `working` at once, upload
   * what waits, then `flushed` without a phase. A page that says nothing isn't waited for long.
   */
  onFlush?: (listener: (request: { requestId: string; accounts: string[] }) => void) => () => void;
  flushed?: (requestId: string, phase?: 'working') => void;
  /** Opens the folder files that weren't uploaded went to last. False when there's none. */
  openRescue?: () => Promise<boolean>;
  /** "Always keep on this device" (`pinned`) and "Free up space" (`unpinned`), as Explorer sets them. Absent in older shells. */
  setPin?: (rootId: string, path: string, pin: 'pinned' | 'unpinned') => Promise<FilesResult<null>>;
  /** New placeholders, parents first. One answer per entry. */
  place: (rootId: string, entries: FilesPlaceholder[]) => Promise<FilesResult<{ path: string; error?: FilesError }[]>>;
  /**
   * New metadata from the server for a placeholder that is in sync. `dehydrate`: the
   * content changed, drop the copy on disk (a pinned one is fetched again). Refused
   * with `changed` when someone edited it here meanwhile.
   */
  update: (rootId: string, path: string, meta: { size: number; mtimeMs: number; identity: string; dehydrate: boolean }, expect: FilesExpect | null) => Promise<FilesResult<FilesLocalEntry>>;
  /** After an upload: makes it a placeholder with this identity if it isn't one, and marks it in sync. */
  markInSync: (rootId: string, path: string, identity: string, expect: FilesExpect) => Promise<FilesResult<FilesLocalEntry>>;
  onFetch: (listener: (request: FilesFetchRequest) => void) => () => void;
  onFetchCancel: (listener: (fetchId: string) => void) => () => void;
  /** Bytes for a fetch, in order from `offset`. False when Windows no longer wants them. */
  supply: (fetchId: string, offset: number, data: Uint8Array) => Promise<boolean>;
  fail: (fetchId: string, error: 'offline' | 'missing' | 'failed') => void;
  setLetter: (letter: string | null) => Promise<FilesResult<FilesDriveLetterState>>;
  /** What Explorer shows for the account's drive. Absent in shells before it. */
  status?: (account: string, status: FilesDriveStatus) => void;
}

export interface FilesBridge {
  claim: () => FilesControls | null;
}

/** What turning the drive off did with the files that weren't uploaded. */
export interface FilesDriveDisableResult {
  rescued: FilesRescued | null;
}

export interface FilesRescued {
  /** Where they are now. */
  folder: string;
  count: number;
  /** Couldn't be copied: still in the drive's folder, which then stays. */
  failed: number;
}

/**
 * Saves messages through the OS's dialogs (lib/desktop/save-as.ts): `begin` asks where at
 * once, the Save dialog for one file and a folder for several, starting in the folder used
 * last; then each file's bytes go over with `write`, and `end` says how many were saved.
 * The shell wants a click or a menu pick just before `begin`, writes each as an .eml with a
 * safe name, never overwrites a file in a picked folder (it numbers the name), and refuses
 * under the organisation's "no downloads" and the app lock.
 */
export interface DesktopSaveAsBridge {
  begin: (request: { kind: 'message'; names: string[] }) => Promise<
    { id: string } | { cancelled: true } | { refused: 'gesture' | 'policy' | 'locked' | 'invalid' }
  >;
  write: (id: string, index: number, data: Uint8Array) => Promise<boolean>;
  end: (id: string) => Promise<{ saved: number; failed: number }>;
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
  /** Absent on older shells. */
  print?: DesktopPrintBridge;
  spellcheck?: DesktopSpellcheckBridge;
  clipboard?: DesktopClipboardBridge;
  lifecycle?: DesktopLifecycleBridge;
  updates?: DesktopUpdatesBridge;
  os?: DesktopOsBridge;
  policy?: DesktopPolicyBridge;
  servers?: DesktopServersBridge;
  auth?: DesktopAuthBridge;
  plugins?: DesktopPluginsBridge;
  keystore?: DesktopKeystoreBridge;
  /** Absent on older shells. */
  certificates?: DesktopCertificatesBridge;
  appLock?: DesktopAppLockBridge;
  /** Absent on an older shell. */
  httpCache?: { clear: () => Promise<void> };
  localImport?: DesktopLocalImportBridge;
  privacy?: DesktopPrivacyBridge;
  edit?: DesktopEditBridge;
  /** Absent on older shells. */
  devTools?: DesktopDevToolsBridge;
  /** Files on this computer. Absent on older shells. */
  files?: FilesBridge;
  /** Absent on older shells. */
  recentFiles?: DesktopRecentFilesBridge;
  /** File > Save as… and the message's own Save as: native dialogs. Absent on older shells. */
  saveAs?: DesktopSaveAsBridge;
}

declare global {
  interface Window {
    bulwarkDesktop?: BulwarkDesktopBridge;
  }
}
