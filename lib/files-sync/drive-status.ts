/**
 * What Explorer shows for the Windows drive (Windows 11's storage provider status): the
 * engine's state of the drive's root, and the storage from the server. Pure, so the mapping
 * is tested on its own; the words come from the page's translations (DriveStatusText).
 */

import type { FilesDriveStatus } from '@/lib/desktop/types';
import { quotaLevel, type QuotaLevel, type StorageQuota } from '@/lib/quota';
import type { FilesQuota, FilesSyncRootState, FilesSyncRootStatus } from './types';

/** The words, in the page's language. */
export interface DriveStatusText {
  /** "Up to date", "Syncing", "Paused", "Offline", "Stopped". */
  state: (state: FilesDriveStatus['state']) => string;
  /** The longer line, as the settings page says it (FilesSyncStatusLine). */
  detail: (status: FilesSyncRootStatus | undefined, state: FilesSyncRootState) => string;
  /** "1 GB of 5 GB used", "1 GB used". */
  quota: (used: number, total: number | null) => string;
  /** Storage nearly full, or full. */
  notice: (level: 'warn' | 'full') => string;
}

/** The engine's states as Windows has them. */
export function driveStateOf(state: FilesSyncRootState): FilesDriveStatus['state'] {
  switch (state) {
    case 'idle':
      return 'synced';
    case 'starting':
    case 'syncing':
      return 'syncing';
    case 'paused':
    case 'confirm-delete':
      return 'paused';
    case 'offline':
      return 'offline';
    case 'error':
    case 'blocked':
      return 'error';
  }
}

/** The server's limit when it sets one; else what the account's files take, with no total. */
export function filesQuotaOf(server: StorageQuota | null | undefined, filesBytes: number | null): FilesQuota | null {
  if (server && server.total > 0) {
    const quota: FilesQuota = { used: server.used, total: server.total, source: 'server' };
    if (server.warnAt !== undefined) quota.warnAt = server.warnAt;
    return quota;
  }
  // Not asked yet: nothing to say. Asked, and no limit: the files.
  if (server === undefined || filesBytes === null) return null;
  return { used: filesBytes, total: null, source: 'files' };
}

/** For the storage ring: only a quota with a limit, in the shape lib/quota.ts uses. */
export function filesRingQuota(quota: FilesQuota | null): StorageQuota | null {
  if (!quota || quota.total === null) return null;
  return quota.warnAt === undefined ? { used: quota.used, total: quota.total } : { used: quota.used, total: quota.total, warnAt: quota.warnAt };
}

export function filesQuotaLevel(quota: FilesQuota | null): QuotaLevel {
  if (!quota || quota.total === null) return 'ok';
  return quotaLevel({ used: quota.used, total: quota.total, warnAt: quota.warnAt });
}

export function driveStatusFor(status: FilesSyncRootStatus | undefined, paused: boolean, quota: FilesQuota | null, text: DriveStatusText): FilesDriveStatus {
  const engineState: FilesSyncRootState = status?.state ?? (paused ? 'paused' : 'starting');
  const state = driveStateOf(engineState);
  const level = filesQuotaLevel(quota);
  return {
    state,
    label: text.state(state),
    detail: text.detail(status, engineState),
    quota: quota ? { used: quota.used, total: quota.total, label: text.quota(quota.used, quota.total) } : null,
    notice: level === 'ok' ? null : text.notice(level),
  };
}
