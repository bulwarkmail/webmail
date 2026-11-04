import { create } from 'zustand';
import type { FilesSyncController, FilesSyncSnapshot } from '@/lib/files-sync/types';

/**
 * Files on this computer, for the UI: the engine (lib/files-sync) writes the snapshot
 * and registers its controller; the settings page and the Files screen read it and
 * call the controller. Nothing here touches the bridge.
 */
interface FilesSyncStore extends FilesSyncSnapshot {
  controller: FilesSyncController | null;
  /** The engine's: replaces what it says changed. */
  publish: (patch: Partial<FilesSyncSnapshot>) => void;
  setController: (controller: FilesSyncController | null) => void;
  /** Back to nothing: signed out, or the engine stopped. */
  reset: () => void;
}

const EMPTY: FilesSyncSnapshot = {
  available: false,
  account: null,
  roots: [],
  status: {},
  activity: [],
  drive: null,
  folderSyncForcedOff: false,
  items: {},
  quota: null,
  rescued: null,
};

export const useFilesSyncStore = create<FilesSyncStore>((set) => ({
  ...EMPTY,
  controller: null,
  publish: (patch) => set(patch),
  setController: (controller) => set({ controller }),
  reset: () => set({ ...EMPTY, controller: null }),
}));
