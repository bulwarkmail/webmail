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
 * What happens to an account's roots when it leaves (FILES-SYNC-BRIEF.md):
 * - sign-out: the drive goes (`signed-out` keeps the wish, so the next sign-in brings it back
 *   without a click), and the folders stop syncing until then;
 * - a wipe (lib/offline/wipe-registry.ts): the drive goes with everything in it, and the
 *   folders are forgotten; their files stay, they were the user's;
 * - a refused login the server was sure of: the same as a wipe for these.
 */

import type { FilesControls, FilesDriveState, FilesResult, FilesRoot } from '@/lib/desktop/types';
import { FetchTransport, type StoreSession } from '@/lib/store/engine/transport';
import { FilesSyncEngine, type EngineTiming } from './engine';
import type { FilesSyncErrorName } from './errors';
import { namingFor } from './names';
import { FilesRemote } from './remote';
import type { FilesSyncController, FilesSyncSnapshot } from './types';

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
}

const DEVICE: Record<string, string> = { win32: 'Windows', darwin: 'Mac', linux: 'Linux' };

/** The app's client as a transport: its session and header, read each time, renewed through it. */
export function remoteForClient(client: SessionClient): FilesRemote | null {
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

  constructor(private readonly deps: HostDeps) {
    this.engine = new FilesSyncEngine({
      controls: deps.controls,
      naming: namingFor(deps.platform),
      device: DEVICE[deps.platform] ?? 'this computer',
      readUrl: deps.readUrl,
      timing: deps.timing,
      blocked: (root) => this.blocked(root),
      downloadsAllowed: (account) => !deps.downloadsForbidden(account),
      onUpdate: () => this.schedulePublish(),
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
        this.schedulePublish();
        void this.engine.refreshRoots();
      }));
    }
    this.deps.setController(this.controller());
    this.publishNow();
  }

  stop(): void {
    this.stopped = true;
    for (const stop of this.unsubscribe.splice(0)) stop();
    if (this.publishTimer) clearTimeout(this.publishTimer);
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
      this.engine.dropAccount(id);
    }
    for (const account of accounts) {
      const known = this.accounts.get(account.id);
      if (known && known.client === account.client) continue;
      const remote = (this.deps.remoteFor ?? ((entry: HostAccount) => remoteForClient(entry.client)))(account);
      if (!remote) continue;
      this.accounts.set(account.id, account);
      this.engine.setAccount(account.id, remote);
    }
    this.startDrives();
    void this.engine.refreshRoots();
    this.schedulePublish();
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
   * Signed out ('all': everyone). The drive goes, and comes back at the next sign-in; its record
   * goes first, since its folder goes with it. The folders stop until then.
   */
  async signedOut(account: string): Promise<void> {
    const ids = account === 'all' ? [...new Set([...this.accounts.keys(), ...this.engine.roots.map((root) => root.account)])] : [account];
    for (const id of ids) {
      const drive = await this.driveRootOf(id);
      if (drive) await this.engine.forgetRoot(drive.id);
      this.accounts.delete(id);
      this.driveStarted.delete(id);
      this.engine.dropAccount(id);
      await this.deps.controls.drive?.disable(id, 'signed-out').catch(() => {});
    }
    await this.engine.refreshRoots();
  }

  /**
   * A wipe or a refused login the server was sure of: the drive goes with everything in it,
   * the folders are forgotten and their files stay. `null`: every account.
   */
  async removeAccountData(account: string | null, reason: 'wipe' | 'refused'): Promise<void> {
    await removeAccountData(this.deps.controls, account, reason, [...this.accounts.keys(), ...this.engine.roots.map((root) => root.account)]);
    for (const id of account === null ? [...this.accounts.keys()] : [account]) {
      this.accounts.delete(id);
      this.driveStarted.delete(id);
      this.engine.dropAccount(id);
    }
    await this.engine.refreshRoots();
  }

  // ─── The store ──────────────────────────────────────────────

  private schedulePublish(): void {
    if (this.publishTimer || this.stopped) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      this.publishNow();
    }, 50);
  }

  /** What the UI shows: the account on screen's roots, their status and activity. */
  publishNow(): void {
    if (this.stopped) return;
    const current = this.current;
    const roots = current ? this.engine.roots.filter((root) => root.account === current) : [];
    const ids = new Set(roots.map((root) => root.id));
    const status = Object.fromEntries(Object.entries(this.engine.status()).filter(([id]) => ids.has(id)));
    this.deps.publish({
      available: true,
      account: current,
      roots,
      status,
      activity: this.engine.activity.filter((entry) => ids.has(entry.rootId)),
      drive: this.drive,
      folderSyncForcedOff: this.deps.folderSyncForcedOff(),
      items: current ? this.engine.items(current) : {},
    });
  }

  controller(): FilesSyncController {
    const controls = this.deps.controls;
    return {
      // Main wants the click this came from: the bridge call goes first, before any await.
      addFolder: async (remoteId, remoteLabel) => {
        const account = this.current;
        if (!account) return fail('inactive');
        // A folder of someone else's shared drive: the engine syncs the account's own Files.
        if (remoteId !== null && remoteId.includes(':')) return fail('unsupported');
        const result = await controls.addFolder({ account, remoteId, remoteLabel });
        await this.engine.refreshRoots();
        return result;
      },
      removeRoot: (rootId) => this.engine.removeRoot(rootId),
      setPaused: (rootId, paused) => this.engine.setPaused(rootId, paused),
      confirmMassDelete: async (rootId, allow) => {
        this.engine.confirmMassDelete(rootId, allow);
      },
      setDriveEnabled: async (enabled) => {
        const account = this.current;
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
        await drive.disable(account, 'user');
        this.driveStarted.delete(account);
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
      clearActivity: () => this.engine.clearActivity(),
    };
  }
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
