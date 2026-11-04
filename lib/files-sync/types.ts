/**
 * Files on this computer, the page's side: what the sync engine reports and what the
 * settings page and the Files screen can ask of it. The engine (lib/files-sync) keeps
 * folders on disk and the Windows drive the same as Files; the desktop shell does the
 * disk work (FilesControls in lib/desktop/types.ts).
 *
 * The store (stores/files-sync-store.ts) holds this state for the UI. The engine sets
 * it and registers a controller there; the UI never talks to the bridge itself.
 */

import type { FilesDriveLetterState, FilesDriveState, FilesRescued, FilesResult, FilesRoot } from '@/lib/desktop/types';

export type FilesSyncRootState =
  /** Reading both sides for the first time since the app started. */
  | 'starting'
  | 'syncing'
  /** Both sides are the same. */
  | 'idle'
  | 'paused'
  /** The server can't be reached; changes wait. */
  | 'offline'
  | 'error'
  /** A mass delete stopped it: the user has to say yes or no (`massDelete`). */
  | 'confirm-delete'
  /** The organisation's policy stopped it. */
  | 'blocked';

export interface FilesSyncRootStatus {
  rootId: string;
  state: FilesSyncRootState;
  /** Changes waiting to go either way. */
  pending: number;
  /** Done in the current run. */
  done: number;
  lastSyncedAt: number | null;
  /** For `error`: a key in the `files_sync` namespace saying what went wrong. */
  errorKey?: string;
  /** For `confirm-delete`: how many items were deleted, and where (MassDeleteOrigin). */
  massDelete?: { count: number; deletedOn: MassDeleteOrigin };
}

/**
 * Where the items of a mass delete WERE deleted, by the user or someone else. The question
 * asks whether to delete them on the other side too. One type for the engine and the UI, so
 * nobody reads it the other way round again (pass-3 files-p3-1).
 * - `this-computer`: deleted in the folder or the drive here; "yes" deletes them in Files.
 * - `files`: deleted in Files (another device, a colleague); "yes" deletes them here.
 */
export type MassDeleteOrigin = 'this-computer' | 'files';

export type FilesSyncActivityKind =
  | 'uploaded'
  | 'downloaded'
  | 'folder-created'
  | 'renamed'
  | 'moved'
  /** Deleted for good: the server has no trash, or it was deleted on this computer by the other side. */
  | 'deleted'
  /** Into Files' trash, or the computer's. */
  | 'trashed'
  /** Both sides changed. Neither is lost: `detail` is the name of the copy kept next to it. */
  | 'conflict'
  /** A name this computer can't hold, shown under another name (`detail`). */
  | 'renamed-for-disk'
  /** Bigger than the server takes. Stays on this computer only. `detail`: the limit in bytes. */
  | 'too-large'
  /** Waiting for the server. */
  | 'waiting'
  /** Stopped before deleting many items, see FilesSyncRootStatus.massDelete. */
  | 'mass-delete'
  | 'error';

export interface FilesSyncActivity {
  id: string;
  at: number;
  rootId: string;
  kind: FilesSyncActivityKind;
  /** `up`: to Files. `down`: to this computer. */
  direction: 'up' | 'down' | null;
  /** Relative to the root, `/` between parts. */
  path: string;
  detail?: string;
  /** For `error` and `waiting`: a key in the `files_sync` namespace. */
  messageKey?: string;
}

/** Where a FileNode is on this computer. */
export interface FilesSyncCoverage {
  rootId: string;
  kind: 'folder' | 'drive';
  /** Relative to the root. */
  path: string;
}

export type FilesSyncItemStatus =
  /** The same on both sides. */
  | 'synced'
  /** Going one way right now. */
  | 'syncing'
  /** Waiting to go. */
  | 'pending'
  | 'error'
  /** The drive: only in Files, fetched when opened. */
  | 'online-only';

/**
 * How uploading what waits went, before a drive or folder stops (FilesSyncController.flushRoot).
 * `done`: nothing waits. `offline`: the server can't be reached. `stuck`: a pass changed nothing
 * (too large, refused, paused, waiting for an answer). `cancelled`: the user stopped waiting.
 * `gone`: the root isn't there any more.
 */
export type FilesFlushOutcome = 'done' | 'offline' | 'stuck' | 'cancelled' | 'gone';

export interface FilesFlushOptions {
  signal?: AbortSignal;
  /** What still waits, by path in the root, and how many waited at the start. */
  onProgress?: (waiting: string[], total: number) => void;
  /** Gives up as `stuck` after this long. */
  timeoutMs?: number;
}

/** What the UI can ask of the engine. Registered by the engine in the store. */
export interface FilesSyncController {
  /** Shows the folder picker; needs the click it came from. */
  addFolder: (remoteId: string | null, remoteLabel: string) => Promise<FilesResult<FilesRoot>>;
  /** A folder stops syncing; its files stay. The drive: turned off. */
  removeRoot: (rootId: string) => Promise<void>;
  setPaused: (rootId: string, paused: boolean) => Promise<void>;
  /** Answer to `confirm-delete`. No: the deleted items come back from the other side. */
  confirmMassDelete: (rootId: string, allow: boolean) => Promise<void>;
  /** The current account's drive. */
  setDriveEnabled: (enabled: boolean) => Promise<FilesResult<FilesRoot | null>>;
  setDriveLetter: (letter: string | null) => Promise<FilesResult<FilesDriveLetterState>>;
  /** Where a FileNode of the current account is on this computer, if a root covers it. */
  coverage: (nodeId: string) => FilesSyncCoverage | null;
  /** Explorer, Finder or the file manager, on that file or folder. */
  showInFolder: (nodeId: string) => Promise<boolean>;
  clearActivity: () => void;
  /** Files changed or made here that aren't in Files yet: what stopping this root now would leave behind. */
  pendingHere: (rootId: string) => Promise<string[]>;
  /** Uploads what waits in a root, pass after pass, until nothing does or it can't go on. */
  flushRoot: (rootId: string, options?: FilesFlushOptions) => Promise<FilesFlushOutcome>;
  /** Opens the folder the last files that weren't uploaded went to. */
  openRescue: () => Promise<boolean>;
  /** The settings page's notice about them was read. */
  dismissRescue: () => void;
}

/**
 * The storage Files counts against. From the server's Quota/get when it sets a limit; without
 * one, what the account's files take, from its FileNode tree, and no total.
 */
export interface FilesQuota {
  used: number;
  /** Null: the server sets no limit. */
  total: number | null;
  /** warnLimit, when the server sets one below the total. */
  warnAt?: number;
  source: 'server' | 'files';
}

export interface FilesSyncSnapshot {
  /** In the desktop app, with a shell that has the files bridge, in the main window. */
  available: boolean;
  /** The local account the engine runs for, or null when nobody is signed in. */
  account: string | null;
  roots: FilesRoot[];
  status: Record<string, FilesSyncRootStatus>;
  /** Newest first, capped. */
  activity: FilesSyncActivity[];
  /** Null off Windows or on an older shell. */
  drive: FilesDriveState | null;
  /** `FilesFolderSyncEnabled` is off. */
  folderSyncForcedOff: boolean;
  /** Per FileNode id of the current account, for rows in the Files screen. */
  items: Record<string, FilesSyncItemStatus>;
  /** The current account's storage. Null until known. */
  quota: FilesQuota | null;
  /** Turning the drive off copied files that weren't uploaded here. Null: nothing to say. */
  rescued: FilesRescued | null;
}
