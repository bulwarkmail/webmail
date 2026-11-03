/**
 * Everything that takes an account's data off this device, and how a device
 * hears that it should:
 *
 * - the instance's registry (lib/devices): a wipe an admin asked for, heard at
 *   check-in. At a start the check-in runs before the local copy is shown.
 * - the user, from settings.
 * - the organisation, when it asks for deletion at once after a refused login
 *   (`organisation.devices.wipeOnRefusedLogin`).
 *
 * A refused login on its own deletes nothing. The account signs out and its data
 * hides until someone signs in with the new password, or for 30 days
 * (EVICTED_KEEP_MS). What this file keeps for it is a number, for the sign-in page.
 * The usual cause is a password changed on another device, and deleting there
 * would lose unsent mail for very little protection against a thief. A deletion
 * the organisation asked for takes the account's own data and nothing shared.
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
 *
 * Wipes run one at a time across every window of this browser, under a Web Lock:
 * the last account's wipe deletes the key database with every row in it, so a
 * second wipe going on at that moment would put back a row just removed.
 */

import { clearAllCheckpoints } from '@/lib/mail-import/checkpoints';
import { sweepPrivateExports } from '@/lib/mail-export/sinks';
import { clearAllPluginStorage, clearPluginStorageForAccount } from '@/lib/plugin-sandbox/storage-scope';
import { fileStorage } from '@/lib/plugin-storage';
import { clearHandoffs } from '@/lib/launch-handoff';
import { apiFetch } from '@/lib/browser-navigation';
import { SW_SCOPE } from '@/lib/app-update';
import { devicesForAccount, devicesForNoOne } from '@/lib/device-policy';
import { getDesktopBridge } from '@/lib/desktop/bridge';
import { IS_DESKTOP_BUILD } from '@/lib/desktop/flag';
import { clearRescuedDrafts } from '@/lib/popout/rescued-drafts';
import { isPopoutWindow } from '@/lib/popout/window-role';
import { PUSH_STATE_CACHE } from '@/lib/push-preferences';
import { ACCOUNT_STORAGE_KEYS, onBeforeSignOut } from '@/lib/sign-out-cleanup';
import {
  checkInWithInstance,
  registerWithInstance,
  reportWipeToInstance,
  type RegisteredRow,
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
  setRefusedCount,
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
import { onAccountRemoved, useAccountStore, type AccountEntry } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';
import { onCredentialsRejected } from './credentials-rejected';
import { forgetEvictedSecrets } from './evicted-secrets';
import { confirmLoss, registerOfflineHooks, unsentForWipe, wipeAccount, wipeEverything } from './offline-mode';
import { clearEvicted, forgetMailSnapshot, isEvicted, readEvicted, serverKey, useOfflineStore } from './state';
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

const WIPE_CHANNEL = 'bulwark-device-wipe';
const WIPE_LOCK = 'bulwark-device-wipe';

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

/**
 * What every account shared and can't be told apart by account, on top of what a
 * full sign-out removes. `template-storage` is here though a sign-out keeps it:
 * with settings sync off it's the user's own work and only here, which is why a
 * sign-out leaves it, but a template can hold anything, and a device told to remove
 * everything keeps no text. The question before a wipe from settings names it.
 */
const SHARED_LOCAL_KEYS = [
  ...ACCOUNT_STORAGE_KEYS,
  'notification-center',
  'plugin-oauth-states',
  'webmail_usernames',
  'global-search',
  'favicon-refresh',
  'template-storage',
];
/** The WebDAV area's favourites, recent files and last folder. */
const SHARED_LOCAL_PREFIXES = ['webdav-'];

const running = new Map<string, Promise<void>>();

let lockQueue: Promise<unknown> = Promise.resolve();

/** One wipe at a time. Without Web Locks: at least in this window. */
function underWipeLock(work: () => Promise<void>): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request(WIPE_LOCK, work);
  const turn = lockQueue.then(work, work);
  lockQueue = turn.catch(() => {});
  return turn;
}

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
 * One a running frame holds open stays on the list, and the wipe isn't reported
 * as done until it's gone.
 */
async function deletePluginDatabases(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const tries = readBlockedDatabases();
  const names = new Set([...KNOWN_PLUGIN_DATABASES, ...Object.keys(tries)]);
  try {
    for (const { name } of await indexedDB.databases()) {
      if (name && !APP_DATABASES.has(name)) names.add(name);
    }
  } catch {
    // No list in this browser: the names above.
  }
  const blocked: Record<string, number> = {};
  await Promise.all([...names].map(async (name) => {
    if (!(await deleteDatabase(name))) blocked[name] = (tries[name] ?? 0) + 1;
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
  // An account dropped earlier has no cookie left to ask with.
  await forgetEvictedSecrets(account);
}

async function forgetPluginSettings(): Promise<void> {
  const { usePluginStore } = await import('@/stores/plugin-store');
  usePluginStore.setState((state) => ({ plugins: state.plugins.map((plugin) => ({ ...plugin, settings: {} })) }));
}

function removeLocalKeys(keys: string[], prefixes: string[]): void {
  try {
    const doomed = [...keys];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key && prefixes.some((prefix) => key.startsWith(prefix))) doomed.push(key);
    }
    for (const key of doomed) localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

async function pushRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration(SW_SCOPE).catch(() => null)) ?? null;
}

/** A sender and a subject can sit on screen long after the mail is gone. */
async function closeShownNotifications(): Promise<void> {
  const registration = await pushRegistration();
  for (const notification of await registration?.getNotifications?.() ?? []) notification.close();
}

/** The subscription is the browser's, shared by every account on this origin. */
async function endWebPushIfNobodyLeft(): Promise<void> {
  if (useAccountStore.getState().accounts.length > 0) return;
  const registration = await pushRegistration();
  const subscription = await registration?.pushManager?.getSubscription();
  await subscription?.unsubscribe();
}

/** What's the account's own: a deletion after a refused login goes no further than this. */
async function scrubAccount(account: string): Promise<void> {
  await runWipeCleaners(account);
  await forgetPluginAccounts(account).catch(() => {});
  clearPluginStorageForAccount(account);
  forgetMailSnapshot(account);
}

/** Everything accounts share, or that can't be told apart by account. */
async function scrubShared(): Promise<void> {
  await clearShellFiles().catch(() => {});
  await deletePluginDatabases();
  await forgetPluginSettings().catch(() => {});
  await fileStorage.clearFiles().catch(() => {});
  await clearAllCheckpoints().catch(() => {});
  await sweepPrivateExports({ force: true }).catch(() => {});
  try {
    indexedDB.deleteDatabase('bulwark-company-calendars');
  } catch {
    /* storage unavailable */
  }
  clearHandoffs();
  clearRescuedDrafts();
  const { useNotificationCenterStore } = await import('@/stores/notification-center-store');
  useNotificationCenterStore.getState().clear();
  await closeShownNotifications().catch(() => {});
  if (typeof caches !== 'undefined') await caches.delete(PUSH_STATE_CACHE).catch(() => {});
  removeLocalKeys(SHARED_LOCAL_KEYS, SHARED_LOCAL_PREFIXES);
}

/**
 * Sends what's ready to go. A wipe's confirmation is queued before anything is
 * deleted, so that a crash can't lose it, and isn't sent until the deletion is
 * done: `finished` is the wipe that just got there. What's still pending, or a
 * plugin database that's still there, isn't a wipe that can be reported.
 */
async function flushConfirmations(finished?: string): Promise<void> {
  const pending = readPendingWipes();
  const blocked = Object.keys(readBlockedDatabases()).length > 0;
  const deviceOpen = WHOLE_DEVICE in pending && finished !== WHOLE_DEVICE;
  const ready = readWipeConfirmations().filter((entry) => {
    if (entry.drop) return true;
    if (deviceOpen || (blocked && entry.reason !== 'rejected')) return false;
    return !entry.account || !(entry.account in pending) || entry.account === finished;
  });
  await Promise.all(ready.map(async (entry) => {
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

type WipePhase = 'start' | 'end';

function tellOtherWindows(account: string | null, phase: WipePhase): void {
  otherWindows()?.postMessage({ account, phase });
}

async function signOutAccount(account: string): Promise<void> {
  const auth = useAuthStore.getState();
  signalSignedOut();
  if (auth.activeAccountId === account) await auth.logout({ endProviderSession: false });
  else auth.removeAccount(account, 'explicit');
}

/** The key database goes with the last account's store, and the other accounts' rows with it. */
async function putRowsBack(rows: DeviceRecord[], wiped: string): Promise<void> {
  const still = await listDeviceRecords().catch(() => [] as DeviceRecord[]);
  for (const row of rows) {
    if (row.account !== wiped && !still.some((entry) => entry.account === row.account)) await putDeviceRecord(row).catch(() => {});
  }
}

export interface WipeAccountOptions {
  /** Heard for this row: another window that got there first has removed it, and there's nothing to do. */
  ifRow?: string;
}

/**
 * Takes one account off this device. A refused login's sign-out is the auth
 * store's own, and what it deletes is only the account's: no shared key database,
 * no plugin settings, and with nothing kept here nothing of offline mode either.
 */
export function wipeAccountFromDevice(account: string, reason: WipeReason, options: WipeAccountOptions = {}): Promise<void> {
  const under = running.get(account);
  if (under) return under;
  // Now, not when the lock comes: a window closed while it waits still finishes this.
  markWipePending(account, reason);
  const work = underWipeLock(() => eraseAccount(account, reason, options)).finally(() => running.delete(account));
  running.set(account, work);
  return work;
}

async function eraseAccount(account: string, reason: WipeReason, options: WipeAccountOptions): Promise<void> {
  // Another window finished it while this one waited for the lock.
  if (!(account in readPendingWipes())) return;
  const records = await listDeviceRecords().catch(() => [] as DeviceRecord[]);
  const record = records.find((entry) => entry.account === account);
  if (options.ifRow && record?.id !== options.ifRow) {
    clearWipePending(account);
    return;
  }
  tellOtherWindows(account, 'start');
  registerOfflineHooks();

  const ownOnly = reason === 'rejected';
  const unsent = await unsentForWipe(account);
  if (record && !readWipeConfirmations().some((entry) => entry.id === record.id)) {
    queueWipeConfirmation({ account, id: record.id, secret: record.secret, reason, unsent });
    if (reason === 'admin') addWipeNote(unsent);
  }

  const shown = useOfflineStore.getState();
  const keepsMail = shown.enabled.includes(account) || shown.outbox.some((row) => row.account === account) || shown.localDrafts.some((row) => row.account === account);
  if (!ownOnly) confirmLoss(account);
  let deleted = true;
  if (!ownOnly || keepsMail) {
    // Tried again at the next start: the row keeps waiting until then.
    await wipeAccount(account).catch(() => { deleted = false; });
  }
  clearEvicted(account);
  dropRefusedLogin(account);
  await scrubAccount(account).catch(() => {});
  if (!ownOnly) await scrubShared().catch(() => {});

  await deleteDeviceRecord(account).catch(() => {});
  await putRowsBack(records, account);

  await flushConfirmations(deleted ? account : undefined);
  if (!ownOnly) {
    await signOutAccount(account);
    await endWebPushIfNobodyLeft().catch(() => {});
  }
  if (deleted) clearWipePending(account);
  tellOtherWindows(account, 'end');
}

/** Everything on this device, for everyone. The app's device preferences stay: they hold no mail. */
export function wipeWholeDevice(reason: WipeReason): Promise<void> {
  const under = running.get(WHOLE_DEVICE);
  if (under) return under;
  markWipePending(WHOLE_DEVICE, reason);
  const work = underWipeLock(() => eraseDevice(reason)).finally(() => running.delete(WHOLE_DEVICE));
  running.set(WHOLE_DEVICE, work);
  return work;
}

async function eraseDevice(reason: WipeReason): Promise<void> {
  if (!(WHOLE_DEVICE in readPendingWipes())) return;
  tellOtherWindows(null, 'start');
  registerOfflineHooks();
  const records = await listDeviceRecords().catch(() => [] as DeviceRecord[]);
  const accounts = [...new Set([...useOfflineStore.getState().enabled, ...records.map((record) => record.account)])];
  const counts = new Map(await Promise.all(accounts.map(async (account) => [account, await unsentForWipe(account)] as const)));
  const queued = readWipeConfirmations();
  for (const record of records) {
    if (queued.some((entry) => entry.id === record.id)) continue;
    queueWipeConfirmation({ account: record.account, id: record.id, secret: record.secret, reason, unsent: counts.get(record.account) ?? 0 });
  }
  if (reason === 'admin') {
    const each = [...counts.values()];
    addWipeNote(each.includes(null) ? null : (each as number[]).reduce((sum, count) => sum + count, 0));
  }

  confirmLoss('all');
  await runWipeCleaners(null);
  await forgetPluginAccounts(null).catch(() => {});
  clearAllPluginStorage();
  await scrubShared().catch(() => {});
  let deleted = true;
  await wipeEverything().catch(() => { deleted = false; });
  for (const account of Object.keys(readEvicted())) clearEvicted(account);
  for (const account of Object.keys(readRefusedLogins())) dropRefusedLogin(account);
  await flushConfirmations(deleted ? WHOLE_DEVICE : undefined);
  signalSignedOut();
  await useAuthStore.getState().logoutAll({ endProviderSession: false });
  await endWebPushIfNobodyLeft().catch(() => {});
  if (deleted) clearWipePending(WHOLE_DEVICE);
  tellOtherWindows(null, 'end');
}

// ---- A sign-out: the row has nothing left to look after ----

function queueDrop(row: Pick<DeviceRecord, 'id' | 'secret'>): void {
  queueWipeConfirmation({ id: row.id, secret: row.secret, reason: 'user', unsent: 0, drop: true });
}

async function dropRows(scope: string): Promise<void> {
  const records = await listDeviceRecords().catch(() => [] as DeviceRecord[]);
  const rows = scope === 'all' ? records : records.filter((record) => record.account === scope);
  if (rows.length === 0) return;
  for (const row of rows) {
    queueDrop(row);
    await deleteDeviceRecord(row.account).catch(() => {});
  }
  await flushConfirmations();
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
    await wipeAccountFromDevice(record.account, 'admin', { ifRow: record.id });
    return;
  }
  // The row is gone, or wiped already: what it was for is over. The account stays, and gets a new one.
  if (answer === 'forgotten' || answer === 'wiped') {
    await deleteDeviceRecord(record.account).catch(() => {});
    lastRegisterTry.delete(record.account);
    return;
  }
  // Signed out here with nothing kept: the row has nothing left to look after.
  if (answer === 'clear') {
    const known = useAccountStore.getState().accounts.some((entry) => entry.id === record.account);
    if (!known && !useOfflineStore.getState().enabled.includes(record.account)) await dropRows(record.account);
  }
}

/**
 * The cookie slot decides whose row the instance makes. A slot that has moved on
 * to another account since would leave this account's mail on someone else's row,
 * where a wipe of this account never finds it. A bare name is the same person as a
 * whole address: a token sign-in can claim either.
 */
function ownsRow(row: RegisteredRow, account: AccountEntry): boolean {
  if (serverKey(row.server) !== serverKey(account.serverUrl)) return false;
  const user = row.user.toLowerCase();
  return [account.username, account.email].some((candidate) => {
    const name = candidate?.toLowerCase();
    if (!name) return false;
    if (name === user) return true;
    return (!name.includes('@') || !user.includes('@')) && name.split('@')[0] === user.split('@')[0];
  });
}

async function registerAccount(account: AccountEntry): Promise<void> {
  const register = async () => {
    // Another window may have got here while this one waited.
    if (await getDeviceRecord(account.id)) return;
    const row = await registerWithInstance(account.cookieSlot ?? 0, AbortSignal.timeout(REPORT_BUDGET_MS * 3));
    if (!row) return;
    if (ownsRow(row, account) && useAccountStore.getState().getAccountById(account.id)) {
      await putDeviceRecord({ account: account.id, id: row.id, secret: row.secret, createdAt: Date.now() });
      return;
    }
    queueDrop(row);
    await flushConfirmations();
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
        return registerAccount(account).catch(() => {});
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

// ---- A refused login ----

function policyKnown(): boolean {
  const { loaded, partial } = usePolicyStore.getState();
  return loaded && !partial;
}

/** A number, for the sign-in page. Unknown stays unknown, and is asked again at the next look. */
async function countRefused(account: string): Promise<void> {
  if (!(account in readRefusedLogins())) return;
  registerOfflineHooks();
  setRefusedCount(account, await unsentForWipe(account));
}

/**
 * The login was refused, and the auth store is signing it out and hiding the data.
 * It goes now only if the organisation asked for that, and only for a refusal that
 * is one for certain: a single bad answer at a start can be a server in trouble.
 */
async function heardRefusal(account: string, certain: boolean): Promise<void> {
  if (certain && policyKnown() && devicesForAccount(account).wipeOnRefusedLogin) {
    await wipeAccountFromDevice(account, 'rejected');
    return;
  }
  await countRefused(account);
}

/** What the sign-in page reads: signed in again, the wait is over. A count that couldn't be had, and a policy that's new. */
export async function sweepRefusedLogins(): Promise<void> {
  for (const [account, wait] of Object.entries(readRefusedLogins())) {
    if (!isEvicted(account)) {
      dropRefusedLogin(account);
      continue;
    }
    // Nobody's signed in to it, so no groups to go by: what applies to everyone reaches it.
    if (wait.certain && policyKnown() && devicesForNoOne().wipeOnRefusedLogin) {
      await wipeAccountFromDevice(account, 'rejected');
      continue;
    }
    if (wait.unsent === null) await countRefused(account);
  }
}

let registered = false;

/** The hooks every wipe needs, once per page. */
export function registerDeviceWipe(): void {
  if (registered) return;
  registered = true;
  onCredentialsRejected((account, certain) => {
    void heardRefusal(account, certain);
  });
  onBeforeSignOut(async (accountId, { keepLocalStore }) => {
    if (!keepLocalStore) await dropRows(accountId);
  });
  onAccountRemoved((accountId, reason) => {
    if (reason === 'explicit') void dropRows(accountId);
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

/**
 * Another window is wiping. An account this one isn't showing leaves its lists at
 * once and in place, or the next write of the account registry here brings it back.
 * One it's showing: its mail is in this window's memory, so it reloads once the wipe
 * is done. Another account's unsaved text isn't touched.
 */
function heardFromOtherWindow(account: string | null, phase: WipePhase): void {
  const auth = useAuthStore.getState();
  if (account === null || account === auth.activeAccountId) {
    if (phase === 'end') window.location.reload();
    return;
  }
  if (useAccountStore.getState().getAccountById(account)) auth.removeAccount(account, 'wiped');
  const { enabled } = useOfflineStore.getState();
  if (enabled.includes(account)) useOfflineStore.setState({ enabled: enabled.filter((id) => id !== account) });
}

function listenToOtherWindows(): () => void {
  const channel = otherWindows();
  if (!channel) return () => {};
  channel.onmessage = (event: MessageEvent<{ account: string | null; phase?: WipePhase }>) => {
    if (event.data?.account === undefined) return;
    heardFromOtherWindow(event.data.account, event.data.phase ?? 'end');
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
  const stopPolicy = usePolicyStore.subscribe((state, prev) => {
    if (state.rawPolicy !== prev.rawPolicy || state.partial !== prev.partial) void sweepRefusedLogins().catch(() => {});
  });
  return () => {
    stopOthers();
    stopEnabled();
    stopPolicy();
    clearInterval(tick);
    window.removeEventListener('online', onOnline);
  };
}
