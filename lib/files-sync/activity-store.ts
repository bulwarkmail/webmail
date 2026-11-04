/**
 * Recent activity of Files on this computer, kept across restarts (pass-3 files-p3-11): the last
 * lines per account (the engine caps them), in this browser profile's storage. A sign-out the
 * user chose and a wipe drop the account's lines (host.ts); a full sign-out drops all of them
 * (lib/sign-out-cleanup.ts lists the key).
 */

import type { FilesSyncActivity } from './types';

export const FILES_ACTIVITY_KEY = 'bulwark-files-activity';

export interface ActivityStore {
  load(account: string): FilesSyncActivity[];
  save(account: string, lines: FilesSyncActivity[]): void;
  remove(account: string): void;
}

const KINDS = new Set(['uploaded', 'downloaded', 'folder-created', 'renamed', 'moved', 'deleted', 'trashed', 'conflict', 'renamed-for-disk', 'too-large', 'waiting', 'mass-delete', 'error']);

function valid(line: unknown): line is FilesSyncActivity {
  const entry = line as FilesSyncActivity;
  return !!entry
    && typeof entry.id === 'string' && Number.isFinite(entry.at) && typeof entry.rootId === 'string'
    && KINDS.has(entry.kind) && typeof entry.path === 'string'
    && (entry.direction === 'up' || entry.direction === 'down' || entry.direction === null)
    && (entry.detail === undefined || typeof entry.detail === 'string')
    && (entry.messageKey === undefined || typeof entry.messageKey === 'string');
}

function readAll(storage: Storage): Record<string, FilesSyncActivity[]> {
  try {
    const parsed = JSON.parse(storage.getItem(FILES_ACTIVITY_KEY) ?? '{}') as Record<string, unknown>;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, FilesSyncActivity[]>) : {};
  } catch {
    return {};
  }
}

/** In localStorage. Anything unreadable reads as nothing. */
export function localActivityStore(storage: Storage | null = typeof window === 'undefined' ? null : window.localStorage): ActivityStore {
  const write = (all: Record<string, FilesSyncActivity[]>) => {
    try {
      if (Object.keys(all).length === 0) storage?.removeItem(FILES_ACTIVITY_KEY);
      else storage?.setItem(FILES_ACTIVITY_KEY, JSON.stringify(all));
    } catch {
      // Full or unavailable: the list is only lost at the next restart.
    }
  };
  return {
    load: (account) => {
      if (!storage) return [];
      const lines = readAll(storage)[account];
      return Array.isArray(lines) ? lines.filter(valid) : [];
    },
    save: (account, lines) => {
      if (!storage) return;
      const all = readAll(storage);
      if (lines.length === 0) delete all[account];
      else all[account] = lines;
      write(all);
    },
    remove: (account) => {
      if (!storage) return;
      const all = readAll(storage);
      delete all[account];
      write(all);
    },
  };
}
