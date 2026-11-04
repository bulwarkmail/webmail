/**
 * Files on this computer, the page's side: what the sync engine reports and what the
 * settings page and the Files screen can ask of it. The engine (lib/files-sync) keeps
 * folders on disk and the Windows drive the same as Files; the desktop shell does the
 * disk work (FilesControls in lib/desktop/types.ts).
 *
 * The store (stores/files-sync-store.ts) holds this state for the UI. The engine sets
 * it and registers a controller there; the UI never talks to the bridge itself.
 */

import type { FilesDriveLetterState, FilesDriveState, FilesResult, FilesRoot } from '@/lib/desktop/types';

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
  /** For `confirm-delete`: how many items would go, and where. */
  massDelete?: { count: number; side: 'local' | 'remote' };
}

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
}
