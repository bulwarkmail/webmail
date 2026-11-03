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
import { keepRescuedDraft } from '@/lib/popout/rescued-drafts';
import { closePopoutWindow, isPopoutWindow } from '@/lib/popout/window-role';
import { getStore, type StoreBackend } from '@/lib/store/client/api';
import { listAccountRecords, rewrapAccountKey, StoreKeyLayerMissingError, type WrapLayer } from '@/lib/store/client/keys';
import { OWNER_LOCK } from '@/lib/store/worker/protocol';
import type { ComposerDraftData } from '@/components/email/email-composer';
import { importLockKey, LOCK_LAYER, lockLayer, mainProof } from './crypto';
import { watchIdle } from './idle';
import { createPasskey, passkeyPrf, PasskeyNoPrfError } from './passkey';
import { appLockRequired, effectiveTimeout, onLockPolicyChange } from './policy';
import { scrubBrowserStorage } from './scrub';
import {
  APP_LOCK_CHANNEL,
  APP_LOCK_HOLDER,
  APP_LOCK_KEY,
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
  changeVaultPin,
  createVault,
  deleteVault,
  openSealedDrafts,
  openVaultWithPin,
  openVaultWithPrf,
  readVault,
  removeVaultPrf,
  sealDraft,
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
  const file = readAppLockFile();
  if (file.on) {
    setLockedHere(true);
    hold = newHold();
    if (file.locked) {
      phase = 'locked';
      tellDesktopLocked();
    } else {
      phase = 'checking';
      void settleCheck();
    }
    return;
  }
  markDocument(false);
  if (setupNeeded()) {
    hold = newHold();
    phase = 'setup';
  }
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
  writeAppLockFile({ ...readAppLockFile(), locked: true });
  tellDesktopLocked();
  tellServiceWorker('locked');
  setPhase('locked');
}

function tellDesktopLocked(): void {
  getDesktopBridge()?.appLock?.lock();
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
  releaseHolder?.();
  releaseHolder = null;
}

/** The app starts, or goes on, in this tab. */
function openUp(): void {
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

function reloadPage(): void {
  if (reloadSeam) reloadSeam();
  else window.location.reload();
}

/** Tests only: jsdom can't reload. */
export function setReloadForTests(run: (() => void) | null): void {
  reloadSeam = run;
}

async function pageReachable(): Promise<boolean> {
  try {
    const response = await fetch(window.location.href, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(RELOAD_PROBE_MS) });
    return response.status < 500;
  } catch {
    return false;
  }
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
  // browser's error page, with no way to unlock. Off the screen now, out of memory when it's back.
  setPhase('locked-stay');
  window.addEventListener('online', () => {
    if (isAppLockedNow()) reloadPage();
  });
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

async function holdAndOpen(raw: Uint8Array): Promise<void> {
  try {
    const proof = await mainProof(raw);
    const key = await importLockKey(raw);
    await getDesktopBridge()?.appLock?.prove(proof).catch(() => false);
    heldKey = key;
  } finally {
    raw.fill(0);
  }
  await becomeHolder();
  const key = heldKey!;
  await addLayerWhereMissing(key);
  await storeBackend().unlock?.(OWNER_WAIT_MS);
  writeAppLockFile({ ...readAppLockFile(), on: true, locked: false });
  postAppLockMessage({ type: 'unlocked' });
  tellServiceWorker('unlocked');
  openUp();
  await deliverSealedDrafts(key);
}

async function deliverSealedDrafts(key: CryptoKey): Promise<void> {
  try {
    for (const state of await openSealedDrafts(key)) {
      if (isPopoutWindow()) postAppLockMessage({ type: 'unsealed-draft', state });
      else keepRescuedDraft(state as ComposerDraftData);
    }
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
  const member = getDesktopBridge()?.appLock;
  if (!member) return false;
  const answer = await member.osUnlock();
  if (!answer.ok) return false;
  await holdAndOpen(new Uint8Array(answer.key));
  return true;
}

// ---- The account keys ----

/** A store record made when the lock was off, or before a crash: it gets the layer now. */
async function addLayerWhereMissing(key: CryptoKey): Promise<void> {
  const layer = lockLayer(key);
  for (const record of await listAccountRecords().catch(() => [])) {
    if (!record.layers.includes(LOCK_LAYER)) await rewrapAccountKey(record.account, [layer], [layer]);
  }
}

async function removeLayerEverywhere(key: CryptoKey): Promise<void> {
  const layer = lockLayer(key);
  for (const record of await listAccountRecords().catch(() => [])) {
    if (record.layers.includes(LOCK_LAYER)) await rewrapAccountKey(record.account, [layer], []);
  }
}

/** What the store's key handling uses. Throws while this tab has no key, so nothing opens or gets written unwrapped. */
export function appLockKeyLayers(): readonly WrapLayer[] {
  if (!readAppLockFile().on) return [];
  if (!heldKey) throw new StoreKeyLayerMissingError(LOCK_LAYER);
  return [lockLayer(heldKey)];
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
}

/** Off again. The PIN proves it's the owner of the lock, in this tab or any other. */
export async function disableAppLock(pin: string): Promise<void> {
  if (appLockRequired()) throw new Error('The organisation requires the app lock');
  const raw = await openVaultWithPin(pin);
  let key: CryptoKey;
  try {
    const proof = await mainProof(raw);
    await getDesktopBridge()?.appLock?.disable(proof);
    key = await importLockKey(raw);
  } finally {
    raw.fill(0);
  }
  await removeLayerEverywhere(key);
  await deleteVault();
  writeAppLockFile({ on: false, locked: false });
  postAppLockMessage({ type: 'off' });
  tellServiceWorker('off');
  afterOff();
}

function afterOff(): void {
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

export function changeAppLockPin(currentPin: string, newPin: string): Promise<void> {
  return changeVaultPin(currentPin, newPin);
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

/**
 * The way out when the PIN is gone: all local data, and every login on this device. The
 * server keeps everything except what waited in the outbox here.
 */
export async function forgetEverything(): Promise<boolean> {
  const member = getDesktopBridge()?.appLock;
  // Native: a page's word alone can't lift the desktop's lock.
  if (member && !(await member.forget())) return false;
  const { useAuthStore } = await import('@/stores/auth-store');
  await Promise.race([
    useAuthStore.getState().logoutAll({ endProviderSession: false }),
    new Promise((resolve) => setTimeout(resolve, STORE_CLOSE_MS)),
  ]).catch(() => {});
  await deleteVault();
  writeAppLockFile({ on: false, locked: false });
  postAppLockMessage({ type: 'off' });
  tellServiceWorker('off');
  afterOff();
  window.location.replace(new URL(process.env.NEXT_PUBLIC_BASE_PATH || '/', window.location.origin).href);
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
        void desktopSaysLocked().then((locked) => {
          if (!locked) openUp();
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
    case 'unsealed-draft':
      if (!isPopoutWindow()) keepRescuedDraft(message.state as ComposerDraftData);
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
  listeners.clear();
  setLockedHere(false);
}
