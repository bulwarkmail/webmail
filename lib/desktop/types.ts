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

/** A native menu built from an HTML one (lib/desktop/native-menu.ts). */
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
  /**
   * What only main can delete. `account` null: everything on this device, and then `finishLocalWipe`.
   * `failed` names what didn't go, and the wipe isn't reported as done. Absent on an older shell.
   */
  localWipe?: (request: { reason: 'remote' | 'settings'; account: string | null }) => Promise<{ failed: string[] }>;
  /** Clears what the page still stood on, and restarts the app. */
  finishLocalWipe?: (options: { keepLocalStorage: boolean }) => Promise<void>;
}

export interface DesktopAppLockBridge {
  status: () => Promise<{ locked: boolean; enrolled: boolean; os: DesktopOsUnlockKind | null; osEnrolled: boolean; wrap?: boolean }>;
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
  | { type: 'new-message' }
  | { type: 'navigate'; target: 'inbox' | 'calendar' | 'contacts' }
  | { type: 'open-message'; emailId: string; accountId?: string; context?: string }
  | { type: 'open-mailbox'; mailboxId: string }
  | { type: 'mailto'; url: string }
  | { type: 'webcal'; url: string }
  /** `ask`: opened with the app, so the user picks between a new message and Files. Without it, attach. */
  | { type: 'files'; reason: 'open' | 'attach'; files: DesktopOsFile[]; failed: string[]; ask?: boolean }
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
  /** What a locked app says instead: new mail unless this says otherwise. */
  kind?: 'mail' | 'reminder';
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

export interface BulwarkDesktopBridge {
  version: number;
  platform: 'win32' | 'darwin' | 'linux';
  mode?: 'standalone' | 'instance';
  windows?: DesktopWindowsBridge;
  theme?: DesktopThemeBridge;
  menu?: DesktopMenuBridge;
  shell?: DesktopShellBridge;
  dialogs?: DesktopDialogsBridge;
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
  /** Absent on older shells. */
  recentFiles?: DesktopRecentFilesBridge;
}

declare global {
  interface Window {
    bulwarkDesktop?: BulwarkDesktopBridge;
  }
}
