/**
 * Everything that takes an account's data off this device, and how a device
 * hears that it should:
 *
 * - the instance's registry (lib/devices): a wipe an admin asked for, heard at
 *   check-in. At a start the check-in runs before the local copy is shown.
 * - the server refusing the stored login for good, through
 *   lib/offline/credentials-rejected.ts.
 * - the user, from settings.
 *
 * Only a clear word wipes. An outage, a 500, an unknown answer: nothing happens.
 *
 * The desktop app's `WipeOfflineData` policy isn't here: its main process clears
 * every partition itself (repos/desktop, src/main/features/local-wipe.ts), with no
 * page taking part, so nothing a page runs could say it was done without doing it.
 *
 * Why a device id doesn't survive a wipe: the row keeps the history at the
 * instance, and after a sign-in this is a device starting over, which the admin
 * can wipe again. Keeping the id here would leave something of the account on a
 * device that was told to remove it. What stays until the instance has heard is
 * the row's id and secret, in lib/devices/wipe-state.ts.
 *
 * Accounts without cookies: a session cookie goes with the browser and the
 * sealed one lasts 30 days, but a check-in only needs the secret, so a device
 * still hears its wipe. One that lost its key database has nothing left to wipe
 * and can't be told. Its row keeps saying the wipe is waiting.
 */

import { clearAllCheckpoints } from '@/lib/mail-import/checkpoints';
import { sweepPrivateExports } from '@/lib/mail-export/sinks';
import { clearAllPluginStorage, clearPluginStorageForAccount } from '@/lib/plugin-sandbox/storage-scope';
import { fileStorage } from '@/lib/plugin-storage';
import { clearHandoffs } from '@/lib/launch-handoff';
import { apiFetch } from '@/lib/browser-navigation';
import { getDesktopBridge } from '@/lib/desktop/bridge';
import { IS_DESKTOP_BUILD } from '@/lib/desktop/flag';
import { isPopoutWindow } from '@/lib/popout/window-role';
import {
  checkInWithInstance,
  registerWithInstance,
  reportWipeToInstance,
} from '@/lib/devices/client';
import type { WipeReason } from '@/lib/devices/types';
import {
  addWipeNote,
  clearWipePending,
  dropRefusedLogin,
  dropWipeConfirmation,
  markWipePending,
  queueWipeConfirmation,
  readBlockedDatabases,
  readPendingWipes,
  readRefusedLogins,
  readWipeConfirmations,
  REFUSED_KEEP_MS,
  WHOLE_DEVICE,
  writeBlockedDatabases,
} from '@/lib/devices/wipe-state';
import {
  deleteDeviceRecord,
  getDeviceRecord,
  listDeviceRecords,
  putDeviceRecord,
  type DeviceRecord,
} from '@/lib/store/client/keys';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { noteCredentialsRejected, onCredentialsRejected } from './credentials-rejected';
import { confirmLoss, registerOfflineHooks, unsentCount, wipeAccount, wipeEverything } from './offline-mode';
import { clearEvicted, isEvicted, readEvicted, useOfflineStore } from './state';
import { runWipeCleaners } from './wipe-registry';

/** How long a start holds the local copy back for the instance's answer. Offline, it doesn't wait at all. */
export const BOOT_CHECK_IN_BUDGET_MS = 1_000;
/** A check-in of each device row, at most this often. */
export const CHECK_IN_EVERY_MS = 60 * 60 * 1000;
/** How often a running page looks whether something is due. */
const TICK_MS = 60 * 1000;
/** How long a wipe waits to tell the instance before it goes on: it tries again at the next contact. */
const REPORT_BUDGET_MS = 3_000;
/** How long a wipe waits for one database a running plugin frame holds open. */
const DATABASE_BUDGET_MS = 2_000;
const DATABASE_RETRIES = 5;

const WIPE_CHANNEL = 'bulwark-device-wipe';

/** The webmail's own databases. Any other on this origin was made by a privileged plugin. */
const APP_DATABASES = new Set([
  'bulwark-store',
  'bulwark-plugins',
  'bulwark-company-calendars',
  'bulwark-mail-import',
  'bulwark-offline',
]);
/** Deleted by name too, for browsers without `indexedDB.databases()`. */
const KNOWN_PLUGIN_DATABASES = ['smime-plugin-store', 'bulwark-openpgp', 'smime-capability-probe', 'openpgp-capability-probe'];

/** What every account shared and can't be told apart by account. */
const SHARED_LOCAL_KEYS = ['notification-center', 'plugin-oauth-states', 'webmail_usernames', 'global-search', 'favicon-refresh'];

const running = new Map<string, Promise<void>>();

// ---- Removing it ----

function deleteDatabase(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    const timer = setTimeout(() => resolve(false), DATABASE_BUDGET_MS);
    const finish = (done: boolean) => {
      clearTimeout(timer);
      resolve(done);
    };
    try {
      request = indexedDB.deleteDatabase(name);
    } catch {
      finish(true);
      return;
    }
    request.onsuccess = () => finish(true);
    request.onerror = () => finish(false);
  });
}

/**
 * Plugin-owned databases. S/MIME and OpenPGP keys aren't kept per account, so a
 * wipe of one account takes everyone's: keeping them would leave a wiped user's
 * private key behind. They're encrypted and come back from the user's own backup.
 */
async function deletePluginDatabases(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const names = new Set([...KNOWN_PLUGIN_DATABASES, ...Object.keys(readBlockedDatabases())]);
  try {
    for (const { name } of await indexedDB.databases()) {
      if (name && !APP_DATABASES.has(name)) names.add(name);
    }
  } catch {
    // No list in this browser: the names above.
  }
  const tries = readBlockedDatabases();
  const blocked: Record<string, number> = {};
  await Promise.all([...names].map(async (name) => {
    if (await deleteDatabase(name)) return;
    const count = (tries[name] ?? 0) + 1;
    if (count < DATABASE_RETRIES) blocked[name] = count;
  }));
  writeBlockedDatabases(blocked);
}

/**
 * What the desktop app keeps outside this page's storage: attachment copies, files
 * on the clipboard, toasts, tray and jump list. Each is feature detected, since an
 * older shell has none of them and a browser no bridge.
 */
async function clearShellFiles(): Promise<void> {
  const bridge = getDesktopBridge() as unknown as {
    os?: { clearSurfaces?: () => void };
    clipboard?: { clearFiles?: () => void | Promise<void> };
  } | null;
  bridge?.os?.clearSurfaces?.();
  await bridge?.clipboard?.clearFiles?.();
}

/** A running frame is gone at the next load. Before any plugin starts again. */
async function retryBlockedDatabases(): Promise<void> {
  if (Object.keys(readBlockedDatabases()).length > 0) await deletePluginDatabases();
}

/** The accounts' connected plugin accounts, which only sit on this device in the desktop app's own server. */
async function forgetPluginAccounts(account: string | null): Promise<void> {
  if (!IS_DESKTOP_BUILD) return;
  const accounts = useAccountStore.getState().accounts;
  const slots = (account === null ? accounts : accounts.filter((entry) => entry.id === account)).map((entry) => entry.cookieSlot ?? 0);
  await Promise.all(slots.map((slot) => apiFetch('/api/plugin-secrets?all=true', {
    method: 'DELETE',
    headers: { 'X-JMAP-Cookie-Slot': String(slot) },
    signal: AbortSignal.timeout(REPORT_BUDGET_MS),
  }).catch(() => {})));
}

async function forgetPluginSettings(): Promise<void> {
  const { usePluginStore } = await import('@/stores/plugin-store');
  usePluginStore.setState((state) => ({ plugins: state.plugins.map((plugin) => ({ ...plugin, settings: {} })) }));
}

function removeLocalKeys(keys: string[]): void {
  for (const key of keys) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* storage unavailable */
    }
  }
}

/** Everything else that's the account's or that accounts share. `account` null: all of it. */
async function scrub(account: string | null): Promise<void> {
  await runWipeCleaners(account);
  await clearShellFiles().catch(() => {});
  await deletePluginDatabases();
  await forgetPluginAccounts(account);
  await forgetPluginSettings().catch(() => {});
  if (account === null) clearAllPluginStorage();
  else clearPluginStorageForAccount(account);
  await fileStorage.clearFiles().catch(() => {});
  await clearAllCheckpoints().catch(() => {});
  await sweepPrivateExports({ force: true }).catch(() => {});
  try {
    indexedDB.deleteDatabase('bulwark-company-calendars');
  } catch {
    /* storage unavailable */
  }
  clearHandoffs();
  const { useNotificationCenterStore } = await import('@/stores/notification-center-store');
  useNotificationCenterStore.getState().clear();
  removeLocalKeys(SHARED_LOCAL_KEYS);
}

async function flushConfirmations(): Promise<void> {
  await Promise.all(readWipeConfirmations().map(async (entry) => {
    if (await reportWipeToInstance(entry, AbortSignal.timeout(REPORT_BUDGET_MS))) dropWipeConfirmation(entry.id);
  }));
}

function signalSignedOut(): void {
  // The login page would otherwise sign straight back in through a provider session.
  try {
    sessionStorage.setItem('signed_out', 'true');
  } catch {
    /* noop */
  }
}

/** One object for sending and hearing: a channel doesn't hear itself, so this window doesn't reload. */
let wipeChannel: BroadcastChannel | null = null;

function otherWindows(): BroadcastChannel | null {
  try {
    wipeChannel ??= new BroadcastChannel(WIPE_CHANNEL);
    return wipeChannel;
  } catch {
    return null;
  }
}

function tellOtherWindows(account: string | null): void {
  otherWindows()?.postMessage({ account });
}

async function signOutAccount(account: string): Promise<void> {
  const auth = useAuthStore.getState();
  signalSignedOut();
  if (auth.activeAccountId === account) await auth.logout({ endProviderSession: false });
  else auth.removeAccount(account, 'explicit');
}

/**
 * Takes one account off this device and signs it out. A refused login's sign-out
 * is the auth store's own, already on its way, and its lost mail is named as for
 * any sign-out nobody asked for. Everywhere else lost mail is a count.
 */
export function wipeAccountFromDevice(account: string, reason: WipeReason): Promise<void> {
  const under = running.get(account);
  if (under) return under;
  const work = eraseAccount(account, reason).finally(() => running.delete(account));
  running.set(account, work);
  return work;
}

async function eraseAccount(account: string, reason: WipeReason): Promise<void> {
  markWipePending(account, reason);
  const records = await listDeviceRecords().catch(() => [] as DeviceRecord[]);
  const record = records.find((entry) => entry.account === account);
  const named = reason === 'rejected';
  const unsent = named ? 0 : (await unsentCount(account).catch(() => ({ messages: 0 }))).messages;
  registerOfflineHooks();
  if (!named) confirmLoss(account);
  await wipeAccount(account).catch(() => {});
  clearEvicted(account);
  dropRefusedLogin(account);
  await scrub(account).catch(() => {});

  // The last account's wipe deletes the whole key database, with the rows of accounts that stay.
  await deleteDeviceRecord(account).catch(() => {});
  for (const other of records) {
    if (other.account !== account) await putDeviceRecord(other).catch(() => {});
  }

  if (record) queueWipeConfirmation({ id: record.id, secret: record.secret, reason, unsent });
  if (reason === 'admin') addWipeNote(unsent);
  await flushConfirmations();
  if (!named) await signOutAccount(account);
  clearWipePending(account);
  tellOtherWindows(account);
}

/** Everything on this device, for everyone. The app's device preferences stay: they hold no mail. */
export function wipeWholeDevice(reason: WipeReason): Promise<void> {
  const under = running.get(WHOLE_DEVICE);
  if (under) return under;
  const work = eraseDevice(reason).finally(() => running.delete(WHOLE_DEVICE));
  running.set(WHOLE_DEVICE, work);
  return work;
}

async function eraseDevice(reason: WipeReason): Promise<void> {
  markWipePending(WHOLE_DEVICE, reason);
  const records = await listDeviceRecords().catch(() => [] as DeviceRecord[]);
  const unsent = (await unsentCount('all').catch(() => ({ messages: 0 }))).messages;
  registerOfflineHooks();
  confirmLoss('all');
  await scrub(null).catch(() => {});
  await wipeEverything().catch(() => {});
  for (const account of Object.keys(readEvicted())) clearEvicted(account);
  for (const account of Object.keys(readRefusedLogins())) dropRefusedLogin(account);
  for (const record of records) queueWipeConfirmation({ id: record.id, secret: record.secret, reason, unsent });
  if (reason === 'admin') addWipeNote(unsent);
  await flushConfirmations();
  signalSignedOut();
  await useAuthStore.getState().logoutAll({ endProviderSession: false });
  clearWipePending(WHOLE_DEVICE);
  tellOtherWindows(null);
}

// ---- Hearing about it ----

/** Whether this device has an instance to talk to. The desktop app's own server has no admin to ask. */
function hasInstance(): boolean {
  if (IS_DESKTOP_BUILD) return false;
  return getDesktopBridge()?.mode !== 'standalone';
}

function wantsRow(account: { id: string; awaitingSignIn?: boolean; impersonated?: boolean }): boolean {
  if (account.awaitingSignIn || account.impersonated) return false;
  return getDesktopBridge()?.mode === 'instance' || useOfflineStore.getState().enabled.includes(account.id);
}

const lastCheckIn = new Map<string, number>();
const lastRegisterTry = new Map<string, number>();
/** An older instance, or a session cookie that isn't back yet: not a request a minute. */
const REGISTER_RETRY_MS = 15 * 60 * 1000;
let checkInFlight: Promise<void> | null = null;

async function checkInRecord(record: DeviceRecord, now: number): Promise<void> {
  lastCheckIn.set(record.account, now);
  const answer = await checkInWithInstance(record, AbortSignal.timeout(REPORT_BUDGET_MS * 3));
  if (answer === 'wipe') {
    await wipeAccountFromDevice(record.account, 'admin');
    return;
  }
  if (answer === 'forgotten') {
    await deleteDeviceRecord(record.account).catch(() => {});
    return;
  }
  // Signed out here with nothing kept: the row has nothing left to look after.
  if (answer === 'clear') {
    const known = useAccountStore.getState().accounts.some((entry) => entry.id === record.account);
    if (!known && !useOfflineStore.getState().enabled.includes(record.account)) await deleteDeviceRecord(record.account).catch(() => {});
  }
}

async function registerAccount(accountId: string, slot: number): Promise<void> {
  const register = async () => {
    // Another window may have got here while this one waited.
    if (await getDeviceRecord(accountId)) return;
    const row = await registerWithInstance(slot, AbortSignal.timeout(REPORT_BUDGET_MS * 3));
    if (row) await putDeviceRecord({ account: accountId, id: row.id, secret: row.secret, createdAt: Date.now() });
  };
  if (typeof navigator !== 'undefined' && navigator.locks) await navigator.locks.request('bulwark-device-register', register);
  else await register();
}

/** Each row that's due, and a row for each account that needs one. `force`: every row, now. One at a time. */
export function checkInDue(force = false, now = Date.now()): Promise<void> {
  if (checkInFlight) return checkInFlight;
  checkInFlight = runCheckIns(force, now).finally(() => { checkInFlight = null; });
  return checkInFlight;
}

async function runCheckIns(force: boolean, now: number): Promise<void> {
  if (!hasInstance()) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  void flushConfirmations();
  const accounts = useAccountStore.getState().accounts;
  const wanted = accounts.filter(wantsRow);
  // No account with a reason and no database to look in: don't make one by looking.
  const records = await listDeviceRecords(wanted.length === 0).catch(() => [] as DeviceRecord[]);
  await Promise.all([
    ...records
      .filter((record) => force || now - (lastCheckIn.get(record.account) ?? 0) >= CHECK_IN_EVERY_MS)
      .map((record) => checkInRecord(record, now)),
    ...wanted
      .filter((account) => !records.some((record) => record.account === account.id))
      .filter((account) => force || now - (lastRegisterTry.get(account.id) ?? 0) >= REGISTER_RETRY_MS)
      .map((account) => {
        lastRegisterTry.set(account.id, now);
        return registerAccount(account.id, account.cookieSlot ?? 0).catch(() => {});
      }),
  ]);
}

/** A wipe cut short by a crash or a closed window: finished before anything else. No network. */
export async function finishInterruptedWipes(): Promise<void> {
  const pending = readPendingWipes();
  for (const [account, reason] of Object.entries(pending)) {
    if (account === WHOLE_DEVICE) await wipeWholeDevice(reason);
    else await wipeAccountFromDevice(account, reason);
  }
  await retryBlockedDatabases();
}

/** Refused passwords whose day has passed, with no sign-in since. */
export async function sweepRefusedLogins(now = Date.now()): Promise<void> {
  for (const [account, at] of Object.entries(readRefusedLogins())) {
    // Signed in again: the wait is over and nothing goes.
    if (!isEvicted(account)) {
      dropRefusedLogin(account);
      continue;
    }
    if (now - at < REFUSED_KEEP_MS) continue;
    dropRefusedLogin(account);
    noteCredentialsRejected(account);
    await running.get(account);
  }
}

let registered = false;

/** The hooks every wipe needs, once per page. */
export function registerDeviceWipe(): void {
  if (registered) return;
  registered = true;
  onCredentialsRejected((account) => {
    void wipeAccountFromDevice(account, 'rejected');
  });
}

/**
 * What a start waits for, before any local data is shown: a wipe that was cut
 * short, without limit, and the instance's answer, up to the budget. An answer
 * that comes later still wipes, from wherever the page has got to.
 */
export async function runDeviceGate(): Promise<void> {
  registerDeviceWipe();
  await finishInterruptedWipes();
  await sweepRefusedLogins();
  const checks = checkInDue(true);
  await Promise.race([
    checks.catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, BOOT_CHECK_IN_BUDGET_MS)),
  ]);
}

function listenToOtherWindows(): () => void {
  const channel = otherWindows();
  if (!channel) return () => {};
  channel.onmessage = (event: MessageEvent<{ account: string | null }>) => {
    const { account } = event.data ?? {};
    // Its mail is in this window's memory. Another account's unsaved text isn't touched.
    if (account === null || account === useAuthStore.getState().activeAccountId) window.location.reload();
  };
  return () => { channel.onmessage = null; };
}

/** For the host component: all of it, for as long as the page runs. */
export function startDeviceWipe(): () => void {
  registerDeviceWipe();
  if (isPopoutWindow()) return listenToOtherWindows();
  const stopOthers = listenToOtherWindows();
  void (async () => {
    await finishInterruptedWipes();
    await sweepRefusedLogins();
    await checkInDue();
  })().catch(() => {});
  const tick = setInterval(() => {
    void checkInDue().catch(() => {});
    void sweepRefusedLogins().catch(() => {});
  }, TICK_MS);
  const onOnline = () => { void checkInDue(true).catch(() => {}); };
  window.addEventListener('online', onOnline);
  const stopEnabled = useOfflineStore.subscribe((state, prev) => {
    if (state.enabled === prev.enabled) return;
    for (const account of state.enabled) lastRegisterTry.delete(account);
    void checkInDue().catch(() => {});
  });
  return () => {
    stopOthers();
    stopEnabled();
    clearInterval(tick);
    window.removeEventListener('online', onOnline);
  };
}
