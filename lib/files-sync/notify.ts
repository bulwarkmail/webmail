/**
 * Files on this computer's OS notifications (files-p3-5): the mass-delete question, a conflict,
 * a file that can't sync. The host (host.ts) shows them; lib/desktop/os-commands.ts answers a
 * click or a button. Kept apart from the host so os-commands doesn't load the engine.
 */

import type { FilesRoot } from '@/lib/desktop/types';
import type { FilesSyncActivity, FilesSyncRootStatus } from './types';

/** The words, in the page's language. The mass-delete question also names its two buttons. */
export interface FilesNotifyText {
  massDelete: (root: FilesRoot, massDelete: NonNullable<FilesSyncRootStatus['massDelete']>) => { title: string; body: string; allow: string; restore: string };
  conflict: (root: FilesRoot, entry: FilesSyncActivity) => { title: string; body: string };
  problem: (root: FilesRoot, entry: FilesSyncActivity) => { title: string; body: string };
}

/** What a click on a Files notification hands back. */
export interface FilesNotificationContext {
  filesSync: string;
}

/** The buttons of the mass-delete notification. */
export const FILES_NOTIFY_ACTIONS = { allow: 'files-delete', restore: 'files-restore' } as const;
