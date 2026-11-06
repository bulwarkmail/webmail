/**
 * Files on this computer in the page: starts the engine in the desktop app's main window, for
 * the signed-in accounts, publishes what it does to stores/files-sync-store.ts and registers the
 * controller the settings page and the Files screen use. The React side
 * (components/providers/files-sync-host.tsx) feeds it the accounts, push and the policies.
 *
 * Each account reaches Files through the app's own JMAP session: the session resource and
 * Authorization header the app's client holds, read when a request goes and renewed through
 * it (as offline mode does). Nothing here writes a token or a password anywhere.
 *
 * What happens to an account's roots when it leaves (FILES-SYNC-BRIEF.md, pass-3 files-p3-3):
 * - a sign-out the user chose: what waits is uploaded first (the sign-out gate asks), then the
 *   drive goes (`signed-out` keeps the wish and the pins; main copies anything still not
 *   uploaded to Documents), and the folders stop syncing until the next sign-in;
 * - a sign-out nobody chose (the session ran out, the login was refused): the drive is only
 *   disconnected (`suspended`), its folder, edits and pins stay, and the next sign-in goes on;
 * - a wipe (lib/offline/wipe-registry.ts): the drive goes with everything in it, unuploaded
 *   edits too, and the folders are forgotten; their files stay, they were the user's.
 *
 * It also keeps each account's storage (Quota/get, at the start, after FileNode changes at most
 * once a minute, and every five minutes) for the settings page, the Files screen and Explorer,
 * and tells main what Explorer should show for each drive (drive-status.ts).
 */

import type { DesktopOsNotification, FilesControls, FilesDriveState, FilesDriveStatus, FilesRescued, FilesResult, FilesRoot } from '@/lib/desktop/types';
import { debug } from '@/lib/debug';
import type { StorageQuota } from '@/lib/quota';
import { FetchTransport, type StoreSession } from '@/lib/store/engine/transport';
import type { ActivityStore } from './activity-store';
import { driveStatusFor, filesQuotaOf, type DriveStatusText } from './drive-status';
import { FilesSyncEngine, type EngineTiming } from './engine';
import { requestFlush } from './flush-requests';
import type { FilesSyncErrorName } from './errors';
import { namingFor } from './names';
import { FilesRemote } from './remote';
import { FILES_NOTIFY_ACTIONS, type FilesNotificationContext, type FilesNotifyText } from './notify';
import type { FilesQuota, FilesSyncActivity, FilesSyncController, FilesSyncSnapshot } from './types';

/** What the host needs of the app's JMAP client. */
export interface SessionClient {
  getSessionSnapshot(): unknown;
  getAuthHeader(): string;
  isOfflineOnly?(): boolean;
  requestNetworkOnly?(calls: [string, Record<string, unknown>, string][]): Promise<unknown>;
}

export interface HostAccount {
  id: string;
  /** Shown with the drive when there are several accounts. */
  label: string;
  client: SessionClient;
}

export interface HostDeps {
  controls: FilesControls;
  platform: string;
  publish: (patch: Partial<FilesSyncSnapshot>) => void;
  setController: (controller: FilesSyncController | null) => void;
  /** `FilesFolderSyncEnabled` is off. */
  folderSyncForcedOff: () => boolean;
  /** The organisation said no to downloads for this account. */
  downloadsForbidden: (account: string) => boolean;
  /** Tests give their own. */
  remoteFor?: (account: HostAccount) => FilesRemote | null;
  timing?: Partial<EngineTiming>;
  readUrl?: (url: string) => Promise<Uint8Array>;
  /** The words for Explorer's status, in the page's language. Null: none sent. */
  driveStatusText?: () => DriveStatusText | null;
  /** Shows an OS notification; main shows none while the main window has the focus. */
  notify?: (notification: DesktopOsNotification) => void;
  notifyText?: () => FilesNotifyText | null;
  /** Where Recent activity is kept across restarts. None: it isn't. */
  activityStore?: ActivityStore;
  quotaTiming?: Partial<QuotaTiming>;
  now?: () => number;
}

export interface QuotaTiming {
  /** After FileNode changes, at most this often. */
  minGapMs: number;
  /** And this often anyway. */
  everyMs: number;
  /** Explorer hears of a change at most this often per drive. */
  statusGapMs: number;
}

const QUOTA_TIMING: QuotaTiming = { minGapMs: 60_000, everyMs: 5 * 60_000, statusGapMs: 1_000 };
/** The policy is turning the drive off: this long for what waits to go up. Main waits a little longer. */
const POLICY_FLUSH_MS = 100_000;

interface QuotaState {
  /** undefined: not asked yet; null: the server sets no limit. */
  server: StorageQuota | null | undefined;
  /** What the files take, when the server sets no limit. */
  filesBytes: number | null;
  lastAt: number;
  running: boolean;
  again: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const DEVICE: Record<string, string> = { win32: 'Windows', darwin: 'Mac', linux: 'Linux' };

/**
 * The app's client as a transport: its session and header, read each time, renewed through it.
 * Null for a client with no JMAP session behind it (the demo's) and a server without Files.
 */
export function remoteForClient(client: SessionClient): FilesRemote | null {
  if (typeof client.getSessionSnapshot !== 'function' || typeof client.getAuthHeader !== 'function') return null;
  if (client.isOfflineOnly?.()) return null;
  const session = client.getSessionSnapshot() as StoreSession | undefined;
  if (!session?.apiUrl || !session.uploadUrl || !session.downloadUrl) return null;
  const transport = new FetchTransport({
    session: () => (client.getSessionSnapshot() as StoreSession | undefined) ?? session,
    auth: () => client.getAuthHeader() || null,
    refreshAuth: async () => {
      // Through the client: a 401 there runs its own renewal or re-login.
      await client.requestNetworkOnly?.([['Core/echo', {}, '0']]).catch(() => null);
      return client.getAuthHeader() || null;
    },
  });
  const remote = new FilesRemote(transport, () => (client.getSessionSnapshot() as StoreSession | undefined) ?? session);
  return remote.supported() ? remote : null;
}

const fail = <T>(error: Exclude<FilesResult<T>, { ok: true }>['error']): FilesResult<T> => ({ ok: false, error });

export class FilesSyncHost {
  readonly engine: FilesSyncEngine;
  private readonly accounts = new Map<string, HostAccount>();
  private current: string | null = null;
  private drive: FilesDriveState | null = null;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly unsubscribe: (() => void)[] = [];
  /** Accounts the drive was turned on for at this sign-in already. */
  private readonly driveStarted = new Set<string>();
  private stopped = false;
  private readonly remotes = new Map<string, FilesRemote>();
  private readonly quotas = new Map<string, QuotaState>();
  private quotaTimer: ReturnType<typeof setInterval> | null = null;
  private readonly quotaTiming: QuotaTiming;
  private readonly now: () => number;
  /** What main last heard for Explorer, per account, and when. */
  private readonly sentStatus = new Map<string, { json: string; at: number }>();
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  /** Turning the drive off copied files that weren't uploaded: the settings page says where. */
  private rescued: FilesRescued | null = null;
  /** Accounts whose kept activity was read back this run. */
  private readonly activityRestored = new Set<string>();
  /** What was last written per account, to write only when it changed. */
  private readonly activitySaved = new Map<string, string>();

  constructor(private readonly deps: HostDeps) {
    this.quotaTiming = { ...QUOTA_TIMING, ...deps.quotaTiming };
    this.now = deps.now ?? Date.now;
    this.engine = new FilesSyncEngine({
      controls: deps.controls,
      naming: namingFor(deps.platform),
      device: DEVICE[deps.platform] ?? 'this computer',
      readUrl: deps.readUrl,
      timing: deps.timing,
      blocked: (root) => this.blocked(root),
      downloadsAllowed: (account) => !deps.downloadsForbidden(account),
      onUpdate: () => this.schedulePublish(),
      onActivity: (entry) => this.announce(entry),
    });
  }

  get controls(): FilesControls {
    return this.deps.controls;
  }

  start(): void {
    this.engine.start();
    const drive = this.deps.controls.drive;
    if (drive) {
      void drive.state().then((state) => {
        this.drive = state;
        this.schedulePublish();
        this.startDrives();
      }).catch(() => {});
      this.unsubscribe.push(drive.onStateChange((state) => {
        this.drive = state;
        // A drive turned on again starts with nothing in Explorer: say it again.
        this.sentStatus.clear();
        this.schedulePublish();
        this.driveStateChanged(state);
        void this.engine.refreshRoots();
      }));
      if (drive.onFlush) this.unsubscribe.push(drive.onFlush((request) => void this.flushForPolicy(request.requestId, request.accounts)));
    }
    this.deps.setController(this.controller());
    this.quotaTimer = setInterval(() => {
      for (const account of this.remotes.keys()) this.refreshQuota(account, true);
    }, this.quotaTiming.everyMs);
    (this.quotaTimer as { unref?: () => void }).unref?.();
    this.publishNow();
  }

  stop(): void {
    this.stopped = true;
    for (const stop of this.unsubscribe.splice(0)) stop();
    if (this.publishTimer) clearTimeout(this.publishTimer);
    if (this.quotaTimer) clearInterval(this.quotaTimer);
    if (this.statusTimer) clearTimeout(this.statusTimer);
    for (const state of this.quotas.values()) if (state.timer) clearTimeout(state.timer);
    this.quotas.clear();
    this.engine.stop();
    this.deps.setController(null);
  }

  private blocked(root: FilesRoot): FilesSyncErrorName | null {
    if (root.kind === 'folder' && this.deps.folderSyncForcedOff()) return 'policy';
    if (this.deps.downloadsForbidden(root.account)) return 'policy';
    return null;
  }

  // ─── Accounts ───────────────────────────────────────────────

  /** The signed-in accounts with a connected client, and the one on screen. */
  setAccounts(accounts: HostAccount[], current: string | null): void {
    if (this.stopped) return;
    this.current = current;
    const now = new Map(accounts.map((account) => [account.id, account]));
    for (const id of [...this.accounts.keys()]) {
      if (now.has(id)) continue;
      // Not connected now (signed out goes through signedOut): its roots wait.
      this.accounts.delete(id);
      this.forgetQuota(id);
      this.engine.dropAccount(id);
    }
    for (const account of accounts) {
      if (!this.activityRestored.has(account.id)) {
        this.activityRestored.add(account.id);
        const kept = this.deps.activityStore?.load(account.id) ?? [];
        if (kept.length > 0) this.engine.restoreActivity(account.id, kept);
        this.activitySaved.set(account.id, signatureOf(this.engine.activityOf(account.id)));
      }
      const known = this.accounts.get(account.id);
      if (known && known.client === account.client) continue;
      let remote: FilesRemote | null;
      try {
        remote = (this.deps.remoteFor ?? ((entry: HostAccount) => remoteForClient(entry.client)))(account);
      } catch (error) {
        // One client that can't say what its session is doesn't stop the others.
        debug.error('[files-sync] no Files for this account:', error);
        remote = null;
      }
      if (!remote) continue;
      this.accounts.set(account.id, account);
      this.remotes.set(account.id, remote);
      this.engine.setAccount(account.id, remote);
      this.refreshQuota(account.id, true);
    }
    this.startDrives();
    void this.engine.refreshRoots();
    this.schedulePublish();
  }

  /** The organisation's word on the drive changed: one it turned off comes back by itself once it's allowed (files-p3-19). */
  private driveStateChanged(state: FilesDriveState): void {
    if (state.forcedOff) this.driveStarted.clear();
    this.startDrives();
  }

  /** A sign-in brings back the drive of an account that had it, without a click. */
  private startDrives(): void {
    const drive = this.deps.controls.drive;
    const state = this.drive;
    if (!drive || !state || !state.supported || state.forcedOff) return;
    for (const account of this.accounts.values()) {
      if (!state.wanted.includes(account.id) || this.driveStarted.has(account.id)) continue;
      this.driveStarted.add(account.id);
      void drive.enable(account.id, account.label).then((result) => {
        if (!result.ok) this.driveStarted.delete(account.id);
        void this.engine.refreshRoots();
      }, () => this.driveStarted.delete(account.id));
    }
  }

  /** A push for this account said FileNode changed. */
  remoteChanged(account: string): void {
    this.engine.remoteChanged(account);
    this.refreshQuota(account, false);
  }

  // ─── Storage ────────────────────────────────────────────────

  /**
   * Quota/get for an account. `now`: at once (a new account, the five-minute round); else at
   * most once per minGapMs, the last ask in a burst of changes going at the end of the gap.
   */
  private refreshQuota(account: string, now: boolean): void {
    if (this.stopped || !this.remotes.has(account)) return;
    let state = this.quotas.get(account);
    if (!state) {
      state = { server: undefined, filesBytes: null, lastAt: -Infinity, running: false, again: false, timer: null };
      this.quotas.set(account, state);
    }
    if (state.running) {
      state.again = true;
      return;
    }
    const wait = now ? 0 : state.lastAt + this.quotaTiming.minGapMs - this.now();
    if (wait > 0) {
      if (!state.timer) {
        state.timer = setTimeout(() => {
          state.timer = null;
          this.refreshQuota(account, true);
        }, wait);
      }
      return;
    }
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    void this.askQuota(account, state);
  }

  private async askQuota(account: string, state: QuotaState): Promise<void> {
    const remote = this.remotes.get(account);
    if (!remote) return;
    state.running = true;
    state.lastAt = this.now();
    try {
      state.server = await remote.quota();
      state.filesBytes = state.server ? null : this.engine.filesBytes(account);
    } catch {
      // Offline or refused: the last answer stays until the next ask.
    } finally {
      state.running = false;
    }
    if (this.quotas.get(account) !== state) return;
    this.schedulePublish();
    if (state.again) {
      state.again = false;
      this.refreshQuota(account, false);
    }
  }

  private forgetQuota(account: string): void {
    const state = this.quotas.get(account);
    if (state?.timer) clearTimeout(state.timer);
    this.quotas.delete(account);
    this.remotes.delete(account);
    this.sentStatus.delete(account);
  }

  /** The account's storage as the UI and Explorer show it. */
  quotaOf(account: string): FilesQuota | null {
    const state = this.quotas.get(account);
    if (!state) return null;
    // No limit, and the tree wasn't listed when the server answered: count it once it is.
    if (state.server === null && state.filesBytes === null) state.filesBytes = this.engine.filesBytes(account);
    return filesQuotaOf(state.server, state.filesBytes);
  }

  /** Tells main what Explorer should show for each drive, when it changed, at most once per statusGapMs. */
  private sendDriveStatus(): void {
    const send = this.deps.controls.drive?.status;
    const text = this.deps.driveStatusText?.();
    if (!send || !text) return;
    const statuses = this.engine.status();
    const drives = new Map(this.engine.roots.filter((root) => root.kind === 'drive').map((root) => [root.account, root]));
    for (const account of this.sentStatus.keys()) if (!drives.has(account)) this.sentStatus.delete(account);
    let later = Infinity;
    for (const [account, root] of drives) {
      if (!this.accounts.has(account)) continue;
      const status: FilesDriveStatus = driveStatusFor(statuses[root.id], root.paused, this.quotaOf(account), text);
      const json = JSON.stringify(status);
      const sent = this.sentStatus.get(account);
      if (sent?.json === json) continue;
      const wait = sent ? sent.at + this.quotaTiming.statusGapMs - this.now() : 0;
      if (wait > 0) {
        later = Math.min(later, wait);
        continue;
      }
      this.sentStatus.set(account, { json, at: this.now() });
      try {
        send(account, status);
      } catch {
        // An older shell: nothing shows in Explorer.
      }
    }
    if (later !== Infinity && !this.statusTimer && !this.stopped) {
      this.statusTimer = setTimeout(() => {
        this.statusTimer = null;
        this.sendDriveStatus();
      }, later);
    }
  }

  /**
   * The mass-delete question, a conflict, a file that can't sync: an OS notification too, so
   * someone working in Explorer or Word sees it (files-p3-5). Main shows none while the app's
   * window has the focus; the settings page says it there. A click opens that page; the
   * question's buttons answer it.
   */
  private announce(entry: FilesSyncActivity): void {
    const notify = this.deps.notify;
    const text = this.deps.notifyText?.();
    if (!notify || !text || !['mass-delete', 'conflict', 'error', 'too-large'].includes(entry.kind)) return;
    const root = this.engine.roots.find((candidate) => candidate.id === entry.rootId);
    if (!root || !this.accounts.has(root.account)) return;
    const context = JSON.stringify({ filesSync: root.id } satisfies FilesNotificationContext);
    try {
      if (entry.kind === 'mass-delete') {
        // Logged as the pass stops to ask, before its status says so: the line has it all.
        const count = Number(entry.detail);
        if (!Number.isFinite(count) || count <= 0) return;
        const massDelete = { count, deletedOn: entry.direction === 'up' ? 'this-computer' as const : 'files' as const };
        const words = text.massDelete(root, massDelete);
        notify({
          id: `files-sync:mass:${root.id}:${massDelete.deletedOn}:${massDelete.count}`,
          group: 'files-sync',
          title: words.title,
          body: words.body,
          context,
          actions: [{ id: FILES_NOTIFY_ACTIONS.restore, label: words.restore }, { id: FILES_NOTIFY_ACTIONS.allow, label: words.allow }],
        });
        return;
      }
      const words = entry.kind === 'conflict' ? text.conflict(root, entry) : text.problem(root, entry);
      notify({ id: `files-sync:${entry.kind}:${root.id}:${entry.path}`, group: 'files-sync', title: words.title, body: words.body, context });
    } catch {
      // A notification is extra.
    }
  }

  online(): void {
    this.engine.retryNow();
  }

  policyChanged(): void {
    this.engine.syncNow();
    this.schedulePublish();
  }

  private async driveRootOf(account: string): Promise<FilesRoot | null> {
    const roots = await this.deps.controls.roots().catch(() => [] as FilesRoot[]);
    return roots.find((root) => root.kind === 'drive' && root.account === account) ?? null;
  }

  /**
   * The sign-out gate: what waits in the account's drive goes up first (FilesFlushDialog shows
   * it), or the user stays signed in. Synced folders keep their files, so they don't ask.
   */
  async signOutGate(accountId: string): Promise<boolean> {
    const drives = this.engine.roots.filter((root) => root.kind === 'drive' && (accountId === 'all' || root.account === accountId));
    for (const root of drives) {
      if (!(await requestFlush({ rootId: root.id, kind: 'drive', purpose: 'sign-out' }))) return false;
    }
    return true;
  }

  /** Main is removing the drives (the policy said off): what waits goes up first, as far as it can. */
  private async flushForPolicy(requestId: string, accounts: string[]): Promise<void> {
    this.deps.controls.drive?.flushed?.(requestId, 'working');
    try {
      for (const account of accounts) {
        const root = this.engine.roots.find((entry) => entry.kind === 'drive' && entry.account === account);
        if (root) await this.engine.flushRoot(root.id, { timeoutMs: POLICY_FLUSH_MS }).catch(() => 'gone');
      }
    } finally {
      this.deps.controls.drive?.flushed?.(requestId);
    }
  }

  /**
   * Signed out ('all': everyone). `chosen`: the user signed out. The drive goes, and comes back
   * with its pins at the next sign-in; its record goes first, since its folder goes with it,
   * and main keeps what wasn't uploaded in Documents. Not chosen (the session ran out, the
   * login was refused): the drive only disconnects and keeps its folder, record and pins. The
   * folders stop until the next sign-in either way.
   */
  async signedOut(account: string, chosen = true): Promise<void> {
    const ids = account === 'all' ? [...new Set([...this.accounts.keys(), ...this.engine.roots.map((root) => root.account)])] : [account];
    for (const id of ids) {
      const drive = await this.driveRootOf(id);
      if (drive && chosen) await this.engine.forgetRoot(drive.id);
      // Its Recent activity goes with a sign-out the user chose; one nobody chose goes on later.
      if (chosen) this.forgetActivity(id);
      this.accounts.delete(id);
      this.driveStarted.delete(id);
      this.forgetQuota(id);
      this.engine.dropAccount(id);
      await this.deps.controls.drive?.disable(id, chosen ? 'signed-out' : 'suspended').catch(() => {});
    }
    await this.engine.refreshRoots();
  }

  /**
   * A wipe or a refused login the server was sure of: the drive goes with everything in it,
   * the folders are forgotten and their files stay. `null`: every account.
   */
  async removeAccountData(account: string | null, reason: 'wipe' | 'refused'): Promise<void> {
    await removeAccountData(this.deps.controls, account, reason, [...this.accounts.keys(), ...this.engine.roots.map((root) => root.account)]);
    for (const id of account === null ? [...new Set([...this.accounts.keys(), ...this.activityRestored])] : [account]) {
      this.accounts.delete(id);
      this.driveStarted.delete(id);
      this.forgetQuota(id);
      this.engine.dropAccount(id);
      this.forgetActivity(id);
    }
    await this.engine.refreshRoots();
  }

  private forgetActivity(account: string): void {
    this.engine.clearActivity(account);
    this.deps.activityStore?.remove(account);
    this.activitySaved.delete(account);
    this.activityRestored.delete(account);
  }

  /** Writes an account's Recent activity when it changed. */
  private saveActivity(): void {
    const store = this.deps.activityStore;
    if (!store) return;
    for (const account of this.activityRestored) {
      const lines = this.engine.activityOf(account);
      const signature = signatureOf(lines);
      if (this.activitySaved.get(account) === signature) continue;
      this.activitySaved.set(account, signature);
      store.save(account, lines);
    }
  }

  // ─── The store ──────────────────────────────────────────────

  private schedulePublish(): void {
    if (this.publishTimer || this.stopped) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      this.publishNow();
    }, 50);
  }

  /**
   * What the UI shows: the signed-in accounts' roots, their status and activity (the settings
   * page shows one account at a time, files-p3-20), and for the Files screen the account on
   * screen's items.
   */
  publishNow(): void {
    if (this.stopped) return;
    const current = this.current;
    const signedIn = new Set([...this.accounts.keys(), ...(current ? [current] : [])]);
    const roots = this.engine.roots.filter((root) => signedIn.has(root.account));
    const ids = new Set(roots.map((root) => root.id));
    const status = Object.fromEntries(Object.entries(this.engine.status()).filter(([id]) => ids.has(id)));
    this.deps.publish({
      available: true,
      account: current,
      accounts: [...this.accounts.values()].map((entry) => ({ id: entry.id, label: entry.label })),
      roots,
      status,
      // With the lines of roots that went since (files-p3-11, settings-p3-12).
      activity: this.engine.activity.filter((entry) => (entry.account ? signedIn.has(entry.account) : ids.has(entry.rootId))),
      drive: this.drive,
      folderSyncForcedOff: this.deps.folderSyncForcedOff(),
      items: current ? this.engine.items(current) : {},
      keptOnDevice: current ? this.engine.keptOnDevice(current) : {},
      quota: current ? this.quotaOf(current) : null,
      rescued: this.rescued,
    });
    this.sendDriveStatus();
    this.saveActivity();
  }

  controller(): FilesSyncController {
    const controls = this.deps.controls;
    return {
      // Main wants the click this came from: the bridge call goes first, before any await.
      addFolder: async (remoteId, remoteLabel, options) => {
        const account = options?.account ?? this.current;
        if (!account) return fail('inactive');
        // A folder of someone else's shared drive: the engine syncs the account's own Files.
        if (remoteId !== null && remoteId.includes(':')) return fail('unsupported');
        const result = await controls.addFolder({ account, remoteId, remoteLabel, ...(options?.chosen ? { chosen: options.chosen } : {}) });
        await this.engine.refreshRoots();
        return result;
      },
      removeRoot: (rootId) => this.engine.removeRoot(rootId),
      setPaused: (rootId, paused) => this.engine.setPaused(rootId, paused),
      setAllPaused: async (paused) => {
        for (const root of this.engine.roots) {
          if (root.paused !== paused && this.accounts.has(root.account)) await controls.setPaused(root.id, paused).catch(() => {});
        }
        await this.engine.refreshRoots();
      },
      confirmMassDelete: async (rootId, allow) => {
        this.engine.confirmMassDelete(rootId, allow);
      },
      chooseFolder: controls.chooseFolder ? () => controls.chooseFolder!() : null,
      setDriveEnabled: async (enabled, chosenAccount) => {
        const account = chosenAccount ?? this.current;
        const drive = controls.drive;
        if (!drive) return fail('unsupported');
        if (!account) return fail('inactive');
        if (enabled) {
          const label = this.accounts.get(account)?.label ?? account;
          const result = await drive.enable(account, label);
          if (result.ok) this.driveStarted.add(account);
          await this.engine.refreshRoots();
          return result;
        }
        const done = await drive.disable(account, 'user');
        this.driveStarted.delete(account);
        if (done && done.rescued && done.rescued.count > 0) {
          this.rescued = done.rescued;
          this.schedulePublish();
        }
        await this.engine.refreshRoots();
        return { ok: true, value: null };
      },
      setDriveLetter: async (letter) => {
        const drive = controls.drive;
        if (!drive) return fail('unsupported');
        return drive.setLetter(letter);
      },
      coverage: (nodeId) => (this.current ? this.engine.coverage(this.current, nodeId) : null),
      showInFolder: async (nodeId) => {
        const coverage = this.current ? this.engine.coverage(this.current, nodeId) : null;
        if (!coverage) return false;
        return controls.showInFolder(coverage.rootId, coverage.path);
      },
      clearActivity: (account) => {
        const which = account ?? this.current;
        if (which) this.engine.clearActivity(which);
      },
      openRoot: (rootId) => controls.showInFolder(rootId, '').catch(() => false),
      setKeptOnDevice: controls.drive?.setPin ? async (nodeId, keep) => {
        const coverage = this.current ? this.engine.coverage(this.current, nodeId) : null;
        const setPin = controls.drive?.setPin;
        if (!coverage || coverage.kind !== 'drive' || !coverage.path || !setPin) return false;
        const result = await setPin(coverage.rootId, coverage.path, keep ? 'pinned' : 'unpinned').catch(() => null);
        // The next scan shows the new state on the row.
        this.engine.syncNow(coverage.rootId);
        return !!result?.ok;
      } : null,
      pendingHere: async (rootId) => (await this.engine.pendingHere(rootId)) ?? [],
      flushRoot: (rootId, options) => this.engine.flushRoot(rootId, options),
      openRescue: async () => (await controls.drive?.openRescue?.().catch(() => false)) ?? false,
      dismissRescue: () => {
        this.rescued = null;
        this.schedulePublish();
      },
    };
  }
}

/** Changes when lines come or go. */
function signatureOf(lines: { id: string }[]): string {
  return `${lines.length}:${lines[0]?.id ?? ''}:${lines.at(-1)?.id ?? ''}`;
}

/**
 * For a wipe or a refused login, with or without a running host: the drive goes with
 * everything in it, the folders are forgotten (their files stay). Bridge calls only: a wipe
 * often runs because the server said no.
 */
export async function removeAccountData(controls: FilesControls, account: string | null, reason: 'wipe' | 'refused', known: string[] = []): Promise<void> {
  const roots = await controls.roots().catch(() => [] as FilesRoot[]);
  const drive = controls.drive;
  const wanted = drive ? await drive.state().then((state) => state.wanted, () => [] as string[]) : [];
  const accounts = account === null ? [...new Set([...known, ...wanted, ...roots.map((root) => root.account)])] : [account];
  for (const id of accounts) {
    if (drive && (wanted.includes(id) || roots.some((root) => root.kind === 'drive' && root.account === id))) {
      await drive.disable(id, reason).catch(() => {});
    }
    for (const root of roots) {
      if (root.kind === 'folder' && root.account === id) await controls.removeRoot(root.id).catch(() => {});
    }
  }
}
