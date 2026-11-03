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

/**
 * The OS certificate store and smart cards. Present only where the native helper
 * loaded and the OS has one. Failures reject with a bare code as the message:
 * keystore:cancelled, not-found, unsupported, locked, invalid, failed. The shell asks the
 * user in a native dialog before any of this, on top of which the OS has its own prompts,
 * so a call may take a while. On an instance it stays off until policy or the user allows
 * it. The key never leaves the OS.
 */
export interface DesktopKeystoreBridge {
  /** Certificates fit for mail that have a private key. The OS doesn't prompt. */
  list: () => Promise<DesktopKeystoreCertificate[]>;
  /** RSA gives the raw signature, ECDSA a DER ECDSA-Sig-Value. */
  sign: (id: string, digest: Uint8Array, scheme: DesktopKeystoreSignScheme) => Promise<Uint8Array>;
  /** Unwraps a CMS content key. */
  decrypt: (id: string, data: Uint8Array, scheme: DesktopKeystoreDecryptScheme) => Promise<Uint8Array>;
  /** The raw shared secret, big-endian. The peer's key is an EC SubjectPublicKeyInfo. */
  agree: (id: string, peerPublicKey: Uint8Array) => Promise<Uint8Array>;
  accessState: () => Promise<DesktopKeystoreAccessState>;
  /** Takes back a stored yes and this session's grants. Only ever narrows. */
  revokeAccess: () => Promise<void>;
  /** Takes back this session's grants, for the next account. Absent on older shells. */
  clearGrants?: () => Promise<void>;
}

export interface DesktopPolicyBridge {
  /** What's in force now. Synchronous: a page can read it in its first render. */
  get: () => PolicySnapshot;
  onChange: (listener: (snapshot: PolicySnapshot) => void) => () => void;
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
  updates?: DesktopUpdatesBridge;
  policy?: DesktopPolicyBridge;
  servers?: DesktopServersBridge;
  auth?: DesktopAuthBridge;
  plugins?: DesktopPluginsBridge;
  keystore?: DesktopKeystoreBridge;
}

declare global {
  interface Window {
    bulwarkDesktop?: BulwarkDesktopBridge;
  }
}
