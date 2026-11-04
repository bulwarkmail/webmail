/**
 * App lock in one tab: when it locks, what locking does, what unlocking does.
 *
 * Locking saves what's being written, closes the store, drops the keys, then reloads
 * the page. The reload is how memory gets cleared: no list of stores to reset can
 * be as complete as a new document, and it takes the plugin frames, the client's
 * credentials and every module cache along. The new document stops at the lock screen
 * (components/app-lock/app-lock-gate.tsx), so nothing starts until someone unlocks.
 *
 * The lock key lives in the memory of the tab that unlocked, and in no other. It
 * never goes over a channel. That tab holds a Web Lock for as long as it lives. When it
 * goes, whichever tab inherits the store couldn't open it, so every tab locks.
 *
 * In the desktop app, main has the last word on whether the app is locked (see
 * the shell's src/main/app-lock-gate.ts). A page can tell it to lock and can prove
 * the real unlock, and has no way to just say "unlocked".
 */

import { flushComposers, composeSnapshots } from '@/lib/compose-flush-registry';
import { getDesktopBridge } from '@/lib/desktop/bridge';
import { setAppLockCheck } from '@/lib/desktop/app-lock-state';
import { restoreUrlFor } from '@/lib/desktop/window-restore';
import { IS_LITE } from '@/lib/lite';
import { useOfflineStore } from '@/lib/offline/state';
import { keepRescuedDraft } from '@/lib/popout/rescued-drafts';
import { closePopoutWindow, isPopoutWindow } from '@/lib/popout/window-role';
import { getStore, type StoreBackend } from '@/lib/store/client/api';
import { forgetAccountKey, listAccountRecords, rewrapAccountKey, StoreKeyLayerMissingError, type AccountRecord, type WrapLayer } from '@/lib/store/client/keys';
import { purgeStoreFiles } from '@/lib/store/client/purge';
import { purgeSignedOutData } from '@/lib/sign-out-cleanup';
import { OWNER_LOCK } from '@/lib/store/worker/protocol';
import type { ComposerDraftData } from '@/components/email/email-composer';
import { importLockKey, LOCK_LAYER, lockLayer, mainProof, ObviousPinError, pinIsObvious, randomBytes, SHELL_LAYER } from './crypto';
import { watchIdle } from './idle';
import { createPasskey, passkeyPrf, PasskeyNoPrfError } from './passkey';
import { appLockRequired, effectiveTimeout, onLockPolicyChange } from './policy';
import { reloadSealedStores, restoreSealedStorage, scrubBrowserStorage } from './scrub';
import { shellControls, shellHasWrap, shellUnwrapCall, shellWrapCall, resetShellForTests } from './shell';
import { clearPendingCookies, markCookiesToClear, rememberMainProof, requireFreshLogin } from './sign-out';
import {
  APP_LOCK_CHANNEL,
  APP_LOCK_HOLDER,
  APP_LOCK_KEY,
  headScriptFoundNoVault,
  isAppLockedNow,
  postAppLockMessage,
  readAppLockFile,
  setLockedHere,
  writeAppLockFile,
  type AppLockFile,
  type AppLockMessage,
} from './state';
import {
  addVaultPrf,
  clearVaultPrevious,
  createVault,
  deleteVault,
  openSealedDrafts,
  openVaultPrevious,
  openVaultWithPin,
  openVaultWithPrf,
  readVault,
  removeVaultPrf,
  rotateVaultKey,
  sealDraft,
  vaultExists,
} from './vault';

export type AppLockPhase =
  /** Off, or on and unlocked. */
  | 'open'
  /** On, and this tab asks whether another tab holds the key. */
  | 'checking'
  /** An organisation requires it and no PIN exists yet. */
  | 'setup'
  /** On its way to the lock screen: saving, closing. */
  | 'locking'
  | 'locked'
  /** Locked, in a page that couldn't reload: the app is gone from the screen. */
  | 'locked-stay';

/** Long enough for a draft save, and for a send under way to end. The screen is covered by then. */
const LOCK_FLUSH_MS = 15_000;
const STORE_CLOSE_MS = 5_000;
const OWNER_WAIT_MS = 5_000;
const HOLDER_WAIT_MS = 1_500;
const RELOAD_PROBE_MS = 2_000;
/** How long a start without the lock file holds the page for the look at the vault. */
const VAULT_LOOK_MS = 1_500;
/** Locked on a page that couldn't reload: how often it tries again. Only the server may have been down. */
export const STAY_RETRY_MS = 30_000;
/** How long a forgotten PIN waits for the sign-out, on top of the cookies' own wait. Nothing depends on it by then. */
const FORGET_LOGOUT_MS = 5_000;
const DRAFTS_SAVED_KEY = 'bulwark-app-lock-drafts-saved';

let booted = false;
let phase: AppLockPhase = 'open';
const listeners = new Set<() => void>();
let hold: { promise: Promise<void>; release: () => void } | null = null;

/** Only ever in this tab's memory. Can't be read back out. */
let heldKey: CryptoKey | null = null;
let releaseHolder: (() => void) | null = null;
let holderWatch: AbortController | null = null;
let stopIdle: (() => void) | null = null;
let stopStay: (() => void) | null = null;
/** Setting up right now: the vault this tab just wrote says nothing about a lost file. */
let enabling = false;
/** Main's wrap for the keys, when it has a real one. Known once asked: unlocking and enabling ask first. */
let shellWraps = false;
let shellAsked = false;

/** See lib/app-lock/shell.ts. Taken in the first render, before any frame exists. */
const desktopControls = shellControls;

function setPhase(next: AppLockPhase): void {
  if (phase === next) return;
  phase = next;
  for (const listener of [...listeners]) listener();
}

export function getAppLockPhase(): AppLockPhase {
  return phase;
}

export function subscribeAppLockPhase(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function newHold(): { promise: Promise<void>; release: () => void } {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** While this is pending, the app under the gate doesn't hydrate. */
export function appLockHold(): Promise<void> | null {
  return hold?.promise ?? null;
}

function markDocument(locked: boolean): void {
  if (typeof document === 'undefined') return;
  if (locked) document.documentElement.setAttribute('data-app-locked', '');
  else document.documentElement.removeAttribute('data-app-locked');
}

function hasAccounts(): boolean {
  try {
    const parsed = JSON.parse(localStorage.getItem('account-registry') ?? 'null') as { state?: { accounts?: unknown[] } } | null;
    return (parsed?.state?.accounts?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

function setupNeeded(): boolean {
  return !readAppLockFile().on && appLockRequired() && hasAccounts();
}

/**
 * Decides this tab's start, synchronously, in the first client render. A tab that
 * finds the lock on doesn't start the app until it knows a tab holds the key.
 */
export function bootAppLock(): void {
  if (booted || typeof window === 'undefined' || IS_LITE) return;
  booted = true;
  setAppLockCheck(isAppLockedNow);
  desktopControls();
  const file = readAppLockFile();
  if (file.on) {
    setLockedHere(true);
    hold = newHold();
    if (file.locked) {
      phase = 'locked';
      tellDesktopLocked();
      void scrubBrowserStorage();
    } else {
      phase = 'checking';
      void settleCheck();
    }
    return;
  }
  markDocument(false);
  // The look already came back empty: nothing to hold back for.
  if (headScriptFoundNoVault() && !setupNeeded()) return;
  hold = newHold();
  if (setupNeeded()) {
    phase = 'setup';
  } else {
    setLockedHere(true);
    phase = 'checking';
  }
  void settleNoFile();
}

function lockedFromNow(): void {
  writeAppLockFile({ ...readAppLockFile(), on: true, locked: true });
  setLockedHere(true);
  markDocument(true);
  hold ??= newHold();
  tellDesktopLocked();
  tellServiceWorker('locked');
  void scrubBrowserStorage();
  setPhase('locked');
}

/**
 * No file says the lock is on. Most often that's the truth, and this takes one look at
 * IndexedDB. But the file can go on its own (a cleared site setting, an extension, someone
 * at the keyboard), and the vault is what really decides: it holds the key the store's
 * keys depend on. A look that takes too long lets the page go on, and locks it if it ends in a vault.
 */
async function settleNoFile(): Promise<void> {
  const looking = vaultExists();
  let waited = false;
  const found = await Promise.race([
    looking,
    new Promise<boolean>((resolve) => setTimeout(() => {
      waited = true;
      resolve(false);
    }, VAULT_LOOK_MS)),
  ]);
  if (readAppLockFile().on) {
    // Another tab turned it on meanwhile.
    if (phase === 'checking') void settleCheck();
    return;
  }
  if (found && !enabling) {
    lockedFromNow();
    return;
  }
  if (phase === 'checking') {
    setLockedHere(false);
    const next = setupNeeded() ? 'setup' : 'open';
    setPhase(next);
    if (next === 'open') {
      hold?.release();
      hold = null;
    }
  }
  if (waited) {
    void looking.then((late) => {
      if (late && !enabling && !readAppLockFile().on) void lockLate();
    });
  }
}

async function lockLate(): Promise<void> {
  writeAppLockFile({ ...readAppLockFile(), on: true, locked: true });
  postAppLockMessage({ type: 'lock' });
  await applyLockHere();
}

async function holderAlive(): Promise<boolean> {
  if (!navigator.locks?.query) return false;
  try {
    const { held } = await navigator.locks.query();
    return (held ?? []).some((lock) => lock.name === APP_LOCK_HOLDER);
  } catch {
    return false;
  }
}

async function desktopSaysLocked(): Promise<boolean> {
  const member = getDesktopBridge()?.appLock;
  if (!member) return false;
  try {
    return (await member.status()).locked;
  } catch {
    return true;
  }
}

async function settleCheck(): Promise<void> {
  if (phase !== 'checking') return;
  if (await holderAlive() && !(await desktopSaysLocked())) {
    openUp();
    return;
  }
  // Nobody holds the key: a crash, or the browser was closed without saying so.
  lockedFromNow();
}

/** Main's gate, and the OS integration's own state: tray, jump list and toasts (the shell's os-hub.ts). */
function tellDesktopLocked(): void {
  desktopControls()?.lock();
  getDesktopBridge()?.os?.setLocked(true);
}

/** The service worker shows push notifications with no page around. Kept across its restarts. */
function tellServiceWorker(state: 'locked' | 'unlocked' | 'off'): void {
  try {
    const message = { type: 'app-lock', state };
    const worker = navigator.serviceWorker;
    if (!worker) return;
    if (worker.controller) worker.controller.postMessage(message);
    else void worker.ready.then((registration) => registration.active?.postMessage(message));
  } catch {
    // No service worker, no push notifications.
  }
}

function startIdle(): void {
  stopIdle?.();
  const file = readAppLockFile();
  if (!file.on) {
    stopIdle = null;
    return;
  }
  stopIdle = watchIdle({
    timeoutMs: () => effectiveTimeout(readAppLockFile().timeoutMinutes).minutes * 60_000,
    onIdle: () => lockEverywhere(),
  });
}

/**
 * A tab with no key watches for the one that has it to go. The request waits as long
 * as the holder lives. Being granted means it's gone.
 */
function watchHolder(): void {
  holderWatch?.abort();
  holderWatch = null;
  if (!navigator.locks?.request || releaseHolder) return;
  const watch = new AbortController();
  holderWatch = watch;
  void navigator.locks.request(APP_LOCK_HOLDER, { signal: watch.signal }, () => {
    if (heldKey) return keepHolder();
    if (readAppLockFile().on && !readAppLockFile().locked) lockEverywhere();
    return undefined;
  }).catch(() => {});
}

function keepHolder(): Promise<void> {
  return new Promise<void>((resolve) => {
    releaseHolder = resolve;
  });
}

async function becomeHolder(): Promise<void> {
  holderWatch?.abort();
  holderWatch = null;
  if (releaseHolder || !navigator.locks?.request) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, HOLDER_WAIT_MS);
    void navigator.locks.request(APP_LOCK_HOLDER, () => {
      clearTimeout(timer);
      resolve();
      return keepHolder();
    }).catch(() => resolve());
  });
}

function dropKey(): void {
  heldKey = null;
  rememberMainProof(null);
  releaseHolder?.();
  releaseHolder = null;
}

/** The app starts, or goes on, in this tab. */
function openUp(): void {
  stopStay?.();
  setLockedHere(false);
  markDocument(false);
  setPhase('open');
  startIdle();
  if (readAppLockFile().on && !heldKey) watchHolder();
  hold?.release();
  hold = null;
}

// ---- Locking ----

/** Every window and tab. Safe to call at any time; it only ever makes things more locked. */
export function lockEverywhere(): void {
  const file = readAppLockFile();
  if (!file.on) return;
  writeAppLockFile({ ...file, locked: true });
  postAppLockMessage({ type: 'lock' });
  void applyLockHere();
}

async function saveComposers(): Promise<{ closing: boolean; saved: number }> {
  const snapshots = composeSnapshots();
  const flushed = await flushComposers(LOCK_FLUSH_MS);
  const after = composeSnapshots();
  let closing = false;
  let saved = 0;
  const trouble = flushed.failed > 0 || flushed.timedOut;
  for (const snapshot of after) {
    const state = snapshot.state();
    const draft = snapshot.draft();
    if (trouble && state) {
      // Not on the server. Sealed, it waits for the lock key.
      await sealDraft(state).catch(() => {});
      if (snapshot.ownWindow) closing = true;
      continue;
    }
    if (draft) saved += 1;
    if (!snapshot.ownWindow) continue;
    if (draft) {
      // This window's address names no text of its own after a reload: it opens this draft.
      window.history.replaceState(window.history.state, '', restoreUrlFor(draft));
    } else {
      closing = true;
    }
  }
  if (snapshots.length > 0 && saved > 0) {
    try {
      sessionStorage.setItem(DRAFTS_SAVED_KEY, '1');
    } catch {
      // Only the notice goes.
    }
  }
  return { closing, saved };
}

/** A flush under way stops at its next item (lib/offline/flush.ts). This waits for that item. */
async function outboxAtRest(): Promise<void> {
  if (!navigator.locks?.query) return;
  const until = Date.now() + LOCK_FLUSH_MS;
  while (Date.now() < until) {
    const { held } = await navigator.locks.query();
    if (!(held ?? []).some((lock) => lock.name?.startsWith('bulwark-offline-flush:'))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

let reloadSeam: (() => void) | null = null;

/**
 * In the desktop app in a new renderer process: what JS can't overwrite is only gone with the
 * process it's in, and a reload stays in the same one. A browser gives a page no such thing, so
 * there the old heap is unreachable, not gone.
 */
function reloadPage(): void {
  if (reloadSeam) {
    reloadSeam();
    return;
  }
  const replace = desktopControls()?.replaceRenderer;
  if (replace) replace();
  else window.location.reload();
}

/** Tests only: jsdom can't reload. */
export function setReloadForTests(run: (() => void) | null): void {
  reloadSeam = run;
}

/**
 * Whether a reload would land on a page. The service worker answers this as it would answer
 * the reload (public/sw.js), from its copy of the shell when offline, so a lock with no
 * network still clears memory. Only a page with neither stays where it is.
 */
async function pageReachable(): Promise<boolean> {
  try {
    const response = await fetch(window.location.href, {
      method: 'GET',
      cache: 'no-store',
      headers: { 'x-bulwark-reload-probe': '1' },
      signal: AbortSignal.timeout(RELOAD_PROBE_MS),
    });
    void response.body?.cancel().catch(() => {});
    return response.status < 500;
  } catch {
    return false;
  }
}

/** Off the screen now, out of memory as soon as a reload can land somewhere. */
function stayUntilReachable(): void {
  setPhase('locked-stay');
  const tryNow = () => {
    void pageReachable().then((reachable) => {
      if (reachable && isAppLockedNow() && phase === 'locked-stay') {
        stopStay?.();
        reloadPage();
      }
    });
  };
  const timer = setInterval(tryNow, STAY_RETRY_MS);
  window.addEventListener('online', tryNow);
  stopStay = () => {
    clearInterval(timer);
    window.removeEventListener('online', tryNow);
    stopStay = null;
  };
}

async function applyLockHere(): Promise<void> {
  if (phase === 'locking' || phase === 'locked' || phase === 'locked-stay') return;
  const wasRunning = phase === 'open';
  setLockedHere(true);
  markDocument(true);
  setPhase('locking');
  tellDesktopLocked();
  tellServiceWorker('locked');
  stopIdle?.();
  stopIdle = null;
  holderWatch?.abort();
  holderWatch = null;

  let closing = false;
  if (wasRunning) {
    try {
      ({ closing } = await saveComposers());
      await outboxAtRest();
    } catch {
      // The lock goes on: what's on screen is covered either way.
    }
    await scrubBrowserStorage();
  }
  await lockStore();
  dropKey();
  if (closing) closePopoutWindow();
  if (await pageReachable()) {
    reloadPage();
    return;
  }
  // The server is out of reach and there's no copy of the page: a reload would land on the
  // browser's error page, with no way to unlock.
  stayUntilReachable();
}

function storeBackend(): StoreBackend {
  return getStore();
}

async function lockStore(): Promise<void> {
  try {
    await storeBackend().lock?.(STORE_CLOSE_MS);
  } catch {
    // Its worker is stopped either way.
  }
}

// ---- Unlocking ----

/**
 * Main has to agree before this tab opens: a page can't go on while main says locked. A no
 * on a good PIN means main lost its record or keeps one from before. Having the proof shows
 * the PIN was right, so it enrolls again. Main refuses that while it holds another lock, and
 * then only the user can let that one go, natively.
 */
async function proveToMain(proof: Uint8Array): Promise<void> {
  const member = getDesktopBridge()?.appLock;
  if (!member) return;
  if (await member.prove(proof).catch(() => false)) return;
  if (await member.enroll(proof).catch(() => false)) return;
  if (await member.forget().catch(() => false) && await member.enroll(proof).catch(() => false)) return;
  throw new Error('The desktop app stays locked');
}

async function askShell(): Promise<void> {
  const member = getDesktopBridge()?.appLock;
  shellWraps = member ? await shellHasWrap() : false;
  shellAsked = true;
}

async function holdAndOpen(raw: Uint8Array): Promise<void> {
  try {
    const proof = await mainProof(raw);
    const key = await importLockKey(raw);
    await proveToMain(proof);
    rememberMainProof(proof);
    heldKey = key;
  } finally {
    raw.fill(0);
  }
  await askShell();
  await becomeHolder();
  const key = heldKey!;
  await moveFromPreviousKey(key);
  await addLayerWhereMissing(key);
  await storeBackend().unlock?.(OWNER_WAIT_MS);
  // Before the app below starts, and before the others hear: they read it again when they do.
  if (!isPopoutWindow()) {
    await restoreSealedStorage(key);
    await reloadSealedStores();
  }
  writeAppLockFile({ ...readAppLockFile(), on: true, locked: false });
  postAppLockMessage({ type: 'unlocked' });
  tellServiceWorker('unlocked');
  openUp();
  await deliverSealedDrafts(key);
}

/** A pop-out is about to close and nothing listens for it with no main window: they wait for one. */
async function deliverSealedDrafts(key: CryptoKey): Promise<void> {
  if (isPopoutWindow()) return;
  try {
    for (const state of await openSealedDrafts(key)) keepRescuedDraft(state as ComposerDraftData);
  } catch {
    // They stay sealed for the next unlock.
  }
}

export async function unlockWithPin(pin: string): Promise<void> {
  await holdAndOpen(await openVaultWithPin(pin));
}

export async function unlockWithPasskey(): Promise<void> {
  const vault = await readVault();
  if (!vault?.prf) throw new PasskeyNoPrfError();
  const output = await passkeyPrf(vault.prf.credentialId, vault.prf.salt);
  if (!output) throw new PasskeyNoPrfError();
  await holdAndOpen(await openVaultWithPrf(output));
}

/** Windows Hello or Touch ID. Main asks, and only hands over the key after a yes. */
export async function unlockWithOs(): Promise<boolean> {
  const member = desktopControls();
  if (!member) return false;
  const answer = await member.osUnlock();
  if (!answer.ok) return false;
  await holdAndOpen(new Uint8Array(answer.key));
  return true;
}

// ---- The account keys ----

/**
 * A store record made when the lock was off, or before a crash: it gets the layer now. Whatever
 * wraps it already has to come off to get at the key, and goes back on under the lock. One that
 * can't (a copied profile) doesn't keep the others shut, and the app says so.
 */
async function addLayerWhereMissing(key: CryptoKey): Promise<void> {
  const layer = lockLayer(key);
  const shell = shellLayer();
  const wanted = shell ? [shell, layer] : [layer];
  for (const record of await listAccountRecords().catch(() => [] as AccountRecord[])) {
    if (record.layers.join() === wanted.map((entry) => entry.name).join()) continue;
    await rewrapAccountKey(record.account, wanted, wanted).catch((error: unknown) => {
      console.warn('[app-lock] A record stays without the layer:', (error as Error)?.name);
      useOfflineStore.setState({ keyUnprotected: true });
    });
  }
}

/** Off again. The OS's layer stays: it's there with the lock off as well. */
async function removeLayerEverywhere(key: CryptoKey): Promise<void> {
  const layer = lockLayer(key);
  const shell = shellLayer();
  for (const record of await listAccountRecords().catch(() => [] as AccountRecord[])) {
    if (record.layers.includes(LOCK_LAYER)) await rewrapAccountKey(record.account, shell ? [shell, layer] : [layer], shell ? [shell] : []);
  }
}

/** A changed PIN made a new lock key. Every store key moves over before the old one goes. */
async function moveFromPreviousKey(key: CryptoKey): Promise<void> {
  const old = await openVaultPrevious(key).catch(() => null);
  if (!old) return;
  const oldKey = await importLockKey(old);
  old.fill(0);
  const shell = shellLayer();
  const layers = (lock: CryptoKey) => (shell ? [shell, lockLayer(lock)] : [lockLayer(lock)]);
  let allMoved = true;
  for (const record of await listAccountRecords().catch(() => [] as AccountRecord[])) {
    if (!record.layers.includes(LOCK_LAYER)) continue;
    try {
      await rewrapAccountKey(record.account, layers(oldKey), layers(key), { rekey: true });
    } catch {
      // Under the new key already, from a try that stopped halfway? Then this goes through.
      await rewrapAccountKey(record.account, layers(key), layers(key), { rekey: true }).catch(() => {
        allMoved = false;
      });
    }
  }
  if (allMoved) await clearVaultPrevious();
}

/** The desktop's safeStorage around the database key (the build prompt's second layer), lock or no lock. */
function shellLayer(): WrapLayer | null {
  const wrap = shellWrapCall();
  const unwrap = shellUnwrapCall();
  if (!shellWraps || !wrap || !unwrap) return null;
  const through = async (run: (data: Uint8Array) => Promise<Uint8Array | null>, data: Uint8Array) => {
    const out = await run(data);
    if (!out) throw new StoreKeyLayerMissingError(SHELL_LAYER);
    return out;
  };
  return {
    name: SHELL_LAYER,
    wrap: (data) => through(wrap, data),
    unwrap: (data) => through(unwrap, data),
  };
}

/** What the store's key handling uses. Throws while this tab has no key, so nothing opens or gets written unwrapped. */
export function appLockKeyLayers(): readonly WrapLayer[] {
  const shell = shellLayer();
  if (!readAppLockFile().on) return shell ? [shell] : [];
  if (!heldKey) throw new StoreKeyLayerMissingError(LOCK_LAYER);
  return shell ? [shell, lockLayer(heldKey)] : [lockLayer(heldKey)];
}

/** The same, for a start that hasn't asked main yet whether it has a real key store. */
export async function storeKeyLayers(): Promise<readonly WrapLayer[]> {
  if (!shellAsked) await askShell();
  return appLockKeyLayers();
}

/** This tab inherited the store and has no key for it. */
export function onStoreKeyMissing(): void {
  lockEverywhere();
}

async function ownerIsElsewhere(): Promise<boolean> {
  if (!navigator.locks?.query) return false;
  const { held } = await navigator.locks.query();
  return (held ?? []).some((lock) => lock.name === OWNER_LOCK) && !storeBackend().ownsStoreHere?.();
}

// ---- Settings ----

export async function enableAppLock(pin: string): Promise<void> {
  enabling = true;
  try {
    await enable(pin);
  } finally {
    enabling = false;
  }
}

async function enable(pin: string): Promise<void> {
  const raw = await createVault(pin);
  const proof = await mainProof(raw);
  const member = getDesktopBridge()?.appLock;
  if (member && !(await member.enroll(proof))) {
    // Main still knows an earlier lock this profile lost. It asks the user natively.
    if (!(await member.forget()) || !(await member.enroll(proof))) {
      raw.fill(0);
      await deleteVault();
      throw new Error('The desktop app refused the lock');
    }
  }
  const key = await importLockKey(raw);
  raw.fill(0);
  heldKey = key;
  rememberMainProof(proof);
  await askShell();
  await becomeHolder();
  await addLayerWhereMissing(key);
  const file: AppLockFile = { ...readAppLockFile(), on: true, locked: false };
  writeAppLockFile(file);
  try {
    localStorage.removeItem('email-snapshot');
  } catch {
    // Storage blocked: there's no snapshot either.
  }
  postAppLockMessage({ type: 'enabled' });
  tellServiceWorker('unlocked');
  openUp();
  // Another tab has the store open and no key for what comes next. Everyone starts over.
  if (await ownerIsElsewhere()) lockEverywhere();
  else void storeBackend().rekeyPending?.();
}

/** Off again. The PIN proves it's the owner of the lock, in this tab or any other. */
export async function disableAppLock(pin: string): Promise<void> {
  if (appLockRequired()) throw new Error('The organisation requires the app lock');
  const raw = await openVaultWithPin(pin);
  let key: CryptoKey;
  try {
    const proof = await mainProof(raw);
    await letMainGo(proof);
    key = await importLockKey(raw);
  } finally {
    raw.fill(0);
  }
  await askShell();
  await removeLayerEverywhere(key);
  await deleteVault();
  writeAppLockFile({ on: false, locked: false });
  postAppLockMessage({ type: 'off' });
  tellServiceWorker('off');
  afterOff();
}

/** A no means main keeps a lock from before this PIN. Only the user can let that go, natively. */
async function letMainGo(proof: Uint8Array): Promise<void> {
  const member = getDesktopBridge()?.appLock;
  if (!member || await member.disable(proof).catch(() => false)) return;
  const status = await member.status().catch(() => null);
  if (status && !status.enrolled) return;
  if (!(await member.forget().catch(() => false))) throw new Error('The desktop app keeps the lock');
}

function afterOff(): void {
  stopStay?.();
  stopIdle?.();
  stopIdle = null;
  holderWatch?.abort();
  holderWatch = null;
  dropKey();
  setLockedHere(false);
  markDocument(false);
  setPhase('open');
  hold?.release();
  hold = null;
}

/**
 * A new PIN takes a new lock key and, in the background, new store keys: the old PIN's record can
 * stay in the browser's files, and must not open anything any more. Main hears first, so that
 * wherever this stops the vault can still be opened. `reenroll`: the passkey and the OS's unlock
 * held the old key, and have to be set up again.
 */
export async function changeAppLockPin(currentPin: string, newPin: string): Promise<{ reenroll: boolean }> {
  if (pinIsObvious(newPin)) throw new ObviousPinError();
  const member = getDesktopBridge()?.appLock;
  const hadOther = Boolean((await readVault())?.prf) || Boolean((await member?.status().catch(() => null))?.osEnrolled);
  const oldRaw = await openVaultWithPin(currentPin);
  const newRaw = randomBytes(32);
  try {
    const hadKey = heldKey !== null;
    const newProof = await mainProof(newRaw);
    if (member) {
      await letMainGo(await mainProof(oldRaw));
      if (!(await member.enroll(newProof))) throw new Error('The desktop app refused the lock');
    }
    await rotateVaultKey(newPin, oldRaw, newRaw);
    // Setting the new PIN went through main's count too.
    await member?.prove(newProof).catch(() => false);
    const key = await importLockKey(newRaw);
    await askShell();
    await moveFromPreviousKey(key);
    if (!hadKey) {
      // Another tab holds the old key: everyone starts over with the new one.
      lockEverywhere();
      return { reenroll: hadOther };
    }
    heldKey = key;
    rememberMainProof(newProof);
    void storeBackend().rekeyPending?.();
    return { reenroll: hadOther };
  } finally {
    oldRaw.fill(0);
    newRaw.fill(0);
  }
}

export function setAppLockTimeout(minutes: number): void {
  writeAppLockFile({ ...readAppLockFile(), timeoutMinutes: minutes });
}

export async function addPasskey(pin: string, appName: string): Promise<void> {
  const passkey = await createPasskey(appName);
  const raw = await openVaultWithPin(pin);
  try {
    await addVaultPrf(raw, passkey.credentialId, passkey.salt, passkey.prfOutput);
  } finally {
    raw.fill(0);
  }
}

export function removePasskey(): Promise<void> {
  return removeVaultPrf();
}

export async function hasPasskey(): Promise<boolean> {
  return Boolean((await readVault())?.prf);
}

export async function addOsUnlock(pin: string): Promise<boolean> {
  const member = getDesktopBridge()?.appLock;
  if (!member) return false;
  const raw = await openVaultWithPin(pin);
  try {
    return await member.osEnroll(await mainProof(raw), raw);
  } finally {
    raw.fill(0);
  }
}

let leaveSeam: (() => void) | null = null;

/** Tests only: jsdom can't navigate. */
export function setLeaveForTests(run: (() => void) | null): void {
  leaveSeam = run;
}

function leaveForLogin(): void {
  if (leaveSeam) leaveSeam();
  else window.location.replace(new URL(process.env.NEXT_PUBLIC_BASE_PATH || '/', window.location.origin).href);
}

/** The keys, for sure: with them gone the store's files can't be read, and no record is left wanting the vault. */
async function removeAccountKeys(): Promise<boolean> {
  await purgeStoreFiles().catch(() => {});
  const left = await listAccountRecords(true).catch(() => [] as AccountRecord[]);
  for (const record of left) await forgetAccountKey(record.account).catch(() => {});
  return left.length === 0 || (await listAccountRecords(true).catch(() => left)).length === 0;
}

/**
 * The way out when the PIN is gone: all local data, and every login on this device. The
 * server keeps everything except what waited in the outbox here.
 *
 * In an order that doesn't depend on the server. The registry and the keys go first, with
 * no network, and the lock stays up meanwhile, so wherever this stops nobody is signed in
 * without a PIN and no record wants a vault that's gone. The lock lifts last. Only then the
 * sign-out, which needs the server and may hang: nothing waits for it beyond its time.
 *
 * What it leaves: the HttpOnly cookies when the server is out of reach, under a mark the
 * start-up clears first (lib/app-lock/sign-out.ts). And the identity provider's session,
 * which stays open: the next login asks the provider for a real one.
 */
export async function forgetEverything(): Promise<boolean> {
  const member = getDesktopBridge()?.appLock;
  // Native: a page's word alone can't lift the desktop's lock.
  if (member && !(await member.forget())) return false;
  markCookiesToClear();
  requireFreshLogin();
  try {
    sessionStorage.setItem('signed_out', 'true');
  } catch {
    // Only the login page's automatic redirect goes by it.
  }
  const { forgetDeviceRows } = await import('@/lib/offline/device-wipe');
  await forgetDeviceRows().catch(() => {});
  const { useAccountStore } = await import('@/stores/account-store');
  useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null } as never);
  try {
    localStorage.removeItem('account-registry');
  } catch {
    // Storage blocked: nothing was kept there either.
  }
  if (!(await removeAccountKeys())) return false;
  purgeSignedOutData({ keepAppLock: true });

  await deleteVault();
  writeAppLockFile({ on: false, locked: false });
  postAppLockMessage({ type: 'off' });
  tellServiceWorker('off');
  rememberMainProof(null);

  const { useAuthStore } = await import('@/stores/auth-store');
  await Promise.race([
    Promise.resolve().then(() => useAuthStore.getState().logoutAll({ endProviderSession: false })).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, FORGET_LOGOUT_MS)),
  ]);
  await clearPendingCookies();
  // This tab stays behind its lock screen until the new page: nothing of the app starts here.
  leaveForLogin();
  return true;
}

/** A saved draft's notice, once, after the lock that saved it. */
export function takeDraftsSavedNotice(): boolean {
  try {
    if (sessionStorage.getItem(DRAFTS_SAVED_KEY) === null) return false;
    sessionStorage.removeItem(DRAFTS_SAVED_KEY);
    return true;
  } catch {
    return false;
  }
}

// ---- The tab's life ----

function onMessage(message: AppLockMessage): void {
  switch (message.type) {
    case 'lock':
      void applyLockHere();
      break;
    case 'unlocked':
      if (phase === 'locked' || phase === 'checking' || phase === 'locked-stay') {
        void desktopSaysLocked().then(async (locked) => {
          if (locked) return;
          await reloadSealedStores();
          openUp();
        });
      }
      break;
    case 'enabled':
      if (phase === 'setup') {
        openUp();
        break;
      }
      startIdle();
      if (!heldKey) watchHolder();
      break;
    case 'off':
      afterOff();
      break;
    case 'main-ping':
      if (!isPopoutWindow()) postAppLockMessage({ type: 'main-pong' });
      break;
    case 'focus-main':
      if (!isPopoutWindow()) window.focus();
      break;
  }
}

/** Runs for as long as the tab does, above the part of the page that the lock holds back. */
export function startAppLock(): () => void {
  if (IS_LITE || typeof window === 'undefined') return () => {};
  bootAppLock();
  let channel: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(APP_LOCK_CHANNEL);
    channel.onmessage = (event: MessageEvent<AppLockMessage>) => onMessage(event.data);
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key !== APP_LOCK_KEY) return;
    const file = readAppLockFile();
    if (file.on && file.locked && phase === 'open') void applyLockHere();
  };
  window.addEventListener('storage', onStorage);
  const stopDesktop = getDesktopBridge()?.appLock?.onLockRequest(() => lockEverywhere());
  const reevaluate = () => {
    if (phase === 'open' && setupNeeded()) setPhase('setup');
  };
  const stopPolicy = onLockPolicyChange(reevaluate);
  if (phase === 'open' && readAppLockFile().on) {
    startIdle();
    if (!heldKey) watchHolder();
  }
  if (readAppLockFile().on) tellServiceWorker(isAppLockedNow() ? 'locked' : 'unlocked');
  return () => {
    channel?.close();
    window.removeEventListener('storage', onStorage);
    stopDesktop?.();
    stopPolicy();
    stopIdle?.();
    stopIdle = null;
  };
}

/** An account appeared in a tab that started with none: a required lock is due now. */
export function recheckAppLockSetup(): void {
  if (phase === 'open' && setupNeeded()) setPhase('setup');
}

/** Tests only. */
export function resetAppLockForTests(): void {
  booted = false;
  phase = 'open';
  hold = null;
  heldKey = null;
  releaseHolder = null;
  holderWatch = null;
  stopIdle?.();
  stopIdle = null;
  stopStay?.();
  resetShellForTests();
  enabling = false;
  shellWraps = false;
  shellAsked = false;
  rememberMainProof(null);
  listeners.clear();
  setLockedHere(false);
}
